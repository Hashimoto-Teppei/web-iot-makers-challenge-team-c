"""警告の出し分け（`arbitrate()`）のテスト。

**ハードウェアも実機も要らない。** 時刻と状態を引数で渡す作りなので、
待たずに「保持時間が切れた」を作れる（`../../../docs/adr/0002-development-lifecycle.md`）。

守っているものの正本は `../../../docs/notifications/arbitration.md`。
**ここで仕様を決め直さない。**
"""

from device import config as device_config
from device.alert import Warn
from device.notify import (
    ANIM_COLUMN,
    LIGHT_OFF,
    LINK_LABEL_WIDTH,
    MOVING_COLUMN,
    SYMBOL_WIDTH,
    ActiveWarning,
    LightPattern,
    NotifyConfig,
    Output,
    arbitrate,
    merge_warning,
    unsupported_lcd_chars,
)

SECOND = 1000

# **`config.py` の実値を読まない**——既定値を実地で変えたときにテストが落ちると、
# 値の調整が怖くなる（`test_link.py` と同じ理由）。守っているのは規則であって値ではない。
CONFIG = NotifyConfig(
    hold_ms={1: 3 * SECOND, 2: 4 * SECOND, 3: 6 * SECOND},
    warn_lights={
        1: LightPattern(lit=True, blink_hz=0.5),
        2: LightPattern(lit=True, blink_hz=2.0),
        3: LightPattern(lit=True, blink_hz=None),
    },
    link_lights={
        "up": LightPattern(lit=True, blink_hz=None),
        "nofix": LightPattern(lit=True, blink_hz=0.5),
        "down": LightPattern(lit=True, blink_hz=2.0),
    },
    link_labels={"up": "OK", "nofix": "GPS", "down": "NG"},
    link_frames={"up": ("*", "."), "nofix": ("^", "_"), "down": ("|", "-")},
    anim_step_ms=SECOND,
    # **カナと桁数まで含めて確かめる。** `ﾀｲｺｳｼｬ`（6マス）と `ﾌﾞﾚｰｷ`（5マス。**濁点が
    # 1マスを食う**）が入るかは、英字の記号では表に出ない（`config.py` と同じ語を置く）。
    symbols={
        "rear_object": "ｺｳﾎｳ",
        "approach": "ｾｯｷﾝ",
        "brake": "ﾌﾞﾚｰｷ",
        "corner": "ﾀｲｺｳｼｬ",
        "stop": "ﾄﾏﾚ",
    },
    priority=("rear_object", "approach", "brake", "corner", "stop"),
)


def warn(kind: str, lv: int, expires_at_ms: int = 10 * SECOND) -> ActiveWarning:
    """発火中の警告を1件作る。"""
    return ActiveWarning(
        kind=kind,
        lv=lv,  # pyright: ignore[reportArgumentType]
        expires_at_ms=expires_at_ms,
    )


def run(
    warnings: list[ActiveWarning],
    link: str = "up",
    moving: bool = True,
    info: str | None = None,
    now_ms: int = 0,
) -> Output:
    return arbitrate(
        warnings=warnings,
        link=link,  # pyright: ignore[reportArgumentType]
        moving=moving,
        info=info,
        now_ms=now_ms,
        config=CONFIG,
    )


# --- 保持時間 ---


def test_保持時間の切れた警告は落ちる() -> None:
    """**消える規則はこの関数の中だけ。**呼び出し側は持っているものを渡すだけでよい。"""
    out = run([warn("approach", 2, expires_at_ms=4 * SECOND)], now_ms=4 * SECOND)

    assert out.line1.strip() == ""
    assert out.warn_light == LIGHT_OFF


def test_保持時間が残っていれば出る() -> None:
    out = run([warn("approach", 2, expires_at_ms=4 * SECOND)], now_ms=4 * SECOND - 1)

    assert out.line1 == "!!  ｾｯｷﾝ        "


# --- 優先順位 ---


