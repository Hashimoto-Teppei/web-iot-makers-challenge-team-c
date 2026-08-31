import { describe, expect, it } from "vitest";
import { bearingDeg, distanceM, normalizeAngleDeg } from "./geo";

// 岡山市付近。実走行のログは使わない（位置情報は個人情報。CLAUDE.md）ので、
// 手で計算できる値を合成して確かめる。
const LAT = 34.66;
const LON = 133.92;

// 緯度 0.001 度 ≒ 111m。経度 0.001 度は緯度 34.66 度で ≒ 91m
// （111m × cos(34.66°) = 111 × 0.8228）。
const DEG = 0.001;
const LAT_DEG_M = 111.19;
const LON_DEG_M = 91.5;

describe("distanceM", () => {
  it("同じ地点なら 0", () => {
    expect(distanceM(LAT, LON, LAT, LON)).toBe(0);
  });

  it("緯度 0.001 度の差は約 111m", () => {
    // 小数がぴったり一致することを期待すると環境で落ちるので、許容誤差を置く。
    expect(distanceM(LAT, LON, LAT + DEG, LON)).toBeCloseTo(LAT_DEG_M, 1);
  });

  it("経度 0.001 度の差は緯度 34.66 度で約 91m（緯度より短い）", () => {
    expect(distanceM(LAT, LON, LAT, LON + DEG)).toBeCloseTo(LON_DEG_M, 0);
  });

  it("向きを入れ替えても同じ距離になる", () => {
    const forward = distanceM(LAT, LON, LAT + DEG, LON + DEG);
    const backward = distanceM(LAT + DEG, LON + DEG, LAT, LON);
    expect(forward).toBeCloseTo(backward, 6);
  });

  it("赤道をまたぐ・経度が負でも破綻しない", () => {
    // 南半球・西経の符号を取り違えていれば、ここで距離が合わなくなる。
    expect(distanceM(-DEG, -DEG, DEG, -DEG)).toBeCloseTo(2 * LAT_DEG_M, 1);
  });
});

describe("bearingDeg", () => {
  it("真北は 0", () => {
    expect(bearingDeg(LAT, LON, LAT + DEG, LON)).toBeCloseTo(0, 3);
  });

  it("真東は 90", () => {
    expect(bearingDeg(LAT, LON, LAT, LON + DEG)).toBeCloseTo(90, 2);
  });

  it("真南は 180", () => {
    expect(bearingDeg(LAT, LON, LAT - DEG, LON)).toBeCloseTo(180, 3);
  });

  it("真西は -90 ではなく 270（0〜360未満に収める）", () => {
    expect(bearingDeg(LAT, LON, LAT, LON - DEG)).toBeCloseTo(270, 2);
  });

  it("北東方向は 45 度ではなく、それより北寄りになる", () => {
    // 経度 0.001 度（約 91m）は緯度 0.001 度（約 111m）より短いので、同じ度数を足しても
    // 東へ進む距離の方が短い。よって方位は 45 度ちょうどにはならず北寄りに出る。
    // atan2(91.5, 111.19) ≒ 39.4 度。
    const bearing = bearingDeg(LAT, LON, LAT + DEG, LON + DEG);
    expect(bearing).toBeCloseTo((Math.atan2(LON_DEG_M, LAT_DEG_M) * 180) / Math.PI, 0);
    expect(bearing).toBeLessThan(45);
  });
});

describe("normalizeAngleDeg", () => {
  it("-180 以上 180 未満はそのまま", () => {
    expect(normalizeAngleDeg(0)).toBe(0);
    expect(normalizeAngleDeg(90)).toBe(90);
    expect(normalizeAngleDeg(-90)).toBe(-90);
  });

  it("180 を超えたら負に回り込む", () => {
    expect(normalizeAngleDeg(190)).toBe(-170);
    expect(normalizeAngleDeg(-190)).toBe(170);
    expect(normalizeAngleDeg(360)).toBe(0);
    expect(normalizeAngleDeg(540)).toBe(-180);
  });

  it("ちょうど 180 度（真後ろ）は -180 に寄せる", () => {
    expect(normalizeAngleDeg(180)).toBe(-180);
    expect(normalizeAngleDeg(-180)).toBe(-180);
  });

  it("359 度と 1 度の差は 358 ではなく 2", () => {
    // ここを間違えると、真後ろから来る自転車を正面と判定する。
    expect(Math.abs(normalizeAngleDeg(1 - 359))).toBe(2);
    expect(Math.abs(normalizeAngleDeg(359 - 1))).toBe(2);
  });

  it("何周していても同じ結果になる", () => {
    expect(normalizeAngleDeg(45 + 360 * 3)).toBeCloseTo(45, 9);
    expect(normalizeAngleDeg(45 - 360 * 3)).toBeCloseTo(45, 9);
  });
});
