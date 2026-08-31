# pyright: reportMissingImports=false
"""BLE ペリフェラル（GATT サーバー + アドバタイズ）。

**Linux（BlueZ）専用。開発機では import した時点で落ちる**ので、
`main.py` の中から遅延 import する（`../../../README.md`「実機だけで要る依存」）。

**このファイルは判断しない。** 何を返すかは `../state.py` が決め、
ここは読まれたときにそれを渡すだけ（BLE の管に徹する）。

UUID とプロパティの正本は `../../../../../docs/interfaces/ble-gatt.md`。
いまあるのは `device-info` / `status` / `alert` で、`control` / `log` は #40 でここに足す。
"""

import logging
from collections.abc import Callable
from typing import Any

from bluezero import adapter, async_tools, peripheral

from device.alert import AlertResult, Beat, Warn, parse_alert
from device.state import DeviceState

logger = logging.getLogger(__name__)

SERVICE_UUID = "68666e00-58cc-4540-90ad-18bfae31615f"
DEVICE_INFO_UUID = "68666e01-58cc-4540-90ad-18bfae31615f"
STATUS_UUID = "68666e04-58cc-4540-90ad-18bfae31615f"
ALERT_UUID = "68666e06-58cc-4540-90ad-18bfae31615f"

# bluezero が GATT のツリーを組むための通し番号。UUID とは無関係で、この中でだけ使う。
_SRV_ID = 1
_CHR_DEVICE_INFO = 1
_CHR_STATUS = 2
_CHR_ALERT = 3


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
        """
        self._state = state
        self._interval_s = status_notify_interval_s
        self._drop_log_every = alert_drop_log_every
        self._on_alert = on_alert
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
        # **暗号化のフラグ（encrypt-*）を付けない。** ペアリングしない決定
        # （`../../../../../docs/interfaces/ble-gatt.md`「ペアリング・認証」）。

        self._peripheral.on_connect = self._on_connect
        self._peripheral.on_disconnect = self._on_disconnect

    def start(self) -> None:
        """アドバタイズを始め、イベントループに入る（戻らない）。"""
        logger.info("アドバタイズを開始する")
        self._peripheral.publish()

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
        logger.info("接続された: %s", remote)

    def _on_disconnect(self, adapter_address: str, device_address: str) -> None:
        # 接続が切れると BlueZ がアドバタイズを再開する（こちらで出し直さなくてよい）。
        # **`_status_chrc` は捨てない**（上の注記。捨てると再購読で戻ってこない）。
        logger.info("切断された: %s", device_address)
