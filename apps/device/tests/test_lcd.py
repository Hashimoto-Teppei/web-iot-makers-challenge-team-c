"""LCD（`hw/lcd.py`）のテスト。

**実機も RPLCD も要らない。** 偽の LCD を渡して、どの行に何を書いたかを記録する
（`../../../docs/adr/0002-development-lifecycle.md`）。
"""

from device.hw.lcd import Lcd, open_lcd


class FakeDisplay:
    """偽の LCD。**書かれた位置と文字列を順番に記録するだけ。**"""

    def __init__(self) -> None:
        self.cursor_pos: tuple[int, int] = (0, 0)
        self.writes: list[tuple[tuple[int, int], str]] = []

    def write_string(self, value: str) -> None:
        self.writes.append((self.cursor_pos, value))


def test_上段と下段がそれぞれの行に出る() -> None:
    display = FakeDisplay()
    lcd = Lcd(display)

    lcd.show("!!  ｺｳﾎｳ        ", "NG  | →         ")

    assert display.writes == [
        ((0, 0), "!!  ｺｳﾎｳ        "),
        ((1, 0), "NG  | →         "),
    ]


def test_変わった行だけ書き直す() -> None:
    # **毎周期2行とも書くと、変わっていないのに画面がちらつく**（`hw/lcd.py`）。
    display = FakeDisplay()
    lcd = Lcd(display)

    lcd.show("!!  ｺｳﾎｳ        ", "NG  | →         ")
    display.writes.clear()
    lcd.show("!!  ｺｳﾎｳ        ", "OK  * →         ")

    assert display.writes == [((1, 0), "OK  * →         ")]


def test_同じ2行が続く間は触らない() -> None:
    display = FakeDisplay()
    lcd = Lcd(display)

    lcd.show("                ", "NG  | →         ")
    display.writes.clear()
    lcd.show("                ", "NG  | →         ")

    assert display.writes == []


def test_アドレスが_None_なら何も触らずに動く() -> None:
    # **実機も部品も持たない開発者がここで止まらないため**
    # （`../../../docs/adr/0002-development-lifecycle.md`）。
    lcd = open_lcd(None)

    lcd.show("!!! ﾄﾏﾚ         ", "GPS ^ →         ")


class BrokenDisplay(FakeDisplay):
    """線が緩んだ LCD。**書こうとすると例外になる。**"""

    def __init__(self) -> None:
        super().__init__()
        self.broken = True

    def write_string(self, value: str) -> None:
        if self.broken:
            raise OSError(121, "Remote I/O error")
        super().write_string(value)


def test_書けなくても落ちない_し戻ったら書き直す() -> None:
    # **投げると `main.py` の周期処理ごと止まり、`link` の更新まで道連れになる**（`hw/lcd.py`）。
    display = BrokenDisplay()
    lcd = Lcd(display)

    lcd.show("!!! ﾄﾏﾚ         ", "OK  * →         ")
    display.broken = False
    lcd.show("!!! ﾄﾏﾚ         ", "OK  * →         ")

    # 書けなかった行は「出した」ことにせず、戻った周期で書き直す。
    assert display.writes == [
        ((0, 0), "!!! ﾄﾏﾚ         "),
        ((1, 0), "OK  * →         "),
    ]
