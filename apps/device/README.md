# apps/device

自転車に載せるデバイス（Raspberry Pi Zero W）のプログラム。Python で書く。

**このデバイスが担うのは2つだけです。**「センサーで後方の物体を検知すること」と、
「スマホから指示されたものを表示・再生すること」（[ADR 0006](../../docs/adr/0006-decision-layer-on-mobile.md)）。
**車車間の3つの検知はモバイルアプリ（TypeScript）に移りました。**
ここに位置情報は届きません。

**実機がなくても開発できます。** 手元の PC（Windows / macOS どちらでも）で
`uv sync` → `uv run pytest` まで通ります。BLE やセンサーなどハードウェアに触る部分は後から足すもので、
検知ロジックそのものはモックデータだけでテストできる状態を保ちます。

## 準備

リポジトリのルートで `mise install` を済ませてから（[`docs/setup.md`](../../docs/setup.md)）、
このディレクトリで:

```
uv sync
```

`uv` が Python 3.11 と依存パッケージを用意します。`pip` や `venv` を自分で触る必要はありません。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `uv run pytest` | テスト（`uv run pytest tests/test_geo.py::test_距離は向きによらず同じ` で1件だけ実行） |
| `uv run ruff check .` | lint |
| `uv run ruff format .` | 整形 |
| `uv run basedpyright` | 型チェック |

## 実機だけで要る依存

BLE と GPIO のライブラリは **Linux 専用**で、開発機（Windows / macOS）には入りません。
そのため `dependencies` ではなく **`device` という dependency-group に隔離してあります**
（[ADR 0008](../../docs/adr/0008-device-dependencies.md)）。

| どこ | コマンド | BLE の依存 |
| --- | --- | --- |
| 開発機 | `uv sync` | **入らない** |
| CI | `uv sync --locked` | **入らない** |
| 実機（Zero W） | `uv sync --group device --python /usr/bin/python3` | 入る |

**新しく実機専用の依存が要るときも `dependencies` へは移さないでください。**
移した瞬間、開発機の `uv sync` が失敗して全員の手が止まります。

**`hw/` の中では import が解決できません**（開発機にも CI にも入っていないため）。
ファイルの先頭に `# pyright: reportMissingImports=false` を1行置いて黙らせます。
**ファイル単位に閉じる**ので、`detect/` 側の import ミスは今までどおり見つかります。

実機へ載せる手順は [`docs/deploy-device.md`](../../docs/deploy-device.md)。

リポジトリのルートで `pnpm test` を実行すると、このディレクトリのテストも一緒に走ります
（`package.json` は Turborepo に認識させるためだけのもので、中身は `uv run` を呼ぶだけです）。

## ディレクトリ

部品（センサー・LED・スイッチ）は**後から増える**前提です。増えるたびに全体を書き直さずに済むよう、
**ハードウェアに触る層と、判断する層を分けます。**

