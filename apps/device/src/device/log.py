"""検知ログの保存（#40）。

**BLE を知らない。** レコードを積んで、番号で切り出して返すだけなので、開発機でも
pytest から回せる（`../../README.md`「それぞれの約束」）。流し方は `transfer.py`、
BLE の管は `hw/ble.py` 側にある。

**レコードの形の正本は `../../../../docs/interfaces/ble-log-transfer.md`。**
ここは形を作るだけで、何を入れるかを決め直さない。

**`log_id`（ログの世代）を持つのはここ**である。`identity.py` から移した——
**ログを消した・失ったときに `log_id` が変わらないと、セントラルは無効になった既読位置を
使い続ける**（つまり、以後の検知が1件も取り込まれない）。**持ち主と所有者を揃える。**

**デバイスはログを消さない。** 受け取った側（スマホ）が既読位置を持ち、こちらは
容量いっぱいのリングバッファとして持ち続ける（同ファイル「転送済みログの扱い」）。
"""

import json
import logging
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import TypeGuard

from device.identity import is_valid_id, new_id

logger = logging.getLogger(__name__)

# 種別。**いまは検知ログだけ**（`../../../../docs/interfaces/ble-log-transfer.md`）。
RECORD_TYPE = "detect"


@dataclass(frozen=True)
class LogRecord:
    """1レコード。**エンベロープ + 検知ログの `body`。**"""

    seq: int
    t: int
    # `t` が実測ではなく単調時計からの推定なら True。**JSON には True のときだけ出す。**
    t_est: bool
    kind: str
    lv: int

    def to_payload(self) -> dict[str, object]:
        """`log` に流す1行ぶんの JSON にする。"""
        payload: dict[str, object] = {"seq": self.seq, "type": RECORD_TYPE, "t": self.t}
        # **偽のときは項目ごと出さない**（正本の表が「`true` のときだけ入る」と決めている）。
        if self.t_est:
            payload["t_est"] = True
        payload["body"] = {"kind": self.kind, "lv": self.lv}
        return payload

    def to_line(self) -> bytes:
        """JSON Lines の1行（末尾の `\\n` を含む）。

        **`json.dumps` の既定のまま**にしてある——生の改行は `\\n` にエスケープされるので、
        **行の区切りとしての `\\n` と混ざらない**（同ファイル「`log`（Notify）」）。
        """
        text = json.dumps(self.to_payload(), separators=(",", ":"), ensure_ascii=False)
        return f"{text}\n".encode()


def _record_from(payload: object) -> LogRecord | None:
    """保存してある1行を読み直す。**読めなければ `None`**（その行だけ捨てる）。"""
    if not isinstance(payload, dict):
        return None
    body = payload.get("body")
    seq = payload.get("seq")
    t = payload.get("t")
    if not isinstance(body, dict) or not _is_int(seq) or not _is_int(t):
        return None
    kind = body.get("kind")
    lv = body.get("lv")
    if not isinstance(kind, str) or not _is_int(lv):
        return None
    return LogRecord(seq=seq, t=t, t_est=payload.get("t_est") is True, kind=kind, lv=lv)


def _is_int(value: object) -> TypeGuard[int]:
    """真偽値でない整数か（`alert.py` の `_is_int` と同じ理由）。"""
    return isinstance(value, int) and not isinstance(value, bool)


