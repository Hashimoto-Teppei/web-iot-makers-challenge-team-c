"""スマホから `alert` に書かれた1通を読み解く。

**BLE を知らない。** バイト列を受け取って中身を返すだけなので、開発機でも pytest から回せる
（`../../README.md`「それぞれの約束」）。BlueZ を触るのは `hw/ble.py` 側で、
あちらは受け取ったバイト列をここへ渡すだけ。

**メッセージの正本は `../../../../docs/interfaces/v2v.md`「デバイスへ渡すもの」**、
GATT の約束は `../../../../docs/interfaces/ble-gatt.md`「`alert`（Write）」。
**ここで形を決め直さない。**

流れてくるのは2種類だけである。**位置も周辺車両も届かない**
（`../../../../docs/adr/0006-decision-layer-on-mobile.md`）。

    {"k":"warn","kind":"approach","lv":2}
    {"k":"beat","t":1756123456789,"st":"ok","mv":false}

**心拍が途切れたことに気づく `LinkWatch` も、このファイルにある**（`../../README.md` の表）。
読み解いた `beat` をそのまま渡す先なので、同じ境界のものとして1か所に置く。
**こちらも BLE を知らない**（時刻は引数で受け取る）ので、開発機で pytest から回せる。
"""

import json
from collections import deque
from dataclasses import dataclass
from typing import Literal, TypeGuard

Level = Literal[1, 2, 3]
BeatState = Literal["ok", "nofix"]

# スマホが生きているか（`../../../../docs/interfaces/v2v.md`「心拍を必ず見せる」）。
#
# **`status` の項目としての意味は `state.py` にあるが、値を決めるのはここ**なので、
# 定義もここに置いて `state.py` から import する。**同じ Literal を2か所に書かない。**
Link = Literal["up", "nofix", "down"]

# スマホから届きうる `kind`。**正本は `../../../../docs/interfaces/detectors.md`。**
#
# **`rear_object` を入れない。** あれはデバイスの中で起きる検知で、BLE を通らない
# （同ファイル「`kind` の一覧」）。ここに入れると、外から偽の後方物体警告を書き込めてしまう。
# ペアリングしていないので誰でも書ける状態ではあるが（`ble-gatt.md`「ペアリング・認証」）、
# **通らないと分かっている経路を自分から開けない。**
KNOWN_WARN_KINDS = frozenset({"approach", "brake", "corner", "stop"})

# 受け取った値を `Level` / `BeatState` に移すための表。
# **`in` で確かめるだけでは型が絞れない**ので、引き当てる形にしてある。
_LEVELS: dict[int, Level] = {1: 1, 2: 2, 3: 3}
# `nofix` は「測位できていない」。**異常ではない**（屋内では出続けるのが正常）。
_BEAT_STATES: dict[str, BeatState] = {"ok": "ok", "nofix": "nofix"}


@dataclass(frozen=True)
class Warn:
    """表示・再生する内容。**検知が発火したときだけ来る。**"""

    kind: str
    lv: Level


@dataclass(frozen=True)
class Beat:
    """心拍。**毎秒1回、検知が起きていなくても来る。**

    止まったことが「スマホが落ちた」と判断する唯一の根拠になる
    （`../../../../docs/interfaces/v2v.md`「心拍を必ず見せる」）。
    """

    t: int
    st: BeatState
    mv: bool


@dataclass(frozen=True)
class AlertResult:
    """1通を読み解いた結果。

    **`status` の2つの数え方が違う**ので、分けて返す（`ble-gatt.md`「`status`」）。

    - `dropped` に数えるのは**壊れているものだけ**（壊れた JSON・知らない `k`・
      必須の項目が欠けている・値の範囲外）
    - **知らない `kind` の `warn` は壊れていない。** アプリ側が検知を1つ足しただけで
      毎回出るので、混ぜると**異常に気づくための数として使えなくなる**
    """

    # 採用したもの。捨てたときは None。
    message: Warn | Beat | None
    # 壊れているとして `status` の `dropped` に数えるか。
    dropped: bool
    # 捨てた理由。**ログに出すためだけのもので、`status` には載せない**
    # （`alert` は毎秒流れるので、`last_error` に入れると転送の診断が毎秒上書きされる。
    # `ble-gatt.md`「`alert`（Write）」）。
    reason: str | None = None


