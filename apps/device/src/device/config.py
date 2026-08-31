"""しきい値・ピン番号・ファイルの置き場所などの設定。

**コードに直書きしない値をここへ集める**（`../../README.md`）。実地で変わる値を探すとき、
読む場所を1つにするため。

**秘密値は置かない。** このファイルはコミットされ、リポジトリは public
（`../../../../CLAUDE.md`「機密情報の扱い」）。
"""

from pathlib import Path

# device_id を保存する場所。
#
# **ログとは別のファイルに置く。** 一緒に消えると device_id が変わり、取り込みの一意キー
# `(device_id, log_id, seq)` が総入れ替えになって履歴がまるごと重複する
# （`../../../../docs/interfaces/ble-gatt.md`）。
#
# パスの区切りをハードコードしないよう pathlib で組み立てる（Windows の開発機でも
# import できる必要がある。ここは BLE を知らないので pytest から読まれる）。
IDENTITY_PATH = Path.home() / ".local" / "share" / "bike-device" / "identity.json"

# 使う Bluetooth アダプタのアドレス。None なら最初に見つかったものを使う。
# ラズパイに載っているのは1つだけなので、通常は None のままでよい。
BLE_ADAPTER_ADDRESS: str | None = None

# status の Notify を送る間隔（秒）。
#
# 値が変わったときだけ送る作りにすると、**心拍が途切れて link が down に落ちたことを
# セントラルへ伝える経路が、そのまま止まる**（変化を検出する側も止まっているため）。
# 一定間隔で送り続ける方が、届いていないことに気づける。
STATUS_NOTIFY_INTERVAL_S = 1
