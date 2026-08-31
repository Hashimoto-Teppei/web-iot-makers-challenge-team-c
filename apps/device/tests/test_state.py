"""state.py のテスト。BLE を使わないので開発機でも回せる。"""

import json

from device.alert import parse_alert
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


def test_採用したwarnだけをwarnsに数える() -> None:
    # warns は「警告が本当に届いているかを人が確かめるため」のもの
    # （docs/interfaces/ble-gatt.md「status」）。**人が見聞きしたものと数が一致する**方を採る。
    state = _state()

    state.record_alert(parse_alert(b'{"k":"warn","kind":"approach","lv":2}'))
    state.record_alert(parse_alert(b'{"k":"warn","kind":"brake","lv":3}'))

    assert state.warns == 2
    assert state.dropped == 0


def test_beatはwarnsに数えない() -> None:
    # 毎秒来るので、混ぜると警告が届いたかどうかが読み取れなくなる。
    state = _state()

    state.record_alert(parse_alert(b'{"k":"beat","t":1,"st":"ok"}'))

    assert state.warns == 0
    assert state.dropped == 0


def test_壊れたものだけをdroppedに数える() -> None:
    state = _state()

    state.record_alert(parse_alert(b"{"))  # 壊れた JSON
    state.record_alert(parse_alert(b'{"k":"warn","kind":"approach","lv":9}'))  # 範囲外

    assert state.dropped == 2
    assert state.warns == 0


def test_知らないkindはどちらにも数えない() -> None:
    # アプリ側が検知を1つ足しただけで dropped が増えると、
    # **異常に気づくための数として使えなくなる**（docs/interfaces/ble-gatt.md）。
    state = _state()

    state.record_alert(parse_alert(b'{"k":"warn","kind":"door","lv":1}'))

    assert state.warns == 0
    assert state.dropped == 0


def test_statusにwarnsとdroppedが出る() -> None:
    state = _state()
    state.record_alert(parse_alert(b'{"k":"warn","kind":"stop","lv":1}'))
    state.record_alert(parse_alert(b"["))

    payload = json.loads(state.status_bytes())

    assert payload["warns"] == 1
    assert payload["dropped"] == 1
    # alert の異常は last_error に載せない（毎秒流れるので転送の診断が上書きされる）。
    assert payload["last_error"] is None
