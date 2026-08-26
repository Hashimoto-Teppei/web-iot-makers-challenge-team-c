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
- Zod スキーマの利用者は当面 `apps/web` だけ。Hono RPC が型を伝播するので、クライアントは独立したスキーマを必要としない。

「まだ1種類しかないものを共通化しない」という方針をドキュメントに書いた以上、構成でも守る。
2つ目の利用者が実際に現れた時点（例: モバイルが BLE 受信データを同じスキーマで検証したくなった時）に切り出す。
切り出す際は `packages/contracts` から `AppType` を再 export しないこと（`contracts → web → contracts` の循環になる）。

### バージョン管理: mise

Node・pnpm・Python・uv を `mise.toml` 1ファイルで固定する。
チームメンバーの環境差異が原因の「自分の環境では動く」を潰すことが目的。
`.node-version` / `.python-version` を併用すると情報源が二重化するため置かない。

**Node は 24 系を使い、20 系に落とさない。** Wrangler が `>=22`、Vite 8 が `>=22.12` を要求するため、
20 系では `apps/web` のツールチェーンがそもそも起動しない。
ハッカソン期間中は、これ以外の大きなメジャーアップデートを取り込まない。

### デバイス: Python 3.12 + uv

GPS・GPIO・BLE いずれもライブラリの選択肢と実績が Python に厚く、Raspberry Pi の標準的な開発手段であるため。
ラズパイに入っている CHIRIMEN（Node.js 環境）は使わない。

- Ruff: lint と format を1つのツールで賄う（Biome の Python 版という位置づけ）
- basedpyright: pyright ベースで、より厳格な型チェックをデフォルトで有効にできる
- pytest: 検知ロジックをモックデータで検証するため

### Web + API: React + Vite + Hono + D1 + Drizzle を1つの Worker に

Vite は起動と HMR が速く、改良サイクルを回す回数が多いハッカソンに向く。SSR が要らないため Next.js は採用しない。
Workers は無料枠で常時稼働でき、デプロイが速い。D1 は Workers と同一プラットフォーム上の SQLite で、
別途 DB をプロビジョニングする手間がない。Drizzle は D1 を公式サポートし、マイグレーションを SQL として
出力するため `wrangler d1 migrations apply` にそのまま乗る。

**Pages ではなく Workers Static Assets を使う。** Pages は静的サイト向けの Git 連携が主眼で、
Cloudflare 自身も新規のフルスタック用途は Workers に寄せている。バインディングを足すときも Workers の方が素直。

**独自ドメインは取得しない**（ハッカソンのため）。`*.workers.dev` で運用する。

#### Web と API を分離しない — 2026-08-23 に「分離する」から変更

当初の分離理由は「Web 担当と API 担当のデプロイを独立させるため」だったが、
**デプロイ担当を1人に固定する方針が決まり、この根拠が失効した**ため統合に変更した。

独自ドメインを取らない以上、`*.workers.dev` では Worker をパスで振り分けられない（ルーティングにはゾーンが要る）。
つまり**単一オリジンにする手段は統合しかなく**、分離すると CORS 設定と API URL のビルド時配線が必ず発生する。
統合すればどちらも不要になり、デモで見せる URL も1つで済む。

`@cloudflare/vite-plugin` により、React の HMR と Worker（D1 バインディング付き）が同一の dev サーバーで動く。
ローカル開発が `pnpm dev` 1コマンドになる点も大きい。

複数人が同じパッケージを触ることになるが、`src/client/` と `src/worker/` を分けて衝突を避ける。
分離が必要になれば、Worker を切り出して CORS を足せば戻せる。

### 型共有: Hono RPC (hc) + Zod

Hono のルート定義から型が自動で伝播し、コード生成のステップが不要。

Web の画面は API と同じ Worker 内にあるため、型共有はパッケージ内で完結する。
`apps/mobile` だけが `apps/web` を型のみの devDependency として参照し、`hc<AppType>()` でクライアントを作る。

```
apps/web  (src/worker が AppType を export)
        ↑ type-only
   apps/mobile
```

将来 Zod スキーマを `packages/contracts` に切り出す場合、そこから `AppType` を再 export しないこと
（`contracts → web → contracts` の循環になる）。

### モバイル: Expo / ローカルビルド / Android 主

BLE のネイティブモジュールが必要なため Development Build が要る。EAS Build（クラウド）ではなく
ローカルビルドを選んだのは、ビルド待ち時間とアカウント準備を避けるため。配布が問題になれば後から併用できる。

ストアに提出せず端末へ直接インストールする前提のため、配布のしやすさが対象 OS の選定を左右した。
Android は APK を配れば誰でもインストールでき、ビルドも Windows / macOS 双方で通る。
iOS は署名とプロビジョニングが必要で Mac + Xcode 必須、かつ無料の Apple ID による署名は7日で失効し、
デモ当日に起動しなくなるリスクがある。したがって **Android を主ターゲットとして機能の検証を完結させ**、
iOS は Mac 保有者が対応する副系統と位置づける。
**iOS でデモする場合は、当日の直前に再インストールできる体制を用意しておくこと**（7日で失効するため）。

モバイルだけ TypeScript が 6 系、React が 19.2.3 になる（他は TypeScript 7 系 / React 19.2.8）。
Expo SDK が動作確認済みの組み合わせを固定するためで、揃えにいくと壊れる。
モノレポ内でバージョンが揃わないことを異常として扱わない。

### 開発環境: Windows / macOS の混在を前提にする

メンバーの開発機が混在するため、どちらでも同じ手順で開発できることを制約として扱う。

mise は Windows でもネイティブに動作する（shims 経由）ため、両 OS で共通のバージョン管理手段として使える。
ただし Windows では `mise.toml` の `[env]` が自動適用されないため、環境変数に依存する設計を避ける。

改行コードは `.gitattributes` で LF に統一する。混在すると Biome と Ruff の整形結果が環境ごとに変わり、
中身のない差分でレビューが埋まる。

`apps/device` の BLE（BlueZ）と GPIO は Linux 専用で、開発機ではそもそも動かない。
この制約が、検知ロジックをハードウェアから分離する要件の根拠になっている
（実機確認をスキップする方針とあわせた帰結は `0002-development-lifecycle.md`）。

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
- **EAS Build**: クラウドビルドは配布が楽だが、待ち時間とアカウント準備を避けてローカルビルドを選んだ。必要になれば後から併用できる。
- **CI からの自動デプロイ**: デプロイ担当が1人でデプロイ頻度も低いため、GitHub Actions に Cloudflare の認証情報を持たせる必要はない。public リポジトリで秘密値の露出面を増やさない方を優先した。
