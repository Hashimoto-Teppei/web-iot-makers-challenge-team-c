import { describe, expect, it } from "vitest";
import {
  aggregateCells,
  type DetectionRow,
  type LocatedEvent,
  matchDetections,
  type RidePoint,
} from "./aggregate";
import type { StatsLimits } from "./config";

/**
 * 合成データだけで回す（`CLAUDE.md`「実機なしで開発する」）。
 * 岡山駅の周辺に置いてあるが、**実走行の GPS ログではない。**
 */
const LAT = 34.6651;
const LON = 133.9183;
/** セル1つぶんの緯度の差。**同じセルに入らない別の場所**を作るのに使う。 */
const CELL = 0.001;
const T0 = 1_756_123_456_000;

const point = (logId: string, t: number, lat = LAT, lon = LON): RidePoint => ({
  deviceId: "0a1b2c3d",
  logId,
  t,
  lat,
  lon,
});

/** 検知1つ。**種別と `t_est` は詳細画面（#87）が使うもの**で、ここの数え方には効かない。 */
const detection = (t: number, over: Partial<DetectionRow> = {}): DetectionRow => ({
  deviceId: "0a1b2c3d",
  t,
  kind: "approach",
  tEst: false,
  ...over,
});

/** 場所が決まった出来事1つ。 */
const event = (logId: string, lat = LAT, lon = LON, t = T0): LocatedEvent => ({
  deviceId: "0a1b2c3d",
  logId,
  lat,
  lon,
  t,
});

const limits = (over: Partial<StatsLimits> = {}): StatsLimits => ({
  minRides: 1,
  maxCells: 100,
  ...over,
});

describe("matchDetections", () => {
  it("時刻が一番近い測位点の場所と走行を採る", () => {
    const points = [point("aaa00001", T0, LAT), point("aaa00001", T0 + 1000, LAT + CELL)];

    const { located, unlocated } = matchDetections(points, [detection(T0 + 900)], 5_000);

    expect(unlocated).toEqual([]);
    expect(located).toEqual([
      {
        deviceId: "0a1b2c3d",
        logId: "aaa00001",
        lat: LAT + CELL,
        lon: LON,
        // **時刻は検知のもの**（突き合わせた点の T0 + 1000 ではない）。
        t: T0 + 900,
        kind: "approach",
        tEst: false,
      },
    ]);
  });

  it("検知が持つ log_id を見ない（走行は当たった測位点の側から決まる）", () => {
    // デバイス発の log_id は電源を入れ直すと変わり、走行と1対1で対応しない。
    const points = [point("aaa00002", T0)];

    const { located } = matchDetections(points, [detection(T0)], 5_000);

    expect(located[0]?.logId).toBe("aaa00002");
  });

  it("離れすぎた検知は「場所不明」として残す（黙って捨てない）", () => {
    const points = [point("aaa00001", T0)];

    const { located, unlocated } = matchDetections(points, [detection(T0 + 30_000)], 5_000);

    expect(located).toEqual([]);
    // **行のまま残す。**詳細画面（#87）が種別ごとの内訳を出すため。
    expect(unlocated).toEqual([detection(T0 + 30_000)]);
  });

  it("測位点が1つも無い端末の検知も「場所不明」になる", () => {
    const detections: DetectionRow[] = [detection(T0, { deviceId: "ffffffff" })];

    expect(matchDetections([point("aaa00001", T0)], detections, 5_000)).toEqual({
      located: [],
      unlocated: detections,
    });
  });

  it("端末をまたいで突き合わせない", () => {
    // 他人の測位点に自分の検知が付くと、走っていない場所の率が上がる。
    const points = [{ ...point("aaa00001", T0), deviceId: "11111111" }];

    expect(
      matchDetections(points, [detection(T0, { deviceId: "22222222" })], 5_000).unlocated,
    ).toHaveLength(1);
  });

  it("前後で同じだけ離れていれば手前の点を採る（並び順で結果が変わらない）", () => {
    const points = [point("aaa00001", T0, LAT), point("aaa00001", T0 + 2000, LAT + CELL)];

    const { located } = matchDetections(points, [detection(T0 + 1000)], 5_000);

    expect(located[0]?.lat).toBe(LAT);
  });
});

