"""log.py のテスト。BLE も実機も使わない（`tmp_path` にファイルを作るだけ）。"""

import json
from pathlib import Path

from device.log import LogStore


def _store(path: Path, capacity: int = 10) -> LogStore:
    return LogStore(path, capacity)


def test_1から振って積む(tmp_path: Path) -> None:
    store = _store(tmp_path)

    first = store.append(kind="rear_object", lv=2, t=1_000, t_est=False)
    second = store.append(kind="rear_object", lv=2, t=2_000, t_est=False)

    assert (first.seq, second.seq) == (1, 2)
    assert (store.oldest_seq, store.latest_seq) == (1, 2)


def test_1件も無ければ範囲は0(tmp_path: Path) -> None:
    # seq は 1 から始まるので、0 は「持っていない」を表せる（docs/interfaces/ble-gatt.md）。
    store = _store(tmp_path)

    assert (store.oldest_seq, store.latest_seq) == (0, 0)


def test_行はJSONLで推定でないときはt_estを出さない(tmp_path: Path) -> None:
    # `t_est` は true のときだけ入る（docs/interfaces/ble-log-transfer.md）。
    store = _store(tmp_path)

    line = store.append(kind="rear_object", lv=2, t=1_756_123_456_789, t_est=False).to_line()

    assert line.endswith(b"\n")
    payload = json.loads(line)
    assert payload == {
        "seq": 1,
        "type": "detect",
        "t": 1_756_123_456_789,
        "body": {"kind": "rear_object", "lv": 2},
    }


def test_推定した時刻にはt_estが付く(tmp_path: Path) -> None:
    store = _store(tmp_path)

    payload = json.loads(store.append(kind="rear_object", lv=2, t=1, t_est=True).to_line())

    assert payload["t_est"] is True


def test_seqより後だけを返す(tmp_path: Path) -> None:
    store = _store(tmp_path)
    for i in range(1, 4):
        store.append(kind="rear_object", lv=2, t=i, t_est=False)

    assert [r.seq for r in store.since(1)] == [2, 3]
    # since=0 は「持っているぶん全部」。
    assert [r.seq for r in store.since(0)] == [1, 2, 3]
    assert store.since(3) == []


def test_容量を超えたら古いものから捨てる(tmp_path: Path) -> None:
    # 捨てても seq は戻らず、oldest_seq が上がるだけ（docs/interfaces/ble-log-transfer.md）。
    store = _store(tmp_path, capacity=3)

    for i in range(1, 6):
        store.append(kind="rear_object", lv=2, t=i, t_est=False)

    assert [r.seq for r in store.since(0)] == [3, 4, 5]
    assert (store.oldest_seq, store.latest_seq) == (3, 5)


def test_再起動してもseqが続く(tmp_path: Path) -> None:
    # 振り直すと、前の世代のレコードと一意キーがぶつかって、あとから来た方が黙って消える。
    store = _store(tmp_path)
    store.append(kind="rear_object", lv=2, t=1, t_est=False)
    store.append(kind="rear_object", lv=2, t=2, t_est=False)

    reopened = _store(tmp_path)

    assert reopened.log_id == store.log_id
    assert [r.seq for r in reopened.since(0)] == [1, 2]
    assert reopened.append(kind="rear_object", lv=2, t=3, t_est=False).seq == 3


def test_番号はレコードより先に保存する(tmp_path: Path) -> None:
    # 逆にすると、落ちたときに次の起動が同じ番号を別のレコードに振る
    # （docs/interfaces/ble-log-transfer.md「転送済みログの扱い」）。
    # 書いたあとのファイルを読めば、次の番号が既に進んでいることを確かめられる。
    store = _store(tmp_path)
    store.append(kind="rear_object", lv=2, t=1, t_est=False)

    saved = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))

    assert saved["next_seq"] == 2
    assert saved["log_id"] == store.log_id


def test_状態を失ったら世代を作り直す(tmp_path: Path) -> None:
    # log_id が変わらないまま 1 から振り直すと、セントラルは無効になった既読位置を
    # 使い続ける（以後の検知が1件も取り込まれない）。
    store = _store(tmp_path)
    store.append(kind="rear_object", lv=2, t=1, t_est=False)
    (tmp_path / "state.json").unlink()

    reopened = _store(tmp_path)

    assert reopened.log_id != store.log_id
    # 前の世代のレコードも残さない（seq が 1 から振り直されるため）。
    assert reopened.since(0) == []
    assert reopened.append(kind="rear_object", lv=2, t=2, t_est=False).seq == 1


def test_壊れた行はその行だけ捨てる(tmp_path: Path) -> None:
    # 電源が落ちた瞬間の最後の1行は途中で切れうる。世代ごと作り直すと、
    # 取れるはずのレコードまで失う（飛びはセントラル側で扱える）。
    store = _store(tmp_path)
    store.append(kind="rear_object", lv=2, t=1, t_est=False)
    store.append(kind="rear_object", lv=2, t=2, t_est=False)
    records = tmp_path / "records.jsonl"
    records.write_text(records.read_text(encoding="utf-8") + '{"seq":3,"typ', encoding="utf-8")

    reopened = _store(tmp_path)

    assert reopened.log_id == store.log_id
    assert [r.seq for r in reopened.since(0)] == [1, 2]


def test_ファイルは容量ぶんに縮む(tmp_path: Path) -> None:
    # 溢れたぶんはファイルにも残るので、放っておくと SD カードの上で伸び続ける。
    store = _store(tmp_path, capacity=3)

    for i in range(1, 20):
        store.append(kind="rear_object", lv=2, t=i, t_est=False)

    lines = (tmp_path / "records.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) <= 3 * 2


def test_書けなくても例外を投げない(tmp_path: Path) -> None:
    # 記録できないことを理由に警告を止めない（identity.py と同じ立場）。
    # ディレクトリを読み出し専用にする代わりに、置き場所をファイルで塞ぐ。
    blocked = tmp_path / "blocked"
    blocked.write_text("これはディレクトリではない", encoding="utf-8")

    store = _store(blocked)
    record = store.append(kind="rear_object", lv=2, t=1, t_est=False)

    assert record.seq == 1
    # メモリの上では積まれている（この電源が入っている間は転送できる）。
    assert [r.seq for r in store.since(0)] == [1]
