/**
 * Worker のエントリ（`wrangler.jsonc` の `main`）。
 *
 * **ここに実装を書かない。**Cloudflare に渡すもの——`fetch` ハンドラと Durable Object の
 * クラス——を並べるだけの場所である。
 *
 * **`src/worker/index.ts` と分けてある理由。**`apps/mobile` は Hono RPC のために
 * `index.ts` を **型として** import する（`apps/mobile/src/lib/api.ts`）。TypeScript は
 * import を辿るので、`index.ts` が `cloudflare:workers` を（間接的にでも）読むと、
 * **Cloudflare の型を持たないモバイル側の型チェックが落ちる。**
 * Durable Object の実装をこちら側に隔離することで、その連鎖を断っている。
 */

export { default } from "./index";
export { NeighborsDO } from "./v2v/neighbors";
