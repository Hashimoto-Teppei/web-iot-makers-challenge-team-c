/**
 * API のベース URL の既定値。**この定数がデプロイ先 URL の正本**で、
 * ドキュメントは URL を書き写さずここを指す（`CLAUDE.md`「同じことを2箇所に書かない」）。
 *
 * **アプリ本体（`api.ts`）と `signs:build`（`scripts/build-signs-db.ts`）の2つが使う。**
 * **揃うのは既定値だけで、上書きの経路は別々**（前者は `EXPO_PUBLIC_API_BASE_URL`、
 * 後者は `--base`）。つまり **`.env.local` だけを書くと、アプリは手元・同梱物はデプロイ先**
 * という食い違いが残る。**片方を手元に向けたら、もう片方も手元に向けること**
 * （`docs/setup.md`）。
 */

/**
 * デプロイ先の Worker。**画面も API もここに同居している**（`docs/adr/0001-tech-stack.md`）。
 *
 * **既定を手元の dev サーバーにしない。** `apps/mobile` を触る人の多くは
 * `apps/web` を動かしておらず、既定が localhost だと**最初の1コマンドが必ず失敗する**。
 * 逆向き（デプロイ先ではなく手元を見る）は、そうしたい人が明示的に選べばよい。
 *
 * **URL は秘密ではない**ので、public リポジトリに書いてよい（`CLAUDE.md`）。
 * 秘密にするのは Cloudflare の API トークンのほう。
 */
export const DEFAULT_API_BASE_URL = "https://team-c-web.hashimoto-2f0.workers.dev";