def parse_alert(payload: bytes) -> AlertResult:
    """`alert` に書かれた1通を読み解く。**例外を投げない。**

    壊れた1通で落ちると、**そこで警告の入口ごと止まる。**
    判断がスマホへ移った以上、`alert` はデバイスが警告を出せる唯一の入口である
    （`../../../../docs/adr/0006-decision-layer-on-mobile.md`）。
    """
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return _drop("UTF-8 として読めない")

    try:
        body = json.loads(text)
    except ValueError:
        return _drop("JSON として読めない")

    if not isinstance(body, dict):
        return _drop("JSON オブジェクトではない")

    k = body.get("k")
    if k == "warn":
        return _parse_warn(body)
    if k == "beat":
        return _parse_beat(body)
    return _drop(f"知らない k: {k!r}")


def _parse_warn(body: dict[str, object]) -> AlertResult:
    """`warn` を読み解く。必須は `k` / `kind` / `lv`（`v2v.md`「デバイスへ渡すもの」）。"""
    kind = body.get("kind")
    if not isinstance(kind, str):
        return _drop("warn に kind が無い")

    raw_lv = body.get("lv")
    if not _is_int(raw_lv):
        return _drop("warn に lv が無い")

    lv = _LEVELS.get(raw_lv)
    if lv is None:
        return _drop(f"lv が範囲外: {raw_lv!r}")

    if kind not in KNOWN_WARN_KINDS:
        # **壊れてはいない。** アプリ側が検知を1つ足しただけでも起きる（上の `AlertResult`）。
        # 出す記号が無いので採らないだけ（`../../../../docs/notifications/arbitration.md`）。
        return _ignore(f"知らない kind: {kind!r}")

    return AlertResult(message=Warn(kind=kind, lv=lv), dropped=False)


def _parse_beat(body: dict[str, object]) -> AlertResult:
    """`beat` を読み解く。必須は `k` / `t` / `st`。**`mv` は任意**（`v2v.md`）。"""
    t = body.get("t")
    if not _is_int(t):
        # **`t` はデバイスがログに時刻を打つ唯一の供給源**なので必須にする（`v2v.md`）。
        return _drop("beat に t が無い")

    raw_st = body.get("st")
    st = _BEAT_STATES.get(raw_st) if isinstance(raw_st, str) else None
    if st is None:
        # **`st` が無いと `nofix` と `ok` が区別できず、測位が無いだけの状態が健全に見える**
        # （`v2v.md`）。だからここも必須にする。
        return _drop(f"beat の st が不正: {raw_st!r}")

    # **`t` の中身は見ない。** 未来でも過去でも捨てない。
    # 捨てると `link` が `down` に落ち、**ずれた時計を持っているだけの端末に対して
    # 「スマホが落ちた」と表示する**ことになる。
    # 時計が固まっていないかは `beat` を1点ずつ見るのではなく**一定の窓の中で**確かめる
    # （#36。`v2v.md`「`link` を決めるときに外してはいけないこと」）。

    # **`mv` が無い・真偽値でないときは「走行中」として扱い、beat ごと捨てない。**
    #
    # ここを必須にすると、**`mv` を載せ忘れた beat が1通残らず捨てられ、`link` が `down` に落ちる**
    # ——スマホは正常に動いているのに「落ちた」と言い続ける、この境界で一番避けたい形になる
    # （`v2v.md`「デバイスへ渡すもの」）。
    # 走行中に倒すのは `../../../../docs/notifications.md`「迷ったら走行中に倒す」に従う。
    raw_mv = body.get("mv")
    mv = raw_mv if isinstance(raw_mv, bool) else True

    return AlertResult(message=Beat(t=t, st=st, mv=mv), dropped=False)


@dataclass(frozen=True)
class LinkStatus:
    """いまスマホとどうつながっているか。`LinkWatch.evaluate()` が返す。"""

    link: Link
    # いまの `link` になった時刻（`evaluate()` に渡した時刻の目盛り）。
    # **通信断のチャイムを1回だけ鳴らすための鍵に使う**
    # （`../../../../docs/notifications/arbitration.md`「鳴らしたことを鍵の集合で持つ」）。
    since_ms: int
    # 走行中か。**`link` が `up` でない間は必ず True**（下の `_moving`）。
    moving: bool


