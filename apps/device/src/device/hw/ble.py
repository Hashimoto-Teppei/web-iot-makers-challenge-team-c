# pyright: reportMissingImports=false
"""BLE ペリフェラル（GATT サーバー + アドバタイズ）。

**Linux（BlueZ）専用。開発機では import した時点で落ちる**ので、
`main.py` の中から遅延 import する（`../../../README.md`「実機だけで要る依存」）。

**このファイルは判断しない。** 何を返すかは `../state.py` が決め、
ここは読まれたときにそれを渡すだけ（BLE の管に徹する）。

UUID とプロパティの正本は `../../../../../docs/interfaces/ble-gatt.md`、
検知ログの流し方は `../../../../../docs/interfaces/ble-log-transfer.md`。
**転送の判断は `../transfer.py`** で、ここは切り出された塊を Notify に載せるだけである。
"""

import logging
from collections.abc import Callable
from typing import Any

from bluezero import adapter, async_tools, peripheral

from device.alert import AlertResult, Beat, Warn, parse_alert
from device.idle import SingleCentral
from device.state import DeviceState
from device.transfer import LogTransfer

logger = logging.getLogger(__name__)

SERVICE_UUID = "68666e00-58cc-4540-90ad-18bfae31615f"
DEVICE_INFO_UUID = "68666e01-58cc-4540-90ad-18bfae31615f"
CONTROL_UUID = "68666e02-58cc-4540-90ad-18bfae31615f"
LOG_UUID = "68666e03-58cc-4540-90ad-18bfae31615f"
STATUS_UUID = "68666e04-58cc-4540-90ad-18bfae31615f"
CONFIG_UUID = "68666e05-58cc-4540-90ad-18bfae31615f"
ALERT_UUID = "68666e06-58cc-4540-90ad-18bfae31615f"

# bluezero が GATT のツリーを組むための通し番号。UUID とは無関係で、この中でだけ使う。
_SRV_ID = 1
_CHR_DEVICE_INFO = 1
_CHR_STATUS = 2
_CHR_ALERT = 3
_CHR_CONFIG = 4
_CHR_CONTROL = 5
_CHR_LOG = 6


def _first_adapter_address() -> str:
    """最初に見つかった Bluetooth アダプタのアドレスを返す。

    見つからないときに `IndexError` で落とさない。**走行中に読めるのは journalctl だけ**なので、
    何が起きたか分かる文言を残す（`../../../../../docs/deploy-device.md`）。
    起動が bluetooth より早い・アダプタが上がっていない、のどちらかで起こる。
    """
    adapters = list(adapter.Adapter.available())
    if not adapters:
        raise RuntimeError(
            "Bluetooth アダプタが見つからない（bluetooth サービスが上がっているか確認する）"
        )
    return adapters[0].address


def quiet_bluezero_loggers() -> None:
    """bluezero が自分で足したハンドラを外す。

    bluezero は各モジュールのロガーに `StreamHandler` を足したうえで `propagate` を切らないため、
    `logging.basicConfig()` と合わせると **journalctl に同じ行が2つ**残る（SD カードへの
    書き込みも倍になる）。こちらの書式に寄せる。
    """
    for name, obj in logging.Logger.manager.loggerDict.items():
        if name.startswith("bluezero") and isinstance(obj, logging.Logger):
            obj.handlers.clear()


