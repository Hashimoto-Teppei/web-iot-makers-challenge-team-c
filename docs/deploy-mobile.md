# iPhone への配布手順（TestFlight）

**ビルドしたアプリを App Store Connect へ上げ、チームの iPhone に配るまで**をここにまとめる。
**ビルドそのものの手順は [`../apps/mobile/README.md`](../apps/mobile/README.md)** にあり、ここでは繰り返さない。
開発機の環境構築は [`setup.md`](./setup.md)、ラズパイは [`deploy-device.md`](./deploy-device.md)。

- ステータス: **内部テスターへ 1 本配り、iPhone 実機で起動と走行前点検まで確認済み**
  （2026-09-14 / `1.0.0 (2)`）。**外部テスターは Beta App Review 待ち**
- **なぜ TestFlight で配るのか**は [`adr/0010-ios-primary-target.md`](./adr/0010-ios-primary-target.md)

**この作業は macOS + Xcode でしかできない。** 担当を固定している理由は
[`setup.md`](./setup.md)「`apps/mobile` とデプロイは担当を固定している」。

**鍵と証明書をコミットしない。** `*.p12` / `*.p8` / `*.mobileprovision` は `.gitignore` 済み
（このリポジトリは public）。

## 0. 用意するもの

| もの | 備考 |
| --- | --- |
| macOS + Xcode | 通したのは **Xcode 26.6** / CocoaPods 1.16.2 |
| Apple Developer Program の有償アカウント | **App Manager 以上の権限**が要る（アプリの登録と証明書の発行に使う） |
| iPhone 実機 | 内部テスターとして受け取る端末 |

**無料の Apple ID は使わない**（署名が 7 日で失効する。
[`adr/0010`](./adr/0010-ios-primary-target.md)「却下した案」）。

## 1. 一度だけやること

**3 つとも Apple のサーバー側の登録**で、Mac を替えない限り 2 回目は無い。

### 1-1. 個別の App ID を登録する