class LinkWatch:
    """心拍のウォッチドッグ。**`beat` が届いているかだけを見て `link` を決める。**

    **この方式で一番危ないのは、静かに止まることである**
    （`../../../../docs/adr/0006-decision-layer-on-mobile.md`）。判断そのものがスマホへ移ったので、
    スマホが落ちるとデバイスから見て「警告が来ていない」＝「今日は危険が無い」に見える。
    **それを「落ちた」と言えるようにするのがここ。**

    仕様は `../../../../docs/interfaces/v2v.md`「心拍を必ず見せる」。**決め直さない。**
    外してはいけない4つが向こうに書いてあり、この実装はそれぞれ次で守っている。

    | 外してはいけないこと | ここでの守り方 |
    | --- | --- |
    | `up` から始めない | `_last_beat` が `None` の間は `down`（初期値を `up` にしない） |
    | `warn` を根拠にしない | 受け口が `record_beat()` だけで、**`Beat` しか受け取らない** |
    | `nofix` を旗にしない | 毎回**直近の `beat` の `st`** から引き直す（`nofix` を覚えない） |
    | `t` が進んでいるかも見る | **窓の中で**見る（`_stalled`）。1点を基準に控えない |

    **時刻は引数で受け取る。** 中で `time` を呼ぶと**同じ入力で結果が変わってテストが書けない**
    （`../../../../docs/notifications/arbitration.md`「調停の関数の形」と同じ理由）。
    渡すのは**単調時計のミリ秒**にすること —— デバイスに RTC は無く、`beat` の `t` は
    スマホの壁時計なので、**経過時間の計測にどちらも使えない。**
    """

    def __init__(self, *, timeout_ms: int, stall_window_ms: int, started_at_ms: int) -> None:
        """
        Args:
            timeout_ms: 最後の `beat` からこれを超えて空いたら `down`。
                **`beat` は毎秒1通**なので、何通ぶん落ちるまで待つかを決める値になる
            stall_window_ms: `t` が進んでいるかを見る窓の長さ。
                **この窓いっぱい同じ `t` が続いたときだけ**「固まっている」と見なす
            started_at_ms: 起動した時刻。**まだ一度も `beat` が来ていない `down` がいつからか**を
                答えられるようにするために要る（`since_ms` の初期値）
        """
        self._timeout_ms = timeout_ms
        self._stall_window_ms = stall_window_ms
        self._last_beat: Beat | None = None
        self._last_beat_at_ms: int | None = None
        # 窓の中の `(受け取った時刻, beat の t)`。**`t` が進んでいるかを見るためだけ**に持つ。
        self._recent: deque[tuple[int, int]] = deque()
        # **`up` から始めない**（`v2v.md`）。一度も `beat` を受け取っていない状態を健全に見せない。
        self._link: Link = "down"
        self._since_ms = started_at_ms

    def record_beat(self, beat: Beat, now_ms: int) -> None:
        """`beat` を1通受け取ったことを控える。

        **受け取るのは `Beat` だけ。** `Warn` を渡せないようにしてあるのは、
        **警告の到着を生存の根拠にしない**ため（`v2v.md`）。警告は**来ないのが正常**なので、
        混ぜると**静かなときと落ちたときが区別できなくなる。**

        **`t` の中身を検証しない。** ここで未来や過去の `t` を弾くと、
        **時計がずれているだけの端末に対して「スマホが落ちた」と表示する**ことになる。
        見るのは「窓の中で進んでいるか」だけ（`_stalled`）。
        """
        self._last_beat = beat
        self._last_beat_at_ms = now_ms
        self._recent.append((now_ms, beat.t))
        self._prune(now_ms)

    def evaluate(self, now_ms: int) -> LinkStatus:
        """いまの `link` を出す。**呼ぶたびに引き直す。**

        **周期的に呼ぶこと。** `beat` が来たときだけ呼ぶ作りにすると、
        **来なくなったことに永久に気づけない** —— それがこの仕組みの目的そのものである。
        """
        self._prune(now_ms)
        link = self._link_at(now_ms)
        if link != self._link:
            self._link = link
            self._since_ms = now_ms
        return LinkStatus(link=link, since_ms=self._since_ms, moving=self._moving(link))

    def _link_at(self, now_ms: int) -> Link:
        """いまの `link`。**直近の `beat` から毎回引き直す**（旗を立てない）。"""
        beat = self._last_beat
        if beat is None or self._last_beat_at_ms is None:
            # まだ一度も届いていない。**スマホがつながる前を `up` にしない。**
            return "down"
        if now_ms - self._last_beat_at_ms > self._timeout_ms:
            # 届かなくなった。アプリが落ちたか、BLE が切れたか（人がすることは「端末を見る」）。
            return "down"
        if self._stalled(now_ms):
            # 届いてはいるが `t` が動いていない。**値の検証では気づけない止まり方**
            # （`v2v.md`「`t` が進んでいるかも見る」）。
            # **`nofix` ではなく `down` にする。** 待って直るものではないので、
            # 人がすべきことは「端末を見る」側である（`v2v.md`「心拍を必ず見せる」）。
            return "down"
        # **`nofix` を覚えない。** 見るのは直近の `beat` がどちらだったかだけ。
        # 旗にすると**再起動するまで `up` に戻らない**（`v2v.md`）。
        return "up" if beat.st == "ok" else "nofix"

    def _moving(self, link: Link) -> bool:
        """走行中として扱うか。

        **`link` が `up` でなければ走行中に倒す。** 速度を持っているのはスマホだけなので、
        心拍が来ていない間は走っているか止まっているか分からない。ここを「停止中」に倒すと
        **通信が切れた瞬間に走行中の画面へ文章が出て**、防ごうとしている「ながら運転」を
        こちらから作り込むことになる（`../../../../docs/notifications.md`「迷ったら走行中に倒す」）。
        """
        beat = self._last_beat
        if link != "up" or beat is None:
            return True
        return beat.mv

    def _prune(self, now_ms: int) -> None:
        """窓から出た控えを捨てる。**境界の1つ手前は残す。**

        窓より古いものを全部捨てると、**残った控えは必ず窓より新しくなり**、
        「窓いっぱい同じ `t` が続いた」が永久に成立しない（`_stalled` が発火しなくなる）。
        """
        limit = now_ms - self._stall_window_ms
        while len(self._recent) >= 2 and self._recent[1][0] <= limit:
            self._recent.popleft()

    def _stalled(self, now_ms: int) -> bool:
        """`t` が固まっているか。**窓の中だけを見る。**

        **「控えた1点の `t` より進んだか」で書かないこと**（`v2v.md`）。
        変な値を1通採用した瞬間に基準がそこで固まり、**再起動まで戻らなくなる。**
        窓の中の広がりで見れば、**新しい `t` が1通来た時点で自然に戻る。**
        """
        if len(self._recent) < 2:
            # 1通しか無ければ「進んでいない」とは言えない（`beat` は毎秒1通しか来ない）。
            return False
        oldest_at_ms = self._recent[0][0]
        if now_ms - oldest_at_ms < self._stall_window_ms:
            # まだ窓ぶん溜まっていない。**足りない窓で判定しない。**
            return False
        # **前に進んだかではなく、動いたかを見る。** 巻き戻った `t`（時計合わせ）も
        # 「動いている」として通す —— ずれた時計を「落ちた」と表示しないため。
        return len({t for _, t in self._recent}) == 1


def _drop(reason: str) -> AlertResult:
    """壊れているとして捨てる。`status` の `dropped` に数える。"""
    return AlertResult(message=None, dropped=True, reason=reason)


def _ignore(reason: str) -> AlertResult:
    """捨てるが、壊れてはいない。**`dropped` に数えない。**"""
    return AlertResult(message=None, dropped=False, reason=reason)


def _is_int(value: object) -> TypeGuard[int]:
    """真偽値でない整数か。

    Python では `True` が `int` のサブクラスなので、素朴に `isinstance(x, int)` と書くと
    `{"lv": true}` が通ってしまう。**`lv` が 1 と読まれて警告が出る**ので、先に弾く。
    """
    return isinstance(value, int) and not isinstance(value, bool)
