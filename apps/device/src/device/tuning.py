"""`config` で受け取る、走行ごとのしきい値の上書き（#124）。

**BLE を知らない。** バイト列を受け取って解釈するだけなので、開発機でも pytest から回せる
（`../../README.md`「それぞれの約束」）。BlueZ を触るのは `hw/ble.py` 側で、
あちらは受け取ったバイト列をここへ渡すだけ。

**仕様の正本は `../../../../docs/interfaces/ble-gatt.md`「`config`（Write）」。**
**ここで決め直さない。**外してはいけないのは次の4つ。

| 外してはいけないこと | ここでの守り方 |
| --- | --- |
| 部分更新（送ったキーだけ差し替える） | `apply()` は届いたキーだけを触る |
| 知らないキーは無視する | `_LIMITS` に無いキーは黙って捨てる（断らない） |
| 範囲外はそのキーだけ捨てる | キーごとに見て、他のキーは採用する |
| 保存しない（切断で既定へ戻す） | 持つのはメモリだけ。戻すのは `reset()` |

**既定値をここに書かない。** 実値は `config.py` にあり、この型は受け取った値と突き合わせる
だけである（`../../README.md`「しきい値をコードに直書きしない」）。
**ここにあるのは範囲**で、これは実地で変える値ではなく**境界の約束**（上のドキュメント）。
"""

import json
from dataclasses import dataclass, replace

from device.notify import Level, NotifyConfig

# 上書きできるキーと、その範囲（両端を含む）。**正本は `ble-gatt.md`。**
#
# **範囲は「下端でも警告が出る」ように切ってある。**どちらも**遅くなる方向にしか
# 動かせず、黙らせることはできない** —— これは値の選び方ではなく、
# **いまペアリング無しで済んでいることの根拠そのもの**である
# （`../../../../docs/interfaces/ble-security.md`）。**広げるときは向こうを開くこと。**
_LIMITS: dict[str, tuple[int, int]] = {
    "hold1": (1_000, 10_000),
    "hold2": (1_000, 10_000),
    "hold3": (1_000, 10_000),
    "beat_to": (2, 10),
}

# `beat_to` を受け取ったとき、`t` の窓をどれだけ長く取るか（秒）。
#
# **窓をタイムアウト以下にしない。** 等しくすると、**届いているのに `t` が1通ぶん
# 止まっただけで `down` に落ちる**（`../../../../docs/interfaces/v2v.md`
# 「`t` が進んでいるかも見る」）。**片方だけ動かせる形にしない**——書ける値を2つにすると、
# 組み合わせの半分が壊れた設定になる（`ble-gatt.md`「`config`」）。
_STALL_MARGIN_S = 2

# `hold1` / `hold2` / `hold3` が指す `lv`。
_HOLD_KEYS: dict[str, Level] = {"hold1": 1, "hold2": 2, "hold3": 3}


@dataclass(frozen=True)
class Rejected:
    """断ったぶんの知らせ。**`status` に載せる短い方と、ログに出す詳しい方に分ける。**

    **`status` に長い文字列を載せない。**理由を並べると、`cfg` と合わせて
    **1回の Read（MTU 247 なら 244 バイト）を超え、JSON ごと切り詰められる**
    ——`link` も `warns` も読めなくなり、**「デバイスが黙った」と区別が付かない**
    （`../../../../docs/unverified.md` 44）。**キーの名前だけで、どれが落ちたかは伝わる。**
    """

    keys: tuple[str, ...]
    # 何が悪かったか。**journalctl だけが読む**（人が原因を追うため）。
    detail: str

    @property
    def short(self) -> str:
        """`status` の `last_error` に載せる形。**長さがキーの数で決まる。**"""
        return "config: " + ",".join(self.keys)