| | 中身 |
| --- | --- |
| `src/device/detect/` | **判断する層。** センサーによる検知（後方の物体など）。1つの検知につき1ファイル |
| `src/device/hw/` | **ハードウェアに触る層。** 1つの部品につき1ファイル（`ble.py` / `led.py` / `lcd.py` …） |
| `src/device/alert.py` | **スマホから届く表示指示と心拍を読み解く**（`../../docs/interfaces/v2v.md`）。**BLE を知らないので開発機でもテストできる**。心拍が途切れたことに気づく仕組み（`LinkWatch`）も同じファイルにある |
| `src/device/idle.py` | **心拍の来ない接続を切るかどうか**の判定（`../../docs/interfaces/ble-gatt.md`「前提」）。**BLE を知らない**ので開発機でもテストできる。実際に切るのは `hw/ble.py` |
| `src/device/tuning.py` | **`config` で受け取る走行ごとのしきい値の上書き**（`../../docs/interfaces/ble-gatt.md`「`config`」）。**保存せず、切断で既定へ戻す。BLE を知らない**ので開発機でもテストできる |
| `src/device/notify.py` | 検知の結果をどう出すかの調停（`../../docs/notifications/arbitration.md`）。ハードには触らない |
| `src/device/main.py` | 起動と配線。どの部品の値をどの検知に渡し、結果をどこに出すかを決める |
| `src/device/state.py` | 今の状態（`link` / 転送の進み具合 / 受け取った警告の数）と、それを `device-info` / `status` の JSON にする変換。**BLE を知らない** |
| `src/device/identity.py` | `device_id` / `log_id` の生成と保存。アドバタイズの名前もここで作る |
| `src/device/config.py` | しきい値・**ピン番号**・失効やウォッチドッグの秒数などの設定。コードに直書きしない。**秘密値は置かない** — このファイルはコミットされる |
| `src/device/` 直下 | どの層からも使う共通の計算（`geo.py` の距離計算など） |
| `tools/` | 開発機で動かす道具。実機の代わりに「ラズパイのふり」をする BLE ペリフェラル（`mock_peripheral.py`） |
| `tests/` | テスト |

`detect/` はまだありません。**中身ができる前にディレクトリだけ先に作らないでください。**
最初のファイルを置く人が、そのときに作ります。

**`geo.py`（緯度経度の距離計算）は、いまこのアプリから使われていません。**
書いた時点ではデバイスが車車間の判断をする前提でしたが、
`../../docs/adr/0006-decision-layer-on-mobile.md` でその判断がスマホへ移りました。
**消さずに残しているのは、一時停止の事前通知をデバイス側でも扱う可能性が残っているため**です。

**同じ計算が `apps/mobile` 側に TypeScript で必要になります**（車車間の3検知と一時停止の事前通知は
どれも距離を使う）。**移植するのではなく、向こうで書いてください**——
言語もテストの仕組みも違うので、共有できるものはありません（`CLAUDE.md`「`packages/` はまだ作らない」）。

`hw` は hardware の略です。`io` にしないのは、Python の標準ライブラリに同名の `io` があり、
読むときにどちらか分からなくなるためです。

**位置情報はデバイスでは測りませんし、届きもしません。** 測位も車車間の判断もスマホ側です
（`../../docs/adr/0006-decision-layer-on-mobile.md`）。`hw/gps.py` は作りません。
届くのは「何を出すか」の指示と、**スマホが生きている印（心拍）だけ**です。
BlueZ を触る `hw/ble.py` は Linux 専用ですが、**受け取ったあとの処理はすべて `alert.py` 側**にあるので、
開発機（Windows / macOS）でも pytest で確かめられます。

**心拍が途切れたことを人に見せるのは、このデバイスの仕事です。**
判断がスマホへ移ったぶん、**スマホが黙ったときに気づける手段はこれしかありません**
（`../../docs/interfaces/v2v.md`「心拍を必ず見せる」）。

見張っているのは `alert.py` の `LinkWatch` で、`main.py` が毎秒呼び、結果を `status` の `link`
（`up` / `nofix` / `down`）として出します。秒数は `config.py` にあります。

**心拍が来ない接続は、30 秒ほどでデバイスの側から切ります**（`idle.py` の `IdleDisconnect`）。
BLE の接続枠は1つで、**つないでいる相手から枠を奪う手段はスマホ側にありません**。
他人がつなぎっぱなしにすると持ち主のスマホが接続できず、
**電源を切るしか戻す方法がなくなる**ためです（`../../docs/interfaces/ble-gatt.md`「前提」）。
持ち主のアプリは接続したら必ず心拍を毎秒書くので、**心拍を書かない接続は持ち主のものではありません。**