def test_lv_の高い方が選ばれる() -> None:
    out = run([warn("stop", 3), warn("rear_object", 1)])

    assert out.line1 == "!!! ﾄﾏﾚ         "


def test_同じ_lv_なら_kind_の固定順で選ばれる() -> None:
    """**後ろは振り向かないと見えない。**加えて通信が死んでいても出る唯一のもの。"""
    out = run([warn("stop", 2), warn("rear_object", 2), warn("approach", 2)])

    assert out.line1 == "!!  ｺｳﾎｳ        "


def test_選ばれなかった警告は消えず_上位が消えたら表に出る() -> None:
    """**捨てると、上位が一瞬出た隙に下位が消える。**"""
    hidden = warn("stop", 1, expires_at_ms=9 * SECOND)
    top = warn("approach", 3, expires_at_ms=2 * SECOND)

    assert run([top, hidden], now_ms=SECOND).line1 == "!!! ｾｯｷﾝ        "
    assert run([top, hidden], now_ms=3 * SECOND).line1 == "!   ﾄﾏﾚ         "


def test_知らない_kind_でも黙らない() -> None:
    """記号の表に無いものは識別子を大文字にして出す。**空欄にすると気づけない。**

    **ここだけ英字になるのは構わない。** 表に無い `kind` は想定外であり、
    そこで文字種を揃えることに意味がない（`notify.py` の `_symbol()`）。
    """
    out = run([warn("wobble", 2)])

    assert out.line1 == "!!  WOBBLE      "


# --- 光 ---


def test_警告の光は状態として毎周期そのまま出る() -> None:
    """**イベントにすると、再送されている `lv 3` で最初の数秒だけ光って以後は消える。**"""
    first = run([warn("approach", 3)])
    later = run([warn("approach", 3)], now_ms=5 * SECOND)

    assert first.warn_light == CONFIG.warn_lights[3]
    assert later.warn_light == CONFIG.warn_lights[3]


def test_警告が無ければ消灯() -> None:
    assert run([]).warn_light == LIGHT_OFF


# --- 通信断 ---


def test_link_の光は_up_でも消灯にしない() -> None:
    """**消灯は「壊れて光っていない」と区別できない**（LCD 下段で `OK` を出すのと同じ理由）。

    ここが消灯だと、**LED が切れていることに誰も気づけない。**
    """
    assert run([]).link_light == CONFIG.link_lights["up"]
    assert run([]).link_light != LIGHT_OFF


def test_link_の光は3状態を出し分ける() -> None:
    """LCD 下段の `OK` / `GPS` / `NG` をそのまま写す。"""
    nofix = run([], link="nofix")
    assert nofix.link_light == CONFIG.link_lights["nofix"]
    assert nofix.line2 == "GPS ^ →         "

    down = run([], link="down")
    assert down.link_light == CONFIG.link_lights["down"]
    assert down.line2 == "NG  | →         "


def test_link_の光は警告に譲らない() -> None:
    """**警告とは別の LED なので場所を取り合わない。**

    取り合わせると、消えるのはたいてい常時表示の方であり、
    **それが一番消してはいけないもの**（`v2v.md`「心拍を必ず見せる」）。
    """
    out = run([warn("rear_object", 3)], link="down")

    assert out.link_light == CONFIG.link_lights["down"]
    assert out.warn_light == CONFIG.warn_lights[3]


def test_通信断でも警告の表示は止まらない() -> None:
    """**デバイスの後方物体検知は `link` に関係なく動き続ける。**上段も奪わない。"""
    out = run([warn("rear_object", 2)], link="down")

    assert out.line1 == "!!  ｺｳﾎｳ        "
    assert out.line2 == "NG  | →         "


# --- 画面の割り付け ---


def test_下段は警告に譲らない() -> None:
    """**消えるのはたいてい常時表示の方で、それが一番消してはいけないもの。**"""
    out = run([warn("approach", 3)], link="up", moving=True)

    assert out.line2 == "OK  * →         "
    assert out.line2[:LINK_LABEL_WIDTH] == "OK "


