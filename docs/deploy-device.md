# ラズパイへの投入手順

**書いたプログラムを Raspberry Pi Zero 2 W に載せて動かすまで**をここにまとめる。
開発機（Windows / macOS）の環境構築は [`setup.md`](./setup.md) にあり、**そちらとは別**。

- ステータス: **実機で一部を通した**（2026-09-19。→ [`unverified.md`](./unverified.md) の 40 / 41 / 42）
- 依存の入れ方をなぜこうするかは [`adr/0008-device-dependencies.md`](./adr/0008-device-dependencies.md)

**実値を書かないこと。** Wi-Fi のパスワード・IP アドレス・ホスト名の実物はコミットしない
（このリポジトリは public）。以下の `<...>` は各自で置き換える。

## 0. 用意するもの

| もの | 備考 |
| --- | --- |
| Raspberry Pi Zero 2 W | **aarch64**（4コア）。手元の実機はこれ（`unverified.md` 40） |
| microSD カード | 8GB 以上 |
| USB 電源 | **PWR** と書かれた側に挿す（もう片方は USB OTG） |
| Wi-Fi | **2.4GHz のみ**。Zero W も Zero 2 W も 5GHz に繋がらない（無線チップが同じ CYW43438） |

**画面もキーボードも要らない。** 最初から SSH で入る前提で書き込む。

## 1. OS を書き込む

### すでに CHIRIMEN が入った SD がある場合

**まず版を見る。焼き直さずに済むことの方が多い。**

```sh
cat /proc/device-tree/model && cat /etc/os-release && python3 -V && uname -m
```

**`pyproject.toml` の `requires-python` を満たす Python が入っていれば、そのまま使ってよい**
（下の 2 へ進む）。**いまは `>=3.13,<3.14`** で、**Trixie のシステム Python 3.13 がこれに当たる。**

**版を選べないのは、システムの Python がそのまま `uv sync` の前提になるため**である
（`adr/0008-device-dependencies.md`。`PyGObject` の共有ライブラリを apt 側と噛み合わせる）。
**実機の OS が変わったら、`pyproject.toml` と `mise.toml` の側を動かす**——
過去に 3.12 → 3.11 → 3.13 と2回動かしている（`adr/0001-tech-stack.md`）。

**手元の実機はこれで通った**（2026-09-19）:
**Raspberry Pi Zero 2 W Rev 1.0 / aarch64 / Debian 13 (trixie) / Python 3.13.5**（CHIRIMEN Lite）。
**CHIRIMEN の Node.js は使わないが、消す必要も無い**（`AGENTS.md`）。

### 新しく書き込む

