"""起動と配線。

**ハードウェアに触るのはここと `hw/` だけ**（`../../README.md`）。
実機では `uv run python -m device.main`、電源投入時は systemd から起動される
（`../../../../docs/deploy-device.md`）。

いまつなぐのは BLE ペリフェラルと心拍のウォッチドッグ（#36）。
センサー・表示と、警告の調停（`notify.py`）は、それぞれの Issue でここに1行ずつ足していく。
"""

import logging
import time

from device import config, identity
from device.alert import Beat, LinkWatch, Warn
from device.state import DeviceState

logger = logging.getLogger(__name__)


def _now_ms() -> int:
    """**単調時計**のミリ秒。

    **壁時計（`time.time()`）を使わない。** デバイスに RTC は無く、起動のたびに 1970 年から
    始まったり、NTP が合った瞬間に数十年ぶん飛んだりする。**飛んだ瞬間に「心拍が
    何十年も途切れている」ことになり、`link` が `down` に落ちる。**
    `beat` の `t` も使えない（あれはスマホの壁時計で、経過時間の計測には使えない。
    `../../../../docs/interfaces/v2v.md`）。
    """
    return time.monotonic_ns() // 1_000_000


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

    # 心拍のウォッチドッグ（`../../../../docs/interfaces/v2v.md`「心拍を必ず見せる」）。
    # **判定は `alert.py` の中**で、ここがやるのは「`beat` を渡す」「毎秒見る」「結果を
    # `state` に入れる」の3つだけ。**判定をここに書かない。**
    watch = LinkWatch(
        timeout_ms=config.LINK_BEAT_TIMEOUT_S * 1000,
        stall_window_ms=config.LINK_STALL_WINDOW_S * 1000,
        started_at_ms=_now_ms(),
    )

    def on_alert(message: Warn | Beat) -> None:
        # **`warn` は渡さない。** 警告の到着を生存の根拠にすると、
        # 静かなときと落ちたときが区別できなくなる（`v2v.md`）。
        # `warn` の行き先は `notify.py`（未実装）。
        if isinstance(message, Beat):
            watch.record_beat(message, _now_ms())

    def on_tick() -> None:
        # **`beat` が来たときではなく、周期で見る。** 来なくなったことに気づくのが目的なので、
        # 到着を起点にすると**永久に気づけない。**
        status = watch.evaluate(_now_ms())
        if status.link == state.link:
            return
        # **変わったときだけログに出す。** 毎秒出すと journalctl が心拍で埋まる（`../config.py`）。
        logger.warning("link が %s → %s に変わった", state.link, status.link)
        state.link = status.link
        # 次の定期送信を待たずに知らせる。**落ちたことは早い方がよい。**
        ble.push_status()
        # **人に見せるのはまだ journalctl と `status` だけ。**
        # ディスプレイ・ブザー・LED への出力は `notify.py`（部品が未確定 — #13）。
        # `status.moving` と `status.since_ms` はそこで使う。

    ble = ble_hw.BlePeripheral(
        state,
        local_name,
        adapter_address=config.BLE_ADAPTER_ADDRESS,
        status_notify_interval_s=config.STATUS_NOTIFY_INTERVAL_S,
        alert_drop_log_every=config.ALERT_DROP_LOG_EVERY,
        on_alert=on_alert,
        on_tick=on_tick,
        tick_interval_s=config.LINK_TICK_INTERVAL_S,
        tick_error_log_every=config.TICK_ERROR_LOG_EVERY,
    )
    ble.start()


if __name__ == "__main__":
    main()
