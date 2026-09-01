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
    const outcome = await syncRideLogs(storeWith(0), post);

    expect(post.sent).toHaveLength(0);
    expect(outcome).toEqual({
      sent: { rides: 0, points: 0, detections: 0 },
      requests: 0,
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
