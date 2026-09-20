"""後方物体検知（`detect/rear_object.py` / `hw/rear_sensor.py`）のテスト。

**実機も GPIO も要らない。** H / L の並びと時刻を渡すだけで発火を確かめられる
（`../../../docs/adr/0002-development-lifecycle.md`。これが満たせないと開発が止まる）。

守っているものの正本は `../../../docs/hardware.md`「後方物体検知」と
`../../../docs/notifications/arbitration.md`。**ここで仕様を決め直さない。**
"""

from device.detect.rear_object import REAR_OBJECT_KIND, RearConfig, RearDetector
from device.hw.rear_sensor import RearSensor, open_rear_sensor

# **テストの中で `config.py` の実値を使わない。** あちらは実地で動かす値なので、
# 変えたとたんにここが落ちると「しきい値を触れないテスト」になる。
CONFIG = RearConfig(on_ms=2_000, cooldown_ms=5_000, level=2)

# 読む間隔（ms）。実機は毎秒1回（`config.LINK_TICK_INTERVAL_S`）。
TICK_MS = 1_000


def _run(pattern: list[bool], config: RearConfig = CONFIG) -> list[int]:
    """H / L の並びを 1 秒間隔で流し、**発火した周期の番号**を返す。"""
    detector = RearDetector(config)
    fired: list[int] = []
    for i, high in enumerate(pattern):
        warn = detector.update(high, i * TICK_MS)
        if warn is not None:
            assert warn.kind == REAR_OBJECT_KIND
            assert warn.lv == config.level
            fired.append(i)
    return fired


def test_H_が続いたら発火する() -> None:
    # 0 秒から H。**2 秒続いた周期**で出る（`on_ms=2000`）。
    assert _run([True] * 3) == [2]


def test_一瞬の_H_では発火しない() -> None:
    # ドップラーは物体が動くたびに H / L を往復するので、1 周期の H はノイズとして捨てる。
    assert _run([False, True, False, True, False]) == []


def test_1回の接近で1件しか出ない() -> None:
    # **チャタリングで連発しないこと**（#152 の完了条件）。
    # H を出し続けても、`cooldown_ms=5000` の間は次が出ない。
    assert _run([True] * 6) == [2]


def test_途中で_L_を挟んでも連発しない() -> None:
    # H / L を往復させる——**L に落ちたことを「次を出してよい」の根拠にしない**
    # （根拠にすると、往復のたびに測り直して鳴り続ける）。
    assert _run([True, True, True, False, True, True, True]) == [2]


def test_接近が続く間はクールダウンの間隔でしか出ない() -> None:
    # **止めない。** 後ろにいる相手が居続けるなら、保持時間（`arbitrate()` 側）が切れたあとも
    # 出し直さないと「危険が去った」ように見える。**間隔は `cooldown_ms` で決まる。**
    assert _run([True] * 11) == [2, 7]


def test_離れて近づき直せば次が出る() -> None:
    # クールダウンを越えて近づき直したときは、**出さないと危険が伝わらない。**
    pattern = [True, True, True] + [False] * 5 + [True, True, True]
    assert _run(pattern) == [2, 10]


def test_センサーが載っていなければ常に非検知() -> None:
    # `REAR_SENSOR_GPIO = None` で、**開発機でも落ちずに動く**（#152 の完了条件）。
    sensor = open_rear_sensor(None)
    assert sensor.is_high() is False


def test_GPIO_の値をそのまま返す() -> None:
    class FakeInput:
        def __init__(self) -> None:
            self.is_active = False

    pin = FakeInput()
    sensor = RearSensor(pin)
    assert sensor.is_high() is False
    pin.is_active = True
    assert sensor.is_high() is True


def test_読むより前に消えた_H_を取りこぼさない() -> None:
    """**裏スレッドが見た H は、次に読むまで残る**（2026-09-20 の実測。`docs/unverified.md` 103）。

    ドップラーの出力は 0.2〜1.3 秒しか続かないのに、読むのは毎秒1回である。
    **掛け金が無いと、周期の合間に立って消えた H はそのまま落ちる。**
    """

    class FakeInput:
        def __init__(self) -> None:
            self.is_active = False

    pin = FakeInput()
    sensor = RearSensor(pin)

    # 周期と周期の間に H が立って、読む前に消えた。
    pin.is_active = True
    sensor.sample()
    pin.is_active = False

    assert sensor.is_high() is True
    # **読んだら倒す。** 残したままだと、1回の H が毎周期の警告に化ける。
    assert sensor.is_high() is False


def test_クールダウンが保持時間より短い() -> None:
    """**実値どうしの関係だけを見る。**値そのものは実地で動かしてよい。

    逆転すると、**後ろに物体が居続けている間に表示と光が 1 周期まるごと消える**
    ——保持が切れてから次の発火までの隙間で、`arbitrate()` が何も出さない周期ができる。
    **片方だけ動かしたときに黙って起きる**ので、ここで留める。
    """
    from device import config

    hold_ms = config.NOTIFY_CONFIG.hold_ms[config.REAR_CONFIG.level]
    assert config.REAR_CONFIG.cooldown_ms < hold_ms


def test_gpiozero_の_InputDevice_を使う() -> None:
    """**`DigitalInputDevice` を使わない。**

    あれは `when_activated` のために**エッジ検出を有効にし、その実装が sysfs の
    `/sys/class/gpio/export` を叩く**が、**いまのカーネルに sysfs GPIO は無い。**
    `OSError: [Errno 22]` で **`main.py` の起動ごと止まる**（実機で2回踏んだ）。

    **`REAR_SENSOR_GPIO = None` のテストでは捕まらない**——あちらは gpiozero を
    import しないため。**偽の gpiozero を差し込んで、何を呼ぶかだけを見る。**
    """
    import sys
    import types

    calls: list[tuple[int, bool]] = []

    class FakeInputDevice:
        def __init__(self, pin: int, pull_up: bool = False) -> None:
            calls.append((pin, pull_up))
            self.is_active = False

    class FakeDigitalInputDevice:
        def __init__(self, *args: object, **kwargs: object) -> None:
            raise AssertionError("DigitalInputDevice を使ってはいけない（sysfs GPIO を叩く）")

    fake = types.ModuleType("gpiozero")
    fake.InputDevice = FakeInputDevice  # pyright: ignore[reportAttributeAccessIssue]
    fake.DigitalInputDevice = FakeDigitalInputDevice  # pyright: ignore[reportAttributeAccessIssue]
    sys.modules["gpiozero"] = fake
    try:
        sensor = open_rear_sensor(27)
    finally:
        del sys.modules["gpiozero"]

    # **内部プルダウン**（`pull_up=False`）。線が外れたら L へ落ちる。
    assert calls == [(27, False)]
    assert sensor.is_high() is False
