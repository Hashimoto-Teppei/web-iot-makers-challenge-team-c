import { describe, expect, it } from "vitest";
import { approachDefaults, detectApproach } from "../detect/approach";
import { register } from "../ride/detectors";
import { runRide } from "./ride";
import {
  appCrashMidRide,
  approachFromBehind,
  positionLostMidRide,
  postFailureMidRide,
} from "./scenarios";

/**
 * **実機・BLE・サーバーなしで、測位から `alert` への書き込みまでを見るテスト。**
 *
 * 検知そのものの合否は各検知のテスト（`../detect/*.test.ts`）が見る。ここが見るのは
 * **登録した検知がアプリの中で実際に呼ばれ、結果がデバイスへ書かれるか**である。
 */
describe("runRide", () => {
  it("登録した検知が発火し、`warn` がデバイスの出口に届く", async () => {
    const frames = await runRide(approachFromBehind, {
      detectors: [register("approach", detectApproach, approachDefaults)],
    });

    const warns = frames.flatMap((frame) => frame.warns);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toMatchObject({ k: "warn", kind: "approach" });
  });

  it("同じ危険が続いても、毎周期は書かない", async () => {
    const frames = await runRide(approachFromBehind, {
      detectors: [register("approach", detectApproach, approachDefaults)],
    });

    const firedTicks = frames.filter((frame) => frame.tick.peers !== null).length;
    const warns = frames.flatMap((frame) => frame.warns).length;
    // 抑制が効いていれば、発火し続けた周期の数より書いた数の方が少ない。
    expect(warns).toBeLessThan(firedTicks);
  });

  it("検知を1つも登録しなければ、何も書かれない（心拍だけが流れる）", async () => {
    const frames = await runRide(approachFromBehind, { detectors: [] });

    expect(frames.flatMap((frame) => frame.warns)).toEqual([]);
    expect(frames.every((frame) => frame.beat !== null)).toBe(true);
  });

  it("`beat` が毎ティック書かれる", async () => {
    const frames = await runRide(approachFromBehind);
    expect(frames.every((frame) => frame.beat?.k === "beat")).toBe(true);
    expect(frames.every((frame) => frame.beat?.t === frame.tick.now)).toBe(true);
  });

  it('測位が無い間も `beat` は止まらず、`st: "nofix"` になる', async () => {
    const frames = await runRide(positionLostMidRide);

    const lost = frames.filter((frame) => frame.tick.fix === null);
    expect(lost.length).toBeGreaterThan(0);
    // 測位が切れた直後は、直前の測位がまだ「新しい」ので `ok` のことがある
    // （失効は `NeighborsConfig.selfStaleMs` で測る）。切れている間の最後まで見て、
    // **`nofix` に落ちていること**を確かめる。
    expect(lost.at(-1)?.beat).toMatchObject({ st: "nofix" });
    expect(lost.every((frame) => frame.beat !== null)).toBe(true);
  });

  it('POST が失敗している間も `beat` は `st: "ok"` のまま（`link` を落とさない）', async () => {
    const frames = await runRide(postFailureMidRide);

    const failing = frames.filter((frame) => frame.tick.fix !== null && frame.tick.peers === null);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((frame) => frame.beat?.st === "ok")).toBe(true);
    // 連続して失敗していることが画面に出せる（デバイスの `link` では気づけない）。
    expect(failing.at(-1)?.status.postFailures).toBeGreaterThan(0);
  });

  it("アプリが止まっている間は1通も書かれない（デバイス側が `down` と判断する根拠）", async () => {
    const frames = await runRide(appCrashMidRide);

    const down = frames.filter((frame) => frame.tick.beat === null);
    expect(down.length).toBeGreaterThan(0);
    expect(down.every((frame) => frame.written.length === 0)).toBe(true);
  });
});
