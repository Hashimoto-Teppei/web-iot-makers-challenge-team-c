"""発火中の警告から、4つのチャンネルへの指示を作る（調停）。

**ハードウェアに触らない。** 引数も戻り値も値だけなので、開発機でも pytest から回せる
（`../../README.md`「それぞれの約束」）。GPIO と LCD を叩くのは `hw/` 側で、
あちらは**ここが返した値をそのまま出す**だけであり、何を出すかを決め直さない。

**仕様の正本は `../../../../docs/notifications/arbitration.md`。**
`kind` の識別子と `lv` の意味は `../../../../docs/interfaces/detectors.md`、
なぜ走行中に文章を出さないかは `../../../../docs/notifications.md` にある。
**ここで決め直さない。**

**`now_ms` を引数で受け取り、中で時計を呼ばない。** 同じ入力から同じ出力が出ないと、
「保持が切れたら消える」「上位が消えたら下位が表に出る」を pytest で確かめられない
（`../../../../docs/adr/0002-development-lifecycle.md`）。
"""

from dataclasses import dataclass

from device.alert import Level, Link, Warn

# LCD の桁数。**16×2 のキャラクタ LCD を前提にすることは決定済み**
# （`../../../../docs/notifications/arbitration.md`「画面の割り付け」）。
# 部品も LCD1602A（16×2）に決まった（#13。`../../../../docs/hardware.md`）。
LCD_COLUMNS = 16

# 停止中の情報に開放する桁数。**上段の16桁すべてと、下段の 8〜15 桁**で合わせて24文字。
INFO_LINE2_START = 8
INFO_CAPACITY = LCD_COLUMNS + (LCD_COLUMNS - INFO_LINE2_START)

# `link` を下段の 0〜4 桁に出すときの文字列。**5桁に固定する。**
#
# **`up` のときも `OK` を出し続け、空白にしない。** 空白は「壊れて何も出ていない」と
# 区別できない（`../../../../docs/notifications/arbitration.md`「下段」）。
_LINK_LABELS: dict[Link, str] = {"up": "OK", "nofix": "NOFIX", "down": "DOWN"}


@dataclass(frozen=True)
class LightPattern:
    """光の状態。**毎周期の現在値**であって、イベントではない。

    `lit` が偽なら消灯。`blink_hz` が `None` なら点きっぱなし。
    """

    lit: bool
    blink_hz: float | None = None


LIGHT_OFF = LightPattern(lit=False)


@dataclass(frozen=True)
class NotifyConfig:
    """保持時間・光・記号。**実値は `config.py` にある**（呼び出し側が渡す）。

    **既定値をここに書かない。** しきい値をコードに直書きしないためであり
    （`../../README.md`）、この dataclass は形だけを決める。
    """

    # `lv` ごとの保持時間（ms）。**再送間隔より長くすること**——等しいと、保持が切れてから
    # 次の再送が届くまでの隙間で表示が消える（BLE は必ず多少遅れるので毎回起きる）。
    hold_ms: dict[Level, int]
    # `lv` ごとの警告の光。
    warn_lights: dict[Level, LightPattern]
    # `link` ごとの状態の光。**`up` でも消灯にしない**——消灯は「壊れて光っていない」と
    # 区別できず、**LED が切れていることに誰も気づけない**
    # （`../../../../docs/notifications/arbitration.md`「`link` の光」）。
    link_lights: dict[Link, LightPattern]
    # `kind` ごとの4文字の記号。**英大文字に揃え、半角カタカナを混ぜない。**
    symbols: dict[str, str]
    # 同じ `lv` が並んだときの `kind` の順（強い順）。**ここに無い `kind` は一番弱い扱い。**
    priority: tuple[str, ...]


@dataclass(frozen=True)
class ActiveWarning:
    """発火中の警告1件。**保持時間が切れているかの判定は `arbitrate()` の中で行う。**"""

    kind: str
    lv: Level
    # 保持時間の切れる時刻。同じ `kind` の `warn` が来るたびに伸びる。
    expires_at_ms: int


@dataclass(frozen=True)
class Output:
    """4チャンネルへの指示。**これを出すのは呼び出し側。**"""

    line1: str
    line2: str
    # 選ばれている警告の `lv`。**状態**であって、イベントではない。毎周期の現在値。
    warn_light: LightPattern
    # `link` の状態。**警告とは別の LED なので、場所を取り合わない。**
    link_light: LightPattern


def hold_until(lv: Level, now_ms: int, config: NotifyConfig) -> int:
    """`lv` の警告をいま受け取ったときの、保持時間が切れる時刻。

    **`ActiveWarning` を組み立てる側が使う。**保持時間の値を呼び出し側に散らさないため、
    表を引くところをここに置く（切れたかどうかを見るのは `arbitrate()` の中）。
    """
    return now_ms + config.hold_ms[lv]


