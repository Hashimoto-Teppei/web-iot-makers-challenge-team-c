import { describe, expect, it } from "vitest";
import { angleDiffDeg, bearingDeg, distanceM } from "./geo";

/** 合成データ。**実走行の GPS ログを使わない**（`CLAUDE.md`）。岡山駅の周辺に置いてある。 */
const LAT = 34.6651;
const LON = 133.9183;

describe("distanceM", () => {
  it("同じ点なら 0", () => {
    expect(distanceM(LAT, LON, LAT, LON)).toBe(0);
  });

  it("緯度 0.001 度の差はおよそ 111m", () => {
    expect(distanceM(LAT, LON, LAT + 0.001, LON)).toBeCloseTo(111.2, 0);
  });
});

describe("bearingDeg", () => {
  it("真北・真東・真南・真西", () => {
    expect(bearingDeg(LAT, LON, LAT + 0.001, LON)).toBeCloseTo(0, 1);
    expect(bearingDeg(LAT, LON, LAT, LON + 0.001)).toBeCloseTo(90, 1);
    expect(bearingDeg(LAT, LON, LAT - 0.001, LON)).toBeCloseTo(180, 1);
    expect(bearingDeg(LAT, LON, LAT, LON - 0.001)).toBeCloseTo(270, 1);
  });

  it("0〜360 の範囲に収まる（負の値を返さない）", () => {
    const northWest = bearingDeg(LAT, LON, LAT + 0.001, LON - 0.001);
    expect(northWest).not.toBeNull();
    expect(northWest as number).toBeGreaterThan(180);
    expect(northWest as number).toBeLessThan(360);
  });

  // **0（真北）に潰さない。**潰すと `docs/unverified.md` 57 と同じ間違いを自前で作る。
  it("同じ点なら null（真北にしない）", () => {
    expect(bearingDeg(LAT, LON, LAT, LON)).toBeNull();
  });
});

describe("angleDiffDeg", () => {
  it("北をまたぐ差を 358 度にしない", () => {
    expect(angleDiffDeg(359, 1)).toBeCloseTo(2, 6);
    expect(angleDiffDeg(1, 359)).toBeCloseTo(2, 6);
  });

  it("0〜180 に収まる", () => {
    expect(angleDiffDeg(0, 180)).toBeCloseTo(180, 6);
    expect(angleDiffDeg(0, 190)).toBeCloseTo(170, 6);
    expect(angleDiffDeg(10, 40)).toBeCloseTo(30, 6);
  });
});
