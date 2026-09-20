"""transfer.py のテスト。BLE も実機も使わない。

**ここで確かめるのは「約束のうち、守らないと片方の実装が壊れること」**
（`docs/interfaces/ble-log-transfer.md`「転送の約束」）。
"""

import json
import logging
from pathlib import Path

import pytest

from device.log import LogStore
from device.state import DeviceState
from device.transfer import EOT, LogTransfer


def _setup(tmp_path: Path, records: int = 0) -> tuple[DeviceState, LogStore, LogTransfer]:
    store = LogStore(tmp_path, capacity=100)
    for i in range(records):
        store.append(kind="rear_object", lv=2, t=1_000 + i, t_est=False)
    state = DeviceState(device_id="c3f1a20b", log_id=store.log_id)
    return state, store, LogTransfer(state, store, fallback_chunk=20)


def _drain(transfer: LogTransfer) -> bytes:
    """送り切るまで塊を集める（実機では `hw/ble.py` のタイマーがこれを回す）。"""
    out = b""
    while (chunk := transfer.next_chunk()) is not None:
        out += chunk
    return out


def _read(since: int | None = None, mtu: int | None = 247) -> tuple[bytes, int | None]:
    body: dict[str, object] = {"cmd": "read"}
    if since is not None:
        body["since"] = since
    return json.dumps(body).encode("utf-8"), mtu


def test_全件を流して最後にEOTを送る(tmp_path: Path) -> None:
    state, _, transfer = _setup(tmp_path, records=3)
    payload, mtu = _read()

    assert transfer.handle_control(payload, mtu=mtu, can_notify=True).started
    stream = _drain(transfer)

    assert stream.endswith(EOT)
    lines = stream[: -len(EOT)].splitlines()
    assert [json.loads(line)["seq"] for line in lines] == [1, 2, 3]
    assert state.transfer_state == "idle"


def test_sinceより後だけを流す(tmp_path: Path) -> None:
    _, _, transfer = _setup(tmp_path, records=3)
    payload, mtu = _read(since=2)

    transfer.handle_control(payload, mtu=mtu, can_notify=True)
    stream = _drain(transfer)

    lines = stream[: -len(EOT)].splitlines()
    assert [json.loads(line)["seq"] for line in lines] == [3]


def test_0件でもEOTを送る(tmp_path: Path) -> None:
    # 送るものが無いことと、途中で止まったことを区別させる（完了の印は EOT だけ）。
    _, _, transfer = _setup(tmp_path)
    payload, mtu = _read()

    transfer.handle_control(payload, mtu=mtu, can_notify=True)

    assert _drain(transfer) == EOT


def test_塊はMTUマイナス3に収まる(tmp_path: Path) -> None:
    # 超えると BlueZ が黙って切り詰め、壊れた JSON が届く
    # （docs/interfaces/ble-log-transfer.md の 6）。
    _, _, transfer = _setup(tmp_path, records=5)
    payload, _ = _read()

    transfer.handle_control(payload, mtu=60, can_notify=True)
    chunks: list[bytes] = []
    while (chunk := transfer.next_chunk()) is not None:
        chunks.append(chunk)

    assert max(len(chunk) for chunk in chunks) == 60 - 3
    # 分かれて届いても、つなげば同じもの。
    assert b"".join(chunks).endswith(EOT)


def test_塊は512バイトを超えない(tmp_path: Path) -> None:
    """**MTU がいくら大きくても 512 バイトで頭打ち**（`transfer.MAX_ATT_VALUE`）。

    ATT の属性値の上限が 512 バイトなので、**`MTU - 3` がそれを超えても運ばれない。**
    超えて渡すと BlueZ が黙って切り、**塊の継ぎ目にまたがったレコードが1件ずつ消える**
    ——2026-09-20 に実機で踏んだ（MTU 517 で 22 件中 3 件が落ちた）。
    """
    _, _, transfer = _setup(tmp_path, records=40)
    payload, _ = _read()

    transfer.handle_control(payload, mtu=517, can_notify=True)
    chunks: list[bytes] = []
    while (chunk := transfer.next_chunk()) is not None:
        chunks.append(chunk)

    assert max(len(chunk) for chunk in chunks) == 512
    # **つなげば元のまま。**間引かれたぶんが出ないこと。
    assert b"".join(chunks).endswith(EOT)
    assert b"".join(chunks).count(b"\n") == 40


def test_MTUが分からなければ小さい方に倒す(tmp_path: Path) -> None:
    _, _, transfer = _setup(tmp_path, records=2)
    payload, _ = _read()

    transfer.handle_control(payload, mtu=None, can_notify=True)
    first = transfer.next_chunk()

    assert first is not None
    assert len(first) == 20


