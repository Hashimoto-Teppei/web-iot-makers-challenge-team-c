import { describe, expect, it } from "vitest";
import { bearingDeg, distanceM, normalizeAngleDeg } from "../detect/geo";
import { destination, rider } from "./node";

const LAT = 34.6617;
const LON = 133.9344;

describe("destination", () => {
  it("指定した距離だけ離れた点を返す", () => {
    const to = destination(LAT, LON, 0, 100);
    expect(distanceM(LAT, LON, to.lat, to.lon)).toBeCloseTo(100, 3);
  });

  it.each([0, 45, 90, 180, 270, 359])("方角 %i 度のとおりに進む", (deg) => {
    const to = destination(LAT, LON, deg, 200);
    // 0 度と 359.999… 度の差は 360 度ではなく 0 度。引き算のまま比べると北向きだけ落ちる。
    expect(Math.abs(normalizeAngleDeg(bearingDeg(LAT, LON, to.lat, to.lon) - deg))).toBeCloseTo(
      0,
      3,
    );
  });

  it("距離 0 なら動かない", () => {
    const to = destination(LAT, LON, 123, 0);
    expect(distanceM(LAT, LON, to.lat, to.lon)).toBeCloseTo(0, 6);
  });
});

describe("rider", () => {
  const straight = rider({
    id: "a1000001",
    lat: LAT,
    lon: LON,
    legs: [{ durationMs: 10_000, bearingDeg: 0, speedMps: 5 }],
  });

  it("等速の区間は 速度 × 時間 だけ進む", () => {
    const at10s = straight.at(10_000);
    expect(distanceM(LAT, LON, at10s.lat, at10s.lon)).toBeCloseTo(50, 1);
  });

  it("同じ時刻を何度渡しても同じ位置を返す（状態を持たない）", () => {
    expect(straight.at(4_000)).toEqual(straight.at(4_000));
  });

  it("ティックを飛ばしても結果が変わらない", () => {
    // 1 秒刻みで見ても 10 秒を一息に見ても、同じ位置に居ること。
    expect(straight.at(7_000)).toEqual(straight.at(7_000));
    expect(distanceM(LAT, LON, straight.at(7_000).lat, straight.at(7_000).lon)).toBeCloseTo(35, 1);
  });

  it("最後の区間は指定の長さを過ぎても延長される", () => {
    // ここで止めると、シナリオの終わり際に起きていない急ブレーキが検知に見える。
    const at20s = straight.at(20_000);
    expect(at20s.spd).toBe(5);
    expect(distanceM(LAT, LON, at20s.lat, at20s.lon)).toBeCloseTo(100, 1);
  });

  it("区間をつなぐと途中で曲がる", () => {
    const turning = rider({
      id: "a1000001",
      lat: LAT,
      lon: LON,
      legs: [
        { durationMs: 10_000, bearingDeg: 0, speedMps: 5 },
        { durationMs: 10_000, bearingDeg: 90, speedMps: 5 },
      ],
    });
    expect(turning.at(9_999).crs).toBe(0);
    // 区間の長さちょうどで次の区間に入る（そこが次の区間の 0 秒目）。
    expect(turning.at(10_000).crs).toBe(90);

    const corner = turning.at(10_000);
    const at15s = turning.at(15_000);
    expect(bearingDeg(corner.lat, corner.lon, at15s.lat, at15s.lon)).toBeCloseTo(90, 1);
    expect(distanceM(corner.lat, corner.lon, at15s.lat, at15s.lon)).toBeCloseTo(25, 1);
  });

  describe("減速", () => {
    const braking = rider({
      id: "b2000002",
      lat: LAT,
      lon: LON,
      legs: [
        { durationMs: 2_000, bearingDeg: 0, speedMps: 6, endSpeedMps: 0 },
        { durationMs: 5_000, bearingDeg: 0, speedMps: 0 },
      ],
    });

    it("速度が線形に落ちる（階段状にしない）", () => {
      expect(braking.at(0).spd).toBe(6);
      expect(braking.at(1_000).spd).toBeCloseTo(3, 6);
      expect(braking.at(2_000).spd).toBe(0);
    });

    it("止まったあとは進まない", () => {
      const stopped = braking.at(2_000);
      const later = braking.at(7_000);
      expect(distanceM(stopped.lat, stopped.lon, later.lat, later.lon)).toBeCloseTo(0, 6);
    });

    it("減速中に進む距離は平均速度ぶん", () => {
      // 6 → 0 に 2 秒なので (6+0)/2 × 2 = 6m。
      const at2s = braking.at(2_000);
      expect(distanceM(LAT, LON, at2s.lat, at2s.lon)).toBeCloseTo(6, 2);
    });

    it("速度が落ちると crs が null になる（測位がそう振る舞う）", () => {
      // 止まっている自転車の進行方角は測位では決まらない。捨てないのは受信側の責務。
      expect(braking.at(0).crs).toBe(0);
      expect(braking.at(2_000).crs).toBeNull();
    });
  });

  it("区間の無い台は作れない", () => {
    expect(() => rider({ id: "a1000001", lat: LAT, lon: LON, legs: [] })).toThrow();
  });

  it("長さ 0 の区間は作れない（速度が NaN になり、その台が黙って消える）", () => {
    expect(() =>
      rider({
        id: "a1000001",
        lat: LAT,
        lon: LON,
        legs: [{ durationMs: 0, bearingDeg: 0, speedMps: 5, endSpeedMps: 0 }],
      }),
    ).toThrow();
  });
});
