import { describe, expect, it } from "vitest";
import { CoverageWatch } from "./coverage";

/** 岡山市内あたりの矩形。**中と外がはっきり分かれる大きさにしてある。** */
const BOUNDS = { minLat: 34.6, maxLat: 34.7, minLon: 133.9, maxLon: 134.0 };

describe("CoverageWatch", () => {
  it("中を走っている間は何も残さない", () => {
    const watch = new CoverageWatch(BOUNDS);
    watch.record(34.65, 133.95, 1_000);
    watch.record(34.66, 133.96, 2_000);

    expect(watch.outside()).toBeNull();
  });

  it("外に出たら、最初に出た時刻と回数を残す", () => {
    const watch = new CoverageWatch(BOUNDS);
    watch.record(34.65, 133.95, 1_000);
    watch.record(34.75, 133.95, 2_000);
    watch.record(34.76, 133.95, 3_000);

    expect(watch.outside()).toEqual({ since: 2_000, until: 3_000, fixes: 2 });
  });

  it("戻ってきても消さない（走行として『足りなかった』ことは変わらない）", () => {
    const watch = new CoverageWatch(BOUNDS);
    watch.record(34.75, 133.95, 1_000);
    watch.record(34.65, 133.95, 2_000);

    // **最初に出た時刻は上書きしない。**知りたいのは「いつから手元が足りなくなったか」。
    expect(watch.outside()).toEqual({ since: 1_000, until: 1_000, fixes: 1 });
  });

  it("矩形を持っていなければ何も記録しない（判定していないことを『出ていない』にしない）", () => {
    // **`null` は「範囲が分からない」。**画面はこれを `signs.db` の `meta` を見て
    // 「確かめていません」と出す（`../app/index.tsx`）。
    const watch = new CoverageWatch(null);
    watch.record(0, 0, 1_000);

    expect(watch.outside()).toBeNull();
  });
});
