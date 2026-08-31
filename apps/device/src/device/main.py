"""起動と配線。

**ハードウェアに触るのはここと `hw/` だけ**（`../../README.md`）。
実機では `uv run python -m device.main`、電源投入時は systemd から起動される
（`../../../../docs/deploy-device.md`）。

いまつなぐのは BLE ペリフェラルだけ。センサー・表示・`alert` の受け取りは、
それぞれの Issue でここに1行ずつ足していく。
"""

import logging

from device import config, identity
from device.state import DeviceState

logger = logging.getLogger(__name__)


def main() -> None:
    """デバイスを起動する。BLE のイベントループに入ったまま戻らない。"""
    # 走行中は画面が無く、後から見る手段が journalctl しかない（`docs/deploy-device.md`）。
    # 時刻を必ず出す。
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    ident = identity.load_or_create(config.IDENTITY_PATH)
    state = DeviceState(device_id=ident.device_id, log_id=ident.log_id)
    local_name = identity.advertised_name(ident.device_id)
    logger.info("device_id=%s / 名前=%s で起動する", ident.device_id, local_name)

    # **ここで import する。** `hw/ble.py` は BlueZ を読むため、開発機では import した時点で落ちる。
    # ファイルの先頭に置くと、このモジュールを開発機から読むだけで失敗する。
    from device.hw import ble as ble_hw

    # bluezero が自分で足したハンドラを外す（外さないと journalctl に同じ行が2つ残る）。
    ble_hw.quiet_bluezero_loggers()

    ble = ble_hw.BlePeripheral(
        state,
        local_name,
        adapter_address=config.BLE_ADAPTER_ADDRESS,
        status_notify_interval_s=config.STATUS_NOTIFY_INTERVAL_S,
    )
    ble.start()


if __name__ == "__main__":
    main()
