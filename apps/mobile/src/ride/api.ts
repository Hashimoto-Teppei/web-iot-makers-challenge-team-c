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
import { DEFAULT_API_BASE_URL } from "../lib/api-base";
import { MOCK_DEVICE_ID } from "./device";
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

/**
 * **モックのデバイスのまま共有のデプロイ先へ中継しようとしているか。**
 *
 * #38 が入るまで走行ループは `createMockDeviceLink()` を使い、**全員が同じ
 * {@link MOCK_DEVICE_ID} を名乗る。**そのまま既定のデプロイ先へ投げると、
 *
 * - **実際の緯度経度が共有の Durable Object に毎秒載り**、半径 300m の他人に周辺車両として見える
 *   （位置情報は個人情報である。`CLAUDE.md`）
 * - 同じ ID なので**開発者どうしが同じ枠を上書きし合う**（自分の ID は除いて返されるため、
 *   お互いには見えないまま消し合う）
 *
 * **文書だけでは止まらない**ので、ここで止める。手元の `apps/web` に向けているとき
 * （`.env.local` で `EXPO_PUBLIC_API_BASE_URL` を変えたとき）は通す——**自分のサーバーなら
 * どちらの害も無い。**
 */
export function blocksMockExchange(deviceId: string, baseUrl: string): boolean {
  return deviceId === MOCK_DEVICE_ID && baseUrl === DEFAULT_API_BASE_URL;
}

/**
 * 中継を断る {@link ExchangeFn}。{@link blocksMockExchange} が真のときに使う。
 *
 * **失敗として返す**ので、走行ループは POST が落ちたときと同じ振る舞いをする
 * （心拍は続き、近傍が空になり、失敗の回数が画面に出る。`./loop.ts`）。
 * **黙って成功にしない**——「中継できている」と見えるまま位置が出ていかない状態が
 * 一番たちが悪い。
 */
export const refuseMockExchange: ExchangeFn = () =>
  Promise.reject(
    new Error(
      "モックのデバイスでは共有のデプロイ先へ中継しません（実際の位置が他人に見えるため）。" +
        "手元で試すときは .env.local に EXPO_PUBLIC_API_BASE_URL を書いてください（docs/setup.md）",
    ),
  );
