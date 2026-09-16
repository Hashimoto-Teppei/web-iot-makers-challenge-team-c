# pyright: reportMissingImports=false
"""LCD1602A（16×2 のキャラクタ LCD、I2C 変換基板つき）。

`notify.py` が返した2行を**そのまま書く**。何を出すかは決めない
（`../../../README.md`「それぞれの約束」）。**16桁へ切り揃えるのも `notify.py` の側**
なので、ここは受け取った文字列を桁の先頭から書くだけである。

**RPLCD の import は `open_lcd()` の中**にある。開発機に RPLCD も smbus2 も入らないが、
**このモジュールは pytest から import できる必要がある**
（`../../../../../docs/adr/0008-device-dependencies.md`）。

配線とアドレスの正本は `../../../../../docs/hardware.md`。
"""

import logging
from typing import Protocol

from device.notify import LCD_COLUMNS

logger = logging.getLogger(__name__)

# 行数。**16×2 であることは決定済み**（`../../../../../docs/notifications/arbitration.md`）。
LCD_ROWS = 2


class LcdDisplay(Protocol):
    """RPLCD の `CharLCD` のうち、ここで使う2つだけ。

    **テストは偽物を渡す**——実機が無くても、どの行に何を書いたかを確かめられるようにするため
    （`../../../../../docs/adr/0002-development-lifecycle.md`）。
    """

    cursor_pos: tuple[int, int]

    def write_string(self, value: str) -> None: ...


class Lcd:
    """2行を LCD に出す。

    **変わった行だけ書き直す。** I2C は 4bit ずつ送るので 16 文字でも数十回の転送になり、
    毎周期2行とも書くと**変わっていないのに画面がちらつく**（人の目には点滅に見える）。
    """

    def __init__(self, display: LcdDisplay | None) -> None:
        # `None` は「LCD が載っていない」という意味（`../config.py`）。
        self._display = display
        self._shown: list[str | None] = [None] * LCD_ROWS
        # いま書けない状態か。**同じ故障を毎秒ログに出さないため**（`../config.py` と同じ理由）。
        self._failing = False

    def show(self, line1: str, line2: str) -> None:
        """上段と下段を出す。**毎周期呼んでよい**（変わった行だけ書く）。

        **消してから書かない。** `notify.py` が右を空白で埋めた16桁を返すので、
        上書きだけで前の表示は残らない——`clear()` を挟むと、**その一瞬だけ画面が真っ白**になる。
        """
        if self._display is None:
            return
        for row, text in enumerate((line1, line2)):
            if text == self._shown[row]:
                continue
            try:
                self._display.cursor_pos = (row, 0)
                self._display.write_string(text)
            except OSError as error:
                # **I2C は線が1本緩んだだけで例外になる。**ここで投げると
                # **`main.py` の周期処理ごと止まり、`link` の更新も接続の切断も道連れになる**
                # （`../main.py` の `on_tick`）。**走行中に届くのは光で、画面ではない。**
                if not self._failing:
                    # **黙って続けない**（`../../../../../AGENTS.md`「静かに黙る故障」）。
                    # ただし毎秒は出さない——同じ行が SD カードを埋める。
                    self._failing = True
                    logger.warning("LCD に書けない（配線か I2C アドレスを見る）: %s", error)
                return
            # **書けてから覚える。** 先に覚えると、**失敗した行は次の周期で書き直されない**
            # ——線が戻っても、`link` が変わるまで古い行（`OK` に戻ったのに `DOWN`）が残る。
            self._shown[row] = text
        self._failing = False


def open_lcd(address: int | None) -> Lcd:
    """`../config.py` の I2C アドレスから作る。**`None` ならどこにも出さない。**

    **`None` で落ちないことが要件である**——実機も部品も持たない開発者が、
    ここで止まらずに `main.py` を起動できるようにするため
    （`../../../../../docs/adr/0002-development-lifecycle.md`）。
    """
    if address is None:
        return Lcd(None)
    from RPLCD.i2c import CharLCD

    try:
        display = CharLCD(
            # 変換基板のチップ。**アドレスは実機の `i2cdetect -y 1` で確定する**
            # （`../../../../../docs/hardware.md`）。
            i2c_expander="PCF8574",
            address=address,
            # ラズパイの I2C は 1 番（物理ピン 3 / 5）。
            port=1,
            cols=LCD_COLUMNS,
            rows=LCD_ROWS,
            # **折り返させない。** 16桁ちょうどの文字列を書くので、折り返しが効いていると
            # 桁あふれの扱いが RPLCD 側の判断になる。**桁を決めるのは `notify.py`。**
            auto_linebreaks=False,
        )
    except OSError as error:
        # **アドレスが違うだけで起動ごと止めない。** `0x27` と `0x3F` のどちらかは
        # **実機で `i2cdetect -y 1` を見るまで分からない**（`../../../../../docs/hardware.md`）
        # ので、**最初の起動はここで外すのが既定**である。
        # **走行中に届くのは光**なので、画面が出ないことを理由に BLE ごと止めない
        # （`show()` の中と同じ判断）。
        logger.warning(
            "LCD が %#04x に見つからない（`i2cdetect -y 1` で確かめる）: %s", address, error
        )
        return Lcd(None)

    return Lcd(display)
