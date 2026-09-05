/**
 * 走り出す前の心拍（`./idle-heartbeat.ts`）のテスト。
 *
 * **実機も BLE も要らない。**書き先はモックのデバイス（`./device.ts`）で、
 * 時間は擬似タイマーで進める（`./loop.test.ts` と同じ形）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockDeviceLink } from "./device";
import { idleBeat, startIdleHeartbeat } from "./idle-heartbeat";

afterEach(() => {
  vi.useRealTimers();
});

describe("走り出す前の心拍", () => {
  // **黙っていると、デバイスが持ち主を 30 秒で切る**（#128。
  // `docs/interfaces/ble-gatt.md`「前提」）。走行前の画面で繋がっては切られるを繰り返した。
  it("書き始めた瞬間と、1秒ごとに書く", () => {
    vi.useFakeTimers();
    const device = createMockDeviceLink();

    const stop = startIdleHeartbeat(device, 1_000);
    expect(device.written).toHaveLength(1);

    vi.advanceTimersByTime(3_000);
    expect(device.written).toHaveLength(4);

    stop();
    vi.advanceTimersByTime(5_000);
    expect(device.written).toHaveLength(4);
  });

  // **測位を待たない。**待つと、デバイスは `down`（＝アプリが落ちた）と出し、
  // **待てば直るものと直らないものが区別できなくなる**（`docs/interfaces/v2v.md`）。
  it("測位が無いので `nofix` を載せる", () => {
    expect(idleBeat(1_700_000_000_000).st).toBe("nofix");
  });

  // **速度を測っていないので、止まっているかを本当は知らない。**
  // 止まっていることにして実は走っていた場合、デバイスが走行中に文章を出す
  // （`docs/notifications.md`「迷ったら走行中に倒す」）。
  it("走行中かは分からないので、走行中に倒す", () => {
    expect(idleBeat(1_700_000_000_000).mv).toBe(true);
  });
});
