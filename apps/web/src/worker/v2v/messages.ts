import { z } from "zod";
import { type MessageLimits, messageLimitDefaults } from "./config";

/**
 * 中継で運ぶメッセージの検証。
 *
 * **形の正本は `docs/interfaces/v2v.md`「メッセージ」。**ここはその実装であって、
 * 決め直す場所ではない。**別の形を作らない**（`apps/mobile/src/v2v/messages.ts` が
 * 同じ形を読む側で持っている）。
 *
 * 範囲の検証をサーバー側でも行うのは、**壊れた1通を他人の近傍に入れないため**である。
 * 受け取る側（スマホ）にも同じ検証があるが、通してしまうと配った全員が同じものを捨てる
 * ことになり、しかも送った本人の POST は成功し続けるので誰も気づけない。
 */

/** 端末ID の形（16進の小文字8文字）。BLE の `device_id` と同じ値を使う。 */
const deviceIdSchema = z.string().regex(/^[0-9a-f]{8}$/);

/**
 * 測位1点ぶんの検証を組み立てる。
 *
 * 範囲を引数で受け取るのは、**上限を設定として外に出す**ため（`CLAUDE.md`）。
 * `z.number()` は zod v4 では `NaN` と `Infinity` を通さないので、有限かの確認は要らない。
 */
function fixSchema(limits: MessageLimits) {
  return {
    // 測位した時刻（UTC ミリ秒）。送信した時刻ではない。
    t: z.number().int(),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    spd: z.number().min(0).max(limits.maxSpdMps),
    // **`null` を範囲外として捨てない。**「止まっていて向きが分からない」という正常な値で、
    // 捨てると止まっている自転車と低速の自転車が丸ごと消える。急接近の検知が一番見たい
    // 相手がこれなので、検知が静かに効かなくなる（`docs/interfaces/v2v.md`）。
    //
    // ただし**キーごと無いものは捨てる。**`.optional()` を付けないのはそのため。
    crs: z.number().min(0).lt(360).nullable(),
    // 0 を通すと「誤差 0 の確かな位置」になってしまうので、0 より大きいことを求める。
    hacc: z.number().gt(0).max(limits.maxHaccM),
  };
}

/**
 * `POST /api/v2v/exchange` のリクエスト。
 *
 * `self` に `id` が入らないのは自分の位置だからで、**代わりに1階層上で名乗る**
 * （`docs/interfaces/v2v.md`「メッセージ」）。
 *
 * **知らないキーは無視する**（zod の既定で剥がれる）。項目が増えても古い実装が落ちない
 * ようにするためで、`strict()` にするとその狙いが逆になる。
 */
export function exchangeRequestSchema(limits: MessageLimits) {
  return z.object({
    /**
     * 名乗る端末ID。**スマホは接続中のデバイスから読んだ `device_id` を使う。**
     * スマホ側で別の ID を作らない（同じデバイスを2つの名前で呼ばないため）。
     */
    id: deviceIdSchema,
    self: z.object({ k: z.literal("self"), ...fixSchema(limits) }),
  });
}

/** 既定の範囲での検証。ルートはこれを使う（テストだけが範囲を差し替える）。 */
export const exchangeRequest = exchangeRequestSchema(messageLimitDefaults);

export type ExchangeRequest = z.infer<typeof exchangeRequest>;

/** 自車の測位（`k` を含む）。Durable Object にはこの形のまま渡す。 */
export type SelfMessage = ExchangeRequest["self"];

/** 周辺車両1台ぶん。`self` の `k` を差し替えて `id` を足しただけ。 */
export type PeerMessage = Omit<SelfMessage, "k"> & {
  k: "peer";
  id: string;
};

/** レスポンス。**台数の上限を置かない**（`docs/interfaces/mobile-api.md`）。 */
export type ExchangeResponse = {
  peers: PeerMessage[];
};
