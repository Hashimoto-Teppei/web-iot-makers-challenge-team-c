/**
 * 権限のダイアログを**一度に1つだけ**出すための順番待ち。
 *
 * **なぜ要るか。**Android のダイアログは同時に1つしか出せない。
 * 測位（`../ride/location.ts`）と BLE（`../ble/permissions.ts`）は別々のフックから
 * ほぼ同時に立ち上がるので、**そのまま頼むと片方が「出ないまま拒否」で返り、
 * もう片方は Promise が解決しないまま固まる**——実機（Pixel 10 / Android 17）で
 * どちらも起きた。**画面には「確かめています…」と「許可されていません」が残り、
 * 人が何をしても直らない。**
 *
 * **React も expo も知らない**ので、開発機の Vitest でそのまま回せる
 * （`docs/adr/0002-development-lifecycle.md`）。
 */

/** 直前までの待ち行列。**失敗しても次に進む**（`catch` で吸収する）。 */
let tail: Promise<unknown> = Promise.resolve();

/**
 * 前の要求が終わってから `run` を呼ぶ。
 *
 * **`run` の結果と例外はそのまま呼び出し側へ返す。**待ち行列は結果を握りつぶさない
 * ——握りつぶすと、権限が下りなかったことが画面に出ない。
 */
export function inPermissionQueue<T>(run: () => Promise<T>): Promise<T> {
  // **`then` の第2引数にも `run` を渡す。**前の要求が失敗しても、こちらは実行する。
  const result = tail.then(run, run);
  tail = result.catch(() => undefined);
  return result;
}
