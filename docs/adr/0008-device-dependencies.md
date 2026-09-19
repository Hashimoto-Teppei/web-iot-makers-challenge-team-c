# ADR 0008: デバイスの依存は uv で管理し、実機ではシステム Python に乗せる

- ステータス: 決定済み（**一部は実機で確認済み** → `../unverified.md`）
- 日付: 2026-08-31（**2026-09-19 に、実機を見て前提の3つを差し替えた**）
- 関連: `0001-tech-stack.md`（Python の版）/ `0002-development-lifecycle.md`（実機なしで開発する）

## 背景

`apps/device` の `dependencies` は空のまま来た。実行時の依存がまだ1つも無かったためで、
**BLE ペリフェラルの実装（#37）に着手した瞬間に、次の2つがぶつかる。**

1. **BLE と GPIO のライブラリは Linux 専用。** 素朴に `dependencies` へ足すと、
   開発機（Windows / macOS）で `uv sync` が失敗し、**全員の手が止まる**
2. **`PyGObject` は apt 側の共有ライブラリを要る。** pip の依存ではないので、
   `uv sync` が成功しても import で落ちうる

### 2026-09-19 に差し替えた前提

**この ADR は当初 Raspberry Pi Zero W（ARMv6）を前提に書いていた。**
実機を繋いだところ **Raspberry Pi Zero 2 W Rev 1.0 / aarch64 / Debian 13 (trixie) /
Python 3.13.5** で（`../unverified.md` 40）、**理由にしていた3つがまとめて消えた。**

| 当初の前提 | 実機 | 結果 |
| --- | --- | --- |
| Zero W は **ARMv6**。ホイールが無ければソースビルドに落ちる | **aarch64** | **PyPI の manylinux ホイールがそのまま降ってくる** |
| **piwheels** が ARMv6 でソースビルドを避ける唯一の手段 | — | **piwheels は 32-bit（armhf）専用。使えないし、要らない** |
| `uv` は実機に Python を用意できない（python-build-standalone は armv7 以上） | **aarch64 には有る** | **制約ごと消えた** |

**古い版の判断は git の履歴に残っている。**Zero W に戻す日が来たら、そちらを見ること。

## 決定

### 1. 実機ではシステムの Python を使う

`uv sync --python /usr/bin/python3` で実機のシステム Python を指す。
**`[tool.uv] python-preference` は設定しない**——プロジェクト全体に効いてしまい、
開発機の挙動まで変わるため。実機だけの事情は実機の手順に置く（`../deploy-device.md`）。

**aarch64 になって「uv が Python を落とせない」制約は消えたが、それでもシステム Python を使う。**
**`PyGObject` が要る共有ライブラリ（`libgirepository` など）は apt が入れるもの**で、
**システム Python 向けに置かれている。** uv が別に落としてきた Python から掴ませようとすると、
そこを手で合わせることになり、**実機だけ別の入れ方**になる（→「却下した案」）。

**`pyproject.toml` の `requires-python` は、実機のシステム Python に合わせる。**
いまは `>=3.13,<3.14`（実機が 3.13.5）。**実機の OS が変われば、ここも動かす**
（`0001-tech-stack.md`。過去に 3.12 → 3.11 → 3.13 と2回動かしている）。

### 2. 実機だけで要る依存は dependency-group に隔離する

```toml
[dependency-groups]
device = ["bluezero>=0.9", "gpiozero>=2.0", "RPLCD>=1.3", "smbus2>=0.4"]
```

**既定では入らない。実機だけ `--group device` で入れる。**

**`sys_platform == 'linux'` のマーカーは使わない。** マーカーだと **CI（ubuntu）に入ってしまい**、
**実機で確かめたい「入るかどうか」を x86 で偽装する**ことになる。

結果としてこうなる:

| どこ | コマンド | BLE の依存 |
| --- | --- | --- |
| 開発機（Windows / macOS / Linux） | `uv sync` | **入らない** |
| CI | `uv sync --locked` | **入らない** |
| 実機（Zero 2 W） | `uv sync --group device --python /usr/bin/python3` | 入る |

**型チェックはどの環境でも `bluezero` が無い前提で動く。** 開発機と CI で挙動がぶれないよう、
import が解決できないことを **`hw/ble.py` の先頭で明示的に黙らせる**
（`# pyright: reportMissingImports=false`）。ファイル単位に閉じるので、
`detect/` 側の import ミスは今までどおり検出される。

