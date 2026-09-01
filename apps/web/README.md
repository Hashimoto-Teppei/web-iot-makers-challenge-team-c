# apps/web

画面（React）と API（Hono）を **1つの Cloudflare Worker** で動かすアプリ。

## 起動

リポジトリのルートで `pnpm dev`（このディレクトリ単体なら `pnpm --filter web dev`）。
http://localhost:5173 が開き、`/api/health` が JSON を返す。

画面と API が同じオリジンなので、フロントからは `fetch("/api/health")` と相対パスで呼べる。
CORS の設定や API の URL を環境変数で配線する必要はない。

## ディレクトリ

| | 中身 |
| --- | --- |
| `src/client/` | React（Vite）。画面担当が触る |
| `src/worker/` | Hono + Cloudflare Workers。API 担当が触る |
| `src/shared/` | 両方から使う型だけを置く |

`src/client/` と `src/worker/` を混ぜないこと。動く環境が違うため tsconfig も分けてある
（`tsconfig.client.json` / `tsconfig.worker.json` / `tsconfig.node.json`）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 開発サーバー（Vite の HMR と Worker が同居する） |
| `pnpm build` | `dist/` にビルド |
| `pnpm typecheck` | 3つの tsconfig をそれぞれ型チェック |
| `pnpm test` | Vitest。実際の Workers ランタイム（workerd）上で実行する |
| `pnpm cf-typegen` | `wrangler.jsonc` から `worker-configuration.d.ts`（`Env` の型）を再生成 |
| `pnpm db:generate` | スキーマの変更から SQL のマイグレーションを生成 |
| `pnpm db:migrate:local` | ローカルの D1 にマイグレーションを適用 |
| `pnpm db:migrate:remote` | Cloudflare 上の D1 に適用（**デプロイ担当のみ**） |
| `pnpm stop-signs:extract` | JARTIC の CSV から一時停止の標識を抜き出し、D1 に流す SQL を作る（下） |
| `pnpm deploy:cf` | Cloudflare へデプロイ（**デプロイ担当のみ**） |

`wrangler.jsonc` にバインディングを足したら `pnpm cf-typegen` を実行して `Env` を更新する。

**Cloudflare のアカウントは要らない。** `pnpm dev` / `pnpm test` / `pnpm db:migrate:local` は
すべてローカルの workerd と SQLite で動く。ログインが要るのは下の2つだけ。

### デプロイ担当だけがやること

```sh
pnpm --filter web exec wrangler login   # ブラウザが開いて Cloudflare の認証をする
```

`db:migrate:remote` と `deploy:cf` はここを済ませた担当者のみが実行する。
秘密値は `wrangler secret put` で登録し、`wrangler.jsonc` には書かない（このリポジトリは public）。
ローカル用の値は `.dev.vars`（gitignore 済み）に置く。

**デプロイ先の URL の正本は [`apps/mobile/src/lib/api-base.ts`](../mobile/src/lib/api-base.ts)。**
モバイルと `signs:build` はここを既定に見る（[`docs/setup.md`](../../docs/setup.md)）。
**書き写さない**——Worker の名前を変えたときに書き写した側が黙って古くなる。

**スクリプト名が `deploy` ではなく `deploy:cf` なのは、`deploy` が pnpm の組み込みコマンドだから。**
組み込みが優先されるため、`pnpm deploy` は `ERR_PNPM_INVALID_DEPLOY_TARGET` で落ちて
スクリプトに届かない。`pnpm run deploy` と書けば動くが、**この表の他の行はすべて `run` なしで書ける**——
1行だけ違う書き方を覚えてもらうより、衝突しない名前にした。

## データベース（D1 + Drizzle）

D1 は Cloudflare の SQLite。テーブルの定義は `src/worker/db/schema.ts` に TypeScript で書き、
そこから SQL のマイグレーションを生成する。**SQL を手で書かない。**

```
# 1. src/worker/db/schema.ts を編集する
# 2. 差分から SQL を生成する（drizzle/migrations/ に増える）
pnpm db:generate
# 3. 手元の D1 に適用する
pnpm db:migrate:local
```

生成された SQL はコミットする。他のメンバーは pull 後に `pnpm db:migrate:local` を実行すれば追いつける。

ローカルの D1 の実体は `.wrangler/` の下にあり、gitignore 済み。壊れたら消して作り直してよい。

### Cloudflare 上のデータベース

`wrangler.jsonc` の `database_id` は実際の値（`team-c-db`。作成済み、マイグレーション適用済み）。
**ローカル開発とテストはこの値を使わない**ので、他のメンバーの手順は何も変わらない。

リモートに触るのはデプロイ担当だけで、マイグレーションを増やしたら
`pnpm db:migrate:remote` を1回当てる。

### 今あるテーブルは仮のもの

`pings` は D1 が動くことを確かめるためだけのテーブル。本来のテーブル設計は Issue #7 で決める。
**ここにカラムを足していかないこと。**

## 型をモバイルと共有する

`src/worker/index.ts` が `AppType` を export している。`apps/mobile` はこれを型のみ参照して
`hc<AppType>()` で API クライアントを作る。**ルートはメソッドチェーンで書くこと**。
`app.get(...)` を文として分けて書くと型が積み上がらず、モバイル側の補完が効かなくなる。

