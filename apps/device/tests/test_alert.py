"""alert.py のテスト。BLE を使わないので開発機でも回せる。

**捨てる条件は `docs/interfaces/v2v.md`「デバイスへ渡すもの」の必須項目の表が正本。**
勝手に必須を増やすと**健全な `beat` を捨てて `link` が `down` に落ちる**ので、
「捨ててはいけないもの」のテストを厚めに置いてある。
"""

import json

import pytest

from device.alert import Beat, Warn, parse_alert


def _write(payload: object) -> bytes:
    """スマホが `alert` に書くのと同じ形（隙間の無い JSON、UTF-8）にする。"""
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


# ---------------------------------------------------------------- warn


def test_warnを受け取る() -> None:
    # docs/interfaces/v2v.md「デバイスへ渡すもの」の例そのもの。
    result = parse_alert(b'{"k":"warn","kind":"approach","lv":2}')

    assert result.message == Warn(kind="approach", lv=2)
    assert result.dropped is False


@pytest.mark.parametrize("kind", ["approach", "brake", "corner", "stop"])
def test_スマホから来る4つのkindを受け取る(kind: str) -> None:
    # 一覧の正本は docs/interfaces/detectors.md「kind の一覧」。
    result = parse_alert(_write({"k": "warn", "kind": kind, "lv": 1}))

    assert result.message == Warn(kind=kind, lv=1)


def test_rear_objectはBLEを通らないので採らない() -> None:
    # デバイスの中で起きる検知であり、スマホ側の実装がこの値を送ることは無い
    # （docs/interfaces/detectors.md）。**壊れてはいないので dropped に数えない。**
    result = parse_alert(_write({"k": "warn", "kind": "rear_object", "lv": 3}))

    assert result.message is None
    assert result.dropped is False


def test_知らないkindはdroppedに数えない() -> None:
    # アプリ側が検知を1つ足しただけで毎回出るので、混ぜると**異常に気づくための数として
    # 使えなくなる**（docs/interfaces/ble-gatt.md「status」）。
    result = parse_alert(_write({"k": "warn", "kind": "door", "lv": 1}))

    assert result.message is None
    assert result.dropped is False
    assert result.reason is not None


@pytest.mark.parametrize("lv", [0, 4, -1, 100])
def test_lvが範囲外なら壊れているとして捨てる(lv: int) -> None:
    result = parse_alert(_write({"k": "warn", "kind": "approach", "lv": lv}))

    assert result.message is None
    assert result.dropped is True


def test_lvがtrueなら捨てる() -> None:
    # Python では True が int のサブクラスなので、素朴に書くと **lv が 1 と読まれて警告が出る。**
    result = parse_alert(_write({"k": "warn", "kind": "approach", "lv": True}))

    assert result.message is None
    assert result.dropped is True


@pytest.mark.parametrize(
    "body",
    [
        {"k": "warn", "lv": 2},  # kind が無い
        {"k": "warn", "kind": "approach"},  # lv が無い
        {"k": "warn", "kind": 1, "lv": 2},  # kind が文字列でない
        {"k": "warn", "kind": "approach", "lv": "2"},  # lv が数値でない
    ],
)
def test_warnの必須が欠けていたら捨てる(body: dict[str, object]) -> None:
    result = parse_alert(_write(body))

    assert result.message is None
    assert result.dropped is True


# ---------------------------------------------------------------- beat


def test_beatを受け取る() -> None:
    result = parse_alert(b'{"k":"beat","t":1756123456789,"st":"ok","mv":false}')

    assert result.message == Beat(t=1756123456789, st="ok", mv=False)
    assert result.dropped is False


def test_nofixのbeatを受け取る() -> None:
    # **屋内では nofix が出続けるのが正常**（docs/interfaces/v2v.md）。故障として扱わない。
    result = parse_alert(_write({"k": "beat", "t": 1, "st": "nofix", "mv": True}))

    assert result.message == Beat(t=1, st="nofix", mv=True)
    assert result.dropped is False