### 3. 実機では `uv sync` に `--locked` を付けない

`uv.lock` は開発機（x86 / arm64）で作られる。**実機が aarch64 になって食い違いはほぼ無くなった**が、
**固定して外したときに sdist のビルドへ落ちる**のは変わらないので、実機では付けない。
**CI は `--locked` のままにする**——ロックの更新漏れを見張る役目はそちらに残す。

### 4. Docker は使わない

**Zero 2 W に載せる意味が無い。** BLE と GPIO には `--privileged` とホストの D-Bus /
ネットワークが要り、**隔離という利点がほぼ残らない**。RAM 512MB でデーモンを常駐させる余裕も無い。

（**「ARMv6 は Docker のエコシステムから外れつつある」という理由は、aarch64 になって消えた。**
それでも上の理由だけで足りるので、判断は変わらない。）

### 5. 実機の上で直接コードを書かない

Zero 2 W はネットに繋がるので、実機で `git clone` して動かすのは素直で、**そうする**。
だが**編集そのものを実機でやるのは避ける。**

- 手元の PC には Ruff / basedpyright / pytest が揃っており、**そちらの方が速く回る**
- RAM 512MB は言語サーバーを常駐させる余裕が無い

（**「VS Code の Remote-SSH は ARMv6 に非対応」という理由は消えた**——aarch64 は対応している。
それでも上の理由で、編集は手元でやる。）

**編集は開発機、実行は実機。運ぶのは `git pull`。** リポジトリが public なので鍵の設定も要らない。

## 却下した案

- **apt の `python3-dbus` / `python3-gi` を使い、venv を `--system-site-packages` で開く** —
  依存の一部が uv の管理から外れ、**実機だけ別の入れ方**になる。手順が二重化し、
  `pyproject.toml` を見ても何が入るのか分からなくなる。
  **`PyGObject` が aarch64 のホイールで入るなら、この道を選ぶ理由が無い**
  （入らなければ戻ってくる。`../unverified.md` 41 / 42）
- **`jeepney`（純 Python の D-Bus 実装）で GATT の登録を自前で書く** — 依存は最も軽いが、
  **BlueZ の D-Bus API を自分で組む量が増える。** ハッカソンの期間で払う対価としては重い

## GPIO について

**部品が決まったので、この条件は外れた**（2026-09-08。#13。`../hardware.md`）。
当初は「部品が未定のうちに選ぶと次の部品で必ず外す」として保留していたが、
**GPIO 3本（LED ×2・センサーの入力）と I2C 1本**で確定した。

**足した**（2026-09-14。#151。`gpiozero` / `RPLCD` / `smbus2`）。**3つとも純 Python** で、
連鎖に入る `colorzero` と `setuptools` も同じなので、**アーキテクチャを問わない。**

**ピンファクトリを足していない。** gpiozero は `lgpio` → `RPi.GPIO` → `pigpio` →
純 Python の `native` の順に探す。**何も足さず `native` に落ちる前提**で進めており、
外れたら実機に1行足す（`../unverified.md` 99）。

## 開発機だけの依存（`mock` グループ）

**`bless` は 0.2 系に固定してある**（`apps/device/pyproject.toml`）。
0.3.0 は **`bleak>=1.1.1`（これ自体が `winrt-* >= 3.1` を要求する）と `winrt-* == 2.0.0b1` の
両方を宣言**しており、**どの環境でも解決できない**（2026-09-19 に確認）。
**Python の版とは無関係**で、bleak が 1.1.1 を出した時点から踏む状態にあった
——3.13 へ上げてロックを取り直したときに、再解決が走って表に出ただけである。

**0.2 系は bleak 1.0 で消えた内部 module を import する**ので、`bleak<1.0` も一緒に縛っている。
**どちらも `mock` グループだけの話**で、実機にも CI にも入らない。**上流が直ったら両方外す。**

## 結果

- 開発機の `uv sync` は依存が増えても壊れない。**「実機なしで開発する」が維持される**（`0002`）
- 実機で C 拡張をコンパイルしない（**aarch64 にはホイールが有る**）
- **Python の版は実機のシステム Python に従う。** 実機の OS を替えるときは
  `0001-tech-stack.md` とこの ADR を一緒に読むこと
