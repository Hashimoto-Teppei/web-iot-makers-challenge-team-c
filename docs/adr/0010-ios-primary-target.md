# ADR 0010: モバイルの主ターゲットを iOS にし、TestFlight で配る

- ステータス: 決定済み（**実機で確認済み**——2026-09-14 に iPhone で配布・起動・走行前点検の4項目・1時間の常駐まで通した。残りは `../unverified.md` 95 / 96 / 98）
- 日付: 2026-09-14
- 関連: `0001-tech-stack.md`（Android を主と決めた。**ここで変更する**）/
  `0002-development-lifecycle.md`（実機なしで開発する）/
  `0006-decision-layer-on-mobile.md`（判断がスマホへ移った）/
  `../deploy-mobile.md`（配る手順）

## 背景

**`0001` が Android を主ターゲットに選んだ理由は、機能ではなく配布だった。**
「無料の Apple ID による署名は7日で失効し、デモ当日に起動しなくなるリスクがある」
——`0001`「モバイル: Expo / ローカルビルド / Android 主」。
**iOS で機能が足りなかったわけではない。**ここを取り違えると、この ADR は
「iOS の制約が解消した」という誤った話に読める。

その配布の前提が2つ変わった。

1. **失効しない署名で配れる体制が取れた。** Apple Developer Program のアカウントを
   使えるようになり、**TestFlight のビルドは内部・外部どちらのテスターでも 90 日**
   配布できる（App Store Connect ヘルプで確認）。7日ごとの入れ直しが要らない。
2. **チームの iPhone 保有者が多い。** Android 実機を持つ人が限られており、
   **主ターゲットと、実際に手元にある端末がずれていた。**

## 決定

### 1. 主ターゲットを iOS にし、Android は従として残す

**Android を落とさない。**`../unverified.md` には Android 実機で通した確認が
20 行以上あり（22 の常駐、13 の MTU、53 の測位間隔、57 の方角、
`../interfaces/stop-signs-delivery.md` の `304` 素通り）、落とすとこれを全部捨てることになる。

コードの側にも落とす理由が無い。**`apps/mobile/src/` の Android 固有コードは
`src/ble/permissions.ts` だけ**で、そこは既に `Platform.OS !== "android"` で
早期 return している。`src/ride/location.ts` のコメントも iOS の挙動差
（`speed` が負、`timestamp` が小数、`course` が -1）を既に織り込んである。
**入れ替えの実体は、設定の穴を塞ぐことである。**

### 2. 配布は TestFlight

- **自分の端末は内部テスター**（App Store Connect のユーザーとして登録済み）。
  **Beta App Review を通らず、アップロード後すぐ配れる。**
- **他のメンバーは外部テスター。** メールアドレスか公開リンクで招待でき、
  **会社の App Store Connect にメンバーのアカウントを作らずに済む。**
- **外部グループへの1本目は Beta App Review を通る。**待ち時間が読めないので、
  **中身が未完成でも最初に1本上げて審査に入れる**（手順は `../deploy-mobile.md`）。
  デモ直前に審査へ当たると、**配布そのものが止まる。**

### 3. EAS Build を入れず、Mac ローカルの Xcode でアーカイブする

配布を Mac 1台に固定したため、**クラウドビルドの唯一の利点（Mac を持たない人が
ビルドできる）が効かない。**`eas.json` を置かず、アカウントも増やさない。
`0001` が「ビルド待ち時間とアカウント準備を避ける」としてローカルビルドを選んだ判断を、
ここでも引き継ぐ。**必要になったら後から入れられる。**

### 4. iOS のビルドと配布は担当を固定し、Windows のメンバーは `apps/device` を担当する

iOS のビルドは Mac + Xcode が要るため、`AGENTS.md`「どちらでも同じ手順で開発できることを
壊さない」と正面から衝突する。**新しい例外を作るのではなく、既にある例外の中に入れる**
——`../setup.md`「`apps/mobile` とデプロイは担当を固定している」がそれである。

Windows のメンバーは `apps/device`（Python）を担当する。**モバイル側に残る作業が、
検知アルゴリズムの実装から実機確認と BLE 転送へ移った**ためで、
検知3つ（`apps/mobile/src/detect/`）は既に実装とテストが揃っている。

**個人の割り当てはここに書かない**（`AGENTS.md`「担当者をドキュメントに書かない」）。
正本は Issue の assignee である。

### 5. Android で取った実機確認は消さない。iOS では「静かに壊れる4つ」だけ取り直す

**全部を取り直さない**（`0002`「動くところまでを作り、細かいところを深掘りしない」）。
iOS で結果が変わり、**かつ外れたことに走行中に気づけないもの**だけを積む
（`../unverified.md` 95〜98）。背景動作・MTU・`304` の素通り・GATT のキャッシュの4つ。

逆に**取り直さなくてよいものもある。57（方角の無い測位が真北として配られる）は
iOS では起きない**——iOS は `course` を測れないとき `-1` を返すので、
Android の `0.0`（真北）のように**確かな値として混ざる経路が無い。**

