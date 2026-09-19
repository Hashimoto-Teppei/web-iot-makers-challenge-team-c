/**
 * 回収と取り込みのつなぎ目のテスト（#40）。**実機も BLE も要らない。**
 *
 * 確かめるのは**既読位置の扱い**——ここを間違えると、
 * **毎回まるごと取り直す**か、**以後1件も取り込めない**のどちらかになる。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceDetection } from "../ble/log-transfer";
import type { CollectOutcome, DeviceLink } from "../ride/device";
import { collectDeviceLogs } from "./collect";
import { type AppDatabase, openAppDatabase } from "./node";
import type { RideLogStore } from "./store";

const DEVICE = "a1000001";
const LOG = "9a1c2b3d";

let open: AppDatabase[] = [];

function store(): RideLogStore {
  const db = openAppDatabase(":memory:");
  open.push(db);
  return db.store;
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

function record(seq: number): DeviceDetection {
  return { seq, t: 1_000 + seq, tEst: false, kind: "rear_object", lv: 2 };
}

/** 頼まれたら `records` を渡してくるデバイス。**`since` を覚えておく。** */
function fakeDevice(
  records: readonly DeviceDetection[],
  outcome: Partial<CollectOutcome> = {},
): DeviceLink & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    deviceId: DEVICE,
    logId: LOG,
    writeAlert: () => {},
    collectLogs: (since, onRecords) => {
      asked.push(since);
      const wanted = records.filter((item) => item.seq > since);
      onRecords(wanted);
      return Promise.resolve({
        received: wanted.length,
        done: true,
        reason: null,
        ...outcome,
      });
    },
  };
}

describe("collectDeviceLogs", () => {
  it("取り込んで、次は続きから頼む", () => {
    const logs = store();
    const device = fakeDevice([record(1), record(2)]);

    return collectDeviceLogs(device, logs)
      .then((reason) => {
        expect(reason).toBeNull();
        expect(logs.summary().pendingDetections).toBe(2);
        return collectDeviceLogs(device, logs);
      })
      .then(() => {
        // 1回目は全件（0）、2回目は続き（2）。毎回まるごと取り直さない。
        expect(device.asked).toEqual([0, 2]);
      });
  });

  it("世代が変われば全件を取り直す", async () => {
    // log_id が変われば seq は 1 に戻る。前の世代の位置を使うと1件も取り込めない。
    const logs = store();
    await collectDeviceLogs(fakeDevice([record(1), record(2)]), logs);

    const renewed = { ...fakeDevice([record(1)]), logId: "0000ffff" };
    await collectDeviceLogs(renewed, logs);

    expect(renewed.asked).toEqual([0]);
    expect(logs.summary().pendingDetections).toBe(3);
  });

  it("つながっていなければ何もしない（理由も出さない）", async () => {
    // デバイスはログを消さないので、次につないだときに取りに行けばよい。
    const logs = store();

    expect(await collectDeviceLogs(null, logs)).toBeNull();
    expect(logs.summary().pendingDetections).toBe(0);
  });

  it("途中で終わってもそこまでは残り、理由を返す", async () => {
    const logs = store();
    const device = fakeDevice([record(1)], { done: false, reason: "途中で切れました" });

    expect(await collectDeviceLogs(device, logs)).toBe("途中で切れました");
    expect(logs.summary().pendingDetections).toBe(1);
  });

  it("取り込みで落ちても投げない", async () => {
    // 投げると走行後の同期ごと止まる（スマホ発の走行ログは送れるはずである）。
    const logs = store();
    vi.spyOn(logs, "addDeviceDetections").mockImplementation(() => {
      throw new Error("書けません");
    });

    const reason = await collectDeviceLogs(fakeDevice([record(1)]), logs);

    expect(reason).toContain("書けません");
  });
});
