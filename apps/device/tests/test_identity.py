"""identity.py のテスト。BLE も実機も使わない。"""

import json
from pathlib import Path

from device.identity import advertised_name, load_or_create, new_id


def test_IDは16進の小文字8文字() -> None:
    value = new_id()

    assert len(value) == 8
    assert all(c in "0123456789abcdef" for c in value)


def test_アドバタイズの名前は7文字() -> None:
    # 7文字を超えると 31 バイトに収まらず、BlueZ が黙って切り詰める
    # （docs/interfaces/ble-gatt.md）。長さそのものが仕様なので、ここで固定する。
    assert advertised_name("c3f1a20b") == "bg-a20b"
    assert len(advertised_name("c3f1a20b")) == 7


def test_初回は作って保存する(tmp_path: Path) -> None:
    path = tmp_path / "sub" / "identity.json"

    identity = load_or_create(path)

    assert path.exists()  # 親ディレクトリごと作る
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved == {"device_id": identity.device_id, "log_id": identity.log_id}


def test_2回目は同じ識別子を返す(tmp_path: Path) -> None:
    # device_id が変わると、取り込みの一意キーが総入れ替えになる（docs/interfaces/ble-gatt.md）。
    path = tmp_path / "identity.json"

    first = load_or_create(path)
    second = load_or_create(path)

    assert first == second


def test_壊れたファイルなら作り直して先へ進む(tmp_path: Path) -> None:
    # 例外で落とすと systemd が再起動を繰り返し、警告を出す装置が丸ごと動かなくなる。
    path = tmp_path / "identity.json"
    path.write_text("これは JSON ではない", encoding="utf-8")

    identity = load_or_create(path)

    assert len(identity.device_id) == 8
    assert json.loads(path.read_text(encoding="utf-8"))["device_id"] == identity.device_id


def test_形の違う識別子が入っていたら作り直す(tmp_path: Path) -> None:
    # ハイフン付きの UUID が入ると、名前の長さもキーの長さも変わる。
    path = tmp_path / "identity.json"
    path.write_text(
        json.dumps({"device_id": "c3f1a20b-0000-4000-8000-000000000000", "log_id": "9a1c2b3d"}),
        encoding="utf-8",
    )

    identity = load_or_create(path)

    assert len(identity.device_id) == 8


def test_読めなかっただけのときは上書きしない(tmp_path: Path) -> None:
    # 劣化した SD カードで一時的に読めなかっただけかもしれない。上書きすると、
    # まだ生きていた device_id を自分で潰す（docs/interfaces/ble-gatt.md）。
    # ここではディレクトリを渡して「存在するが読めない」を作る。
    path = tmp_path / "identity.json"
    path.mkdir()

    identity = load_or_create(path)

    assert len(identity.device_id) == 8  # その場限りの識別子で起動は続く
    assert path.is_dir()  # 触っていない


def test_保存できなくても起動を止めない(tmp_path: Path) -> None:
    # 例外を投げると systemd が再起動を繰り返し、警告を出す装置が丸ごと動かなくなる。
    blocked = tmp_path / "file"
    blocked.write_text("", encoding="utf-8")

    identity = load_or_create(blocked / "identity.json")  # ファイルの下には作れない

    assert len(identity.device_id) == 8
