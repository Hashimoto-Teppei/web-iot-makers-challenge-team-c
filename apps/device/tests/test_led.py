"""LED（`hw/led.py`）のテスト。

**実機も gpiozero も要らない。** 偽の LED を渡して、どんな指示が出たかを記録する
（`../../../docs/adr/0002-development-lifecycle.md`）。

守っているものの正本は `../../../docs/notifications/arbitration.md`。
**ここで仕様を決め直さない。**
"""

import contextlib

from device.hw.led import Light, open_light
from device.notify import LIGHT_OFF, LightPattern

BLINK_SLOW = LightPattern(lit=True, blink_hz=0.5)
BLINK_FAST = LightPattern(lit=True, blink_hz=2.0)
SOLID = LightPattern(lit=True, blink_hz=None)


class FakeLed:
    """偽の LED。**言われたことを順番に記録するだけ。**"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, float, float, int | None]] = []

    def on(self) -> None:
        self.calls.append(("on", 0, 0, None))

    def off(self) -> None:
        self.calls.append(("off", 0, 0, None))

    def blink(self, on_time: float = 1, off_time: float = 1, n: int | None = None) -> None:
        self.calls.append(("blink", on_time, off_time, n))


def test_点灯と点滅と消灯がそのまま出る() -> None:
    led = FakeLed()
    light = Light(led)

    light.apply(SOLID)
    light.apply(BLINK_SLOW)
    light.apply(BLINK_FAST)
    light.apply(LIGHT_OFF)

    # 0.5Hz は 1 秒ずつ、2Hz は 0.25 秒ずつ（1周期の半分ずつ点く）。
    assert led.calls == [
        ("on", 0, 0, None),
        ("blink", 1.0, 1.0, None),
        ("blink", 0.25, 0.25, None),
        ("off", 0, 0, None),
    ]


def test_同じ状態が続く間は触らない() -> None:
    # **毎周期 `blink()` を呼び直すと点滅が最初からやり直しになる**（`hw/led.py`）。
    led = FakeLed()
    light = Light(led)

    light.apply(BLINK_FAST)
    light.apply(BLINK_FAST)
    light.apply(BLINK_FAST)

    assert led.calls == [("blink", 0.25, 0.25, None)]


def test_起動直後に1秒点灯してから消える() -> None:
    # これが無いと、**警告が出ていないのか LED が切れているのかを区別できない**
    # （`../../../docs/notifications/arbitration.md`「起動直後に、光っていることを確かめる」）。
    led = FakeLed()
    light = Light(led)

    light.selftest()

    assert led.calls == [("blink", 1.0, 0, 1)]


def test_起動直後の点灯は最初の消灯に切り上げられない() -> None:
    # 自己点検の直後に来るのはたいてい `LIGHT_OFF`（警告が無いため）。
    # ここで `off()` を送ると、**1秒のはずの点灯が最初の周期で終わる。**
    led = FakeLed()
    light = Light(led)

    light.selftest()
    light.apply(LIGHT_OFF)

    assert led.calls == [("blink", 1.0, 0, 1)]


def test_警告が来たら自己点検より警告を優先する() -> None:
    led = FakeLed()
    light = Light(led)

    light.selftest()
    light.apply(BLINK_FAST)

    assert led.calls == [("blink", 1.0, 0, 1), ("blink", 0.25, 0.25, None)]


def test_点滅の速さが_0_でも落ちない() -> None:
    # `config.py` は人が手で書き換える先。**書き間違いで毎周期落ちると LCD の更新まで止まる。**
    led = FakeLed()
    light = Light(led)

    light.apply(LightPattern(lit=True, blink_hz=0))

    assert led.calls == [("on", 0, 0, None)]


def test_GPIO_が_None_なら何も触らずに動く() -> None:
    # **実機も部品も持たない開発者がここで止まらないため**
    # （`../../../docs/adr/0002-development-lifecycle.md`）。
    light = open_light(None)

    light.selftest()
    light.apply(BLINK_FAST)
    light.apply(LIGHT_OFF)


def test_出せなかった状態は出したことにしない() -> None:
    # 先に覚えると、**その状態が続く限り二度と出し直さない**——`lv 3` が来ても光らないまま、
    # journalctl には `表示:` が出るので**ログ上は正常に見える**（`hw/led.py`）。
    class FlakyLed(FakeLed):
        broken = True

        def blink(self, on_time: float = 1, off_time: float = 1, n: int | None = None) -> None:
            if self.broken:
                raise OSError("GPIO に書けない")
            super().blink(on_time, off_time, n)

    led = FlakyLed()
    light = Light(led)

    with contextlib.suppress(OSError):
        light.apply(BLINK_FAST)
    led.broken = False
    light.apply(BLINK_FAST)

    assert led.calls == [("blink", 0.25, 0.25, None)]