**いまの出力先は `status` と journalctl だけです。**何を出すかを決める `notify.py` は
入り（#60）、**届いた `warn` から毎秒 `arbitrate()` を呼ぶところまで `main.py` に繋がりました**
（#35）。**それを実際に鳴らす・光らせる `hw/` 側がまだありません**
（部品が未確定のため。#13）。`notify.py` は値を返すだけで、ハードウェアに触りません。
繋がっていることは、`warn` を書いたときに journalctl へ出る `表示:` と `鳴らす:` の行で確かめます。

## 実機なしで、アプリと本当につないでみる

実機が届くまで、**開発機を「ラズパイのふり」をする BLE ペリフェラルにできます。**

```
uv sync --group mock
uv run --group mock python tools/mock_peripheral.py
```

開発機が**本物の BLE ペリフェラル**として `bg-xxxx` の名前でアドバタイズし、
Android のアプリから電波で本当につながります。**判断のコードは本物をそのまま使います**——
`state.py` / `alert.py` / `idle.py` は BLE を知らないので、模擬から import できます
（差し替わるのは BLE の管だけです）。

**確かめられるのは、接続・MTU・サービス探索・`device-info` の Read・`status` の購読・
`alert` と `config` への書き込み・`link` の上がり下がり、そして心拍が止まったあとに
アプリが自力で戻れることまで**です。

**しきい値の上書き（#124）もここで確かめられます。** アプリの設定画面で値を変えると
`config` が書かれ、模擬側の journalctl 相当のログに「いま効いている上書き」が出て、
`status` の `cfg` に載ります。**切ると既定へ戻る**ところまで同じコード
（`tuning.py`）が動きます。

**確かめられないのは BlueZ の挙動です。** 相手が CoreBluetooth（macOS）なので、
[`docs/unverified.md`](../../docs/unverified.md) の 88 と 91、44 は**これでは消えません。**
**ここで通ることは、実機で通ることの根拠になりません。**

実機での起動は `uv run python -m device.main`（ラズパイ上でのみ動きます）。
起動すると BLE のアドバタイズが出て、スマホの汎用 BLE アプリから `bg-xxxx` として見えます
（`../../docs/interfaces/ble-gatt.md`）。

**`device_id` は初回起動時に作られ、`~/.local/share/bike-device/identity.json` に残ります**
（置き場所は `config.py`）。**リポジトリの中には置きません**——`git pull` や作り直しで消えると、
取り込みの一意キーが総入れ替えになります。

### それぞれの約束

- **`detect/` はハードウェアを知らない。** 入力を受けて結果を返すだけの関数にします。
  `hw/` は GPIO や BLE のライブラリ（Linux 専用）を import するため、`detect/` から呼ぶと
  開発機（Windows / macOS）でテストできなくなります（レビューで差し戻します）。
  `main.py` から `hw/` を呼ぶのは、それが `main.py` の役割なので問題ありません
- **`hw/` は判断しない。** センサーは値を返すだけ、LED は言われたとおりに光るだけにします。
  「この値なら危険だから光らせる」を `hw/` に書くと、その判断は実機がないと確かめられなくなります
- **つなぐのは `main.py` だけ。** 部品が増えたときに読む場所を1つにするためです
- **早すぎる共通化はしない。** センサーが2〜3種類そろってから共通化を考えます。
  1種類しかない段階で汎用の枠を作ると、次の部品でだいたい壊れます

## 書くときの約束

- **車車間の検知をここに書かない。** 実装先は `apps/mobile` です
  （`../../docs/adr/0006-decision-layer-on-mobile.md`）
- **しきい値（距離・速度・減速度）と GPIO のピン番号をコードに直書きしない。** どちらも実地で変わるため、
  設定として外に出します。配線の正本は `../../docs/hardware.md` です
- **配線する前に `../../docs/adr/0003-hardware-wiring.md` を読む。** ピンの予約手順と、
  基板を壊さないための約束（3.3V 制約・電流の上限）が書いてあります
- **実走行の GPS ログをコミットしない。** 位置情報は個人情報です。テストデータは合成したものを使います