[Raspberry Pi Imager](https://www.raspberrypi.com/software/) を使う。

1. **デバイス**: 手元の機体に合わせる（`Raspberry Pi Zero 2 W`）
2. **OS**: `Raspberry Pi OS (other)` → **`Raspberry Pi OS Lite`**
3. **ストレージ**: microSD

**Lite（デスクトップ無し）を選ぶ。** RAM が 512MB しかなく、画面も使わない。

**32-bit と 64-bit のどちらでもよい**——**ただし選んだ方のシステム Python に
`pyproject.toml` を合わせること。** **Zero 2 W は aarch64 なので 64-bit が動く**
（**Zero W（無印）は ARMv6 で、64-bit が起動しない。** 機体を間違えないこと）。

**64-bit を選んだ場合、piwheels は使えないし、要らない。** あれは 32-bit（armhf）の
Raspberry Pi OS 向けで、**aarch64 には PyPI の manylinux ホイールがそのまま降ってくる**
（`adr/0008-device-dependencies.md`）。

### 書き込む前に設定を埋める

Imager の**歯車アイコン（OS カスタマイズ）**で、以下を入れてから書き込む。
**ここを飛ばすと、画面もキーボードも無い状態で入れなくなる。**

| 項目 | 入れるもの |
| --- | --- |
| ホスト名 | `<好きな名前>`（例: チーム内で重複しない名前） |
| SSH を有効化 | **オン**。パスワード認証でよい |
| ユーザー名 / パスワード | `<ユーザー名>` / `<パスワード>` |
| Wi-Fi の SSID / パスワード | **2.4GHz のもの**。`Wi-Fi を使う国` は `JP` |

## 2. 入れるところまで確認する

電源を挿して1〜2分待つ（**起動は速くない**）。開発機から:

```sh
ssh <ユーザー名>@<ホスト名>.local
```

**繋がらないときは下の「つまずいたとき」へ。**

## 3. 共有ライブラリを入れる

BLE のライブラリ（`PyGObject`）が動くのに必要なもの。**pip の依存ではないので、
これを飛ばすと `uv sync` は成功したのに import で落ちる**（`unverified.md` の 42）。

```sh
sudo apt update
sudo apt install -y git \
  libcairo2-dev libgirepository1.0-dev libdbus-1-dev libglib2.0-dev \
  pkg-config python3-dev build-essential
```

**`-dev` が要るのは、`PyGObject` / `pycairo` / `dbus-python` を実機でビルドするから**である。
**aarch64 でもこの2つはホイールが降ってこない**（2026-09-19 に確認。`unverified.md` の 41）。
**ランタイムのライブラリだけ入れても足りない** ——入れずに `uv sync` すると
`Building pycairo==1.29.1` で止まる。

**`libgirepository1.0-dev`（2.0 ではない）。** Debian 13 には `libgirepository-2.0-dev` も有るが、
**`PyGObject` 3.50 が pkg-config で探すのは `gobject-introspection-1.0`** である
（2.0 を見るのは 3.52 以降）。**2.0 だけを入れると
`Dependency 'gobject-introspection-1.0' is required but not found` でビルドが落ちる**
——名前が似ていて紛らわしいので、**`PyGObject` の版を上げるときはここを一緒に見ること。**

**ビルドには数分かかる。** Zero 2 W は4コアなので現実的な範囲に収まる
（**Zero W の ARMv6 では事実上終わらず、piwheels に頼っていた。** `adr/0008-device-dependencies.md`）。

## 4. uv を入れる

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc
uv --version
```

**`uv` に Python を用意させない。** aarch64 なら落としてくることはできるが、
**`PyGObject` が要る共有ライブラリは apt がシステム Python 向けに置いている**ため、
**別の Python から掴ませようとすると実機だけ別の入れ方になる**
（`adr/0008-device-dependencies.md`）。次の手順で `--python /usr/bin/python3` を渡す。

## 5. コードを持ってくる

```sh
git clone https://github.com/Hashimoto-Teppei/web-iot-makers-challenge-team-c.git
cd web-iot-makers-challenge-team-c/apps/device
```

**public リポジトリなので鍵の設定が要らない。** 更新は `git pull` だけで済む。

**実機の上でコードを書かないこと。** 編集は開発機で行い、実機へは `git pull` で運ぶ。
**RAM 512MB は言語サーバーを常駐させる余裕が無い。**
手元には Ruff / basedpyright / pytest が揃っていて、そちらの方が速く回る。

## 6. 依存を入れる

```sh
uv sync --group device --python /usr/bin/python3
```

**3つとも意味がある。**

- **`--group device`** — BLE のライブラリはこのグループにしか入っていない。
  開発機と CI では入らないように隔離してある（`adr/0008-device-dependencies.md`）
- **`--python /usr/bin/python3`** — **システムの Python を使う**（上の 4）
- **`--locked` を付けない** — `uv.lock` は開発機で作られる。固定して外したときに
  sdist のビルドへ落ちうる

**`Building wheel for ...` が長く流れたら、そこで止めてよい。**
aarch64 ならホイールが降ってくるはずで、**落ちているのは何かが噛み合っていない印**である
（`unverified.md` の 41）。

確認:

```sh
uv run python -V              # pyproject.toml の requires-python に入っていること
uv run python -c "import bluezero; print('ok')"
uv run python -c "import gpiozero, RPLCD; print('ok')"   # LED と LCD
```

## 7. 部品をつないだなら、I2C を有効にする

**LED だけなら要らない。** LCD1602A は I2C でつながるが、**Raspberry Pi OS は既定で I2C を切っている。**
切ったままだと `/dev/i2c-1` が無く、**LCD だけが黙る**（起動はする。`apps/device/src/device/hw/lcd.py`
がアドレスに見つからないことを journalctl に1行出して、光の側だけで走り続ける）。

```sh
sudo raspi-config nonint do_i2c 0    # 0 が「有効にする」
sudo reboot
```

戻ってきたら、**アドレスを確定させる**:

```sh
sudo apt install -y i2c-tools
i2cdetect -y 1
```

**`27` か `3f` のどちらかが出る。** 変換基板のチップで変わり、**見た目では分からない**
（[`hardware.md`](./hardware.md)）。出た方を開発機で `apps/device/src/device/config.py` の
`LCD_I2C_ADDRESS` に書いて、`git pull` で運ぶ。**どちらも出ないなら配線を見る。**

**部品を持っていないなら、`config.py` の末尾を `None` にする。** その部品は無いものとして動く
（[`adr/0002-development-lifecycle.md`](./adr/0002-development-lifecycle.md)）。

## 8. 動かす

```sh
uv run python -m device.main
```

**Ctrl-C で止まる。** ここまでで「手で動かす」はできた。

起動すると **BLE のアドバタイズが出る**。スマホの汎用 BLE アプリ（nRF Connect など）で
スキャンすると `bg-xxxx` という名前で見えるので、**そのまま接続して確かめる**
（GATT の中身は [`interfaces/ble-gatt.md`](./interfaces/ble-gatt.md)）。

| 見るところ | 期待 |
| --- | --- |
| 名前 | **`bg-` + 4文字で、7文字ぜんぶ出ている**（切れていたら広告が 31 バイトを超えている → [`unverified.md`](./unverified.md) の 12） |
| `...6e01`（`device-info`） | Read すると `{"proto":2,"device_id":...}` が返る |
| `...6e04`（`status`） | Read できて、Notify を購読すると毎秒届く |

**`device_id` は初回起動時に作られ、`~/.local/share/bike-device/identity.json` に残る。**
このファイルを消すと `device_id` が変わり、**取り込み済みのログと結び付かなくなる**ので消さないこと。

部品をつないでいるなら、**起動した瞬間に見えるものが2つある**
（[`notifications/arbitration.md`](./notifications/arbitration.md)）。

| 見るところ | 期待 |
| --- | --- |
| 警告の LED（GPIO22） | **1秒だけ光って消える。** 光らなければ**その LED は切れている**——警告が出ないのと区別がつかないので、ここで直す |
| `link` の LED（GPIO17） | **2Hz で点滅し続ける。** スマホが繋がるまで `link` は `down` である。繋ぐと点灯に変わる |
| LCD | 上段は空、下段に `DOWN  -` が出る。**何も出ないなら 7 に戻ってアドレスを確かめる** |

## 9. 電源を入れたら勝手に走るようにする

**自転車に載せると手で起動できない。** systemd に登録する。

```sh
sudo tee /etc/systemd/system/bike-device.service > /dev/null <<'UNIT'
[Unit]
Description=bike device
# BLE を使うので bluetooth が上がってから起動する
After=bluetooth.target network-online.target
Wants=bluetooth.target

[Service]
Type=simple
User=<ユーザー名>
WorkingDirectory=/home/<ユーザー名>/web-iot-makers-challenge-team-c/apps/device
ExecStart=/home/<ユーザー名>/.local/bin/uv run python -m device.main
# 落ちても勝手に上がってくる。走行中に人が直せないため
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now bike-device
systemctl status bike-device
```

**`<ユーザー名>` を3か所とも置き換えること。**

**BLE のペリフェラルとして広告を出すには権限が要る。**
`User=` のユーザーが `bluetooth` グループに入っていない場合は D-Bus に弾かれる:

```sh
sudo usermod -aG bluetooth <ユーザー名>
```

**部品をつないだなら `i2c` と `gpio` も同じ。** Raspberry Pi OS が最初から作るユーザーは入っているが、
**自分で足したユーザーは入っていない**——手で動かせたのに systemd から動かすと LCD と LED だけ黙る、
という形で出る:

```sh
sudo usermod -aG i2c,gpio <ユーザー名>
```

**それでも弾かれる場合は BlueZ の D-Bus ポリシーを足すことになる。**
**まだ実機で通していない**（[`unverified.md`](./unverified.md) の 43）。
`journalctl` に `org.freedesktop.DBus.Error.AccessDenied` が出ていたらこれ。

## 10. ログを見る

**走行中は画面が無い。** 後から見る手段がこれしかない。

```sh
journalctl -u bike-device -f        # 流しっぱなしで見る
journalctl -u bike-device -n 100    # 直近 100 行
journalctl -u bike-device -b        # 今回の起動ぶんだけ
```

## 更新のしかた

コードを変えたあと、実機で:

```sh
cd ~/web-iot-makers-challenge-team-c
git pull
cd apps/device
uv sync --group device --python /usr/bin/python3   # 依存が増えたときだけ
sudo systemctl restart bike-device
```

## つまずいたとき

| 症状 | 対処 |
| --- | --- |
| `ssh <ホスト名>.local` で見つからない | Windows は `.local` の名前解決が弱い。ルーターの管理画面で IP を調べて直接指定する |
| Wi-Fi に繋がらない | **5GHz に繋ごうとしていないか。** 2.4GHz のみ |
| 起動しない（緑の LED が光らない） | **Zero W（無印）に 64-bit を書き込んでいる**可能性。機体を確かめ、32-bit を書き直す |
| `uv sync` が `requires-python` で落ちる | システム Python が `pyproject.toml` の範囲外。**`pyproject.toml` と `mise.toml` の側を実機に合わせる**（`adr/0001-tech-stack.md`） |
| `hci0` が見つからない / アドバタイズが出ない | **rfkill でソフトブロックされていることがある**（手元の CHIRIMEN Lite がそうだった）。`rfkill list bluetooth` を見て、`sudo rfkill unblock bluetooth`（`unverified.md` 104） |
| `uv sync` が Python を落とそうとして失敗する | `--python /usr/bin/python3` を付け忘れている |
| `import bluezero` が落ちる | 手順 3 の apt が済んでいない |
| BLE の広告が出ない | rfkill（上の行）か、`bluetooth` グループと D-Bus のポリシー（手順 9） |
| 広告は見えるが名前が `bg-` の途中で切れている | 広告が 31 バイトを超えている。**`Appearance` や `tx-power` を足していないか**（`interfaces/ble-gatt.md`） |
| スキャンで見つからない | **他の人がつなぎっぱなしになっている可能性がある**（接続中はアドバタイズが止まる）。デバイスを再起動する |
| LCD だけ出ない（LED は光る） | I2C が無効か、アドレスが違う（手順 7）。journalctl に `LCD が 0x27 に見つからない` が出ている |
| SD カードが壊れた疑い | **書き直すのが一番速い。** 手順 1 からやり直す |

**ここに無い症状に当たったら、この表に1行足すこと。** 次に同じ場所で止まる人を減らせる。
