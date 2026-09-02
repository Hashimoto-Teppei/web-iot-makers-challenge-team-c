/**
 * 標識の版と ETag。
 *
 * **版を作るのはサーバー**（`docs/interfaces/stop-signs-delivery.md`「版はサーバーが決める」）。
 * 端末は受け取った ETag をそのまま `signs.db` の `meta.version` に入れ、次回
 * `If-None-Match` で送り返す。**ここの形式を変えると、端末が持っている値と
 * 一致しなくなり、全端末が一度だけ数 MB を落とし直す**（壊れはしないが、変える理由が
 * 無いなら変えない）。
 */

/**
 * 版から ETag の値を作る。**強い ETag**（`W/` を付けない）。
 *
 * 県コードを混ぜるのは、**別の県の版と偶然一致したときに 304 を返さないため**である。
 * 版は取り込んだ中身から決まるので、空の県が2つあれば同じ値になりうる。
 *
 * **ここで強い ETag を返しても、端末に届くのは `W/` 付きになりうる。**
 * Cloudflare は応答を gzip した時点で弱い検証子に書き換えるためで、
 * `accept-encoding: gzip` を送る `fetch` は必ずそちらを受け取る。
 * **端末は `W/` を剥がしてから保存する**こと（`apps/mobile/src/signs/response.ts`）——
 * 剥がさないと、**圧縮された経路と `curl -I` とで版の文字列が食い違う。**
 */
export function etagOf(pref: number, version: string): string {
  return `"${pref}.${version}"`;
}

/**
 * `If-None-Match` ヘッダが、いま返そうとしている ETag と一致するか。
 *
 * - **カンマ区切りで複数**送られうる（RFC 9110）
 * - **`W/` が付いて返ってくることがある**。中継や proxy が弱い ETag に変換するため、
 *   付いていても一致と見なす（**付いているだけで一致しないと判定すると、
 *   端末が毎回数 MB を落とし直す**）
 * - **`*` はすべてに一致する**
 */
export function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;

  const normalize = (value: string) => value.trim().replace(/^W\//, "");
  const target = normalize(etag);

  return header
    .split(",")
    .map(normalize)
    .some((candidate) => candidate === "*" || candidate === target);
}
