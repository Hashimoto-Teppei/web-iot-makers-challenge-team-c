/**
 * 走行後の同期の組み立て。**溜めたものを、上限に収まる大きさに分けて送り、送れたぶんに印を付ける。**
 *
 * **HTTP も SQL も知らない**（`./api.ts` と `./store.ts` の口だけを使う）ので、
 * 実機なしで Vitest から回せる（`docs/adr/0002-development-lifecycle.md`）。
 *
 * **走行中に呼ばない。**数千点の送信は 1Hz の中継と同じ回線を奪う
 * （`docs/interfaces/mobile-api.md`「走行後の同期」）。呼ぶのは走行を終えたあとだけである。
 */

// **件数の上限は取り込み側が正本。**ここで数字を持たない——**手元の数字が大きい方へ
// ずれると、送るたびに 400 になり、走行ログが永久に上がらない**
// （`CLAUDE.md`「同じことを2箇所に書かない」）。
import { logLimitDefaults } from "web/src/worker/logs/config";
import type { PostLogsFn } from "./api";
import type { PendingLimits, RideLogStore } from "./store";

/** 取り込み側の上限そのまま。 */
export const syncLimitDefaults: PendingLimits = {
  maxPoints: logLimitDefaults.maxPoints,
  maxDetections: logLimitDefaults.maxDetections,
};

/**
 * これより小さくしても入らないなら諦める。
 *
 * **`too_many` で半分にしながら試す**のは、**アプリより新しいサーバーが上限を
 * 下げている**ことがあるためである（アプリは配り直さないと変わらない）。
 * **無限に小さくしない**——1点でも入らないのは上限の話ではない。
 */
const MIN_POINTS = 100;

export type SyncOutcome = {
  /** 送れた件数（この呼び出しのぶん） */
  sent: { rides: number; points: number; detections: number };
  /** 投げたリクエストの数 */
  requests: number;
  /**
   * 途中で止まった理由。**送れていれば `null`。**
   *
   * **画面に出す。**走行後の同期は1日に1回しか走らないので、**黙って失敗すると
   * 「走ったのにデータが無い」ことに気づくのがデモの直前になる。**
   */
  error: string | null;
};

/**
 * 溜まっているものを送りきる。**送れたぶんにだけ印を付ける。**
 *
 * @param maxRequests 安全弁。**印が付かずに同じものを返し続ける不具合**（保存層の側）で
 *   無限に投げ続けないための上限であって、送る量の設計ではない
 */
export async function syncRideLogs(
  store: RideLogStore,
  post: PostLogsFn,
  options: { limits?: PendingLimits; now?: () => number; maxRequests?: number } = {},
): Promise<SyncOutcome> {
  const now = options.now ?? Date.now;
  const maxRequests = options.maxRequests ?? 200;
  let limits = options.limits ?? syncLimitDefaults;

  const rideIds = new Set<string>();
  const sent = { points: 0, detections: 0 };
  let requests = 0;

  while (requests < maxRequests) {
    const batch = store.pending(limits);
    // 送るものが無くなった。**これが正常な終わり方。**
    if (batch === null) return { sent: summarize(rideIds, sent), requests, error: null };

    const result = await post(batch);
    requests += 1;

    if (result.ok) {
      store.markSent(batch, now());
      for (const ride of batch.rides) rideIds.add(ride.logId);
      sent.points += batch.points.length;
      sent.detections += batch.detections.length;
      continue;
    }

    if (result.kind === "too_many") {
      // **印を付けずに、次はもっと小さく試す。**送れたかどうかは分からないが、
      // **取り込みは冪等なので、重なっても二重に積まれない**
      // （`docs/interfaces/web-service.md`「データの取り込み」）。
      const smaller = {
        maxPoints: Math.floor(limits.maxPoints / 2),
        maxDetections: Math.max(1, Math.floor(limits.maxDetections / 2)),
      };
      if (smaller.maxPoints < MIN_POINTS) {
        return { sent: summarize(rideIds, sent), requests, error: result.message };
      }
      limits = smaller;
      continue;
    }

    // **形が違う（送り直しても通らない）**も、**届かない**も、ここで止める。
    // **同じものを投げ続けない**——通らない 400 を繰り返すのが一番悪い。
    return { sent: summarize(rideIds, sent), requests, error: result.message };
  }

  return {
    sent: summarize(rideIds, sent),
    requests,
    error: "送信を打ち切りました（同じぶんを送り続けています）",
  };
}

function summarize(
  rideIds: ReadonlySet<string>,
  sent: { points: number; detections: number },
): SyncOutcome["sent"] {
  return { rides: rideIds.size, points: sent.points, detections: sent.detections };
}
