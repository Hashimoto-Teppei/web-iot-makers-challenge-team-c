"""心拍のウォッチドッグ（`LinkWatch`）のテスト。

**BLE も実機も要らない。** 時刻を引数で渡す作りにしてあるので、
待たずに「3秒経った」を作れる（`../../../docs/adr/0002-development-lifecycle.md`）。

守っているものの正本は `../../../docs/interfaces/v2v.md`「心拍を必ず見せる」。
**ここで仕様を決め直さない。**
"""

from device.alert import Beat, LinkWatch

# 秒で書くと桁を数えることになるので、ミリ秒の目盛りを1つ決めておく。
SECOND = 1000
TIMEOUT_MS = 3 * SECOND
WINDOW_MS = 5 * SECOND


def make_watch(started_at_ms: int = 0) -> LinkWatch:
    """テスト用のウォッチドッグ。**秒数は `config.py` から読まない**——
    既定値を実地で変えたときにテストが落ちると、値の調整が怖くなる。
    """
    return LinkWatch(timeout_ms=TIMEOUT_MS, stall_window_ms=WINDOW_MS, started_at_ms=started_at_ms)


def beat(t: int, st: str = "ok", mv: bool = True) -> Beat:
    """`beat` を1通作る。`t` はスマホの壁時計（ミリ秒）。"""
    assert st in ("ok", "nofix")
    return Beat(t=t, st=st, mv=mv)  # pyright: ignore[reportArgumentType]


def test_一度も受け取っていない間は_down() -> None:
    """**`up` から始めない。** つながる前を健全に見せない。"""
    watch = make_watch()

    assert watch.evaluate(0).link == "down"


def test_ok_の_beat_を受け取ると_up_になる() -> None:
    watch = make_watch()

    watch.record_beat(beat(t=1_000), now_ms=1 * SECOND)

    assert watch.evaluate(1 * SECOND).link == "up"


def test_nofix_の_beat_を受け取ると_nofix_になる() -> None:
    """**測位が出ていないだけ。** 屋内のデモではこれが出続けるのが正常。"""
    watch = make_watch()

    watch.record_beat(beat(t=1_000, st="nofix"), now_ms=1 * SECOND)

    assert watch.evaluate(1 * SECOND).link == "nofix"


def test_nofix_のあとに_ok_が来たら_up_に戻る() -> None:
    """**`nofix` を「一度来たら立つ旗」にしない。**

    旗にすると**再起動するまで `up` に戻らない**（`v2v.md`）。
    屋外に出た瞬間に戻ることが要る。
    """
    watch = make_watch()

    watch.record_beat(beat(t=1_000, st="nofix"), now_ms=1 * SECOND)
    watch.record_beat(beat(t=2_000, st="ok"), now_ms=2 * SECOND)

    assert watch.evaluate(2 * SECOND).link == "up"


def test_beat_が途切れると_down_に落ちる() -> None:
    watch = make_watch()
    watch.record_beat(beat(t=1_000), now_ms=1 * SECOND)

    # タイムアウトぴったりではまだ落ちない（境界を含めない）。
    assert watch.evaluate(1 * SECOND + TIMEOUT_MS).link == "up"
    assert watch.evaluate(1 * SECOND + TIMEOUT_MS + 1).link == "down"


def test_down_のあとに_beat_が来たら戻る() -> None:
    """**落ちたままにしない。** アプリを立ち上げ直したら戻ること。"""
    watch = make_watch()
    watch.record_beat(beat(t=1_000), now_ms=1 * SECOND)
    assert watch.evaluate(10 * SECOND).link == "down"

    watch.record_beat(beat(t=11_000), now_ms=11 * SECOND)

    assert watch.evaluate(11 * SECOND).link == "up"


