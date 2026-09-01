import { describe, expect, it } from "vitest";
import type { JudgeSign } from "./judge";
import { boundingBoxOf, signsInBox } from "./query";

/** 合成データ。**実走行の GPS ログを使わない**（`CLAUDE.md`）。岡山駅の周辺に置いてある。 */
const LAT = 34.6651;
const LON = 133.9183;
const M_PER_DEG_LAT = 111_320;

describe("boundingBoxOf", () => {
  it("点が無ければ null（0 の矩形を返さない）", () => {
    expect(boundingBoxOf([], 20)).toBeNull();
  });

  it("1点だけでも、半径ぶん広げた矩形になる", () => {
    const box = boundingBoxOf([{ lat: LAT, lon: LON }], 20);

    expect(box).not.toBeNull();
    if (!box) return;
    // 緯度は 20m ぶん（約 0.00018 度）広がる。
    expect((box.maxLat - LAT) * M_PER_DEG_LAT).toBeCloseTo(20, 3);
    // **経度の余白は緯度より広い**（北緯 35 度では1度が短いため）。狭いと端の標識が落ちる。
    expect(box.maxLon - LON).toBeGreaterThan(box.maxLat - LAT);
  });

  it("すべての点を含む", () => {
    const box = boundingBoxOf(
      [
        { lat: LAT, lon: LON },
        { lat: LAT + 0.01, lon: LON - 0.02 },
      ],
      20,
    );

    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.minLat).toBeLessThan(LAT);
    expect(box.maxLat).toBeGreaterThan(LAT + 0.01);
    expect(box.minLon).toBeLessThan(LON - 0.02);
    expect(box.maxLon).toBeGreaterThan(LON);
  });
});

describe("signsInBox", () => {
  const signs: JudgeSign[] = [
    { id: "near", lat: LAT, lon: LON, approachLat: LAT - 0.001, approachLon: LON },
    { id: "far", lat: LAT + 1, lon: LON + 1, approachLat: LAT + 1, approachLon: LON + 1 },
  ];

  it("矩形の外の標識を落とす", () => {
    const box = boundingBoxOf([{ lat: LAT, lon: LON }], 20);
    expect(box).not.toBeNull();
    if (!box) return;

    expect(signsInBox(signs, box).map((s) => s.id)).toEqual(["near"]);
  });
});
