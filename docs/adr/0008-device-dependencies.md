# ADR 0008: デバイスの依存は uv で管理し、実機ではシステム Python + piwheels に乗せる

- ステータス: 決定済み（**実機未確認** → `../unverified.md`）
- 日付: 2026-08-31
- 関連: `0001-tech-stack.md`（Python の版）/ `0002-development-lifecycle.md`（実機なしで開発する）

## 背景

`apps/device` の `dependencies` は空のまま来た。実行時の依存がまだ1つも無かったためで、
**BLE ペリフェラルの実装（#37）に着手した瞬間に、次の3つが同時にぶつかる。**

1. **BLE と GPIO のライブラリは Linux 専用。** 素朴に `dependencies` へ足すと、
   開発機（Windows / macOS）で `uv sync` が失敗し、**全員の手が止まる**
2. **Raspberry Pi Zero W は ARMv6。** ホイールが無ければソースビルドに落ちるが、
   1GHz 単コア / RAM 512MB で C 拡張をコンパイルするのは現実的でない
3. **`uv` は実機に Python を用意できない。** `uv python install` が使う python-build-standalone は
   armv7 以上しかビルドを出していない（`uv` 本体のバイナリは armv6 で動く）

## 決定

### 1. 実機ではシステムの Python 3.11 を使う

`uv sync --python /usr/bin/python3` で実機のシステム Python を指す。
**`[tool.uv] python-preference` は設定しない**——プロジェクト全体に効いてしまい、
開発機の挙動まで変わるため。実機だけの事情は実機の手順に置く（`../deploy-device.md`）。

### 2. piwheels を実機側の extra index に足す

**ARMv6 でソースビルドを避ける唯一の現実的な手段。** Raspberry Pi OS の `pip` は
既定で piwheels を見ているが、`uv` は見ないので実機で明示的に足す。

**piwheels は「その OS が配る Python の版」にしかホイールを出さない。**
つまり `0001` で Python を 3.11 に下げた決定が、そのままここで効いている。
3.12 のままなら、仮に実機に 3.12 を用意できたとしても**ホイールは1つも無かった。**

BLE に必要な連鎖は cp311 の `linux_armv6l` が揃っていることを確認済み:

| パッケージ | 種類 | armv6l / cp311 |
| --- | --- | --- |
| `bluezero` | pure Python | `py2.py3-none-any`（アーキテクチャに依存しない） |
| `PyGObject` | C 拡張 | あり |
| `pycairo` | C 拡張 | あり |

**`dbus-fast` は採らない。** piwheels に **armv7l のホイールしか無く**、
ARMv6 では一致せずソースビルド（Cython）に落ちる。**Zero W では通らない。**

**`pyproject.toml` には piwheels を書かない。** 開発機の依存解決まで ARM 向けの index を
経由させないため。実機の `~/.config/uv/uv.toml` に置く（手順は `../deploy-device.md`）。

### 3. 実機だけで要る依存は dependency-group に隔離する

```toml
[dependency-groups]
device = ["bluezero>=0.9"]   # 既定では入らない。実機だけ --group device で入れる
```

**`sys_platform == 'linux'` のマーカーは使わない。** マーカーだと **CI（ubuntu）に入ってしまい**、
x86 の PyPI には `PyGObject` のホイールが無いためビルドが走る。
CI を遅くしたうえ、**実機で確かめたい「入るかどうか」を x86 で偽装する**ことになる。

結果としてこうなる:

| どこ | コマンド | BLE の依存 |
| --- | --- | --- |
| 開発機（Windows / macOS / Linux） | `uv sync` | **入らない** |
| CI | `uv sync --locked` | **入らない** |
| 実機（Zero W） | `uv sync --group device --python /usr/bin/python3` | 入る |

**型チェックはどの環境でも `bluezero` が無い前提で動く。** 開発機と CI で挙動がぶれないよう、
import が解決できないことを **`hw/ble.py` の先頭で明示的に黙らせる**
（`# pyright: reportMissingImports=false`）。ファイル単位に閉じるので、
`detect/` 側の import ミスは今までどおり検出される。

### 4. 実機では `uv sync` に `--locked` を付けない

`uv.lock` は開発機（x86 / arm64）で作られるため、**armv6 のホイールが記録されていない可能性がある。**
`--locked` で固定すると sdist からのビルドに落ちうるので、実機では付けずに解決させる。
**CI は `--locked` のままにする**——ロックの更新漏れを見張る役目はそちらに残す。

### 5. Docker は使わない

- **Zero W に載せる意味が無い。** BLE と GPIO には `--privileged` とホストの D-Bus / ネットワークが要り、
  **隔離という利点がほぼ残らない**。RAM 512MB でデーモンを常駐させる余裕も無い
- **ARMv6 は Docker のエコシステムから外れつつある。** 公式・非公式ともイメージの供給が細く、
  ハッカソンの期間で踏む地雷としては大きい

**ただし開発機で armv6 の依存解決を試す用途には使える**（`docker buildx --platform linux/arm/v6` + QEMU）。
実機が無い間に「本当にホイールが降ってくるか」を確かめたくなったときの選択肢として残す。
**QEMU での ARMv6 エミュレーションは遅い**ので、常用はしない。

### 6. 実機の上で直接コードを書かない

Zero W はネットに繋がるので、実機で `git clone` して動かすのは素直で、**そうする**。
だが**編集そのものを実機でやるのは避ける。**

- **VS Code の Remote-SSH は ARMv6 に対応していない**（公式に unsupported）。
  Zero W に繋ぐと「Unsupported architecture: armv6l」で接続自体が失敗する
- 手元の PC には Ruff / basedpyright / pytest が揃っており、**そちらの方が速く回る**

**編集は開発機、実行は実機。運ぶのは `git pull`。** リポジトリが public なので鍵の設定も要らない。

## 却下した案

- **apt の `python3-dbus` / `python3-gi` を使い、venv を `--system-site-packages` で開く** —
  依存の一部が uv の管理から外れ、**実機だけ別の入れ方**になる。手順が二重化し、
  `pyproject.toml` を見ても何が入るのか分からなくなる。piwheels でホイールが降ってくると
  分かった時点で、この道を選ぶ理由が無くなった
- **`dbus-fast` で BlueZ を直接叩く** — armv6 のホイールが無い（上記）
- **`jeepney`（純 Python の D-Bus 実装）で GATT の登録を自前で書く** — 依存は最も軽いが、
  **BlueZ の D-Bus API を自分で組む量が増える。** ハッカソンの期間で払う対価としては重い

## GPIO について

**まだ決めない。** 部品が未定のため（`../hardware.md` / #13）、いま選ぶと**次の部品で必ず外す。**
`gpiozero`（純 Python）を第一候補とし、**部品が決まった時点でバックエンドごと `device` グループに足す。**
そのときに従う形はこの ADR で決まっているので、追加は1行で済む。

## 結果

- 開発機の `uv sync` は依存が増えても壊れない。**「実機なしで開発する」が維持される**（`0002`）
- 実機で C 拡張をコンパイルしない
- Python の版（`0001`）と piwheels の供給が噛み合う。**片方を動かすともう片方が壊れる**ので、
  Python の版を上げるときはこの ADR も一緒に読むこと
