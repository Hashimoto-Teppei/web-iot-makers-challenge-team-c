"""デバイスの状態と、それを `device-info` / `status` の JSON にする変換。

**BLE を知らない。** ここは `hw/ble.py` の外にあり、開発機でも pytest から呼べる
（`../../README.md`「それぞれの約束」）。`hw/ble.py` は「今の JSON をください」と呼ぶだけで、
中身の意味を知らない。

**項目の意味の正本は `../../../../docs/interfaces/ble-gatt.md`。**
ここは形を作るだけで、何を入れるかを決め直さない。
"""

import json
from dataclasses import dataclass
from typing import Literal

# この境界のプロトコルバージョン。**この境界のバージョンはこれ1つ**で、
# alert に別の番号を持たせない。
# 上げるのは互換性を壊す変更のときだけ（`../../../../docs/interfaces/ble-gatt.md`）。
PROTO_VERSION = 2

TransferState = Literal["idle", "sending"]
Link = Literal["up", "nofix", "down"]


@dataclass
class DeviceState:
    """今のデバイスの状態。

    **この Issue（#37）で埋まるのは `device_id` / `log_id` と `state` だけ。**
    `link` は #36（心拍のウォッチドッグ）、`warns` / `dropped` は #35（`alert`）、
    `sent` / `remaining` / `oldest_seq` / `latest_seq` / `last_error` は #40（ログの転送）で埋まる。
    **埋まる前から項目を出しておく**のは、セントラル側が形を先に実装できるようにするため
    （知らないキーは無視する約束なので、後から増えても壊れない）。
    """

    device_id: str
    log_id: str
    # 持っているレコード番号の範囲。1件も持っていないときは両方 0（seq は 1 から始まる）。
    oldest_seq: int = 0
    latest_seq: int = 0
    # 転送の状態。JSON では `state` だが、Python 側では何の状態か分かる名前にする。
    transfer_state: TransferState = "idle"
    sent: int = 0
    remaining: int = 0
    # 直近で断った**コマンド（control）**の理由。alert の異常はここに入れない（dropped に数える）。
    last_error: str | None = None
    # スマホから心拍が届いているか。まだ受け取る経路が無いので down から始める。
    link: Link = "down"
    warns: int = 0
    dropped: int = 0

    def device_info(self) -> dict[str, object]:
        """`device-info` で返す内容。"""
        return {
            "proto": PROTO_VERSION,
            "device_id": self.device_id,
            "log_id": self.log_id,
            "oldest_seq": self.oldest_seq,
            "latest_seq": self.latest_seq,
        }

    def status(self) -> dict[str, object]:
        """`status` で返す内容。"""
        return {
            "state": self.transfer_state,
            "sent": self.sent,
            "remaining": self.remaining,
            "last_error": self.last_error,
            "link": self.link,
            "warns": self.warns,
            "dropped": self.dropped,
        }

    def device_info_bytes(self) -> bytes:
        """`device-info` の Read で返すバイト列。"""
        return _compact(self.device_info())

    def status_bytes(self) -> bytes:
        """`status` の Read / Notify で返すバイト列。"""
        return _compact(self.status())


def _compact(payload: dict[str, object]) -> bytes:
    """JSON を隙間なく1行にして UTF-8 で返す。

    **空白を入れない**のは、1回の Read / Notify に収めるため。
    ネゴシエートされた MTU を超えたぶんは切り詰められる
    （`../../../../docs/unverified.md` の 13 / 44）。
    """
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
