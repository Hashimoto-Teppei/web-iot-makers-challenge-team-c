/**
 * `wrangler.jsonc` に書けない秘密値の型。
 *
 * **`worker-configuration.d.ts` に足さない。**あちらは `wrangler types` が生成し直すファイルで、
 * 手で書いたものは次の生成で消える。**秘密値は `wrangler secret put` で登録するので
 * `wrangler.jsonc` に現れず、生成される型にも出てこない**（`CLAUDE.md`「機密情報の扱い」）。
 *
 * **省略可能（`?`）にしてあるのは、実際に未設定でありうるから**である。
 * 未設定のときに何が起きるかは呼ぶ側が決める（`recompute/auth.ts` は通さない）。
 */

interface Env {
  /** 管理用の共有トークン。`POST /api/admin/recompute` だけが見る */
  ADMIN_TOKEN?: string;
}

// テストからも読めるようにする（`env` は `Cloudflare.Env` として渡ってくる）。
declare namespace Cloudflare {
  interface Env {
    ADMIN_TOKEN?: string;
  }
}
