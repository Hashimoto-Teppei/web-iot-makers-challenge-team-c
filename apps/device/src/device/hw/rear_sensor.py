# pyright: reportMissingImports=false
"""AE-NJR4265 J1 の接近検知出力を GPIO 1本で読む。

**判断しない**（`../../../README.md`「それぞれの約束」）。何 ms 続いたら接近とみなすかは
`../detect/rear_object.py` が決めており、ここは**いまの H / L を返すだけ**である。

**離反の出力（CN2 3番）は読まない。** 遠ざかる物体は危険ではない
（`../../../../../docs/hardware.md`）。

**gpiozero の import はこのファイルの先頭ではなく `open_rear_sensor()` の中**にある
（`led.py` と同じ理由——開発機に gpiozero は入らないが、pytest から import できる必要がある）。
"""

import logging
import threading
import time
from typing import Protocol

logger = logging.getLogger(__name__)


class PinInput(Protocol):
    """gpiozero の `InputDevice` のうち、ここで使う1つだけ。

    **テストは偽物を渡す**——実機が無くても読み取りを確かめられるようにするため。
    """

    @property
    def is_active(self) -> bool: ...


class RearSensor:
    """接近検知出力。**速く読んで掛け金に留め、周期処理が遅く取り出す。**

    **その場の値をそのまま返すと取りこぼす。** 2026-09-20 に実機で測ったところ、
    **人が動き続けている間もドップラーの出力は 0.2〜1.3 秒しか続かず、切れ目が入る**
    （`../../../../../docs/unverified.md` 103）。読むのは毎秒1回（`LINK_TICK_INTERVAL_S`）なので、
    **そのまま読むと H に当たるのは3〜4回に1回**で、検知が数秒遅れる。
    """

    def __init__(self, device: PinInput | None) -> None:
        # `None` は「そのセンサーが載っていない」という意味（`../config.py`）。
        self._device = device
        # 前回 `is_high()` を読んでから H を見たか。**`sample()` が立て、`is_high()` が倒す。**
        # **ロックを置かない** ——書くのは裏スレッド1つ、読むのは周期処理1つで、
        # どちらも `bool` の代入1つ（GIL の下で分割されない）。取りこぼしても次の周期で拾う。
        self._seen_high = False

    def sample(self) -> None:
        """いまの値を掛け金に写す。**`open_rear_sensor()` の裏スレッドが速く呼ぶ。**"""
        if self._device is not None and self._device.is_active:
            self._seen_high = True

    def is_high(self) -> bool:
        """**前回読んでから H が1度でもあったか。読んだら倒す。**

        **センサーが載っていなければ常に偽**（検知ごと動かない）。
        **ここでも1回読む** ——裏スレッドが無い経路（pytest / 起動直後）でも、
        いまの値だけは返るようにしておく。
        """
        if self._device is None:
            return False
        self.sample()
        seen = self._seen_high
        self._seen_high = False
        return seen


def open_rear_sensor(gpio: int | None) -> RearSensor:
    """`../config.py` の GPIO 番号から作る。**`None` ならこの検知ごと動かない。**

    **`None` で落ちないことが要件である**（`open_light()` と同じ。
    `../../../../../docs/adr/0002-development-lifecycle.md`）。
    """
    if gpio is None:
        return RearSensor(None)
    # **`DigitalInputDevice` を使わない。** あちらは `when_activated` のために
    # **エッジ検出を有効にし、その実装が sysfs の `/sys/class/gpio/export` を叩く**が、
    # **いまのカーネルに sysfs GPIO は無い** ——`OSError: [Errno 22] Invalid argument` になり、
    # **`main.py` の起動ごと止まる**（2026-09-19 に実機で踏んだ。
    # `../../../../../docs/unverified.md` 99）。
    # **ここは毎秒読むだけでエッジが要らない**ので、`InputDevice` で足りる。
    from gpiozero import InputDevice

    # **`pull_up=False`**（内部プルダウン）。**線が外れたときに L へ落ちる**ので、
    # 抜けたジャンパが「検知しっぱなし」に化けない。内部プルダウンの約 50kΩ は、
    # データシートが求める負荷抵抗 10k〜100kΩ の中に入る。H のときは VDD 近くまで出るので、
    # **VDD は 3.3V であること**（`../../../../../docs/hardware.md`）。
    sensor = RearSensor(InputDevice(gpio, pull_up=False))

    # **裏スレッドで速く読む。** 周期処理（毎秒）から読むだけでは、上のとおり取りこぼす。
    # **ここに判定を置かない** ——立てるのは「H を見た」という掛け金だけで、
    # 何 ms 続いたら接近かを決めるのは `../detect/rear_object.py` である。
    #
    # **`daemon=True`。** 落とす手順を持たないので、`main.py` が終わるときに道連れにする。
    # **0.1 秒は、いちばん短い H（実測 0.2 秒）の半分。** これより遅いとまた取りこぼす。
    thread = threading.Thread(target=_poll, args=(sensor,), daemon=True, name="rear-sensor")
    thread.start()
    return sensor


def _poll(sensor: RearSensor, interval_s: float = 0.1) -> None:
    """`sample()` を回し続ける。**例外で黙って止まらない**ように、読みは握って続ける。"""
    while True:
        try:
            sensor.sample()
        except Exception:  # noqa: BLE001 — 1回の読み取りの失敗で検知ごと止めない
            logger.exception("後方センサーの読み取りに失敗した")
        time.sleep(interval_s)
