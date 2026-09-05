"""警告の出し分け（`arbitrate()`）のテスト。

**ハードウェアも実機も要らない。** 時刻と状態を引数で渡す作りなので、
待たずに「保持時間が切れた」を作れる（`../../../docs/adr/0002-development-lifecycle.md`）。

守っているものの正本は `../../../docs/notifications/arbitration.md`。
**ここで仕様を決め直さない。**
"""

from device.notify import (
    LIGHT_OFF,
    ActiveWarning,
    LightPattern,
    NotifyConfig,
    Output,
    Tone,
    arbitrate,
)

SECOND = 1000

# **`config.py` の実値を読まない**——既定値を実地で変えたときにテストが落ちると、
# 値の調整が怖くなる（`test_link.py` と同じ理由）。守っているのは規則であって値ではない。
CONFIG = NotifyConfig(
    hold_ms={1: 3 * SECOND, 2: 4 * SECOND, 3: 6 * SECOND},
    tones={
        1: Tone(beeps=1, on_ms=100, gap_ms=0),
        2: Tone(beeps=2, on_ms=100, gap_ms=100),
        3: Tone(beeps=2, on_ms=600, gap_ms=200),
    },
    lights={
        1: LightPattern(lit=True, blink_hz=0.5),
        2: LightPattern(lit=True, blink_hz=2.0),
        3: LightPattern(lit=True, blink_hz=None),
    },
    symbols={
        "rear_object": "REAR",
        "approach": "APPR",
        "brake": "BRK ",
        "corner": "CRNR",
        "stop": "STOP",
    },
    priority=("rear_object", "approach", "brake", "corner", "stop"),
    link_down_tone=Tone(beeps=1, on_ms=100, gap_ms=0),
)


def warn(
    kind: str,
    lv: int,
    expires_at_ms: int = 10 * SECOND,
    peak_lv: int | None = None,
    peak_at_ms: int = 0,
) -> ActiveWarning:
    """発火中の警告を1件作る。`peak_lv` を省いたら `lv` がそのまま最大値。"""
    return ActiveWarning(
        kind=kind,
        lv=lv,  # pyright: ignore[reportArgumentType]
        expires_at_ms=expires_at_ms,
        peak_lv=peak_lv if peak_lv is not None else lv,  # pyright: ignore[reportArgumentType]
        peak_at_ms=peak_at_ms,
    )


def run(
    warnings: list[ActiveWarning],
    link: str = "up",
    link_since_ms: int = 0,
    moving: bool = True,
    info: str | None = None,
    now_ms: int = 0,
    chimed: frozenset[str] = frozenset(),
) -> Output:
    return arbitrate(
        warnings=warnings,
        link=link,  # pyright: ignore[reportArgumentType]
        link_since_ms=link_since_ms,
        moving=moving,
        info=info,
        now_ms=now_ms,
        chimed=chimed,
        config=CONFIG,
    )


# --- 保持時間 ---


def test_保持時間の切れた警告は落ちる() -> None:
    """**消える規則はこの関数の中だけ。**呼び出し側は持っているものを渡すだけでよい。"""
    out = run([warn("approach", 2, expires_at_ms=4 * SECOND)], now_ms=4 * SECOND)

    assert out.line1.strip() == ""
    assert out.light == LIGHT_OFF


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


# --- 音（鳴らし直す条件） ---


def test_新しく上位になった警告は鳴る() -> None:
    out = run([warn("approach", 2)])

    assert out.tone == CONFIG.tones[2]
    assert out.chimed == frozenset({"approach:2:0"})


def test_同じ_lv_のまま延長されても鳴らない() -> None:
    """**数秒おきに鳴り続けると、人は音を無視するようになる。**"""
    first = run([warn("approach", 2, expires_at_ms=4 * SECOND)])
    later = run(
        [warn("approach", 2, expires_at_ms=6 * SECOND)],
        now_ms=2 * SECOND,
        chimed=first.chimed,
    )

    assert later.tone is None
    assert later.line1 == "!!  APPR        "


def test_lv_が上がったら鳴る() -> None:
    first = run([warn("approach", 2)])
    raised = run(
        [warn("approach", 3, peak_lv=3, peak_at_ms=2 * SECOND)],
        now_ms=2 * SECOND,
        chimed=first.chimed,
    )

    assert raised.tone == CONFIG.tones[3]


def test_lv_が下がっても鳴らない() -> None:
    """**下がったことを急いで伝える理由が無い。**`peak_lv` を鍵にしているので鍵が動かない。"""
    first = run([warn("approach", 3)])
    lowered = run(
        [warn("approach", 1, peak_lv=3, peak_at_ms=0)],
        now_ms=2 * SECOND,
        chimed=first.chimed,
    )

    assert lowered.tone is None
    assert lowered.line1 == "!   APPR        "


