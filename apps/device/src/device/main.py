"""起動と配線。

**ハードウェアに触るのはここと `hw/` だけ**（`../../README.md`）。
実機では `uv run python -m device.main`、電源投入時は systemd から起動される
（`../../../../docs/deploy-device.md`）。

いまつなぐのは BLE ペリフェラルと心拍のウォッチドッグ（#36）、
心拍の来ない接続を切る判定（#126）、警告の調停（#35。`notify.py`）、
後方物体検知（#152。`detect/rear_object.py` / `hw/rear_sensor.py`）、
走行ごとのしきい値の上書き（#124。`tuning.py`）、
調停の結果を LCD と LED ×2 に出すところ（#151。`hw/lcd.py` / `hw/led.py`）。
センサーは、それぞれの Issue でここに1行ずつ足していく。

**部品が載っているかどうかは `config.py` の値で決まる。** ピンやアドレスが `None` なら
その部品は無いものとして動くので、**実機も部品も持たない開発者でもここまで起動できる**
（`../../../../docs/adr/0002-development-lifecycle.md`）。
出したものは journalctl にも残す——**走行中に読めるのはそこだけ**である。
"""

import logging
import time

from device import config, identity, notify
from device.alert import Beat, LinkStatus, LinkWatch, Warn
from device.detect.rear_object import RearDetector
from device.hw.lcd import open_lcd
from device.hw.led import open_light
from device.hw.rear_sensor import open_rear_sensor
from device.idle import IdleDisconnect
from device.notify import ActiveWarning, LightPattern
from device.state import DeviceState
from device.tuning import Tuning

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
    # （`hw/lcd.py` と `hw/led.py` は先頭で import している——あちらは gpiozero と RPLCD を
    # 関数の中で読むので、**import しただけではハードウェアに触らない。**）
    from device.hw import ble as ble_hw

    # bluezero が自分で足したハンドラを外す（外さないと journalctl に同じ行が2つ残る）。
    ble_hw.quiet_bluezero_loggers()

    # 走行ごとのしきい値の上書き（#124）。**判定は `tuning.py` の中。**
    # **保存しない。**切断で既定へ戻すので、ここが覚えているのは接続の間だけである
    # （`../../../../docs/interfaces/ble-gatt.md`「`config`」）。
    tuning = Tuning(
        notify_config=config.NOTIFY_CONFIG,
        beat_timeout_s=config.LINK_BEAT_TIMEOUT_S,
        stall_window_s=config.LINK_STALL_WINDOW_S,
    )

    # 心拍のウォッチドッグ（`../../../../docs/interfaces/v2v.md`「心拍を必ず見せる」）。
    # **判定は `alert.py` の中**で、ここがやるのは「`beat` を渡す」「毎秒見る」「結果を
    # `state` に入れる」の3つだけ。**判定をここに書かない。**
    watch = LinkWatch(
        # **`config.py` の値を直に渡さない。**上書きされたら `beat_to` が効かなくなる
        # ——`tuning` が既定と上書きのどちらかを返す（起動時は既定）。
        timeout_ms=tuning.beat_timeout_ms,
        stall_window_ms=tuning.stall_window_ms,
    )

    # 心拍の来ない接続をこちらから切る（#126）。**判定は `idle.py` の中。**
    # 他人がつなぎっぱなしにすると持ち主のスマホが接続できず、いまは電源を切るしか
    # 戻す方法がない（`../../../../docs/interfaces/ble-gatt.md`「前提」）。
    idle = IdleDisconnect(idle_ms=config.IDLE_DISCONNECT_S * 1000)

    # 発火中の警告（`../../../../docs/notifications/arbitration.md`）。
    # **`notify.py` が育てる値**で、ここは持ち回るだけ。**判定をここに書かない。**
    warnings: list[ActiveWarning] = []
    # 直前に出した表示。**変わったときだけログに出す**ため（毎周期出すと journalctl が埋まる）。
    shown: tuple[str, str, LightPattern, LightPattern] | None = None

    # 出力先（#151）。**`config.py` の値が `None` なら、その部品は載っていないものとして動く。**
    # ピンとアドレスは `config.py` の末尾、配線の正本は `../../../../docs/hardware.md`。
    lcd = open_lcd(config.LCD_I2C_ADDRESS)
    warn_light = open_light(config.WARN_LIGHT_GPIO)
    link_light = open_light(config.LINK_LIGHT_GPIO)

    # **警告の LED が生きていることを見せる唯一の機会。** `link_light` は `link` が `down` から
    # 始まるので勝手に点滅するが、こちらは警告が来るまで消灯のままで、
    # **切れていても走り出すまで分からない**
    # （`../../../../docs/notifications/arbitration.md`「起動直後に、光っていることを確かめる」）。
    warn_light.selftest()

    # 後方物体検知（#152）。**デバイスに残る唯一の検知**で、BLE を通らない
    # （`../../../../docs/adr/0006-decision-layer-on-mobile.md`）。
    # **判定は `detect/rear_object.py` の中**で、ここがやるのは
    # 「毎周期読む」「出たら `warnings` に混ぜる」だけ。
    # `REAR_SENSOR_GPIO` が `None` なら常に偽が返り、**この検知ごと動かない。**
    rear_sensor = open_rear_sensor(config.REAR_SENSOR_GPIO)
    rear = RearDetector(config.REAR_CONFIG)

    def emit(now_ms: int, status: LinkStatus) -> None:
        """いま出すものを決めて、出す。**決めるのは `notify.py`** で、ここは渡すだけ。"""
        nonlocal shown
        output = notify.arbitrate(
            warnings,
            link=status.link,
            moving=status.moving,
            # 停止中に出す情報はまだ無い（走行の要約は #40 以降）。
            info=None,
            now_ms=now_ms,
            # **上書きの当たったものを渡す**（`tuning.py`）。`config.NOTIFY_CONFIG` を
            # 直に渡すと、`hold1`〜`hold3` を書いても保持時間が変わらない。
            config=tuning.notify_config,
        )

        # **走行中に読めるのは journalctl だけ**なので、出したものはここにも残す。
        # **4つとも状態**なので、変わったときだけ1行出せばよい。
        current = (output.line1, output.line2, output.warn_light, output.link_light)
        if current != shown:
            shown = current
            logger.info(
                "表示: %r / %r / 警告=%s / link=%s",
                output.line1,
                output.line2,
                output.warn_light,
                output.link_light,
            )

        # **部品に出す。決めるのは `notify.py` で、ここは渡すだけ**
        # （`../../../../docs/adr/0006-decision-layer-on-mobile.md`）。
        # **光を先に出す。** LCD は I2C なので線が緩めば例外で止まるが、
        # **走行中に届くのは光だけ**であり、それを画面の道連れにしない。
        warn_light.apply(output.warn_light)
        link_light.apply(output.link_light)
        lcd.show(output.line1, output.line2)

    def on_alert(message: Warn | Beat) -> None:
        # **`warn` を `watch` に渡さない。** 警告の到着を生存の根拠にすると、
        # 静かなときと落ちたときが区別できなくなる（`v2v.md`）。
        nonlocal warnings
        now_ms = _now_ms()
        if isinstance(message, Beat):
            watch.record_beat(message, now_ms)
        else:
            warnings = notify.merge_warning(warnings, message, now_ms, tuning.notify_config)
            # **周期を待たずにここで出す。** 待つと、届いてから光るまで最大1周期ぶん遅れる
            # ——`lv 3` は「いま避ける」ための警告なので、その1秒が意味を持つ。
            # `arbitrate()` が毎回1件を選び直すので、**先に出したせいで順位が狂うことはない。**
            emit(now_ms, watch.evaluate(now_ms))

    def apply_tuning() -> None:
        """上書きが変わったことを、値を持っている先へ配る。

        **`status` と `LinkWatch` の両方に配る。**片方だけにすると、
        **`cfg` には出ているのに効いていない**（またはその逆の）状態ができる。
        """
        state.cfg = tuning.cfg
        watch.set_timeouts(
            timeout_ms=tuning.beat_timeout_ms, stall_window_ms=tuning.stall_window_ms
        )

    def on_config(raw: bytes) -> None:
        # **判定は `tuning.py` の中。**ここは渡して、結果を配るだけ。
        rejected = tuning.apply(raw)
        # **成功したら消す。**`last_error` は「直近で断った書き込みの理由」であって、
        # 起動してから一度でも断ったことの記録ではない（`ble-gatt.md`「`status`」）。
        # **残すと、直したあともずっと赤い理由が出続ける**——`read` で消える経路は
        # まだ無い（#40）ので、消す場所はここしかない。
        # **断った理由は `last_error` へ。**`dropped` に混ぜない（あれは `alert` 用）。
        state.last_error = rejected.short if rejected is not None else None
        if rejected is not None:
            # **詳しい理由はログだけに出す。**`status` に載せると Read 1回に収まらない。
            logger.warning("config を一部断った: %s", rejected.detail)
        apply_tuning()
        logger.info("いま効いている上書き: %s", state.cfg or "なし（既定）")

    def on_disconnect() -> None:
        idle.on_disconnect()
        # **切れたら既定へ戻す**（`../../../../docs/interfaces/ble-gatt.md`「`config`」）。
        # 残すと、**次につないだ人が前の人の設定で走る。**
        tuning.reset()
        # **断った理由も持ち越さない。**次につないだ人に、前の人の失敗を見せない。
        state.last_error = None
        apply_tuning()

    def on_tick() -> None:
        # **`beat` が来たときではなく、周期で見る。** 来なくなったことに気づくのが目的なので、
        # 到着を起点にすると**永久に気づけない。**
        nonlocal warnings
        now_ms = _now_ms()
        status = watch.evaluate(now_ms)

        # **`push_status()` より先に出す。** 保持時間が切れたことも `link` が落ちたことも
        # `warn` の到着では起きないので、ここを通らない周期を作らない
        # ——後ろに置くと、`push_status()` が D-Bus で失敗した周期の警告ごと落ちる。
        emit(now_ms, status)

        if status.link != state.link:
            # **変わったときだけログに出す。** 毎秒出すと journalctl が心拍で埋まる
            # （`../config.py`）。
            logger.warning("link が %s → %s に変わった", state.link, status.link)
            state.link = status.link
            # 次の定期送信を待たずに知らせる。**落ちたことは早い方がよい。**
            ble.push_status()
            # **人に見せるのは上の `emit()` の側。** `link_light` と LCD の下段は
            # 毎周期そこから出ているので、ここで出し直さない。

        # **`link` が変わらなくてもここまで来ること。** 切る判定は「変わらないまま
        # 続いていること」を見るものなので、上の early return の中に置くと**永久に発火しない。**
        if idle.should_disconnect(
            link=state.link, transfer_state=state.transfer_state, now_ms=now_ms
        ):
            ble.disconnect_central()

        # **後方物体は `alert` ではなくここから入る**（BLE を通らないため）。
        # 入り口は違うが、**合流したあとは他の4つと同じ扱い**である
        # （`../../../../docs/notifications/arbitration.md`「優先順位」で先頭に置いてある）。
        #
        # **周期の最後に置く。** GPIO の読みが例外を出すと `_tick` がそれを握り潰すので、
        # 前に置くと**表示も `link` の判定も切断の判定も、その周期ごと落ちる**
        # （上の `emit()` と同じ理由——**走行中に届くのは光だけ**であり、
        # センサー1個の道連れにしない）。
        rear_warn = rear.update(rear_sensor.is_high(), now_ms)
        if rear_warn is not None:
            logger.info("後方に接近する物体を検知した（lv=%d）", rear_warn.lv)
            warnings = notify.merge_warning(warnings, rear_warn, now_ms, tuning.notify_config)
            # **周期を待たずにここで出す**（`on_alert` と同じ）。待つと、検知してから
            # 光るまで1周期ぶん遅れる。
            emit(now_ms, status)

    ble = ble_hw.BlePeripheral(
        state,
        local_name,
        adapter_address=config.BLE_ADAPTER_ADDRESS,
        status_notify_interval_s=config.STATUS_NOTIFY_INTERVAL_S,
        alert_drop_log_every=config.ALERT_DROP_LOG_EVERY,
        on_alert=on_alert,
        on_config=on_config,
        on_tick=on_tick,
        tick_interval_s=config.LINK_TICK_INTERVAL_S,
        tick_error_log_every=config.TICK_ERROR_LOG_EVERY,
        on_connect=lambda: idle.on_connect(_now_ms()),
        on_disconnect=on_disconnect,
    )
    ble.start()


if __name__ == "__main__":
    main()