class LogStore:
    """検知ログを積む。**容量いっぱいになったら古いものから捨てる。**

    **`seq` は再起動をまたいで続く**（`log_id` が同じ間は 1 から単調増加する）。
    **次の番号は、レコードを書く前に保存する**——順序を逆にすると、落ちたときに
    **次の起動が同じ番号を別のレコードに振る。**一意キーが衝突し、あとから来た方が
    重複として無視されて、**実在する検知が黙って消える**
    （`../../../../docs/interfaces/ble-log-transfer.md`「転送済みログの扱い」）。
    先に保存すれば、落ちたときに番号が飛ぶだけで済む（飛びはセントラル側で扱える）。

    **どう転んでも例外を投げない。** 検知そのものは警告を出すためのもので、
    **記録できないことを理由に警告を止めない**（`identity.py` と同じ立場）。
    """

    def __init__(self, directory: Path, capacity: int) -> None:
        """
        Args:
            directory: `state.json` と `records.jsonl` を置く場所
            capacity: 持ち続けるレコードの数。超えたら古いものから捨てる
        """
        self._dir = directory
        self._state_path = directory / "state.json"
        self._records_path = directory / "records.jsonl"
        self._capacity = capacity
        self._records: deque[LogRecord] = deque(maxlen=capacity)
        # ファイルに書いた行数。**リングバッファから溢れても行は消えない**ので、
        # 溜まったら書き直して縮める（下の `_compact`）。
        self._lines = 0

        state = self._load_state()
        if state is None:
            # **世代を作り直す。**番号の続きが分からないまま同じ `log_id` で 1 から振ると、
            # 前の世代のレコードと一意キーがぶつかる（上のクラスの注記）。
            self._log_id = new_id()
            self._next_seq = 1
            self._reset_records()
            self._save_state()
            logger.warning(
                "検知ログの状態を読めなかった。世代を作り直す（log_id=%s）", self._log_id
            )
            return

        self._log_id, self._next_seq = state
        self._load_records()

    @property
    def log_id(self) -> str:
        """ログの世代（16進の小文字8文字）。"""
        return self._log_id

    @property
    def oldest_seq(self) -> int:
        """**今も持っている**一番古い番号。1件も無ければ 0。"""
        return self._records[0].seq if self._records else 0

    @property
    def latest_seq(self) -> int:
        """**今も持っている**一番新しい番号。1件も無ければ 0。"""
        return self._records[-1].seq if self._records else 0

    def append(self, *, kind: str, lv: int, t: int, t_est: bool) -> LogRecord:
        """レコードを1件積む。**番号を先に保存してから書く**（クラスの注記）。"""
        seq = self._next_seq
        self._next_seq = seq + 1
        self._save_state()

        record = LogRecord(seq=seq, t=t, t_est=t_est, kind=kind, lv=lv)
        self._records.append(record)
        self._write_line(record)
        return record

    def since(self, seq: int) -> list[LogRecord]:
        """`seq` より後のレコードを古い順に返す（`seq` が 0 なら持っているぶん全部）。"""
        return [record for record in self._records if record.seq > seq]

    def _load_state(self) -> tuple[str, int] | None:
        """`log_id` と次の番号を読む。**読めなければ `None`。**"""
        try:
            saved = json.loads(self._state_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as err:
            logger.error("%s を読めなかった（%s）", self._state_path, err)
            return None
        if not isinstance(saved, dict):
            return None
        log_id = saved.get("log_id")
        next_seq = saved.get("next_seq")
        if not is_valid_id(log_id) or not _is_int(next_seq) or next_seq < 1:
            return None
        return log_id, next_seq

    def _save_state(self) -> None:
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(
                json.dumps({"log_id": self._log_id, "next_seq": self._next_seq}),
                encoding="utf-8",
            )
        except OSError as err:
            # **記録できなくても走り続ける。**次の起動で世代が変わるだけで、
            # **警告そのものはデバイスの中で完結している**（`identity.py` と同じ立場）。
            logger.error("%s に保存できなかった（%s）", self._state_path, err)

    def _load_records(self) -> None:
        """保存してあるレコードを読み直す。**読めない行はその行だけ捨てる。**

        **1行壊れていても世代を作り直さない。** 電源が落ちた瞬間の最後の1行は
        途中で切れうるが、**番号の続きは `state.json` 側が持っている**ので、
        欠けたぶんは「飛び」としてセントラル側で扱える
        （`../../../../docs/interfaces/ble-log-transfer.md`「転送の約束」の 5）。
        """
        try:
            text = self._records_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except OSError as err:
            logger.error("%s を読めなかった（%s）。ログは空から始める", self._records_path, err)
            return

        broken = 0
        for line in text.splitlines():
            if not line:
                continue
            self._lines += 1
            try:
                payload = json.loads(line)
            except ValueError:
                broken += 1
                continue
            record = _record_from(payload)
            if record is None:
                broken += 1
                continue
            self._records.append(record)
        if broken:
            logger.warning("検知ログの %d 行を読めなかった（その行だけ捨てる）", broken)
        logger.info(
            "検知ログを %d 件読んだ（log_id=%s / %d〜%d）",
            len(self._records),
            self._log_id,
            self.oldest_seq,
            self.latest_seq,
        )

    def _write_line(self, record: LogRecord) -> None:
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            with self._records_path.open("ab") as handle:
                handle.write(record.to_line())
            self._lines += 1
        except OSError as err:
            logger.error("検知ログを書けなかった（%s）。この1件はメモリにしか残らない", err)
            return
        # **溢れたぶんはファイルにも残っている**ので、溜まったら書き直して縮める。
        # ponytail: 全件書き直し。容量の倍で1回なので、1件あたりは定数で収まる。
        if self._lines > self._capacity * 2:
            self._compact()

    def _compact(self) -> None:
        """いま持っているぶんだけを書き直す。"""
        try:
            with self._records_path.open("wb") as handle:
                for record in self._records:
                    handle.write(record.to_line())
            self._lines = len(self._records)
        except OSError as err:
            logger.error("検知ログを書き直せなかった（%s）。ファイルは伸び続ける", err)

    def _reset_records(self) -> None:
        try:
            self._records_path.unlink(missing_ok=True)
        except OSError as err:
            logger.error("%s を消せなかった（%s）", self._records_path, err)
