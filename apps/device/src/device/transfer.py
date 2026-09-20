"""検知ログの転送（`control` を受けて `log` に流す）。#40

**BLE を知らない。** バイト列を受け取り、次に流すバイト列を返すだけなので、開発機でも
pytest から回せる（`../../README.md`「それぞれの約束」）。実際に Notify を送るのは
`hw/ble.py` 側で、あちらは**ここが返した塊をそのまま `set_value()` に渡すだけ**である。

**約束の正本は `../../../../docs/interfaces/ble-log-transfer.md`「転送の約束」**と
`../../../../docs/interfaces/ble-gatt.md`「`control`」。**ここで決め直さない。**
守っているのは次の4つ。

| 約束 | ここでの守り方 |
| --- | --- |
| 受けた時点の `latest_seq` まで送って EOT | 受けた瞬間に**全部を組み立てる** |
| 送るものが0件でも EOT を送る | 組み立てた結果が EOT 1バイトだけになる |
| `sending` 中の `read` は断る | `state.transfer_state` を見て `last_error` に載せる |
| `stop` と切断では EOT を送らない | 途中で捨てて `idle` に戻すだけ |
"""

import json
import logging
from dataclasses import dataclass

from device.log import LogStore
from device.state import DeviceState

logger = logging.getLogger(__name__)

# 転送の終わりを表す1バイト（EOT）。**完了の印はこれだけ**で、`status` では判定させない。
EOT = b"\x04"

# 1回の Notify に載せられる属性値の上限（バイト）。
#
# **MTU から引いた値がこれを超えたら、こちらで頭を打たせる。** ATT の属性値は
# **仕様上 512 バイトが上限**で、Notify もその属性値を運ぶ。**MTU がそれより大きくても、
# 513 バイト目から先は運ばれない。**
#
# **超えて渡すと、BlueZ が黙って 512 で切る。** こちらは切られた前提で位置を進めないので、
# **塊の継ぎ目にまたがったレコードが1件ずつ壊れる**——**壊れた行はセントラルが捨て、
# 既読位置は読めた行まで進むので、そのレコードは二度と送られてこない。**
#
# **2026-09-20 に実機で踏んだ。** MTU 517（→ 514 バイト送る）で 22 件を流し、
# **届いたのは 512 バイトずつ**で、**継ぎ目の 3 件（seq 7 / 13 / 19）が消えた**
# （`../../../../docs/unverified.md` 107）。**1塊で収まる転送では起きない**ので、
# 件数が増えるまで見えなかった。
MAX_ATT_VALUE = 512


@dataclass(frozen=True)
class ControlOutcome:
    """`control` を1通処理した結果。**`hw/ble.py` が次に何をするかを決めるためのもの。**"""

    # 転送が始まったか（始まったなら、呼び出し側が `next_chunk()` を回し始める）。
    started: bool = False
    # 断った理由。**`status` の `last_error` に載る**（`alert` の異常はここに来ない）。
    error: str | None = None


