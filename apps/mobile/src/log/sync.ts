/**
 * 走行後の同期の組み立て。**溜めたものを、上限に収まる大きさに分けて送り、送れたぶんに印を付け、
 * 送り終えて置いておく期間を過ぎたぶんを端末から消す。**
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
import { type RideLogRetention, rideLogRetentionDefaults } from "./config";
import type { PendingLimits, PurgeResult, RideLogStore } from "./store";

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
   * 端末から消した件数。**送り終えて、置いておく期間を過ぎたぶん**である。
   *
   * **消したことを人に見せる必要は無い。**ここに載せているのは、
   * **掃除が本当に走ったことをテストで確かめられるようにする**ため
   * （**消し損ねの方は見せる**。下の {@link SyncOutcome.purgeError}）。
   */
  purged: PurgeResult;
  /**
   * 消せなかった理由。**消せていれば `null`。**
   *
   * **{@link SyncOutcome.error} と混ぜない。**送れているのに「送信に失敗しました」と
   * 出す方が誤解が大きい。**それでも画面には出す**——**消せていないことは
   * どの件数にも現れない**（`./store.ts` の `summary()` が数えるのは
   * **送っていない行だけ**）ので、**黙ると、位置情報が端末に溜まり続けていることに
   * 誰も気づけない。**
   */
  purgeError: string | null;
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
  options: {
    limits?: PendingLimits;
    now?: () => number;
    maxRequests?: number;
    retention?: RideLogRetention;
  } = {},
): Promise<SyncOutcome> {
  // **送信が失敗しても掃除する。**消す対象は `sent_at` が立っている行だけで、
  // **今回の送信の成否とは関係が無い**——むしろ通信が死んでいる日ほど、
  // 手元に残す量は減らしておきたい（走行ログは個人情報である。`CLAUDE.md`）。
  try {
    const outcome = await sendPending(store, post, options);
    return { ...outcome, ...purgeRideLogs(store, options) };
  } catch (reason: unknown) {
    // **保存層が投げたとき**もここを通る（送信の失敗は `outcome.error` に入る）。
    // **掃除だけは済ませてから、例外を呼び出し元へ通す**——握ると、
    // 送れていないことが画面に出ない。
    const { purgeError } = purgeRideLogs(store, options);
    // **掃除も落ちたなら、その理由を一緒に運ぶ。**この経路では
    // {@link SyncOutcome} を返せず、**投げたものしか画面に届かない**
    // ——落ちるときは同じ `db` の故障で両方が落ちるので、**ここが一番起きやすい。**
    if (purgeError !== null) throw new Error(`${String(reason)}／${purgeError}`, { cause: reason });
    throw reason;
  }
}

/**
 * 送り終えて、置いておく期間を過ぎた行を消す。**送信を伴わない。**
 *
 * **走行後の同期の中だけで呼ばない。**そこだけにすると、**次に走るまで期限が進まない**
 * ——1回走ってアプリを開かなくなった端末に、**送り終えた測位が残り続ける。**
 * 画面を開いたときにも呼ぶこと（`./use-ride-log-sync.ts`）。
 */
export function purgeRideLogs(
  store: RideLogStore,
  options: { now?: () => number; retention?: RideLogRetention } = {},
): { purged: PurgeResult; purgeError: string | null } {
  const now = options.now ?? Date.now;
  const retention = options.retention ?? rideLogRetentionDefaults;
  try {
    return { purged: store.purgeSent(now() - retention.sentRetentionMs), purgeError: null };
  } catch (reason: unknown) {
    // **握りつぶさない。**消せていないことは**どの件数にも現れない**
    // （`summary()` が数えるのは送っていない行だけ）ので、
    // **ここで捨てると、位置情報が端末に溜まり続けていることに誰も気づけない。**
    return {
      purged: { rides: 0, points: 0, detections: 0 },
      purgeError: `送り終えた走行ログを消せません（端末に残り続けます）: ${String(reason)}`,
    };
  }
}

/** 溜まっているものを送りきる部分。**消すのは呼び出し元**（成否によらず消すため）。 */
async function sendPending(
  store: RideLogStore,
  post: PostLogsFn,
  options: { limits?: PendingLimits; now?: () => number; maxRequests?: number },
): Promise<Omit<SyncOutcome, "purged" | "purgeError">> {
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
