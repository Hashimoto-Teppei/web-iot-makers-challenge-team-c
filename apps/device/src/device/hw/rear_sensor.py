# pyright: reportMissingImports=false
"""AE-NJR4265 J1 の接近検知出力を GPIO 1本で読む。

**判断しない**（`../../../README.md`「それぞれの約束」）。何 ms 続いたら接近とみなすかは
`../detect/rear_object.py` が決めており、ここは**いまの H / L を返すだけ**である。

**離反の出力（CN2 3番）は読まない。** 遠ざかる物体は危険ではない
（`../../../../../docs/hardware.md`）。

**gpiozero の import はこのファイルの先頭ではなく `open_rear_sensor()` の中**にある
（`led.py` と同じ理由——開発機に gpiozero は入らないが、pytest から import できる必要がある）。
"""

from typing import Protocol


class InputDevice(Protocol):
    """gpiozero の `DigitalInputDevice` のうち、ここで使う1つだけ。

    **テストは偽物を渡す**——実機が無くても読み取りを確かめられるようにするため。
    """

    @property
    def is_active(self) -> bool: ...


class RearSensor:
    """接近検知出力の現在値。"""

    def __init__(self, device: InputDevice | None) -> None:
        # `None` は「そのセンサーが載っていない」という意味（`../config.py`）。
        self._device = device

    def is_high(self) -> bool:
        """検知中なら真。**センサーが載っていなければ常に偽**（検知ごと動かない）。"""
        return self._device is not None and self._device.is_active


def open_rear_sensor(gpio: int | None) -> RearSensor:
    """`../config.py` の GPIO 番号から作る。**`None` ならこの検知ごと動かない。**

    **`None` で落ちないことが要件である**（`open_light()` と同じ。
    `../../../../../docs/adr/0002-development-lifecycle.md`）。
    """
    if gpio is None:
        return RearSensor(None)
    from gpiozero import DigitalInputDevice

    # **`pull_up=False`**（内部プルダウン）。**線が外れたときに L へ落ちる**ので、
    # 抜けたジャンパが「検知しっぱなし」に化けない。内部プルダウンの約 50kΩ は、
    # データシートが求める負荷抵抗 10k〜100kΩ の中に入る。H のときは VDD 近くまで出るので、
    # **VDD は 3.3V であること**（`../../../../../docs/hardware.md`）。
    return RearSensor(DigitalInputDevice(gpio, pull_up=False))
