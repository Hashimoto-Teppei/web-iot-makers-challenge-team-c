"""後方物体検知。**H / L の並びから「警告を出すか」を決める。**

**ハードウェアを知らない。** 入力は真偽値と時刻だけなので、開発機でも pytest から回せる
（`../../../../../docs/adr/0002-development-lifecycle.md`）。
GPIO を読むのは `../hw/rear_sensor.py` 側で、あちらは**いまの H / L を返すだけ**である。

**デバイスに残る唯一の検知である**（`../../../../../docs/adr/0006-decision-layer-on-mobile.md`）。
車車間の3検知はスマホへ移ったので、**スマホが落ちたとき・電波が無いとき・屋内で
生き残るのはこれだけ。**

**車車間の3検知（`apps/mobile` の TypeScript）とは別物**で、あちらの `DetectorInput` に
合わせにいかない（同 ADR）。入口が「デジタル1本の H / L」である以上、
自車と周辺車両の状態を受け取る形にはならない。

**センサーが差し替わっても、この形は変わらない。** 速度範囲がデモの条件（歩く速度）にしか
合っていないため方式ごと替わる可能性があるが（`../../../../../docs/unverified.md` 92）、
**「デジタル1本が H になったら接近」という入口は変わらない**ので、こことテストは残る。
"""

from dataclasses import dataclass

from device.alert import Level, Warn

# `kind` の識別子。**正本は `../../../../../docs/interfaces/ble-log-transfer.md`。**
# **短く `rear` と書き換えないこと**——同じ検知が2つの名前で D1 に入り、集計が割れる
# （`../../../../../docs/interfaces/detectors.md`）。
REAR_OBJECT_KIND = "rear_object"


@dataclass(frozen=True)
class RearConfig:
    """しきい値。**実値は `../config.py` にある**（呼び出し側が渡す）。

    **既定値をここに書かない**（`../notify.py` の `NotifyConfig` と同じ理由）。
    **検知距離はここに無い** ——基板の半固定抵抗 VR1 で決まり、
    **ツマミの位置が正本**である（`../../../../../docs/hardware.md`）。
    """

    # H がこれだけ続いたら「接近している」とみなす（ms）。
    on_ms: int
    # 1度出してから、次を出せるようになるまで（ms）。
    cooldown_ms: int
    # 出す `lv`。**デジタル1本では距離も速度も分からない**ので固定である
    # （`../../../../../docs/interfaces/detectors.md`「`lv` の意味」）。
    level: Level


class RearDetector:
    """H / L の並びを渡し続けると、接近1回につき `Warn` を1件返す。

    **毎周期 `update()` を呼ぶ**（`main.py` の `on_tick`）。発火した周期だけ `Warn` が返り、
    それ以外は `None` が返る。

    **`now_ms` を引数で受け取り、中で時計を呼ばない。** 同じ並びから同じ結果が出ないと
    pytest で確かめられない（`../notify.py` と同じ）。
    """

    def __init__(self, config: RearConfig) -> None:
        self._config = config
        # H が続き始めた時刻。L を見たら `None` に戻す。
        self._high_since_ms: int | None = None
        # 最後に出した時刻。**切れ目ではなく時間で抑える** ——ドップラーの出力は物体が
        # 動くたびに H / L を往復するので、**「L に落ちたら次を出してよい」にすると
        # 1回の接近で何度も鳴る**（`docs/notifications/arbitration.md` の保持時間とは別物で、
        # あちらは「出したものを消さない時間」、こちらは「次を出さない時間」）。
        self._fired_at_ms: int | None = None

    def update(self, high: bool, now_ms: int) -> Warn | None:
        """いまの入力を渡す。発火した周期だけ `Warn` を返す。"""
        if not high:
            self._high_since_ms = None
            return None

        if self._high_since_ms is None:
            self._high_since_ms = now_ms
        if now_ms - self._high_since_ms < self._config.on_ms:
            return None

        if self._fired_at_ms is not None and now_ms - self._fired_at_ms < self._config.cooldown_ms:
            return None

        self._fired_at_ms = now_ms
        return Warn(kind=REAR_OBJECT_KIND, lv=self._config.level)