class Tuning:
    """いま効いている上書きと、そこから決まる実際の値。

    **判定を呼ぶ側に書かせない。**`main.py` は「書かれたバイト列を渡す」「値を読む」
    「切れたら戻す」の3つだけを行う。
    """

    def __init__(
        self, *, notify_config: NotifyConfig, beat_timeout_s: int, stall_window_s: int
    ) -> None:
        """
        Args:
            notify_config: 上書きしていないときの警告の設定（`config.py` の `NOTIFY_CONFIG`）
            beat_timeout_s: 上書きしていないときの心拍のタイムアウト（秒）
            stall_window_s: 上書きしていないときの `t` の窓（秒）。
                **`beat_to` を受け取ったら、この値ではなく `beat_to + 2` になる**
        """
        self._base_notify = notify_config
        self._base_beat_timeout_s = beat_timeout_s
        self._base_stall_window_s = stall_window_s
        # **既定と違うものだけを持つ。**既定と同じ値を書かれたら消す——そうしておくと、
        # この辞書がそのまま `status` の `cfg` になる（`ble-gatt.md`「`cfg` には既定と
        # 違うキーだけを載せる」）。**2つ目の「何が効いているか」を作らない。**
        self._overrides: dict[str, int] = {}
        self._notify = notify_config

    @property
    def cfg(self) -> dict[str, int]:
        """`status` に載せる「いま効いている上書き」。既定どおりなら空。"""
        return dict(self._overrides)

    @property
    def notify_config(self) -> NotifyConfig:
        """いまの警告の設定。**保持時間だけが上書きの影響を受ける。**"""
        return self._notify

    @property
    def beat_timeout_ms(self) -> int:
        """心拍が途切れてから `link` を `down` にするまで（ミリ秒）。"""
        return self._overrides.get("beat_to", self._base_beat_timeout_s) * 1_000

    @property
    def stall_window_ms(self) -> int:
        """`t` が進んでいるかを見る窓（ミリ秒）。**タイムアウトより必ず長い。**"""
        if "beat_to" in self._overrides:
            return (self._overrides["beat_to"] + _STALL_MARGIN_S) * 1_000
        return self._base_stall_window_s * 1_000

    def reset(self) -> None:
        """上書きを捨てて既定へ戻す。**呼ぶのは切断のとき**（`ble-gatt.md`「`config`」）。

        **保存しないことの実体はここ。**残すと、**次につないだ人が前の人の設定で走る。**
        """
        self._overrides = {}
        self._rebuild()

    def apply(self, raw: bytes) -> Rejected | None:
        """書かれた1通を取り込む。**断ったぶんを返す**（全部採用できたなら `None`）。

        返した理由は `status` の `last_error` に載せる。**採用した結果は `cfg` の側**で、
        **成否の正本はそちら**である（`last_error` は `read` を書くと消えるため。
        `ble-gatt.md`「`status`」）。

        **1つの誤りで全部を捨てない。** 捨てると、**どのキーが悪かったのかセントラルからは
        分からない**（`cfg` は「何も入っていない」としか言えない）。
        """
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return Rejected(keys=("json",), detail="config が JSON として読めない")
        if not isinstance(payload, dict):
            return Rejected(keys=("json",), detail="config が JSON オブジェクトではない")

        keys: list[str] = []
        details: list[str] = []
        for key, value in payload.items():  # pyright: ignore[reportUnknownVariableType]
            limits = _LIMITS.get(key) if isinstance(key, str) else None
            # **知らないキーは断らない。** デバイス側に項目が増えるたびに、
            # 古いアプリが理由の欄を埋め続けることになる（`ble-gatt.md`）。
            if limits is None:
                continue
            # **`bool` を弾く。** Python では `True` が `int` なので、
            # `{"beat_to": true}` が 1 として通ってしまう（範囲外にすらならない値もある）。
            if not isinstance(value, int) or isinstance(value, bool):
                keys.append(key)
                details.append(f"{key} が整数ではない")
                continue
            low, high = limits
            if not low <= value <= high:
                keys.append(key)
                details.append(f"{key} が範囲外（{low}〜{high}）")
                continue
            self._set(key, value)

        self._rebuild()
        if not keys:
            return None
        return Rejected(keys=tuple(keys), detail=" / ".join(details))

    def _set(self, key: str, value: int) -> None:
        """1つ採用する。**既定と同じ値なら覚えない**（`cfg` から消えるのが正しい）。

        **消すことに意味がある。**アプリが「既定に戻す」ために既定の値を書いてくるので
        （`config` は部分更新で、送らないと前の上書きが残る）、ここで覚え続けると
        **戻したはずの `cfg` にキーが残り、戻せたのか分からなくなる。**
        """
        if value == self._default(key):
            self._overrides.pop(key, None)
            return
        self._overrides[key] = value

    def _default(self, key: str) -> int:
        """上書きしていないときの値。

        **知らないキーで落ちること。**既定を返してしまう作りにすると、`_LIMITS` に
        キーを1つ足しただけで（`rear_cm` は足す予定。`ble-gatt.md`）**別の項目の既定と
        比べることになり、書けているのに `cfg` から消える**——アプリ側は
        「効いていない」と読むので、**足した人には理由の分からない失敗**になる。
        """
        lv = _HOLD_KEYS.get(key)
        if lv is not None:
            return self._base_notify.hold_ms[lv]
        if key == "beat_to":
            return self._base_beat_timeout_s
        raise KeyError(key)

    def _rebuild(self) -> None:
        """上書きを当てた `NotifyConfig` を作り直す。

        **毎回作らずに持っておく。**調停は1秒ごと（かつ `warn` が届くたび）に読むので、
        **読むたびに dataclass を作り直す理由がない。**
        """
        hold_ms = dict(self._base_notify.hold_ms)
        for key, lv in _HOLD_KEYS.items():
            if key in self._overrides:
                hold_ms[lv] = self._overrides[key]
        self._notify = replace(self._base_notify, hold_ms=hold_ms)
