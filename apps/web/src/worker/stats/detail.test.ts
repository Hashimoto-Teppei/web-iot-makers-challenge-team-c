import { describe, expect, it } from "vitest";
import type { DetectionRow, LocatedDetection, LocatedEvent, RidePoint } from "./aggregate";
import { aggregateCellDetail, type CellDetailInput, hourOfDay } from "./detail";

/**
 * 合成データだけで回す（`CLAUDE.md`「実機なしで開発する」）。
 * 岡山駅の周辺に置いてあるが、**実走行の GPS ログではない。**
 */
const LAT = 34.6651;
const LON = 133.9183;
/** セル1つぶんの緯度の差。**隣のセル**を作るのに使う。 */
const CELL = 0.001;
/** 日本時間 2026-08-25 (火) 17:24:16。**時間帯は 17 時台**になる。 */
const T0 = 1_756_110_256_000;
const HOUR = 60 * 60 * 1_000;

const point = (logId: string, t = T0, lat = LAT, lon = LON): RidePoint => ({
  deviceId: "0a1b2c3d",
  logId,
  t,
  lat,
  lon,
});

const detection = (
  kind: string,
  t = T0,
  over: Partial<LocatedDetection> = {},
): LocatedDetection => ({
  deviceId: "0a1b2c3d",
  logId: "aaa00001",
  lat: LAT,
  lon: LON,
  t,
  kind,
  tEst: false,
  ...over,
});

const violation = (logId = "aaa00001", t = T0, lat = LAT, lon = LON): LocatedEvent => ({
  deviceId: "0a1b2c3d",
  logId,
  lat,
  lon,
  t,
});

const run = (over: Partial<CellDetailInput> = {}) =>
  aggregateCellDetail({
    // 岡山駅のセル（南西の角は 34.665, 133.918）。
    cell: { lat: 34_665, lon: 133_918 },
    points: [],
    detections: [],
    violations: [],
    unlocatedDetections: [],
    unlocatedViolations: 0,
    ...over,
  });

describe("hourOfDay", () => {
  it("日本時間で切る（UTC のままだと通勤時間帯が前日の23時台に出る）", () => {
    expect(hourOfDay(T0)).toBe(17);
    // UTC では 8:24。**9時間足さないと 8 が返る。**
    expect(new Date(T0).getUTCHours()).toBe(8);
  });

  it("日付をまたいでも 0〜23 に収まる", () => {
    // 日本時間 24 時 = 翌日の 0 時台。
    expect(hourOfDay(T0 + 7 * HOUR)).toBe(0);
    expect(hourOfDay(T0 + 8 * HOUR)).toBe(1);
  });
});

describe("aggregateCellDetail", () => {
  it("時間帯ごとに、検知の件数を種別別に、通過を走行の数で出す", () => {
    const result = run({
      points: [point("aaa00001"), point("aaa00001", T0 + 1000), point("bbb00001")],
      detections: [detection("approach"), detection("rear_object"), detection("approach")],
    });

    expect(result.hours).toEqual([
      {
        hour: 17,
        // **同じ走行が2点あっても通過は1つ。**別の走行が1つで、合わせて2。
        rides: 2,
        // **検知は件数で数える**（走行の数ではない）。**多い順。**
        detections: [
          { kind: "approach", count: 2 },
          { kind: "rear_object", count: 1 },
        ],
        violations: 0,
      },
    ]);
  });

  it("代表座標は南西の角（中心ではない）", () => {
    expect(run()).toMatchObject({ lat: 34.665, lon: 133.918 });
  });

  it("セルの外の測位点・検知・不停止を数えない", () => {
    const result = run({
      points: [point("aaa00001", T0, LAT + CELL)],
      detections: [detection("approach", T0, { lat: LAT + CELL })],
      violations: [violation("aaa00001", T0, LAT + CELL)],
    });

    expect(result.hours).toEqual([]);
    expect(result.totals).toEqual({ rides: 0, detections: [], violations: 0 });
  });

  it("何も無かった時間帯は返さない（0 の並ぶ表にしない）", () => {
    const result = run({
      points: [point("aaa00001"), point("aaa00001", T0 + 2 * HOUR)],
    });

    expect(result.hours.map((hour) => hour.hour)).toEqual([17, 19]);
  });

  it("時間帯は昇順に並ぶ（入ってきた順に左右されない）", () => {
    const result = run({
      points: [point("aaa00001", T0 + 8 * HOUR), point("bbb00001", T0)],
    });

    expect(result.hours.map((hour) => hour.hour)).toEqual([1, 17]);
  });

  it("不停止は検知と混ぜない", () => {
    const result = run({
      points: [point("aaa00001")],
      detections: [detection("approach")],
      violations: [violation()],
    });

    expect(result.hours[0]).toMatchObject({
      detections: [{ kind: "approach", count: 1 }],
      violations: 1,
    });
  });

  it("不停止のあった走行は、そのセルの通過にも入る", () => {
    // 不停止の場所は標識の位置で決まるので、走行の測位点が隣のセルに落ちていることがある。
    // 足さないと「通過 0 なのに不停止 1」という行ができる。
    const result = run({
      points: [point("aaa00001", T0, LAT + CELL)],
      violations: [violation()],
    });

    expect(result.hours[0]).toMatchObject({ hour: 17, rides: 1, violations: 1 });
  });

  it("`t_est` の検知も出す（ただし件数を別に返す）", () => {
    // 地図とランキングはこれを除いている。数を返さないと、2つの画面の件数が
    // 理由の分からないまま食い違う。
    const result = run({
      points: [point("aaa00001")],
      detections: [detection("approach"), detection("rear_object", T0, { tEst: true })],
    });

    expect(result.totals.detections).toEqual([
      { kind: "approach", count: 1 },
      { kind: "rear_object", count: 1 },
    ]);
    expect(result.tEstimated).toBe(1);
  });

  it("合計の通過は時間帯の足し算ではない（またいだ走行を二重に数えない）", () => {
    const result = run({
      points: [point("aaa00001"), point("aaa00001", T0 + HOUR)],
    });

    expect(result.hours.map((hour) => hour.rides)).toEqual([1, 1]);
    expect(result.totals.rides).toBe(1);
  });

  it("場所不明を種別ごとに返す（このセルの話ではなく全体の数）", () => {
    const unlocated: DetectionRow[] = [
      { deviceId: "0a1b2c3d", t: T0, kind: "rear_object", tEst: true },
      { deviceId: "0a1b2c3d", t: T0, kind: "rear_object", tEst: false },
      { deviceId: "0a1b2c3d", t: T0, kind: "approach", tEst: false },
    ];

    const result = run({ unlocatedDetections: unlocated, unlocatedViolations: 2 });

    expect(result.unlocated).toEqual({
      detections: [
        { kind: "rear_object", count: 2 },
        { kind: "approach", count: 1 },
      ],
      violations: 2,
    });
  });

  it("同数の種別は kind の順で決め切る（叩くたびに並びが変わらない）", () => {
    const result = run({
      points: [point("aaa00001")],
      detections: [detection("stop"), detection("approach"), detection("brake")],
    });

    expect(result.totals.detections.map((count) => count.kind)).toEqual([
      "approach",
      "brake",
      "stop",
    ]);
  });
});
