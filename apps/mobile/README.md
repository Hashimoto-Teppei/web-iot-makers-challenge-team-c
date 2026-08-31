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

接続先の既定値は `http://10.0.2.2:5173`（Android エミュレータから見たホスト PC）。
実機で試すときは PC の LAN 内 IP を `.env.local` に書きます。

```
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.5:5173
```

**`EXPO_PUBLIC_` で始まる環境変数はアプリのバンドルに埋め込まれ、利用者から読めます。**
秘密の値をここに置かないでください。

**配る APK をビルドするときは、`EXPO_PUBLIC_API_BASE_URL` に Cloudflare の URL（`https://…workers.dev`）を
必ず指定してください。** 既定値の `http://10.0.2.2:5173` は自分の PC を指すうえ、Android のリリースビルドは
暗号化されていない http 通信を既定で拒否するため、指定を忘れると通信できません。

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