def test_停止中は_mv_の桁が変わる() -> None:
    assert run([], moving=False).line2 == "OK  * -         "


def test_両段とも常に16桁() -> None:
    """**右を空白で埋める**——埋めないと前の表示が残る。"""
    out = run([warn("approach", 1)], info="x" * 40, moving=False)

    assert len(out.line1) == 16
    assert len(out.line2) == 16


def test_記号は桁_4_から始まり6桁まで収まる() -> None:
    """**左端が動くと、探すために画面を見ることになる。**長さが違うのは構わない。

    `ﾀｲｺｳｼｬ` は6マス（**濁点と半濁点はそれぞれ1マスを食う**）。ここが溢れると
    上段の桁割りが崩れる（`../../../docs/notifications/arbitration.md`「上段 — 警告」）。
    """
    for kind, symbol in CONFIG.symbols.items():
        out = run([warn(kind, 2)])

        assert len(symbol) <= SYMBOL_WIDTH, kind
        assert out.line1.startswith(f"!!  {symbol}"), kind
        assert len(out.line1) == 16, kind


# --- 生存のコマ（下段の桁 4） ---


def test_コマは毎秒進み_同じ時刻なら同じコマ() -> None:
    """**動いていること自体が「周期処理が生きている」証拠。**

    LED の点滅は gpiozero の裏スレッドで回るので、**`on_tick` が死んでも光は続く**
    ——固まったことを人が拾える出力はここだけである（`AGENTS.md`「静かに黙る故障」）。

    **`now_ms` から出すので、前の呼び出しを覚えない**（`arbitrate()` の約束）。
    """
    frames = [run([], now_ms=now).line2[ANIM_COLUMN] for now in (0, 999, SECOND, 2 * SECOND)]

    # 1 秒未満では進まず、1 秒で次のコマ、2 秒で戻る（`up` は2コマ）。
    assert frames == ["*", "*", ".", "*"]
    # **同じ入力なら同じ出力。**時計を中で読んでいたらここが揺れる。
    assert run([], now_ms=1500).line2 == run([], now_ms=1500).line2


def test_コマは_link_ごとに絵柄が違う() -> None:
    """**動きだけでも状態が分かる。**`^`/`_` は探している、`|`/`-` は空回り、`*`/`.` は脈。

    **12 個とも ASCII。** `■` や `･` は A00 にしか無く、ROM が A02 だと
    **`up` のコマだけ両方空白になる**（`config.py` の `link_frames`）。
    """
    seen = {
        link: [run([], link=link, now_ms=now).line2[ANIM_COLUMN] for now in (0, SECOND)]
        for link in ("up", "nofix", "down")
    }

    assert seen == {"up": ["*", "."], "nofix": ["^", "_"], "down": ["|", "-"]}


def test_コマも_mv_も警告に譲らない() -> None:
    """**下段は警告に場所を取り合わせない**（`arbitration.md`「下段」）。"""
    out = run([warn("rear_object", 3)], link="down", now_ms=SECOND)

    assert out.line2[ANIM_COLUMN] == "-"
    assert out.line2[MOVING_COLUMN] == "→"


# --- LCD に出せる文字（`config.py` の表） ---


def test_config_の文言は_LCD_に出せる文字だけでできている() -> None:
    """**ここは `config.py` の実値を読む。** 規則ではなく**その値が出せるか**を見るため。

    A00 ROM に無い文字（漢字・ひらがな・全角カナ）は、RPLCD が**例外を投げずに空白へ落とす**
    ——**画面がそこだけ静かに欠け**、ログにも何も出ない（`notify.py` の `unsupported_lcd_chars()`）。
    """
    table = device_config.NOTIFY_CONFIG
    texts = [
        *table.symbols.values(),
        *table.link_labels.values(),
        *(frame for frames in table.link_frames.values() for frame in frames),
    ]

    for text in texts:
        assert unsupported_lcd_chars(text) == [], text


