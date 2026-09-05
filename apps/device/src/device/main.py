"""起動と配線。

**ハードウェアに触るのはここと `hw/` だけ**（`../../README.md`）。
実機では `uv run python -m device.main`、電源投入時は systemd から起動される
（`../../../../docs/deploy-device.md`）。

いまつなぐのは BLE ペリフェラルと心拍のウォッチドッグ（#36）、
心拍の来ない接続を切る判定（#126）、警告の調停（#35。`notify.py`）、
走行ごとのしきい値の上書き（#124。`tuning.py`）。
センサーと表示は、それぞれの Issue でここに1行ずつ足していく。

**調停の結果を出す先はまだ無い。**`arbitrate()` は値を返すだけで、
それを鳴らす・光らせる `hw/` 側は部品が決まってから（#13）。
いまは journalctl に出しており、**繋がっていることはそこでしか確かめられない。**
"""

import logging
import time

from device import config, identity, notify
from device.alert import Beat, LinkStatus, LinkWatch, Warn
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
        started_at_ms=_now_ms(),
    )

    # 心拍の来ない接続をこちらから切る（#126）。**判定は `idle.py` の中。**
    # 他人がつなぎっぱなしにすると持ち主のスマホが接続できず、いまは電源を切るしか
    # 戻す方法がない（`../../../../docs/interfaces/ble-gatt.md`「前提」）。
    idle = IdleDisconnect(idle_ms=config.IDLE_DISCONNECT_S * 1000)

    # 発火中の警告と、鳴らし終えた鍵の集合（`../../../../docs/notifications/arbitration.md`）。
    # **どちらも `notify.py` が育てる値**で、ここは持ち回るだけ。**判定をここに書かない。**
    warnings: list[ActiveWarning] = []
    chimed: frozenset[str] = frozenset()
    # 直前に出した表示。**変わったときだけログに出す**ため（毎周期出すと journalctl が埋まる）。
    shown: tuple[str, str, LightPattern] | None = None

    def emit(now_ms: int, status: LinkStatus) -> None:
        """いま出すものを決めて、出す。**決めるのは `notify.py`** で、ここは渡すだけ。"""
        nonlocal chimed, shown
        output = notify.arbitrate(
            warnings,
            link=status.link,
            link_since_ms=status.since_ms,
            moving=status.moving,
            # 停止中に出す情報はまだ無い（走行の要約は #40 以降）。
            info=None,
            now_ms=now_ms,
            chimed=chimed,
            # **上書きの当たったものを渡す**（`tuning.py`）。`config.NOTIFY_CONFIG` を
            # 直に渡すと、`hold1`〜`hold3` を書いても保持時間が変わらない。
            config=tuning.notify_config,
        )
        # **返ってきた集合をそのまま次に渡す。** 中身を足したり引いたりしない。
        chimed = output.chimed

        # **出力先が無いので journalctl に出す**（#13 で `hw/` が入るまでの唯一の確認手段）。
        # `tone` は1周期に1つしか返らないイベントなので、出るたびに1行でよい。
        if output.tone is not None:
            logger.info("鳴らす: %s", output.tone)
        if (output.line1, output.line2, output.light) != shown:
            shown = (output.line1, output.line2, output.light)
            logger.info("表示: %r / %r / %s", output.line1, output.line2, output.light)

    def on_alert(message: Warn | Beat) -> None:
        # **`warn` を `watch` に渡さない。** 警告の到着を生存の根拠にすると、
        # 静かなときと落ちたときが区別できなくなる（`v2v.md`）。
        nonlocal warnings
        now_ms = _now_ms()
        if isinstance(message, Beat):
            watch.record_beat(message, now_ms)
        else:
            warnings = notify.merge_warning(warnings, message, now_ms, tuning.notify_config)
            # **周期を待たずにここで出す。** 待つと、届いてから鳴るまで最大1周期ぶん遅れる
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
        now_ms = _now_ms()
        status = watch.evaluate(now_ms)

        # **`push_status()` より先に出す。** 保持時間が切れたことも通信断のチャイムも
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
            # **人に見せるのはまだ journalctl と `status` だけ。**
            # ディスプレイ・ブザー・LED への出力は `notify.py`（部品が未確定 — #13）。
            # `status.moving` と `status.since_ms` はそこで使う。

        # **`link` が変わらなくてもここまで来ること。** 切る判定は「変わらないまま
        # 続いていること」を見るものなので、上の early return の中に置くと**永久に発火しない。**
        if idle.should_disconnect(
            link=state.link, transfer_state=state.transfer_state, now_ms=now_ms
        ):
            ble.disconnect_central()

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
