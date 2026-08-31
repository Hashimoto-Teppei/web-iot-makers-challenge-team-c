# 環境構築

**開発が初めての人を想定して、省略せずに書いています。** 上から順にやれば終わります。

途中で1つでもうまくいかなかったら、先に進まずに聞いてください。
環境構築の失敗は、あとの工程で「原因のわからないエラー」に化けます。
**エラーメッセージ全文をコピーして貼る**のがいちばん速い聞き方です。

所要時間の目安は 30分〜1時間（`pnpm install` とネットワークの速さ次第）。

**ここで作るのは `apps/device`（Python）と `apps/web`（React / Hono）の開発環境です。**
`apps/mobile`（Android アプリのビルド）と Cloudflare へのデプロイは担当を固定しているため、
全員がセットアップする必要はありません（→「6. 担当が決まったら」）。

---

## 0. 何を入れるのか

| ツール | 何をするもの | 誰が要るか |
| --- | --- | --- |
| Git | ソースコードの履歴管理 | 全員 |
| mise | Node / pnpm / Python / uv のバージョンを揃える | 全員 |
| GitHub CLI (`gh`) | 認証と PR 作成をコマンドから行う | 全員 |
| VS Code | エディタ（他のエディタでも構わない） | 全員（推奨） |

**Node.js・Python・pnpm・uv を個別にインストールしないでください。** mise がまとめて用意します。
個別に入れると、人によってバージョンがずれて「自分の環境でだけ動かない／動く」が起きます。
すでに入っている場合でも消す必要はありませんが、下の「4. 動作確認」でバージョンを必ず確かめてください。

---

## 1. 共通ツールを入れる

### macOS

Homebrew（macOS のパッケージ管理ツール）を使います。入っていなければ先に入れます。

```sh
# Homebrew が入っているか確認（バージョンが出れば入っている）
brew --version

# 入っていなければ、公式サイトの手順に従う: https://brew.sh
```

```sh
brew install git mise gh
brew install --cask visual-studio-code
```

**mise を有効にします。** Homebrew で入れた場合は自動で有効になることが多いのですが、
ならないこともあるので確認します。

```sh
# ターミナルを開き直してから実行
mise doctor
```

出力の2行目に **`activated: yes`** と出れば有効です。
（`mise --version` はインストールできたことしか分かりません。有効かどうかは `mise doctor` で見ます。）

`activated: no` なら、使っているシェルに合わせて次を1回だけ実行し、**ターミナルを開き直します**。

```sh
# zsh（macOS の既定）
echo 'eval "$(mise activate zsh)"' >> "${ZDOTDIR-$HOME}/.zshrc"

# bash
echo 'eval "$(mise activate bash)"' >> ~/.bashrc
```

### Windows

`winget`（Windows 標準のパッケージ管理ツール）を使います。**PowerShell** を開いて実行してください。

```powershell
winget install Git.Git
winget install GitHub.cli
winget install Microsoft.VisualStudioCode
winget install jdx.mise
```

**mise の shims ディレクトリを PATH に足します。この手順は省けません。**
shims は「`node` と打ったら mise が用意した Node を呼ぶ」ための入口です。
mise の公式ドキュメントは、Windows では `mise activate`（macOS 側で使う方式）がまだ使えず
**shims 経由でのみ動く**と明記しています。ここが PATH になければ、`mise install` を済ませても
`node` は見つかりません。

```powershell
$shims = "$env:LOCALAPPDATA\mise\shims"
$path  = [Environment]::GetEnvironmentVariable("Path", "User")
if ($path -notlike "*$shims*") {
  [Environment]::SetEnvironmentVariable("Path", "$shims;$path", "User")
}
```

`if` で囲んでいるのは、**2回実行しても PATH が重複しないようにするため**です。
うまくいかないときにもう一度実行しても壊れません。

> **`winget install` が PATH に通すのは `mise` 本体だけで、shims は含まれません。**
> 公式ドキュメントにある「winget なら PATH は自動設定される」は本体のことです。
> scoop も shims の PATH 設定はしません（マニフェストから撤回済み）。
> **`mise --version` が動いても、この設定を飛ばすと `node` は見つかりません。**

**PowerShell を開き直してから**、次に進みます。

```powershell
mise doctor
```

