"""開発機を「ラズパイのふり」をする BLE ペリフェラルにする（実機の代わり）。

**実機が1台しかなく、届くまで待てないので用意した**（`../../../docs/adr/0002-development-lifecycle.md`）。
`uv run --group mock python tools/mock_peripheral.py` で動かすと、開発機が
**本物の BLE ペリフェラル**になり、Android のアプリから電波で本当につながる。

**判断のコードは本物をそのまま使う。** `state.py` / `alert.py` / `idle.py` は BLE を知らないので、
ここから import できる（`../README.md`「それぞれの約束」）。**差し替わるのは BLE の管だけ**で、
`status` の JSON も `link` の判定も、実機と同じものが動く。

## 何を確かめられて、何を確かめられないか

**確かめられる**——スキャンで見つかること、接続、MTU の要求、サービス探索、`device-info` の Read、
`status` の購読、`alert` への書き込み、`link` が `up` に上がること、そして
**心拍が止まったあとにアプリが自力で戻れること**（`docs/interfaces/ble-gatt.md`「前提」）。

**確かめられない**——**BlueZ の挙動**。相手が CoreBluetooth（macOS）や別の実装だからで、
`../../../docs/unverified.md` の 88（実機の BlueZ 相手に手順が通る）と
**91（デバイスが切ったあとアドバタイズが再開する）は、これでは消えない。**
44（bluezero が Read の `offset` を無視する）も再現されない。
**ここで通ることは、実機で通ることの根拠にならない。**

## 「デバイスが自分から切る」の再現について

**macOS のペリフェラルには、セントラルを切る API が無い**（CoreBluetooth の
`CBPeripheralManager` に該当するメソッドが無く、切断はセントラル側からしか起こせない）。

**`stop()` してサーバーを作り直すだけでは切れない。** 実際に試すと、アドバタイズは止まるのに
**リンクは生きたまま**残り、Android 側は「接続しています」と言い続けた。
`stop()` は `stopAdvertising()` を呼ぶだけだからである（upstream の
`corebluetooth/server.py` で確認）。

そこで**プロセスごと入れ替える**（`os.execv` で自分を起動し直す）。プロセスが終われば
CoreBluetooth の後始末でリンクが落ちる。**これが macOS でリンクを手放す唯一の道。**
`device_id` は `mock-identity.json` に残るので、入れ替わっても同じデバイスとして戻る。

仕組みは実機と違うが、**Android から見える出来事は同じ**（切断 → アドバタイズ再開）で、
確かめたいのは**アプリが立ち直れるか**なので目的を満たす。
"""

import asyncio
import contextlib
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from bless import (  # pyright: ignore[reportMissingImports]
    BlessGATTCharacteristic,
    BlessServer,
    GATTAttributePermissions,
    GATTCharacteristicProperties,
)

from device import config, identity
from device.alert import Beat, LinkWatch, Warn, parse_alert
from device.idle import IdleDisconnect
from device.state import DeviceState

logger = logging.getLogger("mock")

# UUID の正本は `../../../docs/interfaces/ble-gatt.md`。**ここで決め直さない。**
# `hw/ble.py` からは import しない —— あちらは BlueZ を読むので開発機では import できない。
SERVICE_UUID = "68666e00-58cc-4540-90ad-18bfae31615f"
DEVICE_INFO_UUID = "68666e01-58cc-4540-90ad-18bfae31615f"
STATUS_UUID = "68666e04-58cc-4540-90ad-18bfae31615f"
ALERT_UUID = "68666e06-58cc-4540-90ad-18bfae31615f"

# **本物の識別子と別のファイルに置く。** 同じにすると、開発機で模擬を動かしただけで
# 実機の `device_id` を上書きしうる（取り込みの一意キーが総入れ替えになる）。
MOCK_IDENTITY_PATH = Path.home() / ".local" / "share" / "bike-device" / "mock-identity.json"

# 切ると決めてから、プロセスを入れ替えるまでの間（秒）。
# **0 にしない** —— 最後の `status` を送り終える間を置く。
RESTART_PAUSE_S = 1


def _now_ms() -> int:
    """**単調時計**のミリ秒（`../src/device/main.py` と同じ理由）。"""
    return time.monotonic_ns() // 1_000_000


