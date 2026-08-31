/**
 * 中継の1往復（`POST /api/v2v/exchange`）の実装。
 *
 * **リクエストとレスポンスの型は Hono RPC で伝わる**ので、ここで型を書き写さない
 * （`docs/interfaces/mobile-api.md`）。写すと必ず実装とずれ、**綴りを間違えた項目が
 * コンパイルを通って走行中の POST が毎回 400 になる。**
 *
 * **走行ループはこのファイルを知らない**（`./loop.ts` が受け取るのは `ExchangeFn`）。
 * 分けてあるので、テストとシミュレータは HTTP を通さずに同じ形を渡せる。
 */

import { api } from "../lib/api";
import type { ExchangeFn } from "./loop";

/**
 * 実際に Worker へ投げる {@link ExchangeFn}。
 *
 * **失敗を例外で返す。**近傍が空の配列（＝半径内に誰も居なかった）と区別するため
 * （`./loop.ts`）。**ここで再送もバックオフもしない**——次の測位が1秒後に来る。
 */
export const exchangeViaApi: ExchangeFn = async (id, self) => {
  const res = await api.api.v2v.exchange.$post({ json: { id, self } });
  // **ステータスを見る。**見ないと、エラーの JSON（`{ error }`）を正常な応答として
  // 読み、`peers` が `undefined` のまま近傍へ流れる。
  if (!res.ok) throw new Error(`exchange が ${res.status} を返しました`);
  const body = await res.json();
  return body.peers;
};
