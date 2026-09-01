/**
 * 送る組み立ての確認。**保存層は本物を使う**（`better-sqlite3`）ので、
 * 「送れたぶんにだけ印が付く」ところまで通しで確かめられる。
 *
 * **HTTP は差し替える。**確かめたいのは分け方と、失敗したときに何を残すかであって、
 * 通信そのものではない（`docs/adr/0002-development-lifecycle.md`）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelfMessage } from "../v2v/messages";
import type { PostLogsFn, PostLogsResult } from "./api";
import { type AppDatabase, openAppDatabase } from "./node";
import type { PendingBatch, RideLogStore } from "./store";
import { syncRideLogs } from "./sync";

const DEVICE = "a1000001";

/** **送った直後に消える**設定。既定（3日）を待たずに掃除を確かめるためのもの。 */
const ZERO_RETENTION = { sentRetentionMs: 0 };

function fix(t: number): SelfMessage {
  return { k: "self", t, lat: 34.6612, lon: 133.9345, spd: 4.2, crs: 90, hacc: 8 };
}

let open: AppDatabase[] = [];

/** 点が `points` 個ある、終わった走行を1つ持つ保存層。 */
function storeWith(points: number): RideLogStore {
  const db = openAppDatabase(":memory:");
  open.push(db);
  const ride = db.store.startRide(DEVICE, 1_000);
  for (let i = 0; i < points; i += 1) ride.addPoint(fix(1_000 + i));
  ride.end(1_000 + points);
  return db.store;
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

/** 送られてきたものを覚える {@link PostLogsFn}。 */
function recorder(results: PostLogsResult[] = []): PostLogsFn & { sent: PendingBatch[] } {
  const sent: PendingBatch[] = [];
  const post = vi.fn(async (batch: PendingBatch) => {
    sent.push(batch);
    return results.shift() ?? { ok: true as const };
  });
  return Object.assign(post, { sent });
}

describe("syncRideLogs", () => {
  it("送るものが無ければ何も投げない", async () => {
    const post = recorder();
    // **走り終えた直後の時刻**で回す（既定の保持期間は3日。`./config.ts`）。
    const outcome = await syncRideLogs(storeWith(0), post, { now: () => 2_000 });

    expect(post.sent).toHaveLength(0);
    expect(outcome).toEqual({
      sent: { rides: 0, points: 0, detections: 0 },
      requests: 0,
      // **終えた直後の走行には触れない。**測位が1点も無くても、
      // **置いておく期間を過ぎるまで消さない**（`./store.ts` の `purgeSent`）。
      purged: { rides: 0, points: 0, detections: 0 },
      purgeError: null,
      error: null,
    });
  });

  it("上限を超えるぶんは分けて送り、全部に印を付ける", async () => {
    const logs = storeWith(5);
    const post = recorder();

    const outcome = await syncRideLogs(logs, post, {
      limits: { maxPoints: 2, maxDetections: 2 },
      now: () => 9_000,
    });

    expect(post.sent.map((b) => b.points.length)).toEqual([2, 2, 1]);
    // **走行の行は毎回入る**（`docs/interfaces/web-service.md`「1回の送信は分割してよい」）。
    expect(post.sent.every((b) => b.rides.length === 1)).toBe(true);
    expect(outcome.sent).toEqual({ rides: 1, points: 5, detections: 0 });
    expect(outcome.error).toBeNull();
    expect(logs.summary().pendingPoints).toBe(0);
  });

  it("多すぎると言われたら半分にして送り直す", async () => {
    const logs = storeWith(300);
    const post = recorder([{ ok: false, kind: "too_many", message: "多すぎます" }]);

    const outcome = await syncRideLogs(logs, post, {
      limits: { maxPoints: 300, maxDetections: 2_000 },
      now: () => 9_000,
    });

    expect(post.sent.map((b) => b.points.length)).toEqual([300, 150, 150]);
    expect(outcome.error).toBeNull();
    expect(logs.summary().pendingPoints).toBe(0);
  });

  it("小さくしても入らないなら諦めて理由を残す", async () => {
    const logs = storeWith(10);
    const post = recorder([
      { ok: false, kind: "too_many", message: "多すぎます" },
      { ok: false, kind: "too_many", message: "多すぎます" },
    ]);

    const outcome = await syncRideLogs(logs, post, {
      limits: { maxPoints: 200, maxDetections: 2_000 },
    });

    expect(outcome.error).toBe("多すぎます");
    // **印は付けない。**送れていないものを送れたことにしない。
    expect(logs.summary().pendingPoints).toBe(10);
  });

  it("形が違う 400 は送り直さない（通らないものを投げ続けない）", async () => {
    const logs = storeWith(4);
    const post = recorder([{ ok: false, kind: "invalid", message: "形式が正しくありません" }]);

    const outcome = await syncRideLogs(logs, post, { limits: { maxPoints: 2, maxDetections: 2 } });

    expect(post.sent).toHaveLength(1);
    expect(outcome.error).toBe("形式が正しくありません");
    expect(logs.summary().pendingPoints).toBe(4);
  });

  it("届かなければ、送れたぶんだけ印を付けて止まる", async () => {
    const logs = storeWith(4);
    const post = recorder([
      { ok: true },
      { ok: false, kind: "unreachable", message: "送信できませんでした" },
    ]);

    const outcome = await syncRideLogs(logs, post, {
      limits: { maxPoints: 2, maxDetections: 2 },
      now: () => 9_000,
    });

    expect(outcome.sent.points).toBe(2);
    expect(outcome.error).toBe("送信できませんでした");
    // **残りは手元に残る。**次の機会に続きから送る。
    expect(logs.summary().pendingPoints).toBe(2);
    expect(logs.summary().lastSentAt).toBe(9_000);
  });

  it("送り終えて、置いておく期間を過ぎたぶんを端末から消す", async () => {
    const logs = storeWith(5);
    const post = recorder();

    const outcome = await syncRideLogs(logs, post, { now: () => 9_000, retention: ZERO_RETENTION });

    // **送った直後に消えるのは、保持期間を 0 にしたからである**（既定は3日。`./config.ts`）。
    expect(outcome.purged).toEqual({ rides: 1, points: 5, detections: 0 });
    expect(outcome.purgeError).toBeNull();
    // **「最後に送れた時刻」は消えない**（走行ログとは別の表にある。`./schema.ts`）。
    expect(logs.summary()).toEqual({
      pendingRides: 0,
      pendingPoints: 0,
      pendingDetections: 0,
      lastSentAt: 9_000,
    });
  });

  it("既定では送った直後に消さない（取り込みの取りこぼしを確かめられる猶予）", async () => {
    const logs = storeWith(5);

    const outcome = await syncRideLogs(logs, recorder(), { now: () => 9_000 });

    expect(outcome.purged).toEqual({ rides: 0, points: 0, detections: 0 });
  });

  it("送れなかったぶんは消さない（消すと二度と上がらない）", async () => {
    const logs = storeWith(4);
    const post = recorder([{ ok: false, kind: "unreachable", message: "送信できませんでした" }]);

    const outcome = await syncRideLogs(logs, post, {
      limits: { maxPoints: 2, maxDetections: 2 },
      now: () => 9_000,
      // **保持期間 0 でも、印の付いていない行には触れない。**
      retention: ZERO_RETENTION,
    });

    expect(outcome.purged).toEqual({ rides: 0, points: 0, detections: 0 });
    expect(logs.summary().pendingPoints).toBe(4);
  });

  it("掃除で落ちたら、送信の失敗とは分けて理由を残す", async () => {
    // **送れているのに「送信に失敗しました」と出す方が誤解が大きい。**
    // ただし**黙らない**——消せていないことは、どの件数にも現れない。
    const logs = storeWith(2);
    const broken: RideLogStore = {
      ...logs,
      purgeSent: () => {
        throw new Error("消せません");
      },
    };

    const outcome = await syncRideLogs(broken, recorder(), { now: () => 9_000 });

    expect(outcome.error).toBeNull();
    expect(outcome.sent.points).toBe(2);
    expect(outcome.purged).toEqual({ rides: 0, points: 0, detections: 0 });
    expect(outcome.purgeError).toMatch(/消せません/);
  });

  it("送る側が投げても、掃除は済ませてから通す", async () => {
    // **保存層が投げたときにここへ来る。**掃除は送信の成否と関係が無いので、
    // **通信が死んでいる日ほど手元は減らしておきたい。**
    const logs = storeWith(2);
    const sent = logs.pending({ maxPoints: 5, maxDetections: 5 });
    if (sent === null) throw new Error("送るものがある");
    logs.markSent(sent, 1);

    let purged = 0;
    const broken: RideLogStore = {
      ...logs,
      pending: () => {
        throw new Error("読めません");
      },
      purgeSent: (before) => {
        purged += 1;
        return logs.purgeSent(before);
      },
    };

    await expect(
      syncRideLogs(broken, recorder(), { now: () => 9_000, retention: ZERO_RETENTION }),
    ).rejects.toThrow("読めません");
    expect(purged).toBe(1);
    // **本当に消えている**（呼ばれただけではない）。
    expect(logs.summary().lastSentAt).toBe(1);
    expect(logs.purgeSent(9_000)).toEqual({ rides: 0, points: 0, detections: 0 });
  });

  it("送る側と掃除の両方が落ちたら、理由を両方とも運ぶ", async () => {
    // **この経路では `SyncOutcome` を返せず、投げたものしか画面に届かない。**
    // 落ちるときは同じ `db` の故障で両方が落ちるので、**ここが一番起きやすい。**
    const logs = storeWith(2);
    const broken: RideLogStore = {
      ...logs,
      pending: () => {
        throw new Error("読めません");
      },
      purgeSent: () => {
        throw new Error("消せません");
      },
    };

    await expect(syncRideLogs(broken, recorder())).rejects.toThrow(/読めません.*消せません/s);
  });

  it("印が付かないときに投げ続けない（安全弁）", async () => {
    // 保存層の不具合で同じぶんが返り続けても、通信を無限に繰り返さない。
    const logs = storeWith(4);
    const stuck: RideLogStore = { ...logs, markSent: () => {} };
    const post = recorder();

    const outcome = await syncRideLogs(stuck, post, {
      limits: { maxPoints: 2, maxDetections: 2 },
      maxRequests: 3,
    });

    expect(post.sent).toHaveLength(3);
    expect(outcome.error).toMatch(/打ち切/);
  });
});
