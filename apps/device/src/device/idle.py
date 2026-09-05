"""心拍の来ない接続を、デバイスの側から手放すかどうかを決める。

**なぜ要るか。** BLE の接続枠は1つで、**つないでいる相手から枠を奪う手段はセントラル側に無い**
（リンク層の話で、アプリからはどうにもならない）。他人がつなぎっぱなしにすると、
持ち主のスマホは接続できず、**走行中ずっと警告が出ないまま**になる。
デバイスの側で手放せば、**アプリの再接続だけで戻せる**（電源を切らなくてよい）。

**根拠は「持ち主のアプリは接続したら必ず心拍を毎秒書く」という約束**
（`../../../../docs/interfaces/ble-gatt.md`「前提」）。裏を返すと、
**心拍を書かない接続は、定義上、持ち主のアプリではない。**

**BLE を知らない。** `LinkWatch` と同じで、時刻も状態も引数で受け取るので開発機の pytest で回せる
（`../../README.md`「それぞれの約束」）。実際に切るのは `hw/ble.py` 側。

**`alert.py` に置かなかったのは、ここが `state.py` の転送状態も見るため。**
あちらは「スマホが書いてきた1通」だけを入力にしてあり、混ぜると入口が広がる。
"""

from device.alert import Link
from device.state import TransferState


class IdleDisconnect:
    """心拍の来ない接続を切るべきかを決める。**切る操作はしない。**

    **`link` が `down` のまま続いた時間だけを見る。** `up` でも `nofix` でもない状態が
    `idle_ms` 続いたら、その接続は持ち主のものではないと見なす
    （`nofix` は測位が出ていないだけで、心拍そのものは届いている。**切らない**）。

    **時刻は引数で受け取る**（`alert.py` の `LinkWatch` と同じ理由）。
    中で `time` を呼ぶと、30 秒待たないとテストが書けない。
    """

    def __init__(self, *, idle_ms: int) -> None:
        """
        Args:
            idle_ms: `link` が `down` のままこれを超えて続いたら切る。
                **`LINK_BEAT_TIMEOUT_S` より十分長くすること** —— 心拍が1通遅れただけで
                接続ごと落とすと、持ち主のアプリが**つながっては切られるを繰り返す**
        """
        self._idle_ms = idle_ms
        # `down` が始まった時刻。**つながっていない間は `None`。**
        # つながる前から数え始めると、繋いだ瞬間に切ることになる。
        self._down_since_ms: int | None = None
        self._connected = False

    def on_connect(self, now_ms: int) -> None:
        """つながったときに呼ぶ。**数え直す。**"""
        self._connected = True
        self._down_since_ms = now_ms

    def on_disconnect(self) -> None:
        """切れたときに呼ぶ。**次につながるまで数えない。**"""
        self._connected = False
        self._down_since_ms = None

    def should_disconnect(self, *, link: Link, transfer_state: TransferState, now_ms: int) -> bool:
        """いま切るべきか。**周期的に呼ぶこと**（`link` が変わったときだけでは足りない）。

        **`sending` の間は切らないうえ、数え直す。** ログの転送中に切ると回収が途中で終わる。
        終わった瞬間に切るのも避けたい（取り込みの後始末が飛ぶ）ので、
        **転送が終わってから改めて `idle_ms` 待つ。**
        """
        if not self._connected:
            return False
        if transfer_state == "sending":
            # 転送している相手は、少なくとも `control` を書いている。放置ではない。
            self._down_since_ms = now_ms
            return False
        if link != "down":
            # 心拍が届いている。**`nofix` もここに入る**（測位が出ていないだけ）。
            self._down_since_ms = now_ms
            return False
        if self._down_since_ms is None:
            # つながったことを知らないまま `down` を見た。ここから数え始める。
            self._down_since_ms = now_ms
            return False
        if now_ms - self._down_since_ms <= self._idle_ms:
            return False
        # **答えたら数え直す。** そのまま `True` を返し続けると、切断が終わるまでの間
        # 毎秒 `Disconnect()` が積み上がる。かといって「一度答えたら二度と答えない」に
        # すると、**切るのに失敗したときに二度と試さなくなる**（相手はつないだまま残る）。
        # 数え直せば、失敗しても `idle_ms` 後にまた試す。
        self._down_since_ms = now_ms
        return True