def merge_warning(
    warnings: list[ActiveWarning], warn: Warn, now_ms: int, config: NotifyConfig
) -> list[ActiveWarning]:
    """届いた `warn` を、発火中の一覧に取り込んだ新しい一覧を返す。

    **同じ `kind` を2件に増やさない。**保持時間を延ばし、`lv` を新しい方に置き換える
    （上がるのも下がるのも。`../../../../docs/notifications/arbitration.md`「発火中とみなす期間」）。

    **保持時間の切れたものはここで落とす**——`kept` の側の話である。
    落とさないと、**別の `kind` の切れた警告が次の一覧へそのまま持ち越され**、
    `arbitrate()` が毎周期落とし直すまで残る。
    """
    kept = [w for w in warnings if w.expires_at_ms > now_ms and w.kind != warn.kind]
    current = next((w for w in warnings if w.expires_at_ms > now_ms and w.kind == warn.kind), None)

    # **短くしない。** `lv` が下がった `warn` で切り上げると、危険が続いているのに
    # 上位のぶんの保持が残り時間ごと消える（上の docstring の「延ばし」）。
    expires_at_ms = hold_until(warn.lv, now_ms, config)
    if current is not None:
        expires_at_ms = max(expires_at_ms, current.expires_at_ms)

    return [
        *kept,
        ActiveWarning(kind=warn.kind, lv=warn.lv, expires_at_ms=expires_at_ms),
    ]


def arbitrate(
    warnings: list[ActiveWarning],
    link: Link,
    moving: bool,
    info: str | None,
    now_ms: int,
    config: NotifyConfig,
) -> Output:
    """発火中の警告から、この周期に出すものを決める。

    **保持時間の切れた警告を落とすのもここ。** 呼び出し側は持っているものを渡すだけにし、
    **消える規則を2か所に置かない**（`arbitration.md`「調停の関数の形」）。
    """
    # **切れたものを落とす。**以降はすべて「発火中」のものだけを見る。
    active = [w for w in warnings if w.expires_at_ms > now_ms]

    # **1件だけ選ぶ。重ねない。**`lv` の高い順 → 同じなら `kind` の固定順。
    selected = min(active, key=lambda w: (-w.lv, _priority_index(w.kind, config)), default=None)

    # **光は状態。**選ばれている警告の `lv` を毎周期そのまま出す。
    # **イベントではない**ので、「出し直す条件」を持たない。
    warn_light = config.warn_lights[selected.lv] if selected is not None else LIGHT_OFF

    # **停止中で、発火中の警告が1件も無いときだけ**情報を出す。
    # **出してよいかの判断（この停止中にすでに警告が出たか）は呼び出し側**で、
    # 出さないと決めたなら `None` が渡ってくる。
    shown = info if info is not None and not moving and not active else None

    return Output(
        line1=_line1(selected, shown, config),
        line2=_line2(link, moving, shown),
        warn_light=warn_light,
        # **警告の有無に関わらず、毎周期そのまま出す。**警告に譲らせない
        # ——譲らせると、一番消してはいけないものが警告のたびに消える。
        link_light=config.link_lights[link],
    )


def _priority_index(kind: str, config: NotifyConfig) -> int:
    """`kind` の固定順。**表に無いものは一番弱い扱い**にして、落とさない。

    落とすと、**知らない `kind` が来たときに何も出なくなる**——`alert.py` が形を確かめて
    通した以上、出せるものは出す方がよい（記号は `_symbol()` が埋める）。
    """
    return config.priority.index(kind) if kind in config.priority else len(config.priority)


def _line1(selected: ActiveWarning | None, info: str | None, config: NotifyConfig) -> str:
    """上段。**警告。**優先順位で選ばれた1件だけ（`arbitration.md`「上段 — 警告」）。

    桁 0〜2 が `lv` のバー、4〜7 が `kind` の記号、8〜15 は常に空白。
    **`lv` を数字で出さない**——`!` の本数は長さとして見えるので、読まずに量が伝わる。
    """
    if selected is None:
        # **警告が無いときだけ**、停止中の情報に16桁すべてを開放する。
        # **桁を割らない**——読む相手が停止しているので「毎回同じ場所」の制約は掛からない。
        return _fit(info[:LCD_COLUMNS] if info is not None else "")
    bar = "!" * selected.lv
    return _fit(f"{bar:<3} {_symbol(selected.kind, config)}")


def _line2(link: Link, moving: bool, info: str | None) -> str:
    """下段。**状態。**`link` と `mv`。**警告に譲らない**（`arbitration.md`「下段」）。

    桁 0〜4 が `link`、6 が `mv`、8〜15 は停止中の情報のみ。
    **`link` の桁は絶対に動かさない**——ここが動くと、探すために画面を見ることになる。
    """
    head = f"{_LINK_LABELS[link]:<5} {'>' if moving else '-'} "
    tail = info[LCD_COLUMNS:] if info is not None else ""
    return _fit(head + tail[: LCD_COLUMNS - INFO_LINE2_START])


def _symbol(kind: str, config: NotifyConfig) -> str:
    """`kind` の4文字の記号。**知らない `kind` は先頭4文字を大文字にして出す。**

    黙って空欄にすると、**何かが起きているのに何も出ていない画面**になる。
    """
    return config.symbols.get(kind) or f"{kind[:4].upper():<4}"


def _fit(text: str) -> str:
    """16桁に切り揃える。**右は空白で埋める**（前の表示が残らないように）。"""
    return f"{text:<{LCD_COLUMNS}}"[:LCD_COLUMNS]
