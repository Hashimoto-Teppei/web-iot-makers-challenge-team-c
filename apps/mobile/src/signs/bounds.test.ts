import { describe, expect, it } from "vitest";
import type { StopSign } from "../detect/types";
import { boundsOf, isOutsideBounds } from "./bounds";

const sign = (id: string, lat: number, lon: number): StopSign => ({ id, lat, lon, approach: null });

/** 岡山市内あたりの3件。**南西と北東が別々の標識から来る**（1件では矩形にならない）。 */
const SIGNS = [
  sign("s-1", 34.6612, 133.9345),
  sign("s-2", 34.6605, 133.9388),
  sign("s-3", 34.665, 133.9301),
];

describe("boundsOf", () => {
  it("全件の最小と最大から矩形を作る", () => {
    expect(boundsOf(SIGNS)).toEqual({
      minLat: 34.6605,
      maxLat: 34.665,
      minLon: 133.9301,
      maxLon: 133.9388,
    });
  });

  it("0 件なら矩形は無い（`null`）", () => {
    // **0 件と「範囲が無い」を同じ値で表す。**どちらも判定のしようがない。
    expect(boundsOf([])).toBeNull();
  });

  it("1 件なら潰れた矩形になる（幅ゼロ。それでも矩形として扱う）", () => {
    expect(boundsOf([SIGNS[0] as StopSign])).toEqual({
      minLat: 34.6612,
      maxLat: 34.6612,
      minLon: 133.9345,
      maxLon: 133.9345,
    });
  });
});

describe("isOutsideBounds", () => {
  const bounds = { minLat: 34.6605, maxLat: 34.665, minLon: 133.9301, maxLon: 133.9388 };

  it("中に居れば外ではない", () => {
    expect(isOutsideBounds(bounds, 34.662, 133.935)).toBe(false);
  });

  it("境界の上は中として扱う（外に倒すと、県境に居るだけで出たことになる）", () => {
    expect(isOutsideBounds(bounds, 34.6605, 133.9301)).toBe(false);
    expect(isOutsideBounds(bounds, 34.665, 133.9388)).toBe(false);
  });

  it("北・南・東・西のどれに出ても外と分かる", () => {
    expect(isOutsideBounds(bounds, 34.67, 133.935)).toBe(true);
    expect(isOutsideBounds(bounds, 34.65, 133.935)).toBe(true);
    expect(isOutsideBounds(bounds, 34.662, 133.94)).toBe(true);
    expect(isOutsideBounds(bounds, 34.662, 133.92)).toBe(true);
  });
});