def test_転送中に増えたレコードは混ざらない(tmp_path: Path) -> None:
    # 「持っているぶん全部」にすると、走行中は終わりが来ないまま流し続けることになる
    # （EOT が出ないので、セントラルは永久に未完了と見なす）。
    _, store, transfer = _setup(tmp_path, records=2)
    payload, mtu = _read()

    transfer.handle_control(payload, mtu=mtu, can_notify=True)
    store.append(kind="rear_object", lv=2, t=9_999, t_est=False)
    stream = _drain(transfer)

    lines = stream[: -len(EOT)].splitlines()
    assert [json.loads(line)["seq"] for line in lines] == [1, 2]


def test_sending中のreadは断る(tmp_path: Path) -> None:
    # 受け付けると新旧のストリームが混ざり、古い方の EOT で新しい転送が完了したことになる。
    state, _, transfer = _setup(tmp_path, records=3)
    payload, mtu = _read()

    transfer.handle_control(payload, mtu=mtu, can_notify=True)
    second = transfer.handle_control(payload, mtu=mtu, can_notify=True)

    assert not second.started
    assert state.last_error == "sending"


def test_stopは止めてEOTを送らない(tmp_path: Path) -> None:
    # EOT の有無が「送り切った」と「途中でやめた」の区別になる。
    state, _, transfer = _setup(tmp_path, records=3)
    payload, mtu = _read()
    transfer.handle_control(payload, mtu=mtu, can_notify=True)
    transfer.next_chunk()

    transfer.handle_control(b'{"cmd":"stop"}', mtu=mtu, can_notify=True)

    assert state.transfer_state == "idle"
    assert transfer.next_chunk() is None
    # 止めたあとは `read` を受け付ける（断られ続けると二度と同期できない）。
    assert transfer.handle_control(payload, mtu=mtu, can_notify=True).started


def test_切断でidleに戻る(tmp_path: Path) -> None:
    # 戻さないと、同期中に落ちた端末はつなぎ直しても以後ずっと read を断られる。
    state, _, transfer = _setup(tmp_path, records=3)
    payload, mtu = _read()
    transfer.handle_control(payload, mtu=mtu, can_notify=True)

    transfer.abort()

    assert state.transfer_state == "idle"


def test_購読されていなければ断る(tmp_path: Path) -> None:
    # 流しても Notify の行き先が無く、セントラルは0件で終わったと見なす。
    state, _, transfer = _setup(tmp_path, records=1)
    payload, mtu = _read()

    outcome = transfer.handle_control(payload, mtu=mtu, can_notify=False)

    assert not outcome.started
    assert state.last_error == "log not subscribed"


def test_知らないコマンドと壊れたJSONは無視する(tmp_path: Path) -> None:
    state, _, transfer = _setup(tmp_path)

    assert not transfer.handle_control(b'{"cmd":"nuke"}', mtu=247, can_notify=True).started
    assert state.last_error is not None
    broken = "{壊れている".encode()
    assert not transfer.handle_control(broken, mtu=247, can_notify=True).started
    assert state.last_error == "bad json"
    assert state.transfer_state == "idle"


def test_readを受けたらlast_errorを消す(tmp_path: Path) -> None:
    # 残すと、前に断った理由が健全な転送中も表示され続け、成功した同期が失敗に見える。
    state, _, transfer = _setup(tmp_path, records=1)
    transfer.handle_control(b'{"cmd":"nuke"}', mtu=247, can_notify=True)
    payload, mtu = _read()

    transfer.handle_control(payload, mtu=mtu, can_notify=True)

    assert state.last_error is None


def test_進み具合がstatusに出る(tmp_path: Path) -> None:
    # 目安であって完了判定には使わせない（docs/interfaces/ble-gatt.md「`status`」）。
    state, _, transfer = _setup(tmp_path, records=3)
    payload, _ = _read()

    transfer.handle_control(payload, mtu=None, can_notify=True)
    assert (state.transfer_state, state.sent, state.remaining) == ("sending", 0, 3)
    _drain(transfer)

    assert (state.transfer_state, state.sent, state.remaining) == ("idle", 3, 0)


def test_送り切ったときに中止とログに出さない(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # デバイスの journal は実機で唯一の観測手段なので、成功した転送を「中止した」と
    # 記録しない（読む人の時間を奪う）。
    _, _, transfer = _setup(tmp_path, records=2)
    payload, mtu = _read()
    transfer.handle_control(payload, mtu=mtu, can_notify=True)

    with caplog.at_level(logging.INFO, logger="device.transfer"):
        _drain(transfer)

    assert "送り切った" in caplog.text
    assert "中止" not in caplog.text
