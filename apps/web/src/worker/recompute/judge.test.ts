import { describe, expect, it } from "vitest";
import { type JudgePoint, type JudgeSign, judgeRide, type Thresholds } from "./judge";

/**
 * 合成データ。**実走行の GPS ログを使わない**（`CLAUDE.md`）。岡山駅の周辺に置いてある。
 *
 * **しきい値はテストの中で決める。**サーバーに既定値が無い（`config.ts`）ので、
 * ここの数字は `docs/interfaces/web-service.md`「しきい値の既定値」から写したものである。
 */
const THR: Thresholds = {
  stopSpeedMps: 1.5,
  radiusM: 20,
  bearingToleranceDeg: 60,
  maxHaccM: 30,
};

const SIGN_LAT = 34.6651;
const SIGN_LON = 133.9183;

const M_PER_DEG_LAT = 111_320;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((SIGN_LAT * Math.PI) / 180);

/** 標識からの相対位置（東・北、メートル）を緯度経度にする。 */
function at(eastM: number, northM: number): { lat: number; lon: number } {
  return { lat: SIGN_LAT + northM / M_PER_DEG_LAT, lon: SIGN_LON + eastM / mPerDegLon };
}

/**
 * **進入方向が南にある標識**——つまり**南から北へ走る車両**が規制の対象。
 * 進入方向の点は 25m 手前に置いてある（実測の中央値 20.8m。`docs/unverified.md` 62）。
 */
const NORTHBOUND_SIGN: JudgeSign = {
  id: "33-0001",
  lat: SIGN_LAT,
  lon: SIGN_LON,
  ...(() => {
    const a = at(0, -25);
    return { approachLat: a.lat, approachLon: a.lon };
  })(),
};

const T0 = 1_756_123_456_000;

/**
 * 走行の区間。**進むか（`to`）、その場に留まるか（`hold`）のどちらか。**
 *
 * 留まる区間を分けてあるのは、**止まっている自転車は 1Hz の測位でも同じ場所に点を出し続ける**
 * ため。位置を動かす形でしか書けないと、**「止まった」を1点でしか表せない。**
 */
type Leg = { spd: number } & ({ to: readonly [number, number] } | { hold: number });

/**
 * 折れ線の上を 1Hz で走る点列を作る。
 *
 * 区間ごとに速度を変えられるようにしてあるのは、**「標識の手前で止まったか」だけが
 * 判定を分ける**ため。位置は速度と無関係に 5m 刻みで置く（点の間隔は判定に効かない）。
 */
function ride(
  legs: readonly Leg[],
  start: readonly [number, number] = [0, -60],
  hacc = 5,
): JudgePoint[] {
  const points: JudgePoint[] = [];
  let [east, north] = start;
  let t = T0;

  const push = (e: number, n: number, spd: number) => {
    points.push({ t, ...at(e, n), spd, hacc });
    t += 1000;
  };

  push(east, north, legs[0]?.spd ?? 0);
  for (const leg of legs) {
    if ("hold" in leg) {
      for (let i = 0; i < leg.hold; i++) push(east, north, leg.spd);
      continue;
    }
    const [toE, toN] = leg.to;
    const dist = Math.hypot(toE - east, toN - north);
    const steps = Math.max(1, Math.round(dist / 5));
    for (let i = 1; i <= steps; i++) {
      push(east + ((toE - east) * i) / steps, north + ((toN - north) * i) / steps, leg.spd);
    }
    east = toE;
    north = toN;
  }

  return points;
}