class MockDevice:
    """ラズパイのふりをする側。**BLE の管以外は実機と同じコードを呼ぶ。**"""

    def __init__(self) -> None:
        ident = identity.load_or_create(MOCK_IDENTITY_PATH)
        self.state = DeviceState(device_id=ident.device_id, log_id=ident.log_id)
        self.local_name = identity.advertised_name(ident.device_id)
        self.watch = LinkWatch(
            timeout_ms=config.LINK_BEAT_TIMEOUT_S * 1000,
            stall_window_ms=config.LINK_STALL_WINDOW_S * 1000,
            started_at_ms=_now_ms(),
        )
        self.idle = IdleDisconnect(idle_ms=config.IDLE_DISCONNECT_S * 1000)
        self._connected = False

    def on_read(self, characteristic: BlessGATTCharacteristic, **_: Any) -> bytearray:
        """Read されたら今の値を返す。**`hw/ble.py` の読み出しと同じ中身。**"""
        if characteristic.uuid.lower() == DEVICE_INFO_UUID:
            payload = self.state.device_info_bytes()
            logger.info("device-info を読まれた（%d バイト）", len(payload))
            return bytearray(payload)
        return bytearray(self.state.status_bytes())

    def on_write(self, characteristic: BlessGATTCharacteristic, value: Any, **_: Any) -> None:
        """`alert` に1通書かれた。**中身の解釈は `alert.py`**（実機と同じ道）。"""
        if characteristic.uuid.lower() != ALERT_UUID:
            return
        result = parse_alert(bytes(value))
        self.state.record_alert(result)
        if result.message is None:
            logger.warning("alert を捨てた: %s", result.reason)
            return
        if isinstance(result.message, Warn):
            logger.info("warn を受け取った: %s lv%d", result.message.kind, result.message.lv)
        if isinstance(result.message, Beat):
            # **`beat` はログに出さない**（毎秒来る。`../src/device/config.py`）。
            self.watch.record_beat(result.message, _now_ms())

    def tick(self) -> bool:
        """毎秒の見張り。**切るべきなら True を返す**（切るのは呼んだ側）。"""
        now_ms = _now_ms()
        status = self.watch.evaluate(now_ms)
        if status.link != self.state.link:
            logger.warning("link が %s → %s に変わった", self.state.link, status.link)
            self.state.link = status.link
        return self.idle.should_disconnect(
            link=self.state.link, transfer_state=self.state.transfer_state, now_ms=now_ms
        )

    def note_connection(self, connected: bool) -> None:
        """つながった / 切れたを `IdleDisconnect` に伝える。

        **bless の `is_connected()` は「購読している相手がいるか」**を見ている
        （upstream の `peripheral_manager_delegate.py` で確認）。持ち主のアプリは
        `status` を購読するので、これで足りる。**ただし、つないだだけで購読しない相手
        （nRF Connect など）はここに出てこない**——実機ではそういう相手も切る対象になる。
        """
        if connected == self._connected:
            return
        self._connected = connected
        if connected:
            logger.info("接続された（購読が始まった）")
            self.idle.on_connect(_now_ms())
        else:
            logger.info("切断された")
            self.idle.on_disconnect()


async def _build_server(device: MockDevice, loop: asyncio.AbstractEventLoop) -> BlessServer:
    """GATT を組み立てて、アドバタイズを始める。"""
    server = BlessServer(name=device.local_name, loop=loop)
    server.read_request_func = device.on_read
    server.write_request_func = device.on_write

    await server.add_new_service(SERVICE_UUID)
    await server.add_new_characteristic(
        SERVICE_UUID,
        DEVICE_INFO_UUID,
        GATTCharacteristicProperties.read,
        bytearray(device.state.device_info_bytes()),
        GATTAttributePermissions.readable,
    )
    await server.add_new_characteristic(
        SERVICE_UUID,
        STATUS_UUID,
        GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify,
        # **初期値を渡さない。** CoreBluetooth は値を持った characteristic を read-only と
        # みなし、notify や write を足すと `Characteristics with cached values must be
        # read-only` で組み立てに失敗する。読まれたら `on_read` が今の値を返す。
        None,
        GATTAttributePermissions.readable,
    )
    # **`write` だけを立てる**（`write_without_response` を立てない）。実機と同じ理由で、
    # 応答なしの書き込みは送信キューが埋まると黙って落ちる
    # （`../../../docs/interfaces/ble-gatt.md`「`alert`（Write）」）。
    await server.add_new_characteristic(
        SERVICE_UUID,
        ALERT_UUID,
        GATTCharacteristicProperties.write,
        None,  # 上と同じ理由
        GATTAttributePermissions.writeable,
    )
    await server.start()
    logger.info("アドバタイズを開始した（名前 %s）", device.local_name)
    return server


async def _serve_once(device: MockDevice, loop: asyncio.AbstractEventLoop) -> None:
    """つながって、心拍が止まって、切るまでを1回分。"""
    server = await _build_server(device, loop)
    try:
        while True:
            await asyncio.sleep(config.LINK_TICK_INTERVAL_S)
            device.note_connection(await server.is_connected())

            should_disconnect = device.tick()

            # `status` を毎秒送り直す。**変わったときだけ送らない**
            # （送る側が止まったことをセントラルが知る手段が無くなる。`../src/device/config.py`）。
            characteristic = server.get_characteristic(STATUS_UUID)
            if characteristic is not None:
                characteristic.value = bytearray(device.state.status_bytes())
                server.update_value(SERVICE_UUID, STATUS_UUID)

            if should_disconnect:
                logger.warning(
                    "心拍が来ないので、こちらから接続を切る（%d 秒）", config.IDLE_DISCONNECT_S
                )
                return
    finally:
        await server.stop()


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # bless と bleak は自前で大量に出すので黙らせる（読みたいのはこちらの行）。
    for name in ("bless", "bleak"):
        logging.getLogger(name).setLevel(logging.WARNING)

    device = MockDevice()
    logger.info("模擬デバイスを起動する: device_id=%s", device.state.device_id)
    logger.info("**これは実機ではない。** unverified.md の 88 / 91 はこれでは消えない")

    loop = asyncio.get_running_loop()
    await _serve_once(device, loop)

    # **プロセスごと入れ替える。** macOS のペリフェラルは相手を切れないので、
    # リンクを手放すにはプロセスを終わらせるしかない（このファイルの冒頭）。
    # `os.execv` なので、ここから先は戻ってこない。
    logger.info("%d 秒あけて、プロセスを入れ替える（リンクはここで落ちる）", RESTART_PAUSE_S)
    await asyncio.sleep(RESTART_PAUSE_S)
    os.execv(sys.executable, [sys.executable, *sys.argv])


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
