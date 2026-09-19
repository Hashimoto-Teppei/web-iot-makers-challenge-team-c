"""開発機を「ラズパイのふり」をする BLE ペリフェラルにする（実機の代わり）。

**実機が1台しかなく、届くまで待てないので用意した**（`../../../docs/adr/0002-development-lifecycle.md`）。
`uv run --group mock python tools/mock_peripheral.py` で動かすと、開発機が
**本物の BLE ペリフェラル**になり、Android のアプリから電波で本当につながる。

**判断のコードは本物をそのまま使う。** `state.py` / `alert.py` / `idle.py` は BLE を知らないので、
ここから import できる（`../README.md`「それぞれの約束」）。**差し替わるのは BLE の管だけ**で、
`status` の JSON も `link` の判定も、実機と同じものが動く。

## 何を確かめられて、何を確かめられないか

**確かめられる**——スキャンで見つかること、接続、MTU の要求、サービス探索、`device-info` の Read、
`status` の購読、`alert` への書き込み、`link` が `up` に上がること、
**検知ログの回収（`control` / `log`。#40）**、そして
**心拍が止まったあとにアプリが自力で戻れること**（`docs/interfaces/ble-gatt.md`「前提」）。

**後方物体センサーは無いので、検知はここが作る**（下の `MOCK_DETECT_INTERVAL_S`）。
**流す中身は本物のコード**（`log.py` / `transfer.py`）が組み立てるので、
レコードの形と EOT の位置は実機と同じものが届く。

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
`device_id` は固定、`log_id` と `seq` は `mock-log/` に残るので、
入れ替わっても同じデバイス・同じログの世代として戻る（既読位置が無効にならない）。

## なぜ `device_id` を固定しているか

**模擬でも、本物の BLE を通って本物の位置が流れる。**モバイル側は疑似ペリフェラルを
本物と区別できないので（実機の BLE を通っているため、区別できないのが正しい）、
**走行を終えた瞬間に、実際の緯度経度が共有の Cloudflare の D1 へ永久に入る**
——`POST /api/logs` の取り込みは**上書きも削除もできない**。

そこで**モバイル側の歯止めに掛かる ID を名乗る**（`../../mobile/src/lib/mock-guard.ts`）。
`uuid4()` から作ると実在しうる ID になり、**網に掛からない。**

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
from device.detect.rear_object import REAR_OBJECT_KIND
from device.idle import IdleDisconnect
from device.log import LogStore
from device.state import DeviceState
from device.transfer import LogTransfer
from device.tuning import Tuning

logger = logging.getLogger("mock")

# UUID の正本は `../../../docs/interfaces/ble-gatt.md`。**ここで決め直さない。**
# `hw/ble.py` からは import しない —— あちらは BlueZ を読むので開発機では import できない。
SERVICE_UUID = "68666e00-58cc-4540-90ad-18bfae31615f"
DEVICE_INFO_UUID = "68666e01-58cc-4540-90ad-18bfae31615f"
CONTROL_UUID = "68666e02-58cc-4540-90ad-18bfae31615f"
LOG_UUID = "68666e03-58cc-4540-90ad-18bfae31615f"
STATUS_UUID = "68666e04-58cc-4540-90ad-18bfae31615f"
ALERT_UUID = "68666e06-58cc-4540-90ad-18bfae31615f"
CONFIG_UUID = "68666e05-58cc-4540-90ad-18bfae31615f"

# **本物の識別子と別のファイルに置く。** 同じにすると、開発機で模擬を動かしただけで
# 実機の `log_id` を上書きしうる。
MOCK_IDENTITY_PATH = Path.home() / ".local" / "share" / "bike-device" / "mock-identity.json"

# 模擬の検知ログの置き場所（**本物と別**。同じにすると実機の `seq` を進めてしまう）。
MOCK_LOG_DIR = Path.home() / ".local" / "share" / "bike-device" / "mock-log"

# 模擬の検知を作る間隔（秒）。**後方物体センサーが無いので、ここが代わりに作る。**
# **短くしない** —— 実機の `cooldown_ms`（3 秒）より詰めると、アプリ側が受け取る量だけが
# 実機と違うものになる。
MOCK_DETECT_INTERVAL_S = 15

# **模擬が名乗る `device_id`。正本は `../../mobile/src/lib/mock-guard.ts` の
# `MOCK_PERIPHERAL_DEVICE_ID`。ここで決め直さない**（UUID と同じ扱い。
# Python から TypeScript は参照できない）。**変えるときは両方を揃える。**
MOCK_PERIPHERAL_DEVICE_ID = "a1000002"

# 切ると決めてから、プロセスを入れ替えるまでの間（秒）。
# **0 にしない** —— 最後の `status` を送り終える間を置く。
RESTART_PAUSE_S = 1


def _now_ms() -> int:
    """**単調時計**のミリ秒（`../src/device/main.py` と同じ理由）。"""
    return time.monotonic_ns() // 1_000_000


class MockDevice:
    """ラズパイのふりをする側。**BLE の管以外は実機と同じコードを呼ぶ。**"""

    def __init__(self) -> None:
        # **`device_id` はファイルから読まない。**歯止めに掛かる値を必ず名乗る
        # （上の「なぜ `device_id` を固定しているか」）。読むのは `log_id` だけ。
        identity.load_or_create(MOCK_IDENTITY_PATH)
        # **`log_id` と `seq` は本物の `LogStore` が持つ**（#40。`../src/device/log.py`）。
        self.store = LogStore(MOCK_LOG_DIR, config.LOG_CAPACITY)
        self.state = DeviceState(
            device_id=MOCK_PERIPHERAL_DEVICE_ID,
            log_id=self.store.log_id,
            oldest_seq=self.store.oldest_seq,
            latest_seq=self.store.latest_seq,
        )
        self.local_name = identity.advertised_name(MOCK_PERIPHERAL_DEVICE_ID)
        # 走行ごとのしきい値の上書き（#124）。**判定は `tuning.py`**（実機と同じ道）。
        self.tuning = Tuning(
            notify_config=config.NOTIFY_CONFIG,
            beat_timeout_s=config.LINK_BEAT_TIMEOUT_S,
            stall_window_s=config.LINK_STALL_WINDOW_S,
        )
        self.watch = LinkWatch(
            timeout_ms=self.tuning.beat_timeout_ms,
            stall_window_ms=self.tuning.stall_window_ms,
        )
        self.idle = IdleDisconnect(idle_ms=config.IDLE_DISCONNECT_S * 1000)
        # 検知ログの転送（#40）。**判断は本物のコード**（`../src/device/transfer.py`）。
        self.transfer = LogTransfer(
            self.state, self.store, fallback_chunk=config.LOG_FALLBACK_CHUNK
        )
        self._connected = False
        self._last_detect_ms: int | None = None

    def on_read(self, characteristic: BlessGATTCharacteristic, **_: Any) -> bytearray:
        """Read されたら今の値を返す。**`hw/ble.py` の読み出しと同じ中身。**"""
        if characteristic.uuid.lower() == DEVICE_INFO_UUID:
            payload = self.state.device_info_bytes()
            logger.info("device-info を読まれた（%d バイト）", len(payload))
            return bytearray(payload)
        return bytearray(self.state.status_bytes())

    def on_write(self, characteristic: BlessGATTCharacteristic, value: Any, **_: Any) -> None:
        """`alert` / `config` に1通書かれた。**中身の解釈は本物のコード**（実機と同じ道）。"""
        uuid = characteristic.uuid.lower()
        if uuid == CONFIG_UUID:
            self.apply_config(bytes(value))
            return
        if uuid == CONTROL_UUID:
            # **MTU を渡さない。** bless は書き込みの MTU を教えてくれないので、
            # 小さい方（既定の ATT_MTU）に倒れる——**遅いだけで、形は実機と同じ。**
            self.transfer.handle_control(bytes(value), mtu=None, can_notify=True)
            return
        if uuid != ALERT_UUID:
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

    def apply_config(self, raw: bytes) -> None:
        """`config` を1通取り込む。**`main.py` の `on_config` と同じことをする。**"""
        rejected = self.tuning.apply(raw)
        self.state.last_error = rejected.short if rejected is not None else None
        if rejected is not None:
            logger.warning("config を一部断った: %s", rejected.detail)
        self._push_tuning()
        logger.info("いま効いている上書き: %s", self.state.cfg or "なし（既定）")

    def _push_tuning(self) -> None:
        """上書きを `status` と `LinkWatch` の両方へ配る（`../src/device/main.py`）。"""
        self.state.cfg = self.tuning.cfg
        self.watch.set_timeouts(
            timeout_ms=self.tuning.beat_timeout_ms, stall_window_ms=self.tuning.stall_window_ms
        )

    def make_detection(self) -> None:
        """模擬の検知を1件作る。**実機では後方物体センサーがここに当たる。**

        **時刻の作り方は本物と同じ**（`LinkWatch.stamp()`）。一度も `beat` を
        受け取っていなければ作らない——足す先の `t` が無い
        （`docs/interfaces/ble-log-transfer.md`「検知ログの `body`」）。
        """
        now_ms = _now_ms()
        recent = self._last_detect_ms is not None and (
            now_ms - self._last_detect_ms < MOCK_DETECT_INTERVAL_S * 1000
        )
        if recent:
            return
        stamp = self.watch.stamp(now_ms)
        if stamp is None:
            return
        self._last_detect_ms = now_ms
        record = self.store.append(kind=REAR_OBJECT_KIND, lv=2, t=stamp.t, t_est=stamp.t_est)
        self.state.oldest_seq = self.store.oldest_seq
        self.state.latest_seq = self.store.latest_seq
        logger.info("模擬の検知を積んだ（seq=%d / t_est=%s）", record.seq, stamp.t_est)

    def tick(self) -> bool:
        """毎秒の見張り。**切るべきなら True を返す**（切るのは呼んだ側）。"""
        now_ms = _now_ms()
        self.make_detection()
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
            # **切断で転送を中止する**（`docs/interfaces/ble-gatt.md`「`control`」）。
            self.transfer.abort()
            # **切れたら既定へ戻す**（`../../../docs/interfaces/ble-gatt.md`「`config`」）。
            self.tuning.reset()
            self.state.last_error = None
            self._push_tuning()


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
    # `config`（#124）。**同じく `write` だけ**——断られたことが分からないと、
    # モバイルは書けたつもりで既定のまま走る。
    await server.add_new_characteristic(
        SERVICE_UUID,
        CONFIG_UUID,
        GATTCharacteristicProperties.write,
        None,  # 上と同じ理由
        GATTAttributePermissions.writeable,
    )
    # `control`（#40）。**同じく `write` だけ**——応答なしだと `stop` が届いたかを
    # セントラルが知れず、落ちればデバイスは送り続ける。
    await server.add_new_characteristic(
        SERVICE_UUID,
        CONTROL_UUID,
        GATTCharacteristicProperties.write,
        None,  # 上と同じ理由
        GATTAttributePermissions.writeable,
    )
    # `log`（#40）。**Notify だけ**——値は「最後に流した塊」でしかなく、
    # レコードの区切りは `\n` であってパケットの境目ではない。
    await server.add_new_characteristic(
        SERVICE_UUID,
        LOG_UUID,
        GATTCharacteristicProperties.notify,
        None,  # 上と同じ理由
        GATTAttributePermissions.readable,
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

            # 検知ログを流す（#40）。**1回の周期で送り切る**——実機は 20ms ごとに
            # 1塊だが、ここは毎秒の周期しか持っていない。**形（区切りと EOT）は同じ。**
            while (chunk := device.transfer.next_chunk()) is not None:
                log_characteristic = server.get_characteristic(LOG_UUID)
                if log_characteristic is None:
                    device.transfer.abort()
                    break
                log_characteristic.value = bytearray(chunk)
                server.update_value(SERVICE_UUID, LOG_UUID)

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
