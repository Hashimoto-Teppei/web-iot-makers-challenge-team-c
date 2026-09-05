"""`config` の上書き（#124）。**実機も BLE も要らない**（`../../../docs/adr/0002-...`）。

**確かめるのは4つ**（`../../../docs/interfaces/ble-gatt.md`「`config`（Write）」）。
部分更新・知らないキーは無視・範囲外はそのキーだけ捨てる・切断で既定へ戻す。
"""

import json

import pytest

from device.config import LINK_BEAT_TIMEOUT_S, LINK_STALL_WINDOW_S, NOTIFY_CONFIG
from device.tuning import Rejected, Tuning


def make() -> Tuning:
    return Tuning(
        notify_config=NOTIFY_CONFIG,
        beat_timeout_s=LINK_BEAT_TIMEOUT_S,
        stall_window_s=LINK_STALL_WINDOW_S,
    )


def write(tuning: Tuning, payload: object) -> Rejected | None:
    return tuning.apply(json.dumps(payload).encode("utf-8"))


def test_起動直後は上書きが無い() -> None:
    tuning = make()
    assert tuning.cfg == {}
    assert tuning.notify_config == NOTIFY_CONFIG
    assert tuning.beat_timeout_ms == LINK_BEAT_TIMEOUT_S * 1_000
    assert tuning.stall_window_ms == LINK_STALL_WINDOW_S * 1_000


def test_保持時間を上書きすると調停の設定が変わる() -> None:
    tuning = make()
    assert write(tuning, {"hold2": 5_000}) is None
    assert tuning.cfg == {"hold2": 5_000}
    assert tuning.notify_config.hold_ms[2] == 5_000
    # **触っていない `lv` は既定のまま**（部分更新）。
    assert tuning.notify_config.hold_ms[1] == NOTIFY_CONFIG.hold_ms[1]


def test_送ったキーだけ差し替える() -> None:
    tuning = make()
    write(tuning, {"hold1": 2_000})
    write(tuning, {"hold3": 8_000})
    # **2通目が1通目を消さない。**全置換にすると、アプリが知らないキーを既定へ戻す。
    assert tuning.cfg == {"hold1": 2_000, "hold3": 8_000}


def test_知らないキーは無視して他を採用する() -> None:
    tuning = make()
    # **断らない。**デバイス側に項目が増えるたびに古いアプリが理由の欄を埋めるため。
    assert write(tuning, {"hold2": 5_000, "rear_cm": 120}) is None
    assert tuning.cfg == {"hold2": 5_000}


def test_範囲外はそのキーだけ捨てて理由を返す() -> None:
    tuning = make()
    rejected = write(tuning, {"hold2": 99_999, "hold1": 2_000})
    assert rejected is not None
    assert rejected.keys == ("hold2",)
    # **`status` に載せるのはキーの名前だけ。**理由を並べると Read 1回に収まらない
    # （`../../../docs/unverified.md` 44）。
    assert rejected.short == "config: hold2"
    assert "範囲外" in rejected.detail
    # **1つの誤りで全部を捨てない。**
    assert tuning.cfg == {"hold1": 2_000}


def test_真偽値は整数として通さない() -> None:
    # Python では `True` が `int` なので、素通しすると `beat_to` が 1 秒になる。
    tuning = make()
    assert write(tuning, {"beat_to": True}) is not None
    assert tuning.cfg == {}


def test_壊れた_JSON_は理由を返して何も変えない() -> None:
    tuning = make()
    write(tuning, {"hold2": 5_000})
    assert tuning.apply(b"{oops") is not None
    assert tuning.cfg == {"hold2": 5_000}


def test_beat_to_は窓も一緒に動かす() -> None:
    tuning = make()
    assert write(tuning, {"beat_to": 6}) is None
    assert tuning.beat_timeout_ms == 6_000
    # **窓をタイムアウト以下にしない。**届いているのに `t` が1通ぶん止まっただけで
    # `down` に落ちる（`../../../docs/interfaces/v2v.md`）。
    assert tuning.stall_window_ms > tuning.beat_timeout_ms
    assert tuning.stall_window_ms == 8_000


def test_既定と同じ値を書かれたら_cfg_から消える() -> None:
    # アプリは「既定に戻す」ために既定の値を書いてくる（`config` は部分更新なので、
    # 送らないと前の上書きが残る）。**残すと、戻せたのかセントラルから分からない。**
    tuning = make()
    write(tuning, {"hold2": 5_000})
    assert write(tuning, {"hold2": NOTIFY_CONFIG.hold_ms[2]}) is None
    assert tuning.cfg == {}
    assert tuning.notify_config.hold_ms[2] == NOTIFY_CONFIG.hold_ms[2]


def test_切断で既定へ戻る() -> None:
    tuning = make()
    write(tuning, {"hold2": 5_000, "beat_to": 8})
    tuning.reset()
    assert tuning.cfg == {}
    assert tuning.notify_config == NOTIFY_CONFIG
    assert tuning.beat_timeout_ms == LINK_BEAT_TIMEOUT_S * 1_000
    assert tuning.stall_window_ms == LINK_STALL_WINDOW_S * 1_000


def test_断った理由は次の書き込みで消える() -> None:
    # `last_error` は「直近で断った理由」であって、断ったことがある記録ではない
    # （`../../../docs/interfaces/ble-gatt.md`「`status`」）。**消す判断は `main.py`**
    # だが、そこが判断できるように**成功したときは `None` を返す。**
    tuning = make()
    assert write(tuning, {"hold2": 99_999}) is not None
    assert write(tuning, {"hold2": 5_000}) is None


def test_知らないキーを足したときに既定が引けないと落ちる() -> None:
    # `_LIMITS` にキーを足して `_default` を直し忘れると、**書けているのに `cfg` から
    # 消える**（別の項目の既定と比べるため）。黙って通さず、ここで落ちること。
    tuning = make()
    with pytest.raises(KeyError):
        tuning._set("rear_cm", 3)  # pyright: ignore[reportPrivateUsage]
