"""state.py のテスト。BLE を使わないので開発機でも回せる。"""

import json

from device.state import PROTO_VERSION, DeviceState


def _state() -> DeviceState:
    return DeviceState(device_id="c3f1a20b", log_id="9a1c2b3d")


def test_device_infoは仕様の5項目を出す() -> None:
    # docs/interfaces/ble-gatt.md の device-info。モバイル側がこの形で読む。
    payload = json.loads(_state().device_info_bytes())

    assert payload == {
        "proto": PROTO_VERSION,
        "device_id": "c3f1a20b",
        "log_id": "9a1c2b3d",
        "oldest_seq": 0,
        "latest_seq": 0,
    }


def test_protoは2() -> None:
    # 上げるのは互換性を壊す変更のときだけ（docs/interfaces/ble-gatt.md）。
    # 意図せず動くとモバイルが接続を拒むので、値そのものを固定する。
    assert PROTO_VERSION == 2


def test_1件も持っていないときseqは両方0() -> None:
    payload = json.loads(_state().device_info_bytes())

    assert payload["oldest_seq"] == 0
    assert payload["latest_seq"] == 0


def test_statusは仕様の7項目を出す() -> None:
    payload = json.loads(_state().status_bytes())

    assert payload == {
        "state": "idle",
        "sent": 0,
        "remaining": 0,
        "last_error": None,
        "link": "down",
        "warns": 0,
        "dropped": 0,
    }


def test_心拍を受け取る経路が無いうちはlinkがdown() -> None:
    # 「つながっているのに警告が出ない」を健全に見せないため、up から始めない
    # （docs/interfaces/v2v.md「心拍を必ず見せる」）。
    assert json.loads(_state().status_bytes())["link"] == "down"


def test_JSONに空白を入れない() -> None:
    # 1回の Notify / Read に収めるため。MTU を超えたぶんは切り詰められる。
    payload = _state().status_bytes()

    assert b", " not in payload
    assert b": " not in payload


def test_statusは1回のNotifyに収まる大きさ() -> None:
    # MTU 247 でネゴシエートできた場合、1回で送れるのは 244 バイト
    # （docs/unverified.md の 13）。項目を足しすぎて超えると黙って切れる。
    state = DeviceState(
        device_id="c3f1a20b",
        log_id="9a1c2b3d",
        oldest_seq=999999,
        latest_seq=999999,
        transfer_state="sending",
        sent=999999,
        remaining=999999,
        last_error="unknown cmd",
        link="nofix",
        warns=999999,
        dropped=999999,
    )

    assert len(state.status_bytes()) <= 244