def test_同じ_t_が窓いっぱい続いたら_down() -> None:
    """**`t` が進んでいるかも見る。**

    時計や測位が固まって同じ `t` を送り続けられても、値の検証では気づけない（`v2v.md`）。
    届いてはいるので、**時間の判定だけでは永久に `up` のまま**になる。
    """
    watch = make_watch()
    for i in range(8):
        watch.record_beat(beat(t=1_000), now_ms=i * SECOND)

    assert watch.evaluate(7 * SECOND).link == "down"


def test_窓ぶん溜まるまでは_同じ_t_でも_落とさない() -> None:
    """**足りない窓で判定しない。** 送り始めの数通で `down` にしない。"""
    watch = make_watch()
    for i in range(3):
        watch.record_beat(beat(t=1_000), now_ms=i * SECOND)

    assert watch.evaluate(2 * SECOND).link == "up"


def test_固まった_t_は新しい_t_が_1通来れば戻る() -> None:
    """**自然に回復する形にする。**

    「控えた1点の `t` より進んだか」で実装すると、変な値を1通採用した時点で基準が固まり、
    **再起動まで戻らなくなる**（`v2v.md`）。窓の広がりで見ていれば1通で戻る。
    """
    watch = make_watch()
    for i in range(8):
        watch.record_beat(beat(t=1_000), now_ms=i * SECOND)
    assert watch.evaluate(7 * SECOND).link == "down"

    watch.record_beat(beat(t=9_000), now_ms=8 * SECOND)

    assert watch.evaluate(8 * SECOND).link == "up"


def test_巻き戻った_t_は固まっていない扱い() -> None:
    """**時計が合っただけの端末を「落ちた」と表示しない。**

    見るのは「前へ進んだか」ではなく「動いたか」。NTP で時刻が戻ることは普通に起きる。

    **窓が埋まるまで `beat` を流すこと。** 窓に足りない数で確かめると `_stalled` の
    「窓ぶん溜まったか」で先に止まり、**`t` を見る行まで一度も進まない** ——
    後任が「単調増加か」で書き直しても、テストは通ってしまう。
    """
    watch = make_watch()
    for i in range(8):
        watch.record_beat(beat(t=100_000 - i * SECOND), now_ms=i * SECOND)

    assert watch.evaluate(7 * SECOND).link == "up"


def test_遠い未来の_t_が_1通来ても落ちない() -> None:
    """**`t` の中身を検証しない。** ずれた時計は「落ちた」ではない（`alert.py` と同じ約束）。"""
    watch = make_watch()

    watch.record_beat(beat(t=99_999_999_999), now_ms=1 * SECOND)

    assert watch.evaluate(1 * SECOND).link == "up"


def test_warn_を渡す口が無い() -> None:
    """**`warn` の到着を生存の根拠にしない**（`v2v.md`）。

    警告は**来ないのが正常**なので、混ぜると静かなときと落ちたときが区別できない。
    型で塞いであることを、受け口が `record_beat` だけであることで確かめる。
    """
    assert not hasattr(LinkWatch, "record_warn")
    assert not hasattr(LinkWatch, "record_alert")


def test_up_のときだけ_mv_に従う() -> None:
    """**受け取った `mv` に従う。** 速度からの判定をデバイス側に作らない。"""
    watch = make_watch()

    watch.record_beat(beat(t=1_000, mv=False), now_ms=1 * SECOND)

    status = watch.evaluate(1 * SECOND)
    assert status.link == "up"
    assert status.moving is False


def test_up_でない間は走行中に倒す() -> None:
    """**迷ったら走行中に倒す**（`../../../docs/notifications.md`）。

    停止中に倒すと、**通信が切れた瞬間に走行中の画面へ文章が出る。**
    """
    watch = make_watch()
    assert watch.evaluate(0).moving is True

    # 停止中だと分かっている状態から落ちても、走行中に戻る（前の `mv` を引きずらない）。
    watch.record_beat(beat(t=1_000, mv=False), now_ms=1 * SECOND)
    assert watch.evaluate(1 * SECOND).moving is False

    assert watch.evaluate(10 * SECOND).moving is True


