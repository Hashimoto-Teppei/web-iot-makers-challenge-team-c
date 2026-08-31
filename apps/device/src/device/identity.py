"""デバイスの識別子（`device_id` / `log_id`）の生成と保存。

**BLE を知らないので、開発機でも pytest から呼べる。**
`device_id` は `device-info` とアドバタイズの Local Name の両方に出る
（`../../../../docs/interfaces/ble-gatt.md`）。

- `device_id` — デバイスごとに固定。**16進の小文字8文字。**
- `log_id` — ログの世代。ログを消した・失った・`seq` を振り直したときだけ変わる。

**`log_id` を今はここに置いている。** ログの保存が実装される（#40）まで、置き場所が他に無いため。
ログストアができたら**そちら側へ移す**こと——ログを消したときに `log_id` が変わらないと、
セントラルは無効になった既読位置を使い続ける。
"""

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

logger = logging.getLogger(__name__)

# アドバタイズに載せる名前の頭。`bg-` + device_id の下4桁で7文字になる。
# 7文字を超えると 31 バイトに収まらず、BlueZ が**黙って**切り詰める
# （`../../../../docs/interfaces/ble-gatt.md`「UUID」）。
NAME_PREFIX = "bg-"


@dataclass(frozen=True)
class Identity:
    """このデバイスの識別子。"""

    device_id: str
    log_id: str


def new_id() -> str:
    """16進の小文字8文字の ID を作る。

    ハイフン付きの UUID をそのまま使わないのは、アドバタイズの名前の長さも、
    取り込みのキーの長さも変わってしまうため。
    """
    return uuid4().hex[:8]


def advertised_name(device_id: str) -> str:
    """アドバタイズに載せる Local Name（`bg-a20b` の形、7文字）を返す。"""
    return f"{NAME_PREFIX}{device_id[-4:]}"


def _is_valid_id(value: object) -> bool:
    if not isinstance(value, str) or len(value) != 8:
        return False
    return all(c in "0123456789abcdef" for c in value)


def load_or_create(path: Path) -> Identity:
    """識別子をファイルから読む。無ければ作って保存する。

    **どう転んでも例外を投げない。** ここで落ちると systemd の `Restart=always` が
    起動と失敗を繰り返し、**警告を出す装置が丸ごと動かなくなる**
    （`../../../../docs/deploy-device.md`）。保存に失敗した場合も、
    その場限りの識別子で走り続ける方がよい。**作り直したことはログに残す。**

    **読めなかった理由で扱いを分ける。**

    - **中身が壊れている**（JSON でない・形が違う）→ 作り直して**保存する**。
      そのまま置いても二度と読めないため。
    - **ファイルを読めなかった**（I/O エラー）→ 作り直すが**保存しない**。
      劣化した SD カードで一時的に読めなかっただけかもしれず、上書きすると
      **まだ生きていた `device_id` を自分で潰す**（取り込みの一意キーが総入れ替えになる）。

    Args:
        path: 保存先のファイル（`config.IDENTITY_PATH`）

    Returns:
        読み込んだ、または新しく作った識別子
    """
    save = True
    if path.exists():
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
            if (
                isinstance(saved, dict)
                and _is_valid_id(saved.get("device_id"))
                and _is_valid_id(saved.get("log_id"))
            ):
                return Identity(device_id=saved["device_id"], log_id=saved["log_id"])
            logger.error("%s の中身が識別子として読めない。作り直す", path)
        except ValueError as err:
            logger.error("%s が JSON として読めない（%s）。作り直す", path, err)
        except OSError as err:
            logger.error("%s を読めなかった（%s）。今回だけの識別子で動かす", path, err)
            save = False

    identity = Identity(device_id=new_id(), log_id=new_id())
    if save:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps({"device_id": identity.device_id, "log_id": identity.log_id}),
                encoding="utf-8",
            )
        except OSError as err:
            # 書けなくても起動は続ける。次に電源を入れると別の device_id になるが、
            # **起動しないよりはよい**（走行中に警告が出ないことの方が重い）。
            logger.error("%s に保存できなかった（%s）。次の起動で別の ID になる", path, err)
    logger.info("識別子を作った: device_id=%s log_id=%s", identity.device_id, identity.log_id)
    return identity