def test_上位が消えて_すでに鳴った下位が戻っても鳴らない() -> None:
    """**同じ警告を2度鳴らすことになる。**隠れている間も鍵を集合に残すことで防ぐ。"""
    low = warn("stop", 1, expires_at_ms=9 * SECOND)
    high = warn("approach", 3, expires_at_ms=4 * SECOND)

    # 下位だけが出ている周期で鳴る。
    first = run([low])
    assert first.tone == CONFIG.tones[1]

    # 上位が割り込んで鳴る。
    second = run([low, high], now_ms=SECOND, chimed=first.chimed)
    assert second.tone == CONFIG.tones[3]

    # 上位が切れて下位が戻る。**ここで鳴ってはいけない。**
    third = run([low, high], now_ms=5 * SECOND, chimed=second.chimed)
    assert third.tone is None
    assert third.line1 == "!   STOP        "


def test_隠れている間に届いた警告は_表に出た周期で鳴る() -> None:
    """**まだ発火中＝危険は続いている。**ここで黙ると一度も伝わらない。"""
    high = warn("approach", 3, expires_at_ms=3 * SECOND)
    low = warn("stop", 1, expires_at_ms=9 * SECOND, peak_at_ms=SECOND)

    first = run([high])
    # 隠れている間は鳴らない（鳴る候補になるのは選ばれた1件だけ）。
    hidden = run([high, low], now_ms=SECOND, chimed=first.chimed)
    assert hidden.tone is None
    assert "stop:1:1000" not in hidden.chimed

    surfaced = run([high, low], now_ms=4 * SECOND, chimed=hidden.chimed)
    assert surfaced.tone == CONFIG.tones[1]


def test_鳴らした鍵は生きているものだけに絞られる() -> None:
    """**足すだけの作りにすると走行中ずっと増え続ける。**"""
    expired = run([warn("approach", 2, expires_at_ms=SECOND)])
    assert expired.chimed == frozenset({"approach:2:0"})

    after = run(
        [warn("approach", 2, expires_at_ms=SECOND)], now_ms=2 * SECOND, chimed=expired.chimed
    )
    assert after.chimed == frozenset()


# --- 光 ---


def test_light_は状態として毎周期そのまま出る() -> None:
    """**イベントにすると、再送されている `lv 3` で最初の数秒だけ光って以後は消える。**"""
    first = run([warn("approach", 3)])
    later = run([warn("approach", 3)], now_ms=5 * SECOND, chimed=first.chimed)

    assert first.light == CONFIG.lights[3]
    assert later.tone is None
    assert later.light == CONFIG.lights[3]


def test_警告が無ければ消灯() -> None:
    assert run([]).light == LIGHT_OFF


# --- 通信断 ---


def test_down_に落ちた瞬間だけ鳴る() -> None:
    first = run([], link="down", link_since_ms=SECOND, now_ms=SECOND)
    assert first.tone == CONFIG.link_down_tone

    later = run([], link="down", link_since_ms=SECOND, now_ms=3 * SECOND, chimed=first.chimed)
    assert later.tone is None


def test_up_に戻ってまた落ちたら鳴り直す() -> None:
    """`link_since_ms` が変わるので鍵も変わる。**復帰したときは鳴らさない。**"""
    fell = run([], link="down", link_since_ms=SECOND, now_ms=SECOND)

    recovered = run([], link="up", now_ms=3 * SECOND, chimed=fell.chimed)
    assert recovered.tone is None
    assert recovered.chimed == frozenset()

    again = run(
        [], link="down", link_since_ms=5 * SECOND, now_ms=5 * SECOND, chimed=recovered.chimed
    )
    assert again.tone == CONFIG.link_down_tone


def test_nofix_では鳴らない() -> None:
    """**屋内では `nofix` が出続けるのが正常。**鳴らすとデモの間ずっと鳴る。"""
    out = run([], link="nofix", link_since_ms=SECOND, now_ms=SECOND)

    assert out.tone is None
    assert out.line2 == "NOFIX >         "


def test_通信断が先で_警告のチャイムは次の周期に回る() -> None:
    """**後方物体の警告が出ている最中にスマホが落ちるのは、まさに起こりうる形。**"""
    warning = warn("rear_object", 3, expires_at_ms=9 * SECOND)

    both = run([warning], link="down", link_since_ms=SECOND, now_ms=SECOND)
    assert both.tone == CONFIG.link_down_tone
    # **回した警告は鳴らしていないので集合に入らない。**
    assert "rear_object:3:0" not in both.chimed

    following = run(
        [warning], link="down", link_since_ms=SECOND, now_ms=2 * SECOND, chimed=both.chimed
    )
    assert following.tone == CONFIG.tones[3]


def test_通信断でも警告の表示は止まらない() -> None:
    """**デバイスの後方物体検知は `link` に関係なく動き続ける。**上段も奪わない。"""
    out = run([warn("rear_object", 2)], link="down", link_since_ms=0)

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