## 却下した案

### Android を落として iOS 単独にする

`Platform.OS` の分岐とフォアグラウンドサービス周りを消せるが、**消す手間のぶんだけ純損。**
上の「決定 1」のとおり、既に通した実機確認を捨てることになる。
**Android 機を予備として生かしておく方が、デモ当日の選択肢が増える。**

### EAS Build を入れる

Windows のメンバーも iOS ビルドを投げられるようになるが、**決定 4 でそのメンバーは
`apps/device` を担当すると決めたので、投げる人がいない。**依存とアカウントだけが増える。

### 無料の Apple ID で署名し、7日ごとに入れ直す

`0001` が想定していた副系統の運用。**人数ぶん毎週回す運用が持たない**うえ、
**各メンバーが自分の Mac に Xcode を用意する必要がある**（TestFlight なら要らない）。

### BLE の state restoration（`restoreStateIdentifier`）を入れる

iOS が背景でアプリを終了させたとき、BLE のイベントで復帰できるようになる。
**`AGENTS.md` の例外「静かに黙る故障」に当たるかを確かめたが、当たらない**
——アプリが死ねば心拍が途切れ、**デバイス側のウォッチドッグが `link: down` を出して
人に見せる**（`../interfaces/v2v.md`、`../unverified.md` 25）。気づけない故障ではないので、
ここは深掘りしない側に置く。

## 影響

- **`app.json` に `UIBackgroundModes` が2つ要る。**
  - `location` —— `expo-location` プラグインの `isIosBackgroundLocationEnabled: true` で入る。
    **無いと走行開始が必ず例外になる**：`LocationModule.swift` の
    `startLocationUpdatesAsync` が `hasBackgroundModeEnabled("location")` を見て
    `LocationUpdatesUnavailable` を投げる（upstream のソースで確認済み）。
    投げるので**静かには壊れない**——走行前の点検で止まる。
  - `bluetooth-central` —— `react-native-ble-plx` プラグインの `modes: ["central"]` で入る。
    **無いと画面を消した瞬間に BLE が止まる。**スキャンは既に Service UUID 指定
    （`src/ble/link.ts` の `startDeviceScan([SERVICE_UUID], ...)`）なので、
    iOS の背景スキャンの条件は満たしている。
- **走行前の点検に iOS の「正確な位置」の分岐が要る。**
  `src/ride/location.ts` の `checkLocationPermission` は `permission.android?.accuracy === "coarse"`
  しか見ていない。iOS には `permission.ios?.accuracy: "full" | "reduced"`（iOS 14 以降）がある。
  **外れると `hacc` が数百m〜数kmになり、受け取る側の上限で1通残らず捨てられて、
  画面には「測位: 取れていない」としか出ない**——Android で潰した静かな故障が、そのまま戻る。
- **権限の文言を日本語にする。** `NSBluetoothAlwaysUsageDescription` はプラグインの既定のままだと
  英語（`Allow $(PRODUCT_NAME) to connect to bluetooth devices`）になる。
- **`0001` の「ストアに提出せず端末へ直接インストールする前提」が変わる。**
  TestFlight は App Store Connect を通る。**外部テスターへの1本目が Beta App Review に
  かかるのはこのためである。**
- **`../deploy-mobile.md` を新設する**（`../deploy-device.md` と対になる）。
  **2026-09-14 に内部テスターへ1本配ってから書いた**——配る前に書いた手順は、書いた人以外に検証できない。
  `../setup.md` は 384 行あり、配布手順を足すと `AGENTS.md` の 400 行に達する。
  **`setup.md` は「開発を始めるまで」、`deploy-*` は「配るまで」**という既存の切り方に乗せる。
- **`ios/` は CNG の生成物で、`.gitignore` に既に入っている。**署名鍵（`*.p12` / `*.p8` /
  `*.mobileprovision`）も同様。**Xcode で設定した署名は `expo prebuild` を走らせ直すと消える**
  ので、手順に「Automatically manage signing で Team を選び直す」を明記する。

## 未確認

**上の4つのうち、`304` の素通り（97）は消えた**——2026-09-14 に iPhone 13 で確かめた
（`../interfaces/stop-signs-delivery.md`）。残るのは `../unverified.md` の **95 / 96 / 98**。

- **95（背景動作）は半分取れた。****常駐は 60 分通った**（心拍の途切れ 0 回）が、
  **机の上で止めて測ったので「動かすと 1Hz が出るか」は分からない。**実走行へ送った
- **96（MTU）は Zero W 相手の値だけが残った。**iPhone からは 515 が返る
  ——**ただしここは `link.ts` のバグで長く隠れていた**（iOS の `requestMTU` は
  要求値を捨てて即返すので、その戻り値から読むと必ず 23 になる。#165）
- **98（GATT のキャッシュ）は手つかず。**デバイス側に characteristic を足した回に見る

**Android 側の行は消さない**——決定 1 のとおり Android は従として残るため、
あちらの確認も生きている。
