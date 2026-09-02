import { describe, expect, it } from "vitest";
import { cellCenter, cellCorner, cellKey, cellOf } from "./cell";

describe("cellOf", () => {
  it("小数第3位で切り捨てる", () => {
    expect(cellOf(34.6651, 133.9183)).toEqual({ lat: 34665, lon: 133918 });
  });

  it("四捨五入しない（第4位が 9 でも繰り上がらない）", () => {
    // 四捨五入と混ぜるとセルの境界が半セルずれ、地図の円とランキングが別のセルを指す。
    expect(cellOf(34.66599, 133.91899)).toEqual({ lat: 34665, lon: 133918 });
  });

  it("負の座標でも南西へ寄せる（0 方向へ丸めない）", () => {
    // 日本国内では起きないが、切り方の定義に曖昧さを残さないための境界。
    expect(cellOf(-34.6651, -133.9183)).toEqual({ lat: -34666, lon: -133919 });
  });
});

describe("cellCorner / cellCenter", () => {
  it("代表座標はセルの南西の角", () => {
    expect(cellCorner({ lat: 34665, lon: 133918 })).toEqual({ lat: 34.665, lon: 133.918 });
  });

  it("中心は角から半セル（緯度 +0.0005 / 経度 +0.0005）", () => {
    // 足し忘れると、円が実際の場所から南へ 55m・西へ 46m ずれる。
    const center = cellCenter({ lat: 34665, lon: 133918 });
    expect(center.lat).toBeCloseTo(34.6655, 10);
    expect(center.lon).toBeCloseTo(133.9185, 10);
  });

  it("中心はそのセルの中に入っている", () => {
    const cell = cellOf(34.6651, 133.9183);
    expect(cellOf(cellCenter(cell).lat, cellCenter(cell).lon)).toEqual(cell);
  });
});

describe("cellKey", () => {
  it("違うセルは違う鍵になる（緯度と経度が混ざらない）", () => {
    expect(cellKey({ lat: 34665, lon: 133918 })).not.toBe(cellKey({ lat: 133918, lon: 34665 }));
  });
});
