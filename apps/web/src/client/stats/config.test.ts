import { describe, expect, it } from "vitest";
import {
  bandForPercent,
  MIN_RADIUS_M,
  RADIUS_PER_SQRT_RIDE,
  RATE_BANDS,
  radiusForRides,
  ratePercent,
} from "./config";

/**
 * 見せ方の数字そのものは変わるので試さない（変えるたびにテストが落ちる）。
 * **試すのは、変えたときに黙って壊れる関係だけ。**
 */

describe("ratePercent と段", () => {
  // **これが `0%` の段に入らないと、危険が1件も出ていない場所が赤くなる**
  // （`config.ts` の `ratePercent`）。**率そのものから段を引くとこうなる。**
  it("0% と表示される率は 0% の段に入る", () => {
    expect(ratePercent(0.004)).toBe(0);
    expect(bandForPercent(ratePercent(0.004))).toBe(RATE_BANDS[0]);
  });

  it("段の切れ目は上限の値そのものを含まない", () => {
    expect(bandForPercent(9)).toBe(RATE_BANDS[1]);
    expect(bandForPercent(10)).toBe(RATE_BANDS[2]);
  });

  // **最後の段は上限が無限大なので、どんな値でも必ずどれかの段に当たる。**
  // 当たらなくなると、円が色を持たないまま描かれる。
  it("率がいくつでも段が引ける", () => {
    for (const percent of [0, 1, 19, 40, 100, 1000]) {
      expect(RATE_BANDS).toContain(bandForPercent(percent));
    }
  });
});

describe("radiusForRides", () => {
  // **通行の下限は画面から 0 まで下げられる**ので、1走行の区画が来る。
  // **床が無いと、そこが点になって地図から見つけられない。**
  it("通行が少なくても床を下回らない", () => {
    expect(radiusForRides(1)).toBe(MIN_RADIUS_M);
    expect(radiusForRides(2)).toBe(MIN_RADIUS_M);
  });

  // **面積が通行に比例する**（半径は平方根）。ここが線形になると、
  // **2倍の場所が4倍危険に見える**（`config.ts`）。
  it("床より上では通行の平方根に比例する", () => {
    expect(radiusForRides(16)).toBeCloseTo(RADIUS_PER_SQRT_RIDE * 4);
    expect(radiusForRides(64) / radiusForRides(16)).toBeCloseTo(2);
  });

  // **セルは南北およそ 111m。**円がこれを超えると、隣の区画を覆って場所が読めなくなる。
  it("通行が多くてもセルの大きさを超えない", () => {
    expect(radiusForRides(100)).toBeLessThan(111);
  });
});
