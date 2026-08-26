# 自転車の危険をリアルタイムに知らせるデバイス

Web×IoT メイカーズチャレンジ **チームC** の開発リポジトリ。
お題「岡山県の課題を Web×IoT で解決する」に対し、**自転車**に着目した。

岡山県は自転車の利用者が多く、交通ルールの改正で違反の取り締まりも強化されている。
そこで、**事故と違反を未然に防ぐ**ことを狙ったデバイスとその周辺システムを開発している。

## しくみ

Raspberry Pi Zero W を載せた自転車が、手元のスマホと Worker を経由して位置情報を共有し、3つの危険を検知する。
デバイスはスマホと Bluetooth でつながりっぱなしになり、**位置情報もスマホから受け取る**。

| 検知 | 内容 |
| --- | --- |
| 急接近 | 相対位置・相対速度から急激に接近する自転車を検出 |
| 前方急ブレーキ | 前方車両の急減速を検出 |
| 見えない曲がり角の対向車 | 交差点・カーブで視認できない対向車を検出 |

検知した危険は、その場でデバイスのディスプレイや LED に表示する。
**走行中にスマホを見る行為は取り締まりの対象**であるため、走行中の通知はデバイス側で完結させている。

```
[自転車デバイス] <--Bluetooth--> [モバイルアプリ] <--HTTPS--> [Cloudflare Worker]
                                                              画面 + API + D1
                                                                   ^
                                                                   |
                                                  他の自転車のスマホ（同じ経路）
```

モバイルアプリは測位と中継を担う。デバイスへ自車と周辺の位置を渡し、走行ログ・検知ログを Web へ同期する。
**画面を走行中に見る想定はしていない。** 走行中は画面を消したままハンドルに固定して使う
（空が見える場所に置かないと測位の精度が落ちるため、ポケットや鞄には入れない）。

通信が途切れると車車間の検知は止まるため、**デバイスに載せたセンサーによる、通信に依存しない検知**を土台として持つ。

## 構成

| ディレクトリ | 内容 | 主な技術 |
| --- | --- | --- |
| `apps/device` | 危険検知・BLE ペリフェラル | Python 3.12 / uv |
| `apps/web` | 画面と API（1つの Worker） | React / Vite / Hono / D1 / Drizzle |
| `apps/mobile` | モバイルアプリ | Expo (React Native) |

## 開発をはじめる

**セットアップの手順は [docs/setup.md](./docs/setup.md)。** Windows / macOS どちらでも同じ手順で動く。

[mise](https://mise.jdx.dev/) がランタイムをまとめて用意するので、Node や Python を個別に入れる必要はない。

```sh
mise install     # Node / pnpm / Python / uv を mise.toml のとおりに用意
pnpm install
```

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 開発サーバー起動 |
| `pnpm lint` | Lint / フォーマット確認 |
| `pnpm typecheck` | 型チェック |
| `pnpm test` | テスト |

## ドキュメント

| | 内容 |
| --- | --- |
| [docs/setup.md](./docs/setup.md) | 環境構築の手順。**まずここから** |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Issue から PR・レビューまでの進め方。開発が初めての人向け |
| [CLAUDE.md](./CLAUDE.md) | 開発上の決まりごと（AI エージェント向けだが、人が読んでも開発方針がわかる） |
| [docs/adr/](./docs/adr/) | 技術選定・設計判断とその理由 |
| [docs/interfaces.md](./docs/interfaces.md) | コンポーネント間のインターフェース仕様 |
| [docs/hardware.md](./docs/hardware.md) | ハードウェア構成 |
| [docs/unverified.md](./docs/unverified.md) | 実機でまだ確認していない前提 |

## 開発の進め方

- タスクは [Issues](../../issues) で管理する。着手するときに自分をアサインする
- `main` には直接コミットせず、PR 経由でマージする
- 境界（インターフェース）に関わる変更は、`docs/` だけの PR で先に合意してから実装する
- 実機での確認は待たずに進める。未確認の前提は `docs/unverified.md` に記録する

手順は [CONTRIBUTING.md](./CONTRIBUTING.md)、決めた理由は
[docs/adr/0002-development-lifecycle.md](./docs/adr/0002-development-lifecycle.md)。