**Worker のエントリは `src/worker/entry.ts`**（`wrangler.jsonc` の `main`）で、`index.ts` ではない。
`entry.ts` は Cloudflare に渡すもの（`fetch` ハンドラと Durable Object のクラス）を並べるだけの
ファイルである。分けているのは、TypeScript が import を辿るため——**`index.ts` が
`cloudflare:workers` を間接的にでも読むと、Cloudflare の型を持たないモバイル側の型チェックが落ちる。**
**Durable Object を足すときは `entry.ts` に export を1行足す**（`index.ts` に書かない）。

**リクエストの検証は `zValidator` に通す**（`@hono/zod-validator`）。ハンドラの中で
`c.req.json()` を読んで自分で検証すると、**送る側の型が `AppType` に載らない**——
モバイルが項目を綴り間違えてもコンパイルが通り、実行して初めて 400 で分かる。

**ルートの戻り値には型注釈を付ける**（`const body: ExchangeResponse = ...`）。
`c.env` 由来の型がそのまま `c.json()` に流れると、モバイル側ではバインディングの型が
無いため、**受け取るレスポンスが `any` になる。**

## 走行中の中継（`POST /api/v2v/exchange`）

1Hz で自分の位置を受け取り、**同じレスポンスで半径内の周辺車両を返す。**
状態は Durable Object 1個のメモリにあり、**D1 には何も書かない。**

**仕様の正本は `docs/interfaces/mobile-api.md` と `docs/interfaces/v2v.md`。**
実装が守っていることの理由はすべてそちらにあるので、ここには書かない。
半径・失効・値の範囲は `src/worker/v2v/config.ts` に集めてある（**直書きしない**）。

## 一時停止の標識（`GET /api/stop-signs`）

一時停止の事前通知（#27）は**スマホが手元の標識で判定する**ので、この API は**走行中には使われない。**
それでも壊すと困るのは、**各自のアプリに同梱する `signs.db` がこの経路から作られる**ためで、
**止まるのは走行ではなくビルド**になる（`docs/adr/0009-on-device-storage.md`）。

**仕様の正本は `docs/interfaces/mobile-api.md`「一時停止の標識をスマホに配る」と
`docs/interfaces/web-service.md`「外部データ（一時停止の標識）」。** 理由はそちらにあるので繰り返さない。

- **配るのは規制地点と進入方向**（`StopSign`）。**D1 に入るのもこれだけ**——
  交差点名称は元データが空だったので取り込んでいない（`docs/interfaces/web-service.md`）
- **1つの交差点に複数の進入方向があれば、標識も方向のぶんだけ別の行になる**
  （元データは交差点単位で1レコード）。理由は `docs/interfaces/mobile-api.md`
- **引数は都道府県コードだけ**（`?pref=33`）。**位置を取らない**
- **`ETag` を返し、`If-None-Match` に `304` で応える。**版はサーバーが決め、端末はそれをそのまま持ち帰る
- **まだ取り込んでいない県は 404。**空の配列を返さない（「持っていない」と「0 件」を混ぜない）
- **認証は無い。**公開されている交通規制情報である

### 標識を取り込む（原本を持つ人だけ・月に1回）

**他のメンバーはこの手順を踏まない。** `GET /api/stop-signs` から同梱物を作るので、原本を触らない。

```sh
# 1. JARTIC の交通規制情報オープンデータ（CSV）を scripts/stop-signs/data/ に置く
#    https://www.jartic.or.jp/service/opendata/ （一時停止 = 共通規制種別コード 63、岡山県 = 33）
#    ファイルは1都道府県警察につき1つ（例: 岡山県警_202607_k_2.1.csv）。Shift-JIS / CR+LF
# 2. 抽出して SQL を作る
pnpm stop-signs:extract --in scripts/stop-signs/data/<ファイル名>.csv --pref 33
# 3. 流し込む先に表を作っておく（**先に済ませないと no such table: stop_signs で止まる**）
pnpm db:migrate:local
# 4. 手元の D1 に流し込む（Cloudflare 上へ入れるのはデプロイ担当だけ。--local を --remote に）
pnpm exec wrangler d1 execute team-c-db --local --file=scripts/stop-signs/out/stop-signs-33.sql
```

**リモートに対する wrangler のコマンドが `[code: 7403] not valid or not authorized` で落ちることがある。**
認証は切れておらず、**もう一度実行すると通る**（2026-09-01 に `db:migrate:remote` で発生）。
**ログインをやり直す前に1回リトライする。**

**原本の扱い（コミットしない理由、失うと取り返しがつかないこと、いま何が置いてあるか）の正本は
[`scripts/stop-signs/data/README.md`](./scripts/stop-signs/data/README.md)。**
置く前に読むこと。

抽出そのもの（CSV の解釈・版の計算・SQL の組み立て）は `scripts/stop-signs/` にあり、
**ファイルも通信も持たない純粋な関数に分けてある**ので、**原本を持っていない人でも Vitest で直せる。**

**CSV の形式の正本は JARTIC の
[交通規制情報（拡張版標準フォーマット）説明書](https://www.jartic.or.jp/d/opendata/typeD_kisei_73_k_2.1.pdf)。**
実装が前提にしていること（経度と緯度が1つの項目に入る、複数座標はセミコロン区切り、
一時停止は規制地点と進入方向の組で登録される）はすべてそこに書いてある。
**列名・文字コード・「規制地点と進入方向の組」は実データで確認済み**
（2026-09-01。岡山県警 202607）。**残る未確認は `docs/unverified.md` 62・63。**

## 注意

- `compatibility_date` はローカルの workerd が対応している日付までしか上げられない。
  上げてテストが `newest date supported by this server binary` で落ちたら、まず `wrangler` を更新する。
