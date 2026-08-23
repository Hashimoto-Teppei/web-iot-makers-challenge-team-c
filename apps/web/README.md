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
| `pnpm deploy` | Cloudflare へデプロイ（**デプロイ担当のみ**） |

`wrangler.jsonc` にバインディングを足したら `pnpm cf-typegen` を実行して `Env` を更新する。

## 型をモバイルと共有する

`src/worker/index.ts` が `AppType` を export している。`apps/mobile` はこれを型のみ参照して
`hc<AppType>()` で API クライアントを作る。**ルートはメソッドチェーンで書くこと**。
`app.get(...)` を文として分けて書くと型が積み上がらず、モバイル側の補完が効かなくなる。

## 注意

- **秘密値を `wrangler.jsonc` に書かない**（このリポジトリは public）。
  ローカル用は `.dev.vars`（gitignore 済み）、本番は `wrangler secret put`。
- `compatibility_date` はローカルの workerd が対応している日付までしか上げられない。
  上げてテストが `newest date supported by this server binary` で落ちたら、まず `wrangler` を更新する。
