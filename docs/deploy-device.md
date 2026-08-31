# ラズパイへの投入手順

**書いたプログラムを Raspberry Pi Zero W に載せて動かすまで**をここにまとめる。
開発機（Windows / macOS）の環境構築は [`setup.md`](./setup.md) にあり、**そちらとは別**。

- ステータス: **実機で通していない**（→ [`unverified.md`](./unverified.md) の 40 / 41 / 42）
- 依存の入れ方をなぜこうするかは [`adr/0008-device-dependencies.md`](./adr/0008-device-dependencies.md)

**実値を書かないこと。** Wi-Fi のパスワード・IP アドレス・ホスト名の実物はコミットしない
（このリポジトリは public）。以下の `<...>` は各自で置き換える。

## 0. 用意するもの

| もの | 備考 |
| --- | --- |
| Raspberry Pi Zero W | **ARMv6**。この制約が以下のほぼ全部の理由になる |
| microSD カード | 8GB 以上 |
| USB 電源 | Zero W の **PWR** と書かれた側に挿す |
| Wi-Fi | **2.4GHz のみ**。Zero W は 5GHz に繋がらない |

**画面もキーボードも要らない。** 最初から SSH で入る前提で書き込む。

## 1. OS を書き込む

[Raspberry Pi Imager](https://www.raspberrypi.com/software/) を使う。

1. **デバイス**: `Raspberry Pi Zero`
2. **OS**: `Raspberry Pi OS (other)` → **`Raspberry Pi OS Lite (32-bit)`**
3. **ストレージ**: microSD

**64-bit を選ばない。** Zero W の ARMv6 では起動しない。
**Lite（デスクトップ無し）を選ぶ。** RAM が 512MB しかなく、画面も使わない。

**32-bit の Raspberry Pi OS でなければならない理由はもう1つある。**
実機のホイールを配っている piwheels は **32-bit（armhf）の Raspberry Pi OS しかサポートしていない**
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

電源を挿して1〜2分待つ（**Zero W は起動が遅い**）。開発機から:

```sh
ssh <ユーザー名>@<ホスト名>.local
```

**繋がらないときは下の「つまずいたとき」へ。**

## 3. 共有ライブラリを入れる

BLE のライブラリ（`PyGObject`）が動くのに必要なもの。**pip の依存ではないので、
これを飛ばすと `uv sync` は成功したのに import で落ちる**（`unverified.md` の 42）。

```sh
sudo apt update
sudo apt install -y git libgirepository-1.0-1 libcairo2
```

## 4. uv を入れる

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc
uv --version
```

**`uv` 本体は ARMv6 で動く**（armv7 向けのバイナリが ARMv6 互換のため）。
**ただし `uv` が Python を落としてくることはできない**——後述。

## 5. piwheels を見るようにする

```sh
mkdir -p ~/.config/uv
cat > ~/.config/uv/uv.toml <<'CONF'
# ARMv6 向けにビルド済みのホイールを配っている index。
# これが無いと C 拡張をこの機体でコンパイルすることになり、事実上終わらない。
extra-index-url = ["https://www.piwheels.org/simple"]
CONF
```

**Raspberry Pi OS の `pip` は最初から piwheels を見ているが、`uv` は見ない。**
ここで明示的に足す（`adr/0008-device-dependencies.md`）。

## 6. コードを持ってくる

```sh
git clone https://github.com/Hashimoto-Teppei/web-iot-makers-challenge-team-c.git
cd web-iot-makers-challenge-team-c/apps/device
```

**public リポジトリなので鍵の設定が要らない。** 更新は `git pull` だけで済む。

**実機の上でコードを書かないこと。** 編集は開発機で行い、実機へは `git pull` で運ぶ。
**VS Code の Remote-SSH は ARMv6 に対応しておらず、Zero W には繋がらない**
（`Unsupported architecture: armv6l` で失敗する）。
手元には Ruff / basedpyright / pytest が揃っていて、そちらの方が速く回る。

## 7. 依存を入れる

```sh
uv sync --group device --python /usr/bin/python3
```

**3つとも意味がある。**

- **`--group device`** — BLE のライブラリはこのグループにしか入っていない。
  開発機と CI では入らないように隔離してある（`adr/0008-device-dependencies.md`）
- **`--python /usr/bin/python3`** — **システムの Python 3.11 を使う。**
  `uv` は ARMv6 向けの Python を配布していないので、自分で用意させようとすると失敗する
- **`--locked` を付けない** — `uv.lock` は開発機（x86 / arm64）で作られており、
  ARMv6 のホイールが記録されていない。固定するとソースビルドに落ちうる

**`Building wheel for ...` が流れたら、そこで止めてよい。** piwheels が効いていない印で、
そのまま待っても数時間かかる（`unverified.md` の 41）。

確認:

```sh
uv run python -V              # Python 3.11.x
uv run python -c "import bluezero; print('ok')"
```

## 8. 動かす

```sh
uv run python -m device.main
```

**Ctrl-C で止まる。** ここまでで「手で動かす」はできた。

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

**それでも弾かれる場合は BlueZ の D-Bus ポリシーを足すことになる。**
ここは実機で詰める（#37）。

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
| Wi-Fi に繋がらない | **5GHz に繋ごうとしていないか。** Zero W は 2.4GHz のみ |
| 起動しない（緑の LED が光らない） | 64-bit の OS を書き込んでいる可能性。**32-bit を書き直す** |
| `uv sync` で `Building wheel for ...` が流れる | piwheels が効いていない。手順 5 の `~/.config/uv/uv.toml` を確認する |
| `uv sync` が Python を落とそうとして失敗する | `--python /usr/bin/python3` を付け忘れている |
| `import bluezero` が落ちる | 手順 3 の apt が済んでいない |
| BLE の広告が出ない | `bluetooth` グループと D-Bus のポリシー（手順 9） |
| SD カードが壊れた疑い | **書き直すのが一番速い。** 手順 1 からやり直す |

**ここに無い症状に当たったら、この表に1行足すこと。** 次に同じ場所で止まる人を減らせる。
