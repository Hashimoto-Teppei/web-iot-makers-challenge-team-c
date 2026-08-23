# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Web×IoTメイカーズチャレンジ（ハッカソン）チームCの開発リポジトリ。
お題は「岡山県の課題をWeb×IoTで解決する」。チームCは**自転車**に着目し、岡山県の自転車利用率の高さと、交通ルール改正による違反取り締まり強化を背景に、**事故と違反を未然に防ぐ**ソリューションを開発する。

現状はリポジトリ初期化直後で、コードはまだ存在しない（コミットゼロ）。以下は合意済みの設計方針であり、実装が進んだらこのファイルを実態に合わせて更新すること。

## コアアイデア

Raspberry Pi Zero W を搭載した自転車同士が Wi-Fi メッシュネットワークを構成し、GPS の位置情報を交換して以下3つの危険をリアルタイム検知する。

1. **急接近検知** — 相対位置・相対速度から急激に接近する自転車を検出
2. **前方急ブレーキ検知** — 前方車両の急減速を検出
3. **見えない曲がり角での対向車検知** — 交差点・カーブでの視認できない対向車を検出

検知結果は小型ディスプレイまたは LED でユーザーへ即時通知する。

### 重要な設計制約

- **走行中にスマホを見る行為は取り締まり対象**。したがって走行中の通知はデバイス側（ディスプレイ/LED/ブザー）で完結させること。モバイルアプリの画面を走行中に見る前提の UX は設計として不可。モバイルアプリは走行前後の確認・振り返り用と位置づける。
- Raspberry Pi Zero W はリソースが厳しく Wi-Fi は 2.4GHz のみ。メッシュ通信・GPS 処理・表示制御の負荷配分に注意する。

## システム構成

```
[自転車デバイス] --Wi-Fi mesh--> [自転車デバイス]
       |
   Bluetooth
       |
[モバイルアプリ] --HTTPS--> [API サーバー] <--> [Web アプリ]
```

- **デバイス（Raspberry Pi Zero W）**: 危険検知とユーザーへの即時通知。Python で実装。
- **モバイルアプリ**: Bluetooth でデバイスから検知ログ・走行ログを収集し、Web へ同期。
- **API サーバー / Web アプリ**: 収集データの蓄積と活用。ハッカソンなので「データを活かした面白い見せ方」を重視する。

### CHIRIMEN について

ラズパイには CHIRIMEN（Node.js 動作環境）がセットアップ済みだが、**本プロジェクトでは使用しない**。組み込み側は通常の Raspberry Pi 開発として Python で実装する。ラズパイ上の Node.js に関する提案は不要。

## 技術スタック

| 領域 | 採用 |
| --- | --- |
| デバイス | Python 3.12 / uv / Ruff / basedpyright / pytest |
| API | Hono / Cloudflare Workers / D1 / Drizzle / Wrangler |
| モバイル | Expo (SDK 57, React Native) |
| Web | React / Vite / TypeScript / Cloudflare Workers (Static Assets) |
| 共通 | pnpm workspaces / Turborepo / Biome / Vitest / Zod |
| バージョン管理 | mise |

選定理由と却下した選択肢は `docs/adr/0001-tech-stack.md`。

### バージョンの扱い

- ランタイム（Node, Python, pnpm, uv）は **`mise.toml` が唯一の情報源**。`.node-version` / `.python-version` を併置しない。
- **Node は 24 系**。Wrangler が `>=22`、Vite 8 が `>=22.12` を要求するため 20 系に落とさない。
- **`apps/mobile` の依存は `npx expo install` で入れる**。Expo SDK が React / React Native のバージョンを固定するため、`pnpm add` で latest を入れると壊れる。`apps/mobile` だけ React のバージョンが他とずれるのは正常。
- **TypeScript は 7 系**（Go 製ネイティブコンパイラ）。Expo/Metro 周辺で問題が出たら `apps/mobile` だけ 5 系に固定し、経緯を ADR に追記する。
- ハッカソン期間中に大きなメジャーアップデートを取り込まない。

## リポジトリ構成

```
apps/
  device/    Python + uv。危険検知・メッシュ通信・BLE ペリフェラル
  api/       Hono + Workers + D1 + Drizzle
  mobile/    Expo
  web/       React + Vite → Workers (Static Assets)
docs/
  adr/            技術選定・設計判断の記録
  interfaces.md   コンポーネント間インターフェース仕様
  hardware.md     現在のハードウェア構成
```

`packages/` はまだ作らない。共有したいものが出ても、**2つ目の利用者が現れるまでは利用者側に置く**
（Zod スキーマは当面 `apps/api/src/schemas/`、共有 tsconfig はルートの `tsconfig.base.json`）。

### 構成上の約束

- **`apps/device` も pnpm workspace に含める**。Turborepo は `pnpm-workspace.yaml` からパッケージを検出するため、
  含めないと lint/test を横断実行できない。中身は依存ゼロで、scripts が `uv run` を呼ぶだけの `package.json` を置く。
  Python のツールチェーン自体は uv が管理し、pnpm は関与しない。
- **型の共有は Hono RPC**。`apps/api` が `AppType` を export し、`apps/web` / `apps/mobile` が
  型のみの devDependency として参照して `hc<AppType>()` でクライアントを作る。
  スキーマを別パッケージに切り出す際は、そこから `AppType` を再 export しないこと（循環する）。
- **Python 側は TypeScript のスキーマを参照できない**。デバイスと他コンポーネントの境界は BLE GATT 仕様であり、
  その正本は `docs/interfaces.md`。変更時は Python 実装・TypeScript 実装・ドキュメントの3つを揃える。
