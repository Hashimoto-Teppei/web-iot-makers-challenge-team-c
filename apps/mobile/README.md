# apps/mobile

走行前後に検知ログ・走行ログを確認するためのアプリ。Expo（React Native）で作る。**Android が主ターゲット。**

**走行中にこの画面を見る前提の機能を作らないこと。** 走行中のスマホ操作は取り締まりの対象で、
危険の通知はデバイス側（ディスプレイ / LED / ブザー）で完結させる方針です。

## 準備

**Expo Go では動きません。** BLE のネイティブモジュールを使うため、Development Build を各自で作ります。

1. Android Studio をセットアップする（Windows / macOS どちらでも可）
2. エミュレータを起動するか、開発者オプションを有効にした実機を USB でつなぐ
3. リポジトリのルートで `pnpm install`
4. `pnpm --filter mobile android`（＝ `expo run:android`）

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