class LogTransfer:
    """`control` を受けて、`log` に流すバイト列を切り出す。

    **`state` を書き換えるのはここ**（`transfer_state` / `sent` / `remaining` /
    `last_error`）。`hw/ble.py` は BLE の管に徹し、`state.py` は形を作るだけである。

    **MTU を自分で調べない。** 書き込みのたびに BlueZ が `options` で渡してくるので、
    呼び出し側がそれを渡す（`hw/ble.py`）。
    """

    def __init__(self, state: DeviceState, store: LogStore, *, fallback_chunk: int) -> None:
        """
        Args:
            state: `status` に出る値。**転送の進み具合をここへ書く**
            store: 流すレコードの出どころ
            fallback_chunk: MTU が分からないときに使う1回ぶんのバイト数。
                **既定の ATT_MTU 23 から 3 を引いた 20 を想定している**——
                **小さすぎる方に倒す**（大きく見積もると、BlueZ が黙って切り詰めて
                JSON が壊れる。`../../../../docs/interfaces/ble-log-transfer.md` の 6）
        """
        self._state = state
        self._store = store
        self._fallback_chunk = fallback_chunk
        # 流し終えていないバイト列と、その位置。**`read` を受けた時点で作り切る。**
        self._payload = b""
        self._pos = 0
        # 各レコードの終わりの位置（`sent` を数えるためだけに持つ）。
        self._ends: list[int] = []
        self._chunk = fallback_chunk

    def handle_control(
        self, payload: bytes, *, mtu: int | None, can_notify: bool
    ) -> ControlOutcome:
        """`control` に書かれた1通を処理する。**例外を投げない。**

        Args:
            payload: 書き込まれたバイト列
            mtu: ネゴシエートされた MTU（分からなければ `None`）
            can_notify: `log` が購読されているか。
                **購読されていなければ断る**——流しても Notify の行き先が無く、
                **セントラルは0件で転送が終わったと見なす**
                （`../../../../docs/interfaces/ble-gatt.md`「購読より先に `read` を書かない」）
        """
        try:
            body = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self._reject("bad json")
        if not isinstance(body, dict):
            return self._reject("bad json")

        cmd = body.get("cmd")
        if cmd == "stop":
            # **EOT を送らない。** EOT の有無が「送り切った」と「途中でやめた」の区別になる。
            self.abort()
            return ControlOutcome()
        if cmd != "read":
            # **知らないコマンドは無視する**（理由だけ `last_error` に載せる）。
            return self._reject(f"unknown cmd: {cmd!r}")

        if self._state.transfer_state == "sending":
            # **2つ目の転送を始めない。**同じ `log` の上で新旧が混ざると、`seq` が逆行し、
            # **古い方の EOT で新しい転送が完了したことになる。**
            return self._reject("sending")
        if not can_notify:
            return self._reject("log not subscribed")

        since = body.get("since", 0)
        if not isinstance(since, int) or isinstance(since, bool) or since < 0:
            return self._reject(f"bad since: {since!r}")

        self._build(since, mtu)
        # **`last_error` は `read` を受け付けた時点で `null` に戻す**
        # （`../../../../docs/interfaces/ble-gatt.md`「`status`」）。
        self._state.last_error = None
        self._state.transfer_state = "sending"
        logger.info(
            "検知ログの転送を始める（since=%d / %d 件 / %d バイト / 1回 %d バイト）",
            since,
            len(self._ends),
            len(self._payload),
            self._chunk,
        )
        return ControlOutcome(started=True)

    def next_chunk(self) -> bytes | None:
        """次に流す塊を返す。**送り切っていたら `None`**（呼び出し側は回すのをやめる）。"""
        if self._state.transfer_state != "sending":
            return None
        if self._pos >= len(self._payload):
            self._finish()
            return None

        chunk = self._payload[self._pos : self._pos + self._chunk]
        self._pos += len(chunk)
        self._update_counts()
        return chunk

    def abort(self) -> None:
        """転送を捨てて `idle` に戻す。**切断と `stop` の両方がここへ来る。**

        **戻さないと、同期中に落ちた端末はつなぎ直しても以後ずっと `read` を断られる**
        （`../../../../docs/interfaces/ble-gatt.md`「`control`」）。
        """
        if self._state.transfer_state == "sending":
            logger.info("検知ログの転送を中止した（%d / %d バイト）", self._pos, len(self._payload))
        self._payload = b""
        self._pos = 0
        self._ends = []
        self._state.transfer_state = "idle"
        self._state.sent = 0
        self._state.remaining = 0

    def _build(self, since: int, mtu: int | None) -> None:
        """流すバイト列を組み立てる。**`read` を受けた時点のぶんだけ。**

        **「持っているぶん全部」にしない。** 同期中も走行は続き、検知が発火すれば
        レコードは増えるので、**終わりが来ないまま流し続けることになる。**
        ここで作り切ってしまえば、**そのあと溢れて消えたレコードも送り切れる**
        （`../../../../docs/interfaces/ble-log-transfer.md`「転送の約束」の 1）。
        """
        lines: list[bytes] = []
        self._ends = []
        size = 0
        for record in self._store.since(since):
            line = record.to_line()
            lines.append(line)
            size += len(line)
            self._ends.append(size)
        # **0件でも EOT を送る**（送るものが無いことと、途中で止まったことを区別させる）。
        lines.append(EOT)
        self._payload = b"".join(lines)
        self._pos = 0
        # **1パケットは `MTU - 3` バイト以内**（`ble-log-transfer.md` の 6）。
        # 分からなければ小さい方に倒す（上の `fallback_chunk`）。
        #
        # **`MAX_ATT_VALUE` で頭を打たせる。** MTU がいくら大きくても、
        # **属性値そのものが 512 バイトを超えて運ばれることはない**（下の定数）。
        limit = min(mtu - 3, MAX_ATT_VALUE) if mtu is not None else 0
        self._chunk = limit if limit >= 1 else self._fallback_chunk
        self._update_counts()

    def _finish(self) -> None:
        logger.info("検知ログを送り切った（%d 件）", len(self._ends))
        sent = len(self._ends)
        # **先に `idle` へ落としてから片付ける。**`sending` のまま `abort()` を呼ぶと、
        # あちらが「中止した」と journal に出す ——**成功した転送が中止と記録される。**
        # デバイスの journal は実機で唯一の観測手段なので、ここで嘘をつかない。
        self._state.transfer_state = "idle"
        self.abort()
        # **送った数は残す。** `abort()` が 0 に戻すが、**送り切った直後に `status` を
        # 読む相手に「0件だった」と見せない**（完了の判定には使わせないが、人は読む）。
        self._state.sent = sent

    def _update_counts(self) -> None:
        """`sent` / `remaining` を数え直す。**どちらも目安**（完了判定には使わせない）。"""
        sent = sum(1 for end in self._ends if end <= self._pos)
        self._state.sent = sent
        self._state.remaining = len(self._ends) - sent

    def _reject(self, reason: str) -> ControlOutcome:
        logger.warning("control を断った: %s", reason)
        self._state.last_error = reason
        return ControlOutcome(error=reason)