def test_mvが無いbeatは走行中として受け取る() -> None:
    # **mv を必須にすると、載せ忘れた beat が1通残らず捨てられて link が down に落ちる**
    # ——スマホは動いているのに「落ちた」と言い続ける、この境界で一番避けたい形
    # （docs/interfaces/v2v.md）。走行中に倒すのは docs/notifications.md に従う。
    result = parse_alert(_write({"k": "beat", "t": 1756123456789, "st": "ok"}))

    assert result.message == Beat(t=1756123456789, st="ok", mv=True)
    assert result.dropped is False


@pytest.mark.parametrize("mv", ["yes", 1, None, {}])
def test_mvが真偽値でなくてもbeatを捨てない(mv: object) -> None:
    # 同上。**mv1つのために心拍を落とさない。**
    result = parse_alert(_write({"k": "beat", "t": 1, "st": "ok", "mv": mv}))

    assert result.message == Beat(t=1, st="ok", mv=True)
    assert result.dropped is False


@pytest.mark.parametrize("t", [0, -1, 1, 99999999999999])
def test_tの値がおかしくてもbeatを捨てない(t: int) -> None:
    # 時計がずれているだけの端末を「落ちた」と表示しないため、**t の妥当さは見ない。**
    # 時計が固まっていないかは #36 のウォッチドッグが一定の窓の中で見る
    # （docs/interfaces/v2v.md「link を決めるときに外してはいけないこと」）。
    result = parse_alert(_write({"k": "beat", "t": t, "st": "ok"}))

    assert result.message == Beat(t=t, st="ok", mv=True)
    assert result.dropped is False


@pytest.mark.parametrize(
    "body",
    [
        {"k": "beat", "st": "ok"},  # t が無い
        {"k": "beat", "t": 1},  # st が無い
        {"k": "beat", "t": 1, "st": "OK"},  # st の綴りが違う
        {"k": "beat", "t": 1, "st": "fix"},  # 知らない st
        {"k": "beat", "t": "1756123456789", "st": "ok"},  # t が文字列
        {"k": "beat", "t": True, "st": "ok"},  # t が真偽値
    ],
)
def test_beatの必須が欠けていたら捨てる(body: dict[str, object]) -> None:
    # t が無いとログに時刻を打てず、st が無いと nofix と ok が区別できない
    # （docs/interfaces/v2v.md）。**この2つだけは必須。**
    result = parse_alert(_write(body))

    assert result.message is None
    assert result.dropped is True


# ---------------------------------------------------------------- 壊れているもの


@pytest.mark.parametrize(
    "payload",
    [
        b"",  # 空
        b"{",  # 途中で切れた JSON
        b'{"k":"warn",}',  # 壊れた JSON
        b"[1,2,3]",  # オブジェクトでない
        b'"warn"',  # 同上
        b"42",  # 同上
        b"\xff\xfe",  # UTF-8 として読めない
    ],
)
def test_壊れた1通は捨ててdroppedに数える(payload: bytes) -> None:
    result = parse_alert(payload)

    assert result.message is None
    assert result.dropped is True
    assert result.reason is not None


@pytest.mark.parametrize("k", ["uplink", "ping", "", None, 1])
def test_知らないkは捨ててdroppedに数える(k: object) -> None:
    # `uplink` は 0006 で消えた古い名前。**proto を上げてあるので、来たら不一致である**
    # （docs/interfaces/ble-gatt.md）。
    result = parse_alert(_write({"k": k, "t": 1}))

    assert result.message is None
    assert result.dropped is True


def test_kが無ければ捨てる() -> None:
    result = parse_alert(_write({"kind": "approach", "lv": 2}))

    assert result.message is None
    assert result.dropped is True


def test_知らないキーがあっても捨てない() -> None:
    # **知らないキーは無視する**（docs/interfaces/ble-gatt.md「書き込みを受ける側の約束」）。
    # ここで捨てると、アプリ側が項目を1つ足しただけで警告が届かなくなる。
    result = parse_alert(_write({"k": "warn", "kind": "approach", "lv": 2, "seq": 7}))

    assert result.message == Warn(kind="approach", lv=2)
    assert result.dropped is False


def test_例外を投げない() -> None:
    # 壊れた1通で落ちると、**そこで警告の入口ごと止まる**
    # （docs/adr/0006-decision-layer-on-mobile.md）。
    for payload in [b"", b"\x00" * 200, b"null", b"{}", b'{"k":null}']:
        parse_alert(payload)  # 例外が出たらここで落ちる