出力に **`shims_on_path: yes`** と出れば、PATH の設定は成功しています。
`no` のままなら、**まず PowerShell を開き直してください**（PATH の変更は新しく開いた
ウィンドウにしか反映されません）。それでも `no` なら、上のコマンドをもう一度実行します。

#### Windows でもう1つだけ設定すること

```powershell
git config --global core.longpaths true
```

Windows はファイルパスの長さに 260 文字の制限があります。`node_modules` の中は階層が深く、
この制限を超えることがあるため、先に外しておきます。

なお改行コードの設定（`core.autocrlf`）は**変更しないでください**。
このリポジトリは `.gitattributes` で LF に固定しているので、Git 側の設定は不要です。

---

## 2. GitHub にログインする

```sh
gh auth login
```

対話形式で聞かれます。迷ったら次のとおり選んでください。

| 質問 | 選ぶもの |
| --- | --- |
| What account do you want to log into? | GitHub.com |
| What is your preferred protocol...? | HTTPS |
| Authenticate Git with your GitHub credentials? | Yes |
| How would you like to authenticate? | Login with a web browser |

ブラウザが開くので、表示された8桁のコードを入力して認証します。

**HTTPS を選ぶのは、SSH 鍵を自分で作らなくて済むからです。** `gh` が Git の認証も一緒に設定するため、
このあと `git push` でパスワードを聞かれることもありません。

```sh
gh auth status   # Logged in to github.com と出れば成功
```

---

## 3. リポジトリを取得して依存を入れる

```sh
gh repo clone Hashimoto-Teppei/web-iot-makers-challenge-team-c
cd web-iot-makers-challenge-team-c

mise install     # Node / pnpm / Python / uv を mise.toml のとおりに用意する
pnpm install     # プロジェクトの依存を入れる
```

`mise install` の途中で「信頼するか（trust）」を聞かれたら、`mise trust` を実行してから
もう一度 `mise install` を実行してください。**設定ファイルを勝手に実行しないための mise の安全機能**です。

`pnpm install` は数分かかります。`apps/mobile` の依存が多いためで、正常です。

---

## 4. 動作確認

**まずバージョンを確認します。** ここがずれていると、あとで必ず困ります。

```sh
node -v    # v24.x
pnpm -v    # 11.x
python -V  # Python 3.11.x
uv --version
```

違う数字が出たら、mise が有効になっていません。「1. 共通ツールを入れる」の mise の項をやり直してください。

**次にコマンドを回します。** 全部エラーなく終われば環境構築は成功です。

```sh
pnpm lint        # 整形と lint の確認
pnpm typecheck   # 型チェック
pnpm test        # テスト
```

`pnpm test` は `apps/device` の Python のテストも一緒に走ります（`uv` が裏で動きます）。
初回は依存のダウンロードで少し待ちます。

**最後に画面を出します。**

```sh
pnpm --filter web dev
```

http://localhost:5173 を開いて画面が出れば完了です。止めるときは `Ctrl + C`。

> ルートの `pnpm dev` は `apps/mobile` の Expo も一緒に起動します。
> Web だけ見たいときは上のように `--filter web` を付けてください。

---

## 5. エディタの設定（VS Code）

このリポジトリを VS Code で開くと、**推奨拡張機能のインストールを提案されます**（`.vscode/extensions.json`）。
「インストール」を押してください。保存するたびに自動で整形され、
**CI で落ちる原因のうち「整形漏れ」がなくなります。**

| 拡張機能 | 役割 |
| --- | --- |
| Biome | TypeScript / JSON の整形と lint |
| Ruff | Python の整形と lint |
| BasedPyright | Python の型チェック |
| Python | Python 本体のサポート |
| Expo Tools | `app.json` などの補完 |

`.vscode/settings.json` に保存時整形の設定が入っているので、追加の設定は要りません。
Pylance の無効化（BasedPyright と警告が二重に出るため）もこの中で済ませています。

### `apps/device` を触る人だけ、1つ設定します

コマンドパレット（`Ctrl/Cmd + Shift + P`）で **Python: Select Interpreter** を開き、
`apps/device/.venv` の Python を選んでください。`uv sync` が作った仮想環境の場所を
VS Code に教える操作です（OS ごとにパスが違うため、設定ファイルには書けません）。

**この操作をして初めて、エディタの Ruff と BasedPyright が CI と同じバージョンで動きます。**
選ばないと拡張機能に同梱された別バージョンが使われ、手元では整形済みなのに CI が落ちることがあります。

