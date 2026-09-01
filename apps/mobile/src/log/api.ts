/**
 * 走行後の同期（`POST /api/logs`）の実装。
 *
 * **リクエストとレスポンスの型は Hono RPC で伝わる**ので、ここで型を書き写さない
 * （`docs/interfaces/mobile-api.md`）。写すと必ず実装とずれ、**綴りを間違えた項目が
 * コンパイルを通って、走行後の送信が毎回 400 になる**——1日の終わりに1回しか走らないので、
 * **気づけるのは走行データが1件も無いと分かったとき**である。
 *
 * **送る組み立て（`./sync.ts`）はこのファイルを知らない。**分けてあるので、
 * テストは HTTP を通さずに同じ形を渡せる。
 */

import { api, apiBaseUrl } from "../lib/api";
import { blocksMockDevice } from "../lib/mock-guard";
import type { PendingBatch } from "./store";

/**
 * 1回の送信の結果。
 *
 * **「送り直せば入る」と「送り直しても無駄」を分ける。**分けないと、
 * **通らない 400 に送り直しを繰り返す**（`docs/interfaces/web-service.md`）。
 */
export type PostLogsResult =
  /** 入った（重複していても成功。取り込みは冪等） */
  | { ok: true }
  /** 件数が多すぎる。**分けて送り直せば入る** */
  | { ok: false; kind: "too_many"; message: string }
  /** 形が違う。**送り直しても通らない**ので、人に見せて止める */
  | { ok: false; kind: "invalid"; message: string }
  /** 届かなかった・サーバーが落ちている。**次の機会に送り直す** */
  | { ok: false; kind: "unreachable"; message: string };

export type PostLogsFn = (batch: PendingBatch) => Promise<PostLogsResult>;

/** 実際に Worker へ投げる {@link PostLogsFn}。 */
export const postLogsViaApi: PostLogsFn = async (batch) => {
  // **モックの ID のまま共有のデプロイ先へ実際の走行ログを送らない**（`../lib/mock-guard.ts`）。
  // **消せない行を他人の D1 に残すことになる。**
  if (blocksMockDevice(batch.deviceId, apiBaseUrl)) {
    return {
      ok: false,
      kind: "invalid",
      message:
        "モックのデバイスでは共有のデプロイ先へ走行ログを送りません（実際の位置が消せない行として残るため）。" +
        "手元で試すときは .env.local に EXPO_PUBLIC_API_BASE_URL を書いてください（docs/setup.md）",
    };
  }

  let res: Awaited<ReturnType<typeof api.api.logs.$post>>;
  try {
    res = await api.api.logs.$post({ json: batch });
  } catch (reason: unknown) {
    // **通信の失敗と 400 を混ぜない。**こちらは手元をそのままにして次の機会を待つ。
    return { ok: false, kind: "unreachable", message: `送信できませんでした: ${String(reason)}` };
  }

  if (res.ok) return { ok: true };

  const body = await res.json().catch(() => null);
  // **サーバーが理由を付けている 400 だけを見分ける。**5xx はサーバー側の不調なので、
  // 「送り直しても無駄」には倒さない。
  if (body !== null && "code" in body) {
    return { ok: false, kind: body.code, message: body.error };
  }
  return { ok: false, kind: "unreachable", message: `サーバーが ${res.status} を返しました` };
};
