# ADR 0001: 技術スタックとモノレポ構成

- ステータス: 決定済み
- 日付: 2026-08-23

## 背景

ハッカソン期間内に、デバイス（Raspberry Pi Zero W）・モバイル・API・Web の4コンポーネントを複数人で並行開発する。
部品を追加しながら改良していく前提のため、「後から変えやすいこと」を「最初から正しいこと」より優先する。

## 決定

### モノレポ基盤: pnpm workspaces + Turborepo

pnpm はディスク効率が良く、node_modules を分離するため **アプリごとに異なる React バージョンを持てる**。
これは Expo が React/React Native のバージョンを固定する都合上、実質的に必須の性質だった。npm / yarn では hoisting で衝突しやすい。

Turborepo は lint/typecheck/test/build の横断実行とキャッシュのために採用する。
アプリ間にビルド成果物の依存がない（Hono RPC は型のみの参照）ため依存グラフの旨味は薄く、
現状はほぼタスクランナーとして使う。設定コストが低く CI のキャッシュが効くので採用に足る。

Turborepo は `pnpm-workspace.yaml` からパッケージを検出するため、**Python の `apps/device` も workspace に含める**。
含めないと Python の lint/test が横断実行から漏れ、CI が2系統に分かれてしまう。
`apps/device` には依存ゼロの `package.json` を置き、scripts から `uv run` を呼ぶだけにする。

### `packages/` を最初から作らない

当初は `packages/contracts`（Zod スキーマ）と `packages/tsconfig` を置く想定だったが、初期構成から外した。

- `packages/tsconfig` は中身が tsconfig 1枚で、ルートの `tsconfig.base.json` で足りる。
- Zod スキーマの利用者は当面 `apps/api` だけ。Hono RPC が型を伝播するので、クライアントは独立したスキーマを必要としない。

「まだ1種類しかないものを共通化しない」という方針をドキュメントに書いた以上、構成でも守る。
2つ目の利用者が実際に現れた時点（例: モバイルが BLE 受信データを同じスキーマで検証したくなった時）に切り出す。
切り出す際は `packages/contracts` から `AppType` を再 export しないこと（`contracts → api → contracts` の循環になる）。

### バージョン管理: mise

Node・pnpm・Python・uv を `mise.toml` 1ファイルで固定する。
チームメンバーの環境差異が原因の「自分の環境では動く」を潰すことが目的。
`.node-version` / `.python-version` を併用すると情報源が二重化するため置かない。

### デバイス: Python 3.12 + uv

GPS・GPIO・BLE いずれもライブラリの選択肢と実績が Python に厚く、Raspberry Pi の標準的な開発手段であるため。
ラズパイに入っている CHIRIMEN（Node.js 環境）は使わない。

- Ruff: lint と format を1つのツールで賄う（Biome の Python 版という位置づけ）
- basedpyright: pyright ベースで、より厳格な型チェックをデフォルトで有効にできる
- pytest: 検知ロジックをモックデータで検証するため

### API: Hono + Cloudflare Workers + D1 + Drizzle

Workers は無料枠で常時稼働でき、デプロイが速く、ハッカソンのデモに向く。
D1 は Workers と同一プラットフォーム上の SQLite で、別途 DB をプロビジョニングする手間がない。
Drizzle は D1 を公式サポートし、マイグレーションを SQL として出力するため `wrangler d1 migrations apply` にそのまま乗る。

### 型共有: Hono RPC (hc) + Zod

Hono のルート定義から型が自動で伝播し、コード生成のステップが不要。
モノレポ内に API とクライアントが同居しているという前提を満たすため採用できる。

依存の向きを次のように固定し、循環を避ける:

```
packages/contracts  (Zod スキーマのみ、依存なし)
        ↑
    apps/api  (AppType を export)
        ↑ type-only
apps/web, apps/mobile
```

`packages/contracts` から `AppType` を再 export すると `contracts → api → contracts` の循環になるため禁止。

### モバイル: Expo (React Native) / ローカルビルド

BLE のネイティブモジュールが必要なため Development Build が要る。EAS Build（クラウド）ではなくローカルビルドを選んだのは、
ビルド待ち時間とアカウント準備を避けるため。各自 Android Studio（iOS を触るなら Mac + Xcode）のセットアップが要る点は
トレードオフとして受け入れる。配布が問題になれば後から EAS Build を併用できる。

### Web: React + Vite + TypeScript → Cloudflare Workers

Vite は起動とHMRが速く、改良サイクルを回す回数が多いハッカソンに向く。
SSR が要らないため Next.js のような統合フレームワークは採用しない。

デプロイ先は Cloudflare で統一する方針のため Workers。**Pages ではなく Workers Static Assets を使う**。
Pages は静的サイト向けの Git 連携が主眼で、Cloudflare 自身も新規のフルスタック用途は Workers に寄せている。
D1 などのバインディングを後から足すときも Workers の方が素直に繋がる。

**独自ドメインは取得しない**（ハッカソンのため）。`*.workers.dev` で運用する。

### `apps/web` と `apps/api` を1つの Worker にまとめない

Workers Static Assets の `run_worker_first` を使えば、静的アセットと API を1つの Worker に同居させ、
同一オリジンにして CORS を不要にできる。実際ドメインを取らない構成ではこれが最も手数が少ない。

それでも分けたのは、**Web 担当と API 担当のデプロイを独立させるため**。
同居させると片方の変更が他方のデプロイを巻き込み、並行開発で待ちが発生する。
CORS は Hono の `cors()` ミドルウェア1行で済むので、コストとしては小さいと判断した。

デモ用に URL を1つにまとめたくなった場合は、後から同居構成に寄せられる。

### Lint/Format: Biome（JS/TS）、Ruff（Python）

ESLint + Prettier の二重管理を避ける。Biome は単体で lint と format を賄い、設定ファイルが1つで済む。

### TypeScript 7

Go 製ネイティブコンパイラ版が stable。typecheck が大幅に速い。

**リスク**: リリースから日が浅く、Expo/Metro 周辺のツールが追随していない可能性がある。
問題が出た場合は `apps/mobile` のみ 5 系に固定して回避する（アプリごとに別バージョンを持てる構成のため局所化できる）。
実際に問題が起きたら、その内容と対処をこの ADR に追記すること。

### 機密情報: public リポジトリ前提

リポジトリを public で管理するため、秘密値をリポジトリに一切置かない前提で構成する。

- Cloudflare の秘密値は `wrangler secret put`、ローカルは `.dev.vars`（コミットしない）
- クライアントに配られる `VITE_*` / `EXPO_PUBLIC_*` はバンドルに埋め込まれるため機密にできない。
  秘密を要する処理は API サーバー側に置く
- 位置情報は個人情報であり、実走行の GPS ログをリポジトリに含めない

具体的な運用ルールは `CLAUDE.md` の「機密情報の扱い」を参照。

## 却下した選択肢

- **Cloudflare Pages**: Git 連携とプレビューデプロイは魅力だが、静的サイト向けの位置づけであり、バインディングを足していく前提では Workers が素直。
- **OpenAPI + 型生成**: 仕様が可視化される利点はあるが、生成ステップの運用コストがハッカソンの速度に見合わない。可視化は `docs/interfaces.md` で代替する。