def test_config_の文言は桁に収まる() -> None:
    """**桁を動かさないことが決定事項**なので、値の側で守る（`arbitration.md`「下段」）。"""
    table = device_config.NOTIFY_CONFIG

    for kind, symbol in table.symbols.items():
        assert len(symbol) <= SYMBOL_WIDTH, kind
    for link, label in table.link_labels.items():
        assert len(label) <= LINK_LABEL_WIDTH, link
    # **0 を書かない。**`_frame()` はこれで割るので、0 だと周期処理ごと落ちる。
    assert table.anim_step_ms > 0
    for link, frames in table.link_frames.items():
        # **空にしない。**コマが無いと `_frame()` が 0 で割る（= 周期処理ごと落ちる）。
        assert frames, link
        assert all(len(frame) == 1 for frame in frames), link


# --- 停止中の情報表示 ---


def test_停止中で警告が無ければ情報を出す() -> None:
    out = run([], moving=False, info="ABCDEFGHIJKLMNOP" + "QRSTUVWX")

    assert out.line1 == "ABCDEFGHIJKLMNOP"
    # **下段の 0〜6 桁は開放しない。**状態の枠は停止中も動かさない。
    assert out.line2 == "OK  * - QRSTUVWX"


def test_走行中は情報を出さない() -> None:
    out = run([], moving=True, info="ABCDEFGH")

    assert out.line1.strip() == ""
    assert out.line2 == "OK  * →         "


def test_警告が入ったら情報は消える() -> None:
    out = run([warn("approach", 2)], moving=False, info="ABCDEFGHIJKLMNOPQRSTUVWX")

    assert out.line1 == "!!  ｾｯｷﾝ        "
    assert out.line2 == "OK  * -         "


# --- 届いた warn の取り込み（`merge_warning`） ---


def incoming(kind: str, lv: int) -> Warn:
    """スマホから届いた `warn` を1通作る。"""
    return Warn(kind=kind, lv=lv)  # pyright: ignore[reportArgumentType]


def merge(warnings: list[ActiveWarning], kind: str, lv: int, now_ms: int) -> list[ActiveWarning]:
    return merge_warning(warnings, incoming(kind, lv), now_ms, CONFIG)


def test_届いた_warn_は保持時間つきで発火中になる() -> None:
    active = merge([], "approach", 2, now_ms=1 * SECOND)

    assert len(active) == 1
    assert active[0].kind == "approach"
    assert active[0].lv == 2
    # `lv 2` の保持時間は 4 秒。
    assert active[0].expires_at_ms == 5 * SECOND


def test_同じ_kind_は2件に増えない() -> None:
    """**増やすと、同じ警告が上段の1枠を奪い合う**（`arbitration.md`「発火中とみなす期間」）。"""
    active = merge(merge([], "approach", 1, now_ms=0), "approach", 3, now_ms=2 * SECOND)

    assert len(active) == 1
    assert active[0].lv == 3


def test_lv_が下がったら表示も下がるが保持は短くならない() -> None:
    """**短くすると、`lv 3` の残り時間ごと消える。**危険が続いている最中に画面が空になる。"""
    active = merge(merge([], "approach", 3, now_ms=0), "approach", 1, now_ms=2 * SECOND)

    assert active[0].lv == 1
    # `lv 3` の 6 秒（= 6000）が残る。下げた側の 2000 + 3000 = 5000 を採らない。
    assert active[0].expires_at_ms == 6 * SECOND


def test_別の_kind_は並んで残る() -> None:
    active = merge(merge([], "approach", 1, now_ms=0), "brake", 1, now_ms=0)

    assert {w.kind for w in active} == {"approach", "brake"}


def test_保持の切れた警告は取り込みのときに落ちる() -> None:
    active = merge(merge([], "brake", 1, now_ms=0), "approach", 1, now_ms=10 * SECOND)

    assert [w.kind for w in active] == ["approach"]
