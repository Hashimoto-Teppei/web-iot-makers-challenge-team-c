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
"""

import json
from dataclasses import dataclass
from typing import Literal, TypeGuard

Level = Literal[1, 2, 3]
BeatState = Literal["ok", "nofix"]

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
