import { describe, expect, it } from "vitest";
import { cellOf, cellRange, sameCell } from "./cell";

describe("cellOf", () => {
  it("小数第3位で切り捨てる", () => {
    expect(cellOf(34.6612, 133.9345)).toEqual({ lat: 34661, lon: 133934 });
  });

  it("四捨五入しない（第4位が 9 でも繰り上がらない）", () => {
    expect(cellOf(34.66119, 133.93459)).toEqual({ lat: 34661, lon: 133934 });
  });

  it("同じセルの中の2点は同じセルになる", () => {
    // 岡山では 1 セルがおよそ 111m × 92m。その内側で動いても引き直さない。
    expect(sameCell(cellOf(34.661, 133.934), cellOf(34.6619, 133.9349))).toBe(true);
  });

  it("セルをまたぐと別のセルになる", () => {
    expect(sameCell(cellOf(34.6619, 133.934), cellOf(34.662, 133.934))).toBe(false);
  });

  it("負の座標でも南西へ寄せる（0 方向へ丸めない）", () => {
    // 日本国内では起きないが、切り方の定義に曖昧さを残さないための確認。
    expect(cellOf(-0.0001, -0.0001)).toEqual({ lat: -1, lon: -1 });
  });
});

describe("cellRange", () => {
  it("自セルを中心に前後1セルずつを含む", () => {
    expect(cellRange({ lat: 34661, lon: 133934 })).toEqual({
      latMin: 34660,
      latMax: 34662,
      lonMin: 133933,
      lonMax: 133935,
    });
  });
});
