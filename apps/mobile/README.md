# apps/mobile

走行前後に検知ログ・走行ログを確認するためのアプリ。Expo（React Native）で作る。**Android が主ターゲット。**

**走行中にこの画面を見る前提の機能を作らないこと。** 走行中のスマホ操作は取り締まりの対象で、
危険の通知はデバイス側（ディスプレイ / LED / ブザー）で完結させる方針です。

## 準備

**Expo Go では動きません。** BLE のネイティブモジュールを使うため、Development Build を各自で作ります。

**このアプリは担当を固定しています。** 触らない人はここのセットアップは不要です
（`pnpm install` は依存を入れますが、それだけならビルド環境は要りません）。
共通の環境構築は [`docs/setup.md`](../../docs/setup.md) を先に済ませてください。

手順は [Expo 公式の環境構築ガイド](https://docs.expo.dev/get-started/set-up-your-environment/?mode=development-build&platform=android)
に沿っています（最終確認 2026-08-25）。

### 1. JDK 17 を入れる

Android のビルドは JDK 17 でないと通りません（新しすぎても失敗します）。

```sh
brew install --cask zulu@17          # macOS
```

```powershell
winget install Microsoft.OpenJDK.17  # Windows
```

`java -version` で 17 が出ることを確認します。

- **macOS は、17 を入れただけでは切り替わりません。** 別のプロジェクトで新しい JDK を入れていると
  そちらが使われます。手順3で `JAVA_HOME` を明示してください。
- **Windows は winget が `JAVA_HOME` と `Path` まで設定します**（パッケージが `FeatureJavaHome` /
  `FeatureEnvironment` 付きでインストールするため）。あとから別の JDK を入れたときだけ、手順3で直します。

> Expo 公式は Windows に `choco install -y microsoft-openjdk17` を案内していますが、
> 中身は同じ Microsoft Build of OpenJDK 17 です。このリポジトリは他のツールも winget で入れるため、
> Chocolatey を増やさず winget に揃えています。

### 2. Android Studio と SDK を入れる

[公式サイト](https://developer.android.com/studio)からインストールし、
**Settings > Languages & Frameworks > Android SDK** を開きます。

`SDK Platforms` タブで右下の **Show Package Details** にチェックを入れ、次を選んで適用します。

- Android SDK Platform 36
- Sources for Android 36

`SDK Tools` タブでは **Android SDK Build-Tools** と **Android Emulator** を入れます。

### 3. 環境変数を設定する

```sh
# macOS: ~/.zshrc に追記してターミナルを開き直す
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export PATH=$JAVA_HOME/bin:$PATH
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

`JAVA_HOME` を書くのは、**新しい JDK が入っていても 17 を使わせるため**です。
Gradle はこの変数を見ます。書いたら `java -version` が 17 になることを確認してください。

`/usr/libexec/java_home -v 17` は macOS 標準のコマンドで、入っている JDK 17 の場所を返します。
Expo 公式は `/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home` を直接書く案内ですが、
こちらのほうが Zulu 以外を入れた場合でも壊れません。

Windows は「システム環境変数の編集」から、ユーザー環境変数に次を追加します。

- `ANDROID_HOME` = `%LOCALAPPDATA%\Android\Sdk`
- `Path` に `%LOCALAPPDATA%\Android\Sdk\platform-tools` を追加
- `Path` に `%LOCALAPPDATA%\Android\Sdk\emulator` を追加（エミュレータを使う場合）
- あとから 17 以外の JDK を入れた場合は、`JAVA_HOME` を JDK 17 のパスに戻す
  （winget で入れた直後は設定済みです）

さらに `git config --global core.longpaths true` を済ませておきます
（React Native のビルドは Windows のパス長制限 260 文字を超えます）。

### 4. 端末を用意してビルドする

エミュレータを起動するか、実機を USB でつなぎます。実機の場合は
設定 > デバイス情報 > **ビルド番号を7回タップ**して開発者オプションを出し、**USB デバッグ**をオンにします。

```sh
adb devices                      # 端末が一覧に出れば認識されている
pnpm install                     # リポジトリのルートで
pnpm --filter mobile android     # ＝ expo run:android
```

`adb devices` に出ないときは、USB デバッグがオンか、ケーブルが**充電専用でない**かを確認します。

**初回のネイティブビルドは非常に時間がかかります。** C++ のコンパイル（reanimated / worklets /
expo-modules-core）が大半で、開発機によっては数時間かかることがあります（M シリーズの Mac で約7時間の実測あり）。
`:app:buildCMakeDebug` のあたりで出力が止まって見えても、進行中です。**止めないでください。**
2回目以降はキャッシュが効いて数分で終わります。

普段の開発では `pnpm --filter mobile dev` で開発サーバーだけ起動すれば、JavaScript の変更は即座に反映されます。
もう一度ビルドが要るのは、ネイティブの依存（`expo-*` のライブラリなど）を足したときだけです。

`android/` `ios/` は `expo prebuild` の生成物で、gitignore 済みです。手で編集しないでください。

## API につなぐ

`src/lib/api.ts` が `apps/web` の `AppType` を型として読み込み、`hc<AppType>()` でクライアントを作ります。
API の URL やレスポンスの形が変わると、モバイル側は**型エラーとして**気づけます。

**接続先の既定値はデプロイ先の Worker**（URL の正本は `src/lib/api-base.ts`）。
**そのままビルドすれば配れる APK になります。**

手元の `apps/web` に向けたいときだけ `.env.local` に書きます。
**手順の正本は [`docs/setup.md`](../../docs/setup.md)**（`.env.example` をコピーして使います）。
書き換えたあとに Metro を `--clear` 付きで再起動することと、同梱物も `--base` で作り直すことも
そちらに書いてあります。

**BLE のネイティブモジュールが無い環境では、走行ループは中継を断ります**
（`src/lib/mock-guard.ts` の `blocksMockDevice`）。そこでは `createMockDeviceLink()` に落ちて
**全員が同じ `a1000001` を名乗る**ため、そのまま共有の Durable Object へ投げると
**実際の位置が半径 300m の他人に見え**、**開発者どうしが同じ枠を上書きし合う**
（位置情報は個人情報である。`CLAUDE.md`）。**手元に向けているときだけ実際に中継します。**
**実機のデバイスにつながれば、デバイスから読んだ `device_id` を名乗るので歯止めは外れます。**
検知そのものはシミュレータで確かめられます（`src/sim/`。ネットワークを使いません）。

**`EXPO_PUBLIC_` で始まる環境変数はアプリのバンドルに埋め込まれ、利用者から読めます。**
秘密の値をここに置かないでください（**URL は秘密ではない**ので、上の既定値はコミットしてあります）。

**配る APK をビルドする前に `.env.local` を確かめてください。**
手元に向けたまま残っていると、その URL は自分の PC を指すうえ、Android のリリースビルドは
暗号化されていない http 通信を既定で拒否するため、通信できません。
**消してから `--clear` 付きでビルドする**（＝既定の https に戻す）のが確実です。
**消し忘れは画面に出ません**——起動して繋がらないことでしか分かりません。

## 検知のコードとテスト

危険検知は `src/detect/` に置きます。**仕様の正本は
[`docs/interfaces/detectors.md`](../../docs/interfaces/detectors.md)** で、ここには書き写しません。

```
src/detect/
  types.ts   4つの検知が共有する型（Fix / Track / DetectorInput / Warning / Detector）
  geo.ts     距離・方位角・角度差の正規化
```

**検知は測位にも BLE にも HTTP にも触れない純粋な関数**なので、実機も Android のビルドも要りません。
`pnpm install` さえ済んでいれば、Windows でも macOS でもテストが走ります。

```sh
pnpm --filter mobile test          # 一度だけ実行
pnpm --filter mobile exec vitest   # 変更を監視して実行し続ける
```

テストは検知と同じ名前で並べます（`approach.ts` なら `approach.test.ts`）。
**実走行の GPS ログは使わず、合成したモックデータで書いてください**（位置情報は個人情報です）。

Vitest の設定は `vitest.config.mts` にあり、`src/` 全体の `*.test.ts` を対象にしています
（シミュレータのテストもここで走ります）。画面（`src/app/`）だけは react-native の解決が要るので
除外しており、書くときは別のプロジェクト設定を足してください。

> **Vitest だけは `pnpm add -D` で入れています。** 下の「依存を足すときは `npx expo install`」は
> Expo SDK が組み合わせを固定しているパッケージの話で、Vitest はその管理外だからです。

## 書いた検知をアプリの中で動かす

**検知を1つ足す手順は2つです。**

1. `src/detect/` に自分のファイルを1つ足す（`hard-brake.ts` など）
2. **`src/ride/detectors.ts` の配列に1行足す** —— `register("brake", detectHardBrake, hardBrakeDefaults),`

**これだけで走行ループが毎周期呼びます。**呼び出し側（`src/ride/loop.ts`）は触りません
（触る形にすると、並行で書いている担当どうしが同じ場所を編集してぶつかります）。

```
src/ride/
  detectors.ts     検知の登録口。**検知を足す人が触るのはここだけ**
  loop.ts          走行ループ（測位 → 中継 → 検知 → 出力）。BLE も測位も HTTP も知らない
  warn-gate.ts     同じ警告を毎周期書き直さないための抑制
  device.ts        BLE の出口（口だけ）とモック実装。実装は `src/ble/`
  location.ts      測位の購読と常駐（expo-location を知っている唯一の場所）
  api.ts           POST /api/v2v/exchange の実装
  use-ride-loop.ts 画面のライフサイクルに載せるフック
  use-device-link.ts 接続中のデバイスを1つ持つフック（`src/ble/` を画面に載せる）
```

## デバイスとの接続（`src/ble/`）

**GATT の約束の正本は
[`docs/interfaces/ble-gatt.md`](../../docs/interfaces/ble-gatt.md)** で、ここには書き写しません。

```
src/ble/
  protocol.ts    UUID・MTU の下限・`device-info` / `status` の解釈（React Native を知らない）
  base64.ts      UTF-8 ⇄ Base64（react-native-ble-plx が Base64 でやりとりするため）
  permissions.ts Android の実行時権限
  link.ts        スキャン・接続・MTU・サービス探索・再接続（react-native-ble-plx を知る唯一の場所）
```

**`protocol.ts` と `base64.ts` は開発機の Vitest で回せます**（実機も Development Build も要りません）。
`link.ts` にはテストを置きません——実機の BLE が要るものは実機で確かめます
（`docs/adr/0002-development-lifecycle.md`）。

**BLE のネイティブモジュールが無い環境（Web など）ではモックに落ちます**
（`src/ride/use-device-link.ts`）。**モックであることは走行前の点検に必ず出る**ので、
黙って実機のふりをすることはありません。

**動いたことは実機なしで確かめられます。**シミュレータのシナリオを走行ループごと回して、
デバイスの出口に `warn` が届くかを見ます（`src/sim/ride.ts`）。

```ts
const frames = await runRide(hardBrakeAhead, {
  detectors: [register("brake", detectHardBrake, hardBrakeDefaults)],
});
expect(frames.flatMap((f) => f.warns).length).toBeGreaterThan(0);
```

**`src/sim/run.ts` の `runDetectorInputs()` との違い**は、あちらが「検知に渡る入力」までを
返すのに対し、こちらは**登録・抑制・BLE への書き込みまで**通ることです。
検知そのものの合否は前者で、アプリの中で動くことの確認は後者で見ます。

## 一時停止の標識（`src/signs/`）

**県ぶんの標識をアプリに同梱し、走行中は SQLite（`expo-sqlite`）で近傍だけを引きます。**
**決めた理由の正本は [`docs/adr/0009-on-device-storage.md`](../../docs/adr/0009-on-device-storage.md)**、
配り方は [`docs/interfaces/mobile-api.md`](../../docs/interfaces/mobile-api.md)。ここには置き場所だけを書きます。

```
src/signs/
  cell.ts      セル（緯度経度を小数第3位で切り捨てた升目）。切り方の正本は docs/interfaces/web-stats.md
  schema.ts    signs.db の Drizzle スキーマと、作るときの DDL
  store.ts     SignStore の口 / メモリ実装 / SQL 実装（better-sqlite3 と expo-sqlite で共通）
  node.ts      better-sqlite3（Node のテストと同梱物の生成。**アプリから import しない**）
  expo.ts      expo-sqlite（実機。React Native に触れる唯一のファイル）
  nearby.ts    セルをまたいだときだけ引き直す
  response.ts  GET /api/stop-signs の応答を確かめる（同梱物を作るときだけ通る）
scripts/build-signs-db.ts  同梱物を作る
```

**`assets/signs.db` は生成物で、リポジトリに入っていません。**作り方は
[`docs/setup.md`](../../docs/setup.md)。**作っていないとビルドが止まります**（そういう作りです）。

**走行ループも検知も SQL を知りません。**間に `SignStore` があるので、テストは実機なしで回せます。
**メモリ実装と `better-sqlite3` 実装に同じテストを回している**（`src/signs/store.test.ts`）のは、
メモリだけだと「実機の SQL が間違っている」が素通りするためです。

> **`better-sqlite3` は `pnpm add -D` で入れています。**Vitest と同じ理由（Expo SDK の管理外）で、
> **Node でしか動きません。**アプリの中では `expo-sqlite` を使います。

## 他のアプリとバージョンが違うのは正常

`apps/mobile` だけ React が 19.2.3、TypeScript が 6 系です（他は React 19.2.8 / TypeScript 7 系）。
Expo SDK が動作確認済みの組み合わせを固定しているためで、揃えにいくと壊れます。

**依存を足すときは `npx expo install <パッケージ名>` を使ってください。**
`pnpm add` で最新版を入れると SDK が想定するバージョンから外れます。

`npx expo-doctor` は React の重複を警告しますが、これは `apps/web` の React を見ているためで、
ビルドには影響しません。

## 配布

ストアには出さず、APK を配って各自インストールします。iOS は Mac + Xcode が必要で、
無料の Apple ID で署名すると7日で失効するため、デモ当日の直前に入れ直せる体制が要ります。