describe("judgeRide", () => {
  it("止まらずに通り抜けたら不停止になる", () => {
    const points = ride([{ to: [0, 60], spd: 5 }]);

    const found = judgeRide(points, [NORTHBOUND_SIGN], THR);

    expect(found).toHaveLength(1);
    expect(found[0]?.signId).toBe("33-0001");
    // 標識に一番近づいた点の時刻が入る（走行の開始時刻ではない）。
    const closest = points.reduce((a, b) =>
      Math.abs(b.lat - SIGN_LAT) < Math.abs(a.lat - SIGN_LAT) ? b : a,
    );
    expect(found[0]?.t).toBe(closest.t);
  });

  it("半径の中で速度がしきい値を下回れば不停止にならない", () => {
    // 標識の 10m 手前まで来て 3 秒止まり、そこから走り出す。
    const points = ride([
      { to: [0, -10], spd: 5 },
      { hold: 3, spd: 0.3 },
      { to: [0, 60], spd: 5 },
    ]);

    expect(judgeRide(points, [NORTHBOUND_SIGN], THR)).toEqual([]);
  });

  it("測位の速度が跳ねても、止まった点が残っていれば不停止にしない", () => {
    const points = ride([
      { to: [0, -10], spd: 5 },
      { hold: 3, spd: 0.3 },
      { to: [0, 60], spd: 5 },
    ]);
    // 止まっている最中の1点だけが跳ねる（悪い測位は簡単に 30 m/s を出す）。
    const stopped = points.find((p) => p.spd === 0.3);
    if (stopped) stopped.spd = 32;
    // 跳ねなかった点が残っていれば足りる。
    expect(points.filter((p) => p.spd === 0.3).length).toBeGreaterThan(0);

    expect(judgeRide(points, [NORTHBOUND_SIGN], THR)).toEqual([]);
  });

  it("逆向きに走った走行は対象にしない（対向車線で濡れ衣を着せない）", () => {
    const points = ride([{ to: [0, -60], spd: 5 }], [0, 60]);

    expect(judgeRide(points, [NORTHBOUND_SIGN], THR)).toEqual([]);
  });

  it("交差する道路を走っただけでは不停止にならない", () => {
    const points = ride([{ to: [60, 0], spd: 5 }], [-60, 0]);

    expect(judgeRide(points, [NORTHBOUND_SIGN], THR)).toEqual([]);
  });

  it("進入方向が登録されていない標識は対象にしない", () => {
    const noApproach: JudgeSign = { ...NORTHBOUND_SIGN, approachLat: null, approachLon: null };
    const points = ride([{ to: [0, 60], spd: 5 }]);

    expect(judgeRide(points, [noApproach], THR)).toEqual([]);
  });

  it("半径の外を通っただけでは不停止にならない", () => {
    const points = ride([{ to: [40, 60], spd: 5 }], [40, -60]);

    expect(judgeRide(points, [NORTHBOUND_SIGN], THR)).toEqual([]);
  });

  it("精度の悪い点は判定から外す", () => {
    const points = ride([{ to: [0, 60], spd: 5 }], [0, -60], 50);

    expect(judgeRide(points, [NORTHBOUND_SIGN], THR)).toEqual([]);
    // しきい値を緩めれば同じデータで結果が変わる（これがしきい値を外に出す理由）。
    expect(judgeRide(points, [NORTHBOUND_SIGN], { ...THR, maxHaccM: 60 })).toHaveLength(1);
  });

  it("同じ標識を2度通れば2件になる（周回しても2度目が消えない）", () => {
    const points = ride([
      { to: [0, 60], spd: 5 },
      { to: [60, 60], spd: 5 },
      { to: [60, -60], spd: 5 },
      { to: [0, -60], spd: 5 },
      { to: [0, 60], spd: 5 },
    ]);

    const found = judgeRide(points, [NORTHBOUND_SIGN], THR);

    expect(found).toHaveLength(2);
    expect(found[0]?.t).toBeLessThan(found[1]?.t ?? 0);
  });

  it("しきい値を変えると同じデータで結果が変わる", () => {
    // 3.0 m/s まで落として通り抜ける。既定（1.5）では不停止、緩めれば止まった扱いになる。
    const points = ride([
      { to: [0, -10], spd: 5 },
      { to: [0, 10], spd: 2.0 },
      { to: [0, 60], spd: 5 },
    ]);

    expect(judgeRide(points, [NORTHBOUND_SIGN], THR)).toHaveLength(1);
    expect(judgeRide(points, [NORTHBOUND_SIGN], { ...THR, stopSpeedMps: 3.0 })).toEqual([]);
  });

  it("点が1つも無ければ何も出さない", () => {
    expect(judgeRide([], [NORTHBOUND_SIGN], THR)).toEqual([]);
  });
});