class BlePeripheral:
    """デバイスを BLE ペリフェラルとして公開する。

    `start()` はイベントループに入ったまま戻らない（Ctrl-C で抜ける。
    systemd から止めるときは SIGTERM でプロセスごと終わる）。
    """

    def __init__(
        self,
        state: DeviceState,
        local_name: str,
        *,
        adapter_address: str | None = None,
        status_notify_interval_s: int = 1,
        alert_drop_log_every: int = 100,
        on_alert: Callable[[Warn | Beat], None] | None = None,
        on_config: Callable[[bytes], None] | None = None,
        transfer: LogTransfer | None = None,
        log_chunk_interval_ms: int = 20,
        on_tick: Callable[[], None] | None = None,
        tick_interval_s: int = 1,
        tick_error_log_every: int = 60,
        on_connect: Callable[[], None] | None = None,
        on_disconnect: Callable[[], None] | None = None,
    ) -> None:
        """
        Args:
            state: 読み出しのたびに今の値を聞く状態。**数えるのはここ**（`record_alert`）
            local_name: アドバタイズに載せる名前（`bg-a20b` の形、7文字）
            adapter_address: 使うアダプタ。None なら最初に見つかったもの
            status_notify_interval_s: status を Notify で送り直す間隔（秒）
            alert_drop_log_every: 同じ理由で `alert` を捨て続けたとき、何通に1行ログを出すか
            on_alert: `alert` で受け取って**採用した**1通を渡す先。
                心拍のウォッチドッグ（#36）と警告の調停（`notify.py`）がここにつながる。
                None なら数えるだけで捨てる
            on_config: `config` に書かれたバイト列を渡す先（#124）。
                **中身の解釈はここでしない**（`../tuning.py`）。None なら捨てる
            transfer: 検知ログの転送（#40）。**判断はあちら**で、ここは
                切り出された塊を Notify に載せるだけ。None なら `control` を断る
            log_chunk_interval_ms: `log` に1塊ずつ流す間隔（ミリ秒）。
                **まとめて送らずに間隔を空ける**——`set_value()` は D-Bus のシグナルを
                出すだけなので、**詰め込むと BlueZ が送り出す前に次が重なりうる**。
                **`alert` と周期処理を止めない**ためでもある（同じイベントループの上）
            on_tick: 一定間隔で呼ぶ先。**何も届かなくても呼ばれる**ので、
                心拍が途切れたことに気づけるのはここだけ（`../alert.py` の `LinkWatch`）。
                None なら呼ばない
            tick_interval_s: `on_tick` を呼ぶ間隔（秒）
            tick_error_log_every: `on_tick` が例外で落ち続けるとき、何回に1本ログを出すか
            on_connect: セントラルがつないできたときに呼ぶ先。
                **受け入れたときだけ呼ぶ**（2台目は切るので呼ばない。`../idle.py` の
                `SingleCentral`）。**相手が誰かは渡さない** —— 受け入れるのは1台だけなので、
                区別する相手がいない
            on_disconnect: **主が**切れたときに呼ぶ先。
                **主でない相手の切断では呼ばない** —— 呼ぶと、2台目が切れただけで
                主の設定が既定へ戻る（`main.py` の `on_disconnect`）
        """
        self._state = state
        self._interval_s = status_notify_interval_s
        self._drop_log_every = alert_drop_log_every
        self._on_alert = on_alert
        self._on_config = on_config
        self._transfer = transfer
        self._log_chunk_interval_ms = log_chunk_interval_ms
        self._on_tick = on_tick
        self._tick_interval_s = tick_interval_s
        self._tick_error_log_every = tick_error_log_every
        self._on_connect_cb = on_connect
        self._on_disconnect_cb = on_disconnect
        # いまつながっている相手。**心拍の来ない接続を切るために持つ**（`../idle.py`）。
        # bluezero は引数が1つのコールバックに `device.Device` を渡す
        # （upstream の `adapter.py` `_properties_changed` で確認済み）。
        self._remote: Any | None = None
        # つながってよいのは1台だけ。**誰を主にするかの判断は `../idle.py` 側**で、
        # ここは言われたとおりに切るだけである（このファイルは判断しない）。
        self._central = SingleCentral()
        # 周期処理が例外で落ちた回数。**毎回ログに出さないため**（`_tick`）。
        self._tick_errors = 0
        # 直近で捨てた理由と、そのあと同じ理由で捨てた数。**毎通ログに出さないため**（下）。
        self._last_drop_reason: str | None = None
        self._drop_repeats = 0
        # 購読が始まったときに bluezero から渡される Characteristic。一度受け取ったら**捨てない。**
        # 切断や購読解除のたびに None へ戻すと、**再購読で戻ってこない。**
        # bluezero の `StartNotify` は `Notifying` が既に True なら何もせずに返り、
        # `notify_callback` を呼ばないため。送ってよいかは `is_notifying` で毎回見る。
        self._status_chrc: Any | None = None
        # status を送るタイマーが動いているか。**購読し直すたびに足すと重なる** ——
        # 走行中に接続が切れて戻るのは普通に起きるので、そのたびに毎秒の送信が1本増える。
        self._status_timer_running = False
        # `log` の Characteristic（購読されたときに bluezero から渡される）。
        # **`status` と同じく、一度受け取ったら捨てない**（上の注記）。
        self._log_chrc: Any | None = None
        # 流すタイマーが動いているか。**`read` のたびに足すと重なる**（`status` と同じ）。
        self._log_timer_running = False

        address = adapter_address or _first_adapter_address()
        logger.info("アダプタ %s でペリフェラルを作る（名前 %s）", address, local_name)

        # **appearance を渡さない。** アドバタイズの余白は1バイトしかなく、Appearance を足すと
        # 31 バイトを超えて **Local Name が黙って切り詰められる**
        # （`../../../../../docs/interfaces/ble-gatt.md`「UUID」）。
        # 同じ理由で Includes（tx-power）と ServiceData も設定しない。
        self._peripheral = peripheral.Peripheral(address, local_name=local_name)

        self._peripheral.add_service(srv_id=_SRV_ID, uuid=SERVICE_UUID, primary=True)
        self._peripheral.add_characteristic(
            srv_id=_SRV_ID,
            chr_id=_CHR_DEVICE_INFO,
            uuid=DEVICE_INFO_UUID,
            value=[],
            notifying=False,
            flags=["read"],
            read_callback=self._read_device_info,
            write_callback=None,
            notify_callback=None,
        )
        self._peripheral.add_characteristic(
            srv_id=_SRV_ID,
            chr_id=_CHR_STATUS,
            uuid=STATUS_UUID,
            value=[],
            notifying=False,
            flags=["read", "notify"],
            read_callback=self._read_status,
            write_callback=None,
            notify_callback=self._on_status_subscribed,
        )
        # **`write` だけを立てて `write-without-response` を立てない。**
        # 応答なしの書き込みは送信キューが埋まると**黙って落ちる**ため、
        # セントラルに Write Request を使わせる（`../../../../../docs/interfaces/ble-gatt.md`
        # 「`alert`（Write）」）。**警告が落ちたことが分かる方を選ぶ。**
        self._peripheral.add_characteristic(
            srv_id=_SRV_ID,
            chr_id=_CHR_ALERT,
            uuid=ALERT_UUID,
            value=[],
            notifying=False,
            flags=["write"],
            read_callback=None,
            write_callback=self._on_alert_write,
            notify_callback=None,
        )
        # **`config` も同じく `write` だけ。** 断られたことが分からないと、
        # モバイルは**書けたつもりで既定のまま走る**
        # （`../../../../../docs/interfaces/ble-gatt.md`「`config`（Write）」）。
        self._peripheral.add_characteristic(
            srv_id=_SRV_ID,
            chr_id=_CHR_CONFIG,
            uuid=CONFIG_UUID,
            value=[],
            notifying=False,
            flags=["write"],
            read_callback=None,
            write_callback=self._on_config_write,
            notify_callback=None,
        )
        # **`control` も `write` だけ。** 応答なしだと `stop` が届いたかをセントラルが
        # 知れず、**落ちればデバイスは送り続ける**
        # （`../../../../../docs/interfaces/ble-gatt.md`「`control`（Write）」）。
        self._peripheral.add_characteristic(
            srv_id=_SRV_ID,
            chr_id=_CHR_CONTROL,
            uuid=CONTROL_UUID,
            value=[],
            notifying=False,
            flags=["write"],
            read_callback=None,
            write_callback=self._on_control_write,
            notify_callback=None,
        )
        # **`log` は Notify だけ。** Read を足さない——値は「最後に流した塊」でしかなく、
        # **読めると、読んだ側が途中の1塊をレコードとして扱いうる**
        # （レコードの区切りは `\n` であって、パケットの境目ではない）。
        self._peripheral.add_characteristic(
            srv_id=_SRV_ID,
            chr_id=_CHR_LOG,
            uuid=LOG_UUID,
            value=[],
            notifying=False,
            flags=["notify"],
            read_callback=None,
            write_callback=None,
            notify_callback=self._on_log_subscribed,
        )
        # **暗号化のフラグ（encrypt-*）を付けない。** ペアリングしない決定
        # （`../../../../../docs/interfaces/ble-security.md`「ペアリング・認証」）。

        self._peripheral.on_connect = self._on_connect
        self._peripheral.on_disconnect = self._on_disconnect

    def start(self) -> None:
        """アドバタイズを始め、イベントループに入る（戻らない）。"""
        if self._on_tick is not None:
            # **`publish()` の前に登録してよい。** bluezero の `add_timer_seconds` は
            # `GLib.timeout_add_seconds` を呼ぶだけで、**タイマーは登録した時点で既定の
            # main context に付く**（動き出すのはループが回り始めてから）。
            #
            # **`status` の購読タイマーと同じ仕組みだが、別に持つ。**
            # あちらは購読されている間しか回らない ——
            # **セントラルがつながっていない間こそ `link` は `down` である**べきなので、
            # 購読に相乗りさせると**一番出したい状態のときに止まる。**
            async_tools.add_timer_seconds(self._tick_interval_s, self._tick)
        logger.info("アドバタイズを開始する")
        self._peripheral.publish()

    def _tick(self) -> bool:
        """一定間隔で `on_tick` を呼ぶ。**True を返して回り続ける。**

        **ここから例外を出さない。** 抜けると GLib がこのタイマーを外し、
        **心拍のウォッチドッグが二度と回らないまま、表示は最後の値のまま残る**
        （`../../../../../docs/adr/0006-decision-layer-on-mobile.md` が一番恐れた
        「静かに止まる」そのもの）。False を返さないのも同じ理由。
        """
        try:
            if self._on_tick is not None:
                self._on_tick()
        except Exception:
            # **毎回は出さない。** 周期は毎秒なので、つないだ先が恒常的に落ちていると
            # トレースバックで journalctl が埋まり、**`link` が変わったという一番読みたい行が
            # その中に消える**（`_record_drop` と同じ理由）。1本目は必ず出す。
            if self._tick_errors % self._tick_error_log_every == 0:
                logger.exception(
                    "周期処理で例外が出た（%d 回目。この回は飛ばす）", self._tick_errors + 1
                )
            self._tick_errors += 1
        return True

    def push_status(self) -> None:
        """今の `status` を購読しているセントラルへ送る。

        購読されていなければ何もしない（Notify の送り先が無いだけで、異常ではない）。
        `link` が落ちたときなど、**次の定期送信を待たずに知らせたい側**が呼ぶ。
        """
        chrc = self._status_chrc
        if chrc is None or not chrc.is_notifying:
            return
        chrc.set_value(list(self._state.status_bytes()))

    def _read_device_info(self) -> list[int]:
        payload = self._state.device_info_bytes()
        logger.info("device-info を読まれた（%d バイト）", len(payload))
        return list(payload)

    def _read_status(self) -> list[int]:
        return list(self._state.status_bytes())

    def _on_status_subscribed(self, notifying: bool, characteristic: Any) -> None:
        """セントラルが `status` の Notify を購読した / やめたときに呼ばれる。"""
        # **外れても参照は持ったままにする**（上の `_status_chrc` の注記）。
        # 送ってよいかは `is_notifying` で毎回見るので、持っていても誤って送らない。
        self._status_chrc = characteristic
        if not notifying:
            logger.info("status の購読が外れた")
            return

        logger.info("status を購読された")
        if self._status_timer_running:
            return
        # 定期的に送り直す。**変化したときだけ送る作りにしない** —— 送る側が止まったことを
        # セントラルが知る手段が無くなる（`../config.py`）。
        self._status_timer_running = True
        async_tools.add_timer_seconds(self._interval_s, self._on_status_timer, characteristic)

    def _on_status_timer(self, characteristic: Any) -> bool:
        """一定間隔で `status` を送る。False を返すとタイマーが止まる。"""
        if not characteristic.is_notifying:
            self._status_timer_running = False
            return False
        characteristic.set_value(list(self._state.status_bytes()))
        return True

    def _on_alert_write(self, value: bytearray, options: dict[str, Any]) -> None:
        """セントラルが `alert` に1通書いたときに呼ばれる。

        bluezero は D-Bus の `ay` を **`bytearray`** にして渡す
        （`bluezero/dbus_tools.py` の `dbus_to_python`。署名が `y` の配列だけ特別扱いされる）。
        **中身の解釈はここでしない** —— `../alert.py` に渡し、ここは受け取って数えるところまで
        （BLE の管に徹する）。

        **ここから例外を出さない。** 送出すると bluezero の `WriteValue` を抜けて
        dbus-python が ATT のエラー応答に変えるため、
        **その1通だけでなく以降の Write も失敗し続ける。**
        `alert` はデバイスが警告を出せる唯一の入口なので、そこで警告が止まる
        （`../../../../../docs/adr/0006-decision-layer-on-mobile.md`）。
        """
        # **分割された Write を1通として読まない。** MTU を上げずにつなぐと（既定の ATT_MTU 23 →
        # 1回 20 バイト）、50 バイトを超える `beat` は BlueZ から **offset 付きで複数回**渡される。
        # 気づかずに読むと全部 JSON として壊れ、**「届いていない」ではなく「壊れている」に見える。**
        # セントラルは MTU 247 を要求する約束だが（`../../../../../docs/interfaces/ble-gatt.md`
        # 「接続してから転送するまで」）、**nRF Connect のような手動のツールは上げてくれない。**
        # **すべてを try の中に置く。** 一部でも外に出すと、そこで出た例外が
        # そのまま bluezero を抜けてしまい、上の約束が守れない。
        try:
            offset = options.get("offset", 0)
            if offset:
                result = AlertResult(
                    None, dropped=True, reason=f"分割されて届いた（offset={offset}）"
                )
            else:
                result = parse_alert(bytes(value))

            self._state.record_alert(result)
            if result.message is None:
                self._record_drop(result)
                return

            # **`beat` をログに出さない。** 毎秒1通来るので、走行1時間で数千行になり、
            # SD カードへの書き込みと journalctl の見通しの両方を潰す
            # （`../config.py` と同じ理由）。届いているかは `status` の `warns` で見る。
            if isinstance(result.message, Warn):
                logger.info("warn を受け取った: %s lv%d", result.message.kind, result.message.lv)
            if self._on_alert is not None:
                # **渡す先で何が起きても、この経路は止めない。** #36 のウォッチドッグと
                # `notify.py` がここにつながるので、
                # あちらの不具合が `alert` 全体を殺さないようにする。
                self._on_alert(result.message)
        except Exception:
            logger.exception("alert の処理で例外が出た（この1通は捨てる）")

    def _on_config_write(self, value: bytearray, options: dict[str, Any]) -> None:
        """セントラルが `config` に1通書いたときに呼ばれる（#124）。

        **中身の解釈はここでしない** —— `../tuning.py` に渡し、ここは管に徹する
        （`_on_alert_write` と同じ）。

        **ここから例外を出さない。** 送出すると bluezero の `WriteValue` を抜けて
        dbus-python が ATT のエラー応答に変えるため、**以降の Write も失敗し続ける**
        ——**同じ接続の `alert` まで巻き込む**ので、設定を1回間違えただけで警告が止まる。

        **`dropped` に数えない。** あれは `alert` で壊れているものを数える箱で、
        混ぜると**警告の異常に気づくための数として使えなくなる**
        （`../../../../../docs/interfaces/ble-gatt.md`「`status`」）。
        断った理由は `last_error` に載る（`../main.py`）。
        """
        try:
            # **分割された Write を1通として読まない**（`_on_alert_write` と同じ理由）。
            # 上書きは高々4キーで 60 バイト程度だが、**MTU を上げずに繋ぐツールでは
            # 20 バイトずつに割れる**ので、黙って壊れた JSON として扱わない。
            offset = options.get("offset", 0)
            if offset:
                logger.warning("config が分割されて届いた（offset=%d）。この1通は捨てる", offset)
                return
            logger.info("config を受け取った（%d バイト）", len(value))
            if self._on_config is not None:
                self._on_config(bytes(value))
        except Exception:
            logger.exception("config の処理で例外が出た（この1通は捨てる）")

    def _on_control_write(self, value: bytearray, options: dict[str, Any]) -> None:
        """セントラルが `control` に1通書いたときに呼ばれる（#40）。

        **中身の解釈はここでしない** —— `../transfer.py` に渡し、ここは管に徹する
        （`_on_alert_write` と同じ）。**ここから例外を出さない**のも同じ理由で、
        送出すると**同じ接続の `alert` まで巻き込む**（警告が止まる）。

        **MTU はここで拾う。** BlueZ 5.62 以降は書き込みの `options` に `mtu` を入れて
        渡してくるので、**D-Bus へ別途聞きに行かなくてよい**（実機は 5.82。
        `../../../../../docs/unverified.md` 15）。**取れなければ小さい方に倒す**
        ——大きく見積もると BlueZ が黙って切り詰め、**壊れた JSON が届く。**
        """
        try:
            offset = options.get("offset", 0)
            if offset:
                # **分割された Write を1通として読まない**（`_on_alert_write` と同じ理由）。
                logger.warning("control が分割されて届いた（offset=%d）。この1通は捨てる", offset)
                return
            if self._transfer is None:
                return

            mtu = options.get("mtu")
            outcome = self._transfer.handle_control(
                bytes(value),
                mtu=mtu if isinstance(mtu, int) else None,
                can_notify=self._log_chrc is not None and self._log_chrc.is_notifying,
            )
            # **断った理由も、始まったことも `status` に出す。**次の定期送信を待つと、
            # **人は「書いたのに何も起きない」時間を見ることになる。**
            self.push_status()
            if outcome.started:
                self._start_log_timer()
        except Exception:
            logger.exception("control の処理で例外が出た（この1通は捨てる）")

    def _on_log_subscribed(self, notifying: bool, characteristic: Any) -> None:
        """セントラルが `log` の Notify を購読した / やめたときに呼ばれる。"""
        # **外れても参照は持ったままにする**（`_status_chrc` と同じ）。
        self._log_chrc = characteristic
        logger.info("log の購読が%s", "始まった" if notifying else "外れた")

    def _start_log_timer(self) -> None:
        """流すタイマーを回し始める。**既に回っていれば足さない。**"""
        if self._log_timer_running:
            return
        self._log_timer_running = True
        async_tools.add_timer_ms(self._log_chunk_interval_ms, self._pump_log)

    def _pump_log(self) -> bool:
        """`log` に1塊だけ流す。**False を返すとタイマーが止まる。**

        **1回に1塊だけ。** 送り切るまで回し続けると、その間**`alert` も周期処理も
        動けない**（同じイベントループの上にある）——警告の出口と心拍の見張りが、
        ログの回収に巻き込まれて止まる。

        **ここから例外を出さない**（`_tick` と同じ）。抜けるとタイマーが外れ、
        **`sending` のまま二度と進まない転送が残る。**
        """
        try:
            chrc = self._log_chrc
            transfer = self._transfer
            if transfer is None or chrc is None or not chrc.is_notifying:
                # **購読が外れたら中止する。**流し先が無いまま `sending` を続けない。
                if transfer is not None:
                    transfer.abort()
                self._log_timer_running = False
                self.push_status()
                return False

            chunk = transfer.next_chunk()
            if chunk is None:
                self._log_timer_running = False
                # **送り切ったことを `status` にも出す**（完了の印は EOT の側で、
                # これは人が見るためのもの）。
                self.push_status()
                return False
            chrc.set_value(list(chunk))
            return True
        except Exception:
            logger.exception("検知ログを流せなかった（転送を中止する）")
            if self._transfer is not None:
                self._transfer.abort()
            self._log_timer_running = False
            return False

    def _record_drop(self, result: AlertResult) -> None:
        """捨てたことをログに出す。**同じ理由が続く間は間引く。**

        理由は `status` に載せられない（`alert` は毎秒流れるので、`last_error` に入れると
        転送を断った理由が毎秒上書きされる。`../../../../../docs/interfaces/ble-gatt.md`「`status`」）。
        **journalctl だけが理由を知る手段**になるが、毎通出すと `beat` を出さないことにした理由
        （SD への書き込みと見通し）をここで自分から壊すことになる ——
        **`st` の綴りを1つ間違えたアプリは毎秒ここへ来る。**
        """
        reason = result.reason
        if reason != self._last_drop_reason:
            self._last_drop_reason = reason
            self._drop_repeats = 0
            logger.warning("alert を捨てた（dropped=%s）: %s", result.dropped, reason)
            return

        self._drop_repeats += 1
        if self._drop_repeats % self._drop_log_every == 0:
            logger.warning("alert を捨て続けている（%d 通目）: %s", self._drop_repeats + 1, reason)

    def _on_connect(self, remote: Any) -> None:
        # **アドレスは1回だけ読む。** `device.Device.address` は**読むたびに D-Bus を叩く**ので、
        # 持ち回さずにここで文字列にする。
        #
        # **大文字小文字を正規化しない。** `on_connect` に来るアドレスも `on_disconnect` に
        # 来るアドレスも、**どちらも BlueZ が返す大文字**である（upstream の
        # `bluezero/adapter.py` と `dbus_tools.get_device_address_from_dbus_path`）。
        address = str(remote.address)
        # **受け入れてよいかはここで決めない**（`../idle.py` の `SingleCentral`。先着優先）。
        if not self._central.accept(address):
            # **2台目。つないでから切るしか手が無い** —— アドバタイズを止めても、
            # アドレスを知っていれば接続できる
            # （`../../../../../docs/interfaces/ble-gatt.md`「前提」）。
            logger.warning("2台目を切る（主は %s）: %s", self._central.owner, address)
            try:
                remote.disconnect()
            except Exception:
                # **主の接続を巻き添えにしない。** 切れなくても、こちらは主を持ったまま動き続ける
                # （`disconnect_central` と同じ理由で、例外を外に出さない）。
                #
                # **切れなかった相手を追いかける仕組みは持たない。** つないだままになるが、
                # **持ち主は別に受け入れられる**（主が去れば `accept` が通る）ので、
                # **警告が出なくなることはない。** 追うには2台目も持ち回ることになり、
                # 「つながるのは1台」という前提そのものを崩す。
                logger.exception("2台目を切れなかった（主の接続はそのまま続ける）")
            return
        logger.info("接続された: %s", remote)
        # **持っておく。** 心拍の来ない接続をこちらから切るのに要る（`disconnect_central`）。
        # **主のものしか入らない**ので、切るつもりで持ち主を切ることはない。
        self._remote = remote
        if self._on_connect_cb is not None:
            self._on_connect_cb()

    def _on_disconnect(self, adapter_address: str, device_address: str) -> None:
        # 接続が切れると BlueZ がアドバタイズを再開する（こちらで出し直さなくてよい）。
        # **こちらから切ったときも再開するかは実機で未確認**
        # （`../../../../../docs/unverified.md` 91。bluezero は `publish()` で1回
        # `register_advertisement` を呼ぶだけで、切断のたびに登録し直さない）。
        # **外れていたらここで登録し直す。**
        # **`_status_chrc` は捨てない**（上の注記。捨てると再購読で戻ってこない）。
        if not self._central.release(device_address):
            # **主でない相手が切れただけ。** ここで片付けると、**2台目が切れただけで
            # 主の転送が止まり、設定が既定へ戻る**（これが #184 で直したかったもの）。
            logger.info("主でない相手が切れた（何もしない）: %s", device_address)
            return
        logger.info("切断された: %s", device_address)
        self._remote = None
        # **切断で転送を中止し、`idle` に戻す**（`../../../../../docs/interfaces/ble-gatt.md`
        # 「`control`」）。戻さないと、**同期中に落ちた端末はつなぎ直しても
        # 以後ずっと `read` を断られる。**
        if self._transfer is not None:
            self._transfer.abort()
        if self._on_disconnect_cb is not None:
            self._on_disconnect_cb()

    def disconnect_central(self) -> None:
        """いまつながっている相手をこちらから切る。

        **切るかどうかはここで決めない**（`../idle.py` の `IdleDisconnect`）。
        ここは言われたとおりに `org.bluez.Device1.Disconnect()` を呼ぶだけ。

        **例外を外に出さない。** 呼ぶのは毎秒の周期処理の中なので、
        ここで送出すると**心拍のウォッチドッグごとタイマーが外れる**（`_tick` の注記）。
        """
        remote = self._remote
        if remote is None:
            return
        # **失敗しても手放さない。** 切れていなければ相手はつないだままなので、
        # もう一度試せる相手を捨てない（切れれば `_on_disconnect` が None に戻す）。
        # 何度も投げ続けないようにするのは `../idle.py` 側の仕事。
        try:
            logger.warning("心拍が来ないので、こちらから接続を切る")
            remote.disconnect()
        except Exception:
            logger.exception("接続を切れなかった（アドバタイズはそのまま続ける）")