[Identifiers](https://developer.apple.com/account/resources/identifiers/list) で右上のチームが
**会社のチーム**になっていることを確かめてから「+」。

1. **App IDs** → Continue
2. **App** → Continue
3. Description: `Team C Bike Alert`
4. Bundle ID: **Explicit** を選び、`jp.teamc.bikealert`（`app.json` の `ios.bundleIdentifier` と同じ値）
5. Capabilities は**何も触らない** → Continue → Register

**ここを Xcode の自動署名に任せない。** Push 通知や App Groups を使わないアプリに対して、
Xcode はチーム共用のワイルドカード App ID（`<TeamID>.*`）で済ませてしまう。
開発ビルドはそれで通るが、**App Store Connect のアプリ登録には個別の App ID しか使えない。**
任せると、次の 1-2 でプルダウンに Bundle ID が出てこず、**原因が分からないまま止まる。**

**Description は英数字とスペースしか受け付けない。** 日本語も `-` も `.` も弾かれる。
Apple 側の管理ラベルで、どこにも表示されない。

**`UIBackgroundModes` に当たる項目をここで探さない。無い。**
`location` と `bluetooth-central` は**アプリに埋め込む Info.plist の話**で（`app.json` で設定済み）、
App ID 側で許可を得る種類のものではない。

### 1-2. App Store Connect にアプリを登録する

[App Store Connect](https://appstoreconnect.apple.com/apps) の「+」→「新規アプリ」。

| 項目 | 値 |
| --- | --- |
| プラットフォーム | iOS |
| 名前 | `チームC 自転車アラート` |
| プライマリ言語 | 日本語 |
| バンドル ID | `jp.teamc.bikealert`（1-1 で登録したもの） |
| SKU | `jp-teamc-bikealert` |
| ユーザーアクセス | フルアクセス |

**この登録を飛ばすとアップロードが `No suitable application records were found.` で弾かれる。**
1-1 で登録したのは開発者ポータル側の Bundle ID であって、**TestFlight で配る単位である
「アプリ」はまだ存在しない。**

**名前は全 App Store で一意**である必要があり、短い一般語は取られている。**後から変更できる。**
**端末のホーム画面に出る名前（`app.json` の `name`）とは別物**で、揃える必要は無い。

「ユーザーアクセスを保存できませんでした」が出ても**進んでよい。**
これは社内の App Store Connect ユーザーのうち誰にこのアプリを見せるかの設定で、
**作成者本人は常にアクセスでき、外部テスターは App Store Connect のユーザーですらない。**

### 1-3. 配布用証明書を作る

Xcode ▸ Settings（`⌘,`）▸ **Accounts** ▸ Apple ID を選ぶ ▸ チームを選ぶ ▸
**Manage Certificates…** ▸ 左下の「**+**」▸ **Apple Distribution**。

**Archive のときに Xcode が出すウィザードに乗らない。** アカウント設定アシスタントに入り、
**GitHub へのアクセス許可（`Grant Access to Your Source Code`）まで聞かれて遠回りになる**——
あれはソース管理の機能で、証明書とは無関係。Cancel してこの経路で作る方が速い。

手元にあるのが Development だけかどうかは、`Manage Certificates…` の**見出し**で見分ける
（`Apple Development Certificates` しか無ければ配布用は未発行）。ターミナルなら:

```sh
security find-identity -v -p codesigning
```

## 2. ビルドして上げる

**ここから先は配るたびに毎回やる。**

### 2-1. ビルド番号を上げる

`apps/mobile/app.json` の `ios.buildNumber` を 1 つ増やす。

**同じ番号は二度と受け付けられない。取り込みに失敗したぶんも消費される。**
`version`（`1.0.0`）を上げるのは、配る中身の区切りを変えたいときだけでよい。

**`app.json` を書き換えただけでは `Info.plist` に入らない。**次の 2-2 の `prebuild` が
入れる。**飛ばすと前の番号のまま Archive され、アップロードの最後で弾かれる**
（確かめ方は 2-3 の `CFBundleVersion`）。

### 2-2. ネイティブを作り直して Team を選び直す

```sh
pnpm --filter mobile signs:build
cd apps/mobile
npx expo prebuild --platform ios
```

**`prebuild` は `ios/` を消して作り直すので、Xcode で設定した Team が消える。**
`ios/C.xcworkspace` を開き直し（**`.xcodeproj` ではない**）、
TARGETS の `C` ▸ **Signing & Capabilities** ▸ **Team** を選び直す。

**これは設定ミスではなく仕様。**（`ios/` は生成物で gitignore 済み。
[`adr/0010`](./adr/0010-ios-primary-target.md)「影響」）

**Xcode を開いたまま `prebuild` を走らせない。** 開いているプロジェクトのファイルごと
消えるため、一度終了してから開き直す。

### 2-3. Archive する

1. 実行先を「**Any iOS Device (arm64)**」にする
2. **Product ▸ Archive**

**1 を先にやらないと Archive がグレーで押せない。** シミュレータ向けの成果物は配布できないため。
初回は Hermes の変換と JS バンドルの生成が走るので **5〜15 分**かかる。

**上げる前に、成果物の中身を見ておくと 1 往復減らせる**（アップロードの検証は
上げてから数分後にメールで返ってくるため）:

```sh
A=$(ls -dt ~/Library/Developer/Xcode/Archives/*/*.xcarchive | head -1)
APP="$A/Products/Applications/C.app"
plutil -p "$APP/Info.plist" | grep -E "CFBundleVersion|NS.*UsageDescription|ITSApp"
plutil -extract UIBackgroundModes json -o - "$APP/Info.plist"
ls -la "$APP/main.jsbundle" "$APP/assets/assets/signs.db"
```

**`Debug` では確かめられないものがここで初めて見える。** Debug は JS も資産も Metro から
読むため、`main.jsbundle` と `signs.db` が本当に焼き込まれるかは **Release の成果物でしか分からない。**

### 2-4. アップロードする

Organizer で **Distribute App** ▸ 「**App Store Connect**」▸ Distribute。
署名は **Automatically manage signing** のまま。

**「TestFlight Internal Only」を選ばない。** 名前が近いが、**そのビルドは外部テスターへ出せず、
審査にも出せない**——選ぶとアップロードからやり直しになる。

アップロード後、App Store Connect 側の処理に **5〜30 分**かかる。終わるとメールが届く。

## 3. 配る

### 3-1. 内部テスター（審査なし・すぐ届く）

TestFlight ▸ 「内部テスト」のグループ ▸ **テスター**に自分を足し、**ビルド**に今回のビルドを足す。
**Beta App Review を通らないので、足した瞬間に配布可能**になる。

受け取る側は、iPhone に **TestFlight アプリ**を入れ、**App Store Connect と同じ Apple ID**
でサインインする。

### 3-2. 外部テスター（1 本目だけ審査）

**先に TestFlight ▸「テスト情報」を埋める。** 埋めないとグループへ提出できない。

- **ベータ版 App の説明** —— **位置情報と Bluetooth を背景で使う理由を明記する。**
  ここが曖昧だと審査で止まる
- **フィードバックメールアドレス**、**連絡先情報**（審査員の問い合わせ先。テスターには見えない）
- **サインインが必要** のチェックは**外す**（このアプリにログインは無い）
- プライバシーポリシー URL は**必須ではない**（2026-09 時点）

そのうえで「外部テスト」でグループを作り、**ビルド**を足すと提出を求められる。

**中身が未完成でも、最初の 1 本を早く審査へ入れる。**
審査を通るのは**そのグループの 1 本目だけ**で、2 本目以降は基本的に素通りする。
つまりこの提出は「**このグループを審査済みにしておく**」ための作業であり、
**中身の完成度とは切り離せる。**後回しにすると、デモ直前に「配ろうとしたら審査待ち」という
**手の打ちようがない止まり方**をする（[`adr/0010`](./adr/0010-ios-primary-target.md)「決定 2」）。

テスターの招待は**パブリックリンクを使う。** メールアドレスを集めて登録するより速く、
受け取る側も招待メールの見落としで止まらない。
**リンクをリポジトリにコミットしない**——知っていれば誰でもインストールできる（public リポジトリ）。

**ビルドの有効期限は内部・外部とも 90 日。**

## 4. 出るが、無視してよいもの

- **`Upload Symbols Failed`（dSYM が無い）** —— `React.framework` /
  `ReactNativeDependencies.framework` / `hermesvm.framework` で出る。
  **React Native 0.86 がこれらをビルド済みの XCFramework で配っており、dSYM を同梱していない**ため。
  影響は「React Native 本体の中でクラッシュしたときのレポートが関数名まで解決されない」だけで、
  **こちらが書いた TypeScript には影響しない。**
- **輸出コンプライアンスを聞かれない** —— `app.json` に
  `ITSAppUsesNonExemptEncryption: false` を入れてあるため。聞かれたら「該当しない」。
- **「Sending analysis to App Store Connect...」で 40 分止まって見える** ——
  **Cancel しない。**2026-09-14 に実際に起きた。`asset-description` という **2MB の部品ひとつだけ**が
  `Checksums do not match` で **1,603 回**はねられ続け、**40 分後にそのまま通った**
  （その後、本体の IPA 20MB は 4 パートを**再試行 0 回・2.3 秒**で送り終えている）。
  **Apple 側の一時的な不調で、こちらの環境は関係ない**——回線が中身を壊しているなら、
  小さい方ではなく 20MB の方が失敗する。

  **本当に進んでいるかは、ログで分かる。**画面の進捗バーは当てにならない。

  ```sh
  D=$(ls -dt "$TMPDIR"/C_*.xcdistributionlogs | head -1)
  tail -f "$D/ContentDelivery.log"
  ```

  `WILL RETRY PART 1` が流れ続けていれば**この現象**。`UPLOAD SUCCEEDED with no errors` が出れば完了。

## 5. 弾かれたときに見るところ

### `ITMS-90683: Missing purpose string in Info.plist`

**Info.plist に使用目的の文言が足りない。** Apple の検査は
**バイナリがその API を参照しているか**だけを見る——**こちらのコードが実際に使うかどうかは関係ない。**

実際に起きた例: `expo-location` の設定で `motionUsagePermission` を `false` にしていた
（英語の既定文言が残るのを嫌って消した）が、**`ExpoLocation.framework` が `CoreMotion` を
リンクしている**ため `NSMotionUsageDescription` が必須だった。**消すのではなく日本語に差し替える**
のが正解。

どのフレームワークが原因かは成果物から辿れる:

```sh
otool -L "$APP/C" | grep -i coremotion            # アプリ本体が参照しているか
otool -L "$APP/Frameworks/ExpoLocation.framework/ExpoLocation" | grep -i coremotion
```

**上げ直す前に 2-1 のビルド番号を必ず上げる。**
