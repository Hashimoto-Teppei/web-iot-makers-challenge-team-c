"""警告の出し分け（`arbitrate()`）のテスト。

**ハードウェアも実機も要らない。** 時刻と状態を引数で渡す作りなので、
待たずに「保持時間が切れた」を作れる（`../../../docs/adr/0002-development-lifecycle.md`）。

守っているものの正本は `../../../docs/notifications/arbitration.md`。
**ここで仕様を決め直さない。**
"""

from device.alert import Warn
from device.notify import (
    LIGHT_OFF,
    ActiveWarning,
    LightPattern,
    NotifyConfig,
    Output,
    arbitrate,
    merge_warning,
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
    symbols={
        "rear_object": "REAR",
        "approach": "APPR",
        "brake": "BRK ",
        "corner": "CRNR",
        "stop": "STOP",
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

    assert out.line1 == "!!  APPR        "


# --- 優先順位 ---


def test_lv_の高い方が選ばれる() -> None:
    out = run([warn("stop", 3), warn("rear_object", 1)])

    assert out.line1 == "!!! STOP        "


def test_同じ_lv_なら_kind_の固定順で選ばれる() -> None:
    """**後ろは振り向かないと見えない。**加えて通信が死んでいても出る唯一のもの。"""
    out = run([warn("stop", 2), warn("rear_object", 2), warn("approach", 2)])

    assert out.line1 == "!!  REAR        "


def test_選ばれなかった警告は消えず_上位が消えたら表に出る() -> None:
    """**捨てると、上位が一瞬出た隙に下位が消える。**"""
    hidden = warn("stop", 1, expires_at_ms=9 * SECOND)
    top = warn("approach", 3, expires_at_ms=2 * SECOND)

    assert run([top, hidden], now_ms=SECOND).line1 == "!!! APPR        "
    assert run([top, hidden], now_ms=3 * SECOND).line1 == "!   STOP        "


def test_知らない_kind_でも黙らない() -> None:
    """記号の表に無いものは先頭4文字を大文字にして出す。**空欄にすると気づけない。**"""
    out = run([warn("wobble", 2)])

    assert out.line1 == "!!  WOBB        "


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
    """LCD 下段の `OK` / `NOFIX` / `DOWN` をそのまま写す。"""
    nofix = run([], link="nofix")
    assert nofix.link_light == CONFIG.link_lights["nofix"]
    assert nofix.line2 == "NOFIX >         "

    down = run([], link="down")
    assert down.link_light == CONFIG.link_lights["down"]
    assert down.line2 == "DOWN  >         "


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

    assert out.line1 == "!!  REAR        "
    assert out.line2 == "DOWN  >         "


# --- 画面の割り付け ---


def test_下段は警告に譲らない() -> None:
    """**消えるのはたいてい常時表示の方で、それが一番消してはいけないもの。**"""
    out = run([warn("approach", 3)], link="up", moving=True)

    assert out.line2 == "OK    >         "
    assert out.line2[:5] == "OK   "


def test_停止中は_mv_の桁が変わる() -> None:
    assert run([], moving=False).line2 == "OK    -         "


def test_両段とも常に16桁() -> None:
    """**右を空白で埋める**——埋めないと前の表示が残る。"""
    out = run([warn("approach", 1)], info="x" * 40, moving=False)

    assert len(out.line1) == 16
    assert len(out.line2) == 16


# --- 停止中の情報表示 ---


def test_停止中で警告が無ければ情報を出す() -> None:
    out = run([], moving=False, info="ABCDEFGHIJKLMNOP" + "QRSTUVWX")

    assert out.line1 == "ABCDEFGHIJKLMNOP"
    # **下段の 0〜6 桁は開放しない。**状態の枠は停止中も動かさない。
    assert out.line2 == "OK    - QRSTUVWX"


def test_走行中は情報を出さない() -> None:
    out = run([], moving=True, info="ABCDEFGH")

    assert out.line1.strip() == ""
    assert out.line2 == "OK    >         "


def test_警告が入ったら情報は消える() -> None:
    out = run([warn("approach", 2)], moving=False, info="ABCDEFGHIJKLMNOPQRSTUVWX")

    assert out.line1 == "!!  APPR        "
    assert out.line2 == "OK    -         "


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