- **`apps/mobile` は Expo Go では動かない**（BLE のネイティブモジュールが必要）。`npx expo run:android` / `run:ios` で
  Development Build をローカルに作る。各自 Android Studio（iOS なら Mac + Xcode）のセットアップが要る。
- **`apps/web` も Cloudflare Workers にデプロイする**。Pages ではなく Workers Static Assets を使い、
  `wrangler.jsonc` の `assets.directory` に Vite のビルド出力を指し、`not_found_handling` を
  `"single-page-application"` にする（SPA なのでこれがないとリロードで 404 になる）。
- **独自ドメインは取得しない**。`*.workers.dev` のサブドメインで運用するため、`apps/web` と `apps/api` は別オリジンになる。
  API 側に CORS の許可設定が要る（Hono の `cors()` ミドルウェア）。オリジンをコードに直書きせず設定として外に出す。
- Biome / Turborepo / tsconfig のベース設定はルートに置き、各アプリは差分だけを持つ。Biome の対象から `apps/device` を除外する。

## 機密情報の扱い（public リポジトリ）

**このリポジトリは public。** コミットした時点で世界に公開され、後から消してもコミット履歴に残る。

- **クライアントに渡る環境変数は機密にできない**。`VITE_*`（Vite）と `EXPO_PUBLIC_*`（Expo）は
  ビルド時にバンドルへ埋め込まれ、利用者が読める。ここに API トークンや秘密鍵を置かない。
  秘密が必要な処理は必ず API サーバー側に置くこと。
- **Cloudflare の秘密値は `wrangler secret put` で登録する**。`wrangler.jsonc` に書かない。
  ローカル開発用は `.dev.vars` に置き、これはコミットしない。
- **Cloudflare API トークン / アカウント認証情報をリポジトリに置かない**。CI から使う場合は GitHub Secrets を使う。
  public リポジトリでは fork からの PR に Secrets を渡さないよう、ワークフローのトリガに注意する。
- **デバイス側の秘密値**（Wi-Fi の PSK、BLE のペアリング情報、API トークン）もコミットしない。
  `apps/device` では設定ファイルを分離し、実値を含むファイルは `.gitignore` に入れる。
- **実走行の GPS ログをコミットしない**。位置情報は個人情報であり、自宅や行動パターンが特定できる。
  テスト用のモックデータは合成したものを使う。
- 誤ってコミットした場合は、**まず該当する認証情報を無効化・再発行する**。履歴の書き換えより先に行うこと。

## チーム開発の進め方

複数人での並行開発が前提。

- `main` は保護ブランチとして扱い、直接コミットしない。作業はブランチを切って PR 経由でマージする。
- コンポーネント（デバイス / モバイル / API / Web）ごとに担当が分かれるため、**コンポーネント間のインターフェース（BLE の GATT 仕様、API スキーマ、メッシュのメッセージフォーマット）を先に決めてドキュメント化する**。ここが暗黙のまま並行実装が進むと確実に破綻する。
- インターフェースを変更する場合は、影響を受けるコンポーネントの担当に伝わる形（PR の説明・ドキュメント更新）で行う。

## 段階的に育てる前提（重要）

このプロジェクトは**最初から仕様・設計が固まっているものではない**。ラズパイにセンサーモジュール・スイッチ・LED などの部品を順次追加しながら、試行錯誤で改良していく。**仕様変更は異常ではなく通常運転**として扱うこと。

- **部品追加のたびに大規模な書き換えが発生しない構造にする**。センサーやアクチュエータは「後から増える」ことを前提に、個々のデバイスドライバとそれを束ねる側を疎結合に保つ。特定のセンサー構成を前提とした密結合な実装は、次の部品追加で必ず壊れる。
- **早すぎる抽象化は避ける**。まだ1種類しかないものに汎用フレームワークを用意するより、2〜3個目が出てきた時点で共通化する。ハッカソンの期間内では、動くものを早く作って改良を回す方が優先される。`packages/` をまだ作っていないのはこの理由による。

## ドキュメントの役割分担

肥大化と二重管理を防ぐため、**同じことを2箇所に書かない**。

| | 書くこと |
| --- | --- |
| `CLAUDE.md` | **守るべき制約**。理由は書かず、ADR を参照する |
| `docs/adr/` | **なぜそう決めたか**。決定を見直すときに読む |
| `docs/interfaces.md` | コンポーネント間の境界仕様。実装と同じ PR で更新する |
| `docs/hardware.md` | 接続中の部品・GPIO/I2C の接続先・電源。実物を見ないとわからなくなるため、変更したら必ず更新する |

- 「決定済み / 検討中 / 未着手」を明示する。決まっていない箇所は TODO のまま残す方が、憶測で埋めるより価値がある。
- 実装とずれた古い記述は残さず更新する。過去の決定を書き換えるときは、なぜ変えたかを一行添える。
- ドキュメントも早すぎる分割を避ける。1ファイルが読みにくくなってから分ける。

## 実装上の注意

- **ハードウェア非依存でテストできるようにする**。実機（GPS モジュール、複数台のラズパイ）が常に手元にあるとは限らないため、危険検知ロジックはセンサー入出力から分離し、位置情報のモックデータで検証できる構造にする。ハッカソン期間中のデバッグ効率に直結する。
- 検知アルゴリズムのしきい値（接近速度、減速度、距離）はコードに直書きせず設定として外出しし、実地調整できるようにする。