def test_nofix_の間も走行中に倒す() -> None:
    """測位が無いので速度も分からない。**`up` でなければ走行中。**"""
    watch = make_watch()

    watch.record_beat(beat(t=1_000, st="nofix", mv=False), now_ms=1 * SECOND)

    assert watch.evaluate(1 * SECOND).moving is True


def test_beat_が続いている間は_up_のまま() -> None:
    """窓を越えて受け取り続けても落ちない。**`t` が進んでいれば `_stalled` は発火しない。**

    **`mv` を載せていない `beat` の扱いはここでは確かめられない。** `LinkWatch` が受け取るのは
    読み解いたあとの `Beat` で、欠けた `mv` を「走行中」に倒すのは `alert.py` の側
    （`tests/test_alert.py`）。**この境界で一番避けたい形**（`mv` の無い `beat` を捨てて
    `link` が `down` に落ちる）は、向こうで守られている。
    """
    watch = make_watch()

    for i in range(1, 9):
        watch.record_beat(beat(t=i * 1_000, mv=True), now_ms=i * SECOND)

    status = watch.evaluate(8 * SECOND)
    assert status.link == "up"
    assert status.moving is True


def test_since_は変わったときだけ動く() -> None:
    """**通信断のチャイムを1回だけ鳴らすための鍵**になる（`arbitration.md`）。

    毎周期動くと鍵が毎回変わり、**`down` の間ずっと鳴り続ける。**
    """
    watch = make_watch(started_at_ms=0)

    # 一度も受け取っていない `down` は、起動した時刻から続いている。
    assert watch.evaluate(2 * SECOND).since_ms == 0

    watch.record_beat(beat(t=1_000), now_ms=3 * SECOND)
    up_at = watch.evaluate(3 * SECOND)
    assert up_at.link == "up"
    assert up_at.since_ms == 3 * SECOND

    # 続いている間は動かない。
    watch.record_beat(beat(t=2_000), now_ms=4 * SECOND)
    assert watch.evaluate(4 * SECOND).since_ms == 3 * SECOND

    # 落ちた周期で動く。
    down = watch.evaluate(10 * SECOND)
    assert down.link == "down"
    assert down.since_ms == 10 * SECOND


def test_up_に戻ってまた落ちると_since_が変わる() -> None:
    """**次に落ちたときはまた鳴る**（`arbitration.md` の鍵の表）。"""
    watch = make_watch()
    watch.record_beat(beat(t=1_000), now_ms=1 * SECOND)
    first_down = watch.evaluate(10 * SECOND).since_ms

    watch.record_beat(beat(t=11_000), now_ms=11 * SECOND)
    watch.evaluate(11 * SECOND)
    second_down = watch.evaluate(20 * SECOND)

    assert second_down.link == "down"
    assert second_down.since_ms != first_down


def test_評価を呼ばずに時間が過ぎても落ちる() -> None:
    """**周期で呼ばれない環境を前提にしない。**

    `evaluate()` は呼ばれた時刻から引き直すので、間引かれても結果は同じになる。
    """
    watch = make_watch()
    watch.record_beat(beat(t=1_000), now_ms=1 * SECOND)

    assert watch.evaluate(60 * SECOND).link == "down"


def test_タイムアウトを差し替えても控えた心拍は消えない() -> None:
    # `config` の `beat_to` を書いた瞬間に link が down へ落ちないこと（#124）。
    # 落ちると、設定を1つ書いただけで「スマホが落ちた」と表示することになる。
    watch = LinkWatch(timeout_ms=3_000, stall_window_ms=5_000, started_at_ms=0)
    watch.record_beat(Beat(t=1_000, st="ok", mv=True), 1_000)
    watch.set_timeouts(timeout_ms=6_000, stall_window_ms=8_000)

    assert watch.evaluate(1_500).link == "up"
    # 新しいタイムアウトで測る（古い 3 秒なら down になっている頃）。
    assert watch.evaluate(5_000).link == "up"
    assert watch.evaluate(7_500).link == "down"