describe("aggregateCells", () => {
  it("率は走行の数で数える（件数では数えない）", () => {
    // 同じ走行が同じセルで8件出しても、率は 1/2（2走行のうち1走行）にとどまる。
    // 件数で数えると 800% になり、順位が「そこで何秒詰まったか」の順位になる。
    const points = [point("aaa00001", T0), point("bbb00001", T0)];
    const events: LocatedEvent[] = Array.from({ length: 8 }, () => event("aaa00001"));

    const { cells } = aggregateCells(points, events, limits());

    expect(cells).toEqual([{ lat: 34.665, lon: 133.918, rides: 2, hits: 1, rate: 0.5 }]);
  });

  it("同じ走行が同じセルを何度通っても、通過は1つ", () => {
    const points = [point("aaa00001", T0), point("aaa00001", T0 + 1000)];

    expect(aggregateCells(points, [], limits()).cells).toEqual([
      { lat: 34.665, lon: 133.918, rides: 1, hits: 0, rate: 0 },
    ]);
  });

  it("通過が下限に満たないセルを出さない", () => {
    const points = [point("aaa00001", T0), point("bbb00001", T0)];

    expect(aggregateCells(points, [], limits({ minRides: 3 })).cells).toEqual([]);
    expect(aggregateCells(points, [], limits({ minRides: 2 })).cells).toHaveLength(1);
  });

  it("出来事のあった走行は分母にも入る（率が 100% を超えない）", () => {
    // 不停止の場所は標識の位置で決まるので、その走行の測位点が隣のセルに落ちていることがある。
    const points = [point("aaa00001", T0, LAT + CELL)];
    const events: LocatedEvent[] = [event("aaa00001")];

    const { cells } = aggregateCells(points, events, limits());

    expect(cells.every((cell) => cell.rate <= 1)).toBe(true);
    expect(cells.find((cell) => cell.lat === 34.665)).toMatchObject({ rides: 1, hits: 1, rate: 1 });
  });

  it("率の高い順に並ぶ。同率なら通過の多い順（叩くたびに並びが変わらない）", () => {
    const points = [
      // 危ないセル: 2走行のうち1走行で検知（率 0.5、通過 2）
      point("aaa00001", T0, LAT),
      point("bbb00001", T0, LAT),
      // 同率で通過が多いセル: 4走行のうち2走行（率 0.5、通過 4）
      ...["a", "b", "c", "d"].map((n) => point(`${n}bb00002`, T0, LAT + CELL)),
    ];
    const events: LocatedEvent[] = [
      event("aaa00001"),
      event("abb00002", LAT + CELL),
      event("bbb00002", LAT + CELL),
    ];

    const { cells } = aggregateCells(points, events, limits());

    expect(cells.map((cell) => cell.rides)).toEqual([4, 2]);
  });

  it("上限で打ち切ったことを truncated で伝える（黙って切らない）", () => {
    const points = ["a", "b", "c"].map((n, i) => point(`${n}aa00001`, T0, LAT + i * CELL));

    const { cells, truncated } = aggregateCells(points, [], limits({ maxCells: 2 }));

    expect(cells).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("上限に達していなければ truncated は false", () => {
    const points = [point("aaa00001", T0)];

    expect(aggregateCells(points, [], limits({ maxCells: 1 })).truncated).toBe(false);
  });

  it("代表座標は南西の角（中心ではない）", () => {
    const { cells } = aggregateCells([point("aaa00001", T0, 34.66599, 133.91899)], [], limits());

    expect(cells[0]).toMatchObject({ lat: 34.665, lon: 133.918 });
  });
});
