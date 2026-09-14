# pyright: reportMissingImports=false
"""LED 1個。`notify.py` が返した `LightPattern` をそのまま光にする。

**判断しない**（`../../../README.md`「それぞれの約束」）。どの `lv` で何 Hz にするかは
`../config.py` の表が決めており、ここは**渡された状態を出すだけ**である。

**点滅のために眠らない。** `time.sleep()` で点滅させると、その間 `main.py` の周期処理が
止まり、**BLE の心拍が途切れてアプリからは「デバイスが落ちた」に見える**
（`../../../../../docs/interfaces/v2v.md`）。眠らせずに済むよう、点滅は gpiozero の
`blink()`（自前の裏スレッドで回り、すぐ戻る）に任せる。

**gpiozero の import はこのファイルの先頭ではなく `open_light()` の中**にある。
開発機（Windows / macOS）に gpiozero は入らないが、**このモジュールは pytest から
import できる必要がある**（`../../../../../docs/adr/0008-device-dependencies.md`）。
"""

from typing import Protocol

from device.notify import LIGHT_OFF, LightPattern


class LedDevice(Protocol):
    """gpiozero の `LED` のうち、ここで使う3つだけ。

    **テストは偽物を渡す**——実機が無くても点滅の指示を確かめられるようにするため
    （`../../../../../docs/adr/0002-development-lifecycle.md`）。
    """

    def on(self) -> None: ...

    def off(self) -> None: ...

    def blink(self, on_time: float = 1, off_time: float = 1, n: int | None = None) -> None: ...


class Light:
    """`LightPattern` を1個の LED に出す。

    **直前と同じ状態なら触らない。** `arbitrate()` は毎周期**現在値**を返すので、
    毎回 `blink()` を呼び直すと**そのたびに点滅が最初からやり直しになり**、
    消えている位相で呼ばれ続けると人には消灯に見える。
    """

    def __init__(self, led: LedDevice | None) -> None:
        # `None` は「その LED が載っていない」という意味（`../config.py`）。
        self._led = led
        self._shown: LightPattern | None = None

    def selftest(self, seconds: float = 1.0) -> None:
        """起動時に1秒だけ点灯して消す。**光っていることを人に見せる唯一の機会。**

        `link_light` は `link` が `down` から始まるので勝手に点滅するが、
        **`warn_light` は警告が来るまで消灯のまま**で、
        **切れているのか警告が無いのかを誰も区別できない**
        （`../../../../../docs/notifications/arbitration.md`「起動直後に、光っていることを確かめる」）。

        **ここでも眠らない。** `blink()` の1回だけの点滅に任せる（`off_time` は使われない）。
        """
        # 終わったとき消えているので、**次に来る消灯で LED を触り直さない**
        # ——触ると、この1秒が最初の周期で切り上げられる。
        self._shown = LIGHT_OFF
        if self._led is not None:
            self._led.blink(on_time=seconds, off_time=0, n=1)

    def apply(self, pattern: LightPattern) -> None:
        """いまの状態を出す。**毎周期呼んでよい**（変わったときだけ LED を触る）。"""
        if pattern == self._shown:
            return
        if self._led is not None:
            if not pattern.lit:
                self._led.off()
            elif pattern.blink_hz is None or pattern.blink_hz <= 0:
                # **0 や負の値でも落ちない。** ここは `../config.py` を人が手で書き換える先なので、
                # 書き間違いで毎周期例外が出ると、**LCD の更新ごと止まる**（`main.py` の `emit`）。
                self._led.on()
            else:
                # 1周期の半分だけ点いて、半分消える（0.5Hz なら 1 秒ずつ）。
                half_s = 1 / (pattern.blink_hz * 2)
                self._led.blink(on_time=half_s, off_time=half_s)
        # **出してから覚える。** 先に覚えると、例外で出せなかった状態を「出した」ことにしてしまい、
        # **その状態が続く限り二度と出し直さない**——`lv 3` が来ても光らないまま黙る
        # （`../../../../../CLAUDE.md`「静かに黙る故障」）。
        self._shown = pattern


def open_light(gpio: int | None) -> Light:
    """`../config.py` の GPIO 番号から作る。**`None` ならどこにも出さない。**

    **`None` で落ちないことが要件である**——実機も部品も持たない開発者が、
    ここで止まらずに `main.py` を起動できるようにするため
    （`../../../../../docs/adr/0002-development-lifecycle.md`）。
    """
    if gpio is None:
        return Light(None)
    from gpiozero import LED

    return Light(LED(gpio))