---

## 6. 担当が決まったら

ここまでで `apps/device` と `apps/web` の開発はできます。**以下は、その担当になったときに読めば十分です。**

### `apps/device`（Python）を触る人

ルートで `mise install` が済んでいれば、追加で入れるものはありません。

```sh
cd apps/device
uv sync          # Python 3.11 と依存を用意する
uv run pytest    # テストが通れば OK
```

`pip` や `venv` を自分で触る必要はありません。詳細は [`apps/device/README.md`](../apps/device/README.md)。

**実機（ラズパイ）に載せる手順は [`deploy-device.md`](./deploy-device.md) にあります。**
OS の書き込み・SSH・依存の入れ方・自動起動まで、そちらに一本化してあります（ここには書きません）。

**実機（Raspberry Pi）がなくても開発できます。** ハードウェアに触る部分は分離してあり、
検知ロジックはモックデータだけでテストできます。

### `apps/web`（React / Hono）を触る人

追加で入れるものはありません。**Cloudflare のアカウントも不要です。**

```sh
pnpm --filter web dev          # http://localhost:5173
pnpm --filter web db:migrate:local   # 手元の D1（SQLite）にマイグレーションを適用
```

`wrangler` はログインなしでローカル実行できます（`.wrangler/` の下に手元用の D1 が作られる）。
詳細は [`apps/web/README.md`](../apps/web/README.md)。

### `apps/mobile` とデプロイは担当を固定している

- **`apps/mobile`（Android）** — Android Studio と JDK 17、そして数時間かかる初回ビルドが必要です。
  担当になったら [`apps/mobile/README.md`](../apps/mobile/README.md) に手順があります。
- **Cloudflare へのデプロイ** — アカウントと秘密値は担当者1人が持ちます。
  手順は [`apps/web/README.md`](../apps/web/README.md)。

**どちらも、触らない人はセットアップ不要です。** `pnpm install` は `apps/mobile` の依存も入れますが、
入れるだけならビルド環境は要りません。

---

## 7. うまくいかないとき

| 症状 | 原因と対処 |
| --- | --- |
| `mise: command not found` | シェルの設定が読まれていない。**ターミナルを開き直す**。それでもだめなら「1.」の activate をやり直す |
| `mise install` したのに `node: command not found` | `mise doctor` を実行する。Windows は `shims_on_path: no`、macOS は `activated: no` が原因。「1.」をやり直す |
| `node -v` が 24 以外 | 別に入れた Node が優先されている。`mise doctor` で問題を確認する |
| `pnpm install` が `ERR_PNPM_...` で失敗 | `node_modules` を消してやり直す。それでもだめならエラー全文を貼って聞く |
| `Untrusted config file` と言われる | `mise trust` を実行してからやり直す |
| CI だけ落ちて手元では通る | まず `pnpm lint:fix` を実行してコミットする。整形漏れがいちばん多い |
| `pnpm dev` でポートが使えないと言われる | 5173 番を別のプロセスが使っている。前に起動した dev サーバーが残っていないか確認する |
| Windows で `Filename too long` と言われる | `git config --global core.longpaths true` を実行してから clone し直す |

**30分詰まったら聞いてください。** これは推奨されている行動です。

---

## 出典

インストール手順は各ツールの公式ドキュメントで確認しています（最終確認 2026-08-25）。
手順が古くなったと感じたら、まずここを見てください。

- [mise — Installing mise](https://mise.jdx.dev/installing-mise.html) / [Shims](https://mise.jdx.dev/dev-tools/shims.html) / [FAQ（Windows は shims 経由）](https://mise.jdx.dev/faq.html)
- [Homebrew Formulae](https://formulae.brew.sh/)（`mise` / `gh` / `git` / `visual-studio-code`）
- [winget-pkgs](https://github.com/microsoft/winget-pkgs)（`Git.Git` / `GitHub.cli` / `Microsoft.VisualStudioCode` / `jdx.mise`）
- [GitHub CLI マニュアル — `gh auth login`](https://cli.github.com/manual/gh_auth_login)
- [basedpyright — IDE への導入](https://docs.basedpyright.com/latest/installation/ides/)

---

作業の進め方（Issue からブランチ、PR、レビューまで）は [CONTRIBUTING.md](../CONTRIBUTING.md) にあります。
