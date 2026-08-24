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
| `pnpm deploy` | Cloudflare へデプロイ（**デプロイ担当のみ**） |

`wrangler.jsonc` にバインディングを足したら `pnpm cf-typegen` を実行して `Env` を更新する。

**Cloudflare のアカウントは要らない。** `pnpm dev` / `pnpm test` / `pnpm db:migrate:local` は
すべてローカルの workerd と SQLite で動く。ログインが要るのは下の2つだけ。

### デプロイ担当だけがやること

```sh
pnpm --filter web exec wrangler login   # ブラウザが開いて Cloudflare の認証をする
```

`db:migrate:remote` と `deploy` はここを済ませた担当者のみが実行する。
秘密値は `wrangler secret put` で登録し、`wrangler.jsonc` には書かない（このリポジトリは public）。
ローカル用の値は `.dev.vars`（gitignore 済み）に置く。

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

### まだ Cloudflare 上に作っていない

`wrangler.jsonc` の `database_id` は仮の値（ゼロ）。ローカル開発とテストはこの値を使わないため、
このままで開発できる。実際のデータベースの作成と差し替えはデプロイ担当が行う（Issue #19）。

### 今あるテーブルは仮のもの

`pings` は D1 が動くことを確かめるためだけのテーブル。本来のテーブル設計は Issue #7 で決める。
**ここにカラムを足していかないこと。**

## 型をモバイルと共有する

`src/worker/index.ts` が `AppType` を export している。`apps/mobile` はこれを型のみ参照して
`hc<AppType>()` で API クライアントを作る。**ルートはメソッドチェーンで書くこと**。
`app.get(...)` を文として分けて書くと型が積み上がらず、モバイル側の補完が効かなくなる。

## 注意

- `compatibility_date` はローカルの workerd が対応している日付までしか上げられない。
  上げてテストが `newest date supported by this server binary` で落ちたら、まず `wrangler` を更新する。
