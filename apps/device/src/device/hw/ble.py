# pyright: reportMissingImports=false
"""BLE ペリフェラル（GATT サーバー + アドバタイズ）。

**Linux（BlueZ）専用。開発機では import した時点で落ちる**ので、
`main.py` の中から遅延 import する（`../../../README.md`「実機だけで要る依存」）。

**このファイルは判断しない。** 何を返すかは `../state.py` が決め、
ここは読まれたときにそれを渡すだけ（BLE の管に徹する）。

UUID とプロパティの正本は `../../../../../docs/interfaces/ble-gatt.md`。
この Issue（#37）で作るのは `device-info` と `status` だけで、
`control` / `log` は #40、`alert` は #35 でここに足す。
"""

import logging
from typing import Any

from bluezero import adapter, async_tools, peripheral

from device.state import DeviceState

logger = logging.getLogger(__name__)

SERVICE_UUID = "68666e00-58cc-4540-90ad-18bfae31615f"
DEVICE_INFO_UUID = "68666e01-58cc-4540-90ad-18bfae31615f"
STATUS_UUID = "68666e04-58cc-4540-90ad-18bfae31615f"

# bluezero が GATT のツリーを組むための通し番号。UUID とは無関係で、この中でだけ使う。
_SRV_ID = 1
_CHR_DEVICE_INFO = 1
_CHR_STATUS = 2


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
    ) -> None:
        """
        Args:
            state: 読み出しのたびに今の値を聞く状態。**ここでは書き換えない**
            local_name: アドバタイズに載せる名前（`bg-a20b` の形、7文字）
            adapter_address: 使うアダプタ。None なら最初に見つかったもの
            status_notify_interval_s: status を Notify で送り直す間隔（秒）
        """
        self._state = state
        self._interval_s = status_notify_interval_s
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

    def _on_connect(self, remote: Any) -> None:
        logger.info("接続された: %s", remote)

    def _on_disconnect(self, adapter_address: str, device_address: str) -> None:
        # 接続が切れると BlueZ がアドバタイズを再開する（こちらで出し直さなくてよい）。
        # **`_status_chrc` は捨てない**（上の注記。捨てると再購読で戻ってこない）。
        logger.info("切断された: %s", device_address)
