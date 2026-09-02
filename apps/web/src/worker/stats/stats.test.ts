import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { StatsCellDetailResponse, StatsResponse } from "../../shared/api";
import app from "../index";

/**
 * 合成データ。**実走行の GPS ログを使わない**（`CLAUDE.md`）。岡山駅の周辺に置いてある。
 */
const DEVICE_ID = "0a1b2c3d";
const LAT = 34.6651;
const LON = 133.9183;
/** セルの代表座標（南西の角）。**応答に出るのはこの値。** */
const CELL_LAT = 34.665;
const CELL_LON = 133.918;
const T0 = 1_756_123_456_000;

beforeEach(async () => {
  // 行が残ると、実行順によって結果が変わる。
  await env.DB.exec("DELETE FROM stop_violations");
  await env.DB.exec("DELETE FROM detections");
  await env.DB.exec("DELETE FROM ride_points");
  await env.DB.exec("DELETE FROM rides");
  await env.DB.exec("DELETE FROM stop_signs");
});

/** 1点だけの走行を入れる。**セルの中で完結する**ので、通過は必ず1セルぶんになる。 */
async function seedRide(
  logId: string,
  { lat = LAT, lon = LON, sample = false, t = T0 } = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO rides (device_id, log_id, started_at, ended_at, sample) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(DEVICE_ID, logId, t, t + 1000, sample ? 1 : 0)
    .run();
  await env.DB.prepare(
    "INSERT INTO ride_points (device_id, log_id, seq, t, lat, lon, spd, crs, hacc) " +
      "VALUES (?, ?, 1, ?, ?, ?, 4.0, NULL, 5.0)",
  )
    .bind(DEVICE_ID, logId, t, lat, lon)
    .run();
}

async function seedDetection(
  logId: string,
  seq: number,
  { t = T0, tEst = false, sample = false, source = "phone", kind = "approach" } = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO detections (device_id, source, log_id, seq, kind, lv, t, t_est, sample) " +
      "VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?)",
  )
    .bind(DEVICE_ID, source, logId, seq, kind, t, tEst ? 1 : 0, sample ? 1 : 0)
    .run();
}

async function seedViolation(logId: string, signId: string, lat = LAT, lon = LON): Promise<void> {
  await env.DB.prepare("INSERT INTO stop_signs (id, pref, lat, lon) VALUES (?, 33, ?, ?)")
    .bind(signId, lat, lon)
    .run();
  await env.DB.prepare(
    "INSERT INTO stop_violations " +
      "(device_id, log_id, sign_id, t, thr_stop_speed_mps, thr_radius_m, " +
      "thr_bearing_tolerance_deg, thr_max_hacc_m) VALUES (?, ?, ?, ?, 1.5, 20, 60, 30)",
  )
    .bind(DEVICE_ID, logId, signId, T0)
    .run();
}

async function get(query: string): Promise<{ status: number; body: StatsResponse }> {
  const res = await app.request(`/api/stats/cells${query}`, {}, env);
  return { status: res.status, body: (await res.json()) as StatsResponse };
}

describe("GET /api/stats/cells", () => {
  it("走行が1つも無ければ空で返す（500 にしない）", async () => {
    const { status, body } = await get("");

    expect(status).toBe(200);
    expect(body).toMatchObject({ layer: "detection", cells: [], unlocated: 0, truncated: false });
  });

  it("検知のあった走行の率を返す", async () => {
    await seedRide("aaa00001");
    await seedRide("bbb00001");
    await seedDetection("aaa00001", 1);

    const { body } = await get("?minRides=1");

    expect(body.cells).toEqual([{ lat: CELL_LAT, lon: CELL_LON, rides: 2, hits: 1, rate: 0.5 }]);
  });

  it("通過が下限に満たないセルを順位に出さない", async () => {
    await seedRide("aaa00001");
    await seedDetection("aaa00001", 1);

    // 既定の下限は5走行。1走行しか無いので出ない（1回しか通っていない場所で率 100% になる）。
    expect((await get("")).body.cells).toEqual([]);
    expect((await get("?minRides=1")).body.cells).toHaveLength(1);
  });

  it("t_est が立った検知を地図とランキングから除く", async () => {
    await seedRide("aaa00001");
    await seedDetection("aaa00001", 1, { tEst: true, source: "device" });

    const { body } = await get("?minRides=1");

    // セル自体は通過があるので出るが、分子には入らない。
    expect(body.cells).toEqual([{ lat: CELL_LAT, lon: CELL_LON, rides: 1, hits: 0, rate: 0 }]);
  });

  it("測位点に突き合わない検知を「場所不明」として数える", async () => {
    await seedRide("aaa00001");
    await seedDetection("aaa00001", 1, { t: T0 + 60_000 });

    const { body } = await get("?minRides=1");

    expect(body.unlocated).toBe(1);
    expect(body.cells).toEqual([{ lat: CELL_LAT, lon: CELL_LON, rides: 1, hits: 0, rate: 0 }]);
  });

  it("サンプルを除くと、サンプルの走行も検知も消える", async () => {
    await seedRide("aaa00001", { sample: true });
    await seedDetection("aaa00001", 1, { sample: true });

    expect((await get("?minRides=1")).body.cells).toHaveLength(1);
    expect((await get("?minRides=1&sample=exclude")).body.cells).toEqual([]);
  });

  it("不停止は標識の位置で数える（layer=violation）", async () => {
    await seedRide("aaa00001");
    await seedRide("bbb00001");
    await seedViolation("aaa00001", "sign-1");

    const { body } = await get("?layer=violation&minRides=1");

    expect(body.layer).toBe("violation");
    expect(body.cells).toEqual([{ lat: CELL_LAT, lon: CELL_LON, rides: 2, hits: 1, rate: 0.5 }]);
    // 不停止の場所は標識から決まるので、突き合わせに失敗するものが無い。
    expect(body.unlocated).toBe(0);
  });

  it("レイヤーを混ぜない（検知は violation に出ない）", async () => {
    await seedRide("aaa00001");
    await seedDetection("aaa00001", 1);

    expect((await get("?layer=violation&minRides=1")).body.cells).toEqual([
      { lat: CELL_LAT, lon: CELL_LON, rides: 1, hits: 0, rate: 0 },
    ]);
  });

  it("標識が消えた不停止を「場所不明」として数える（黙って捨てない）", async () => {
    await seedRide("aaa00001");
    await seedViolation("aaa00001", "sign-1");
    // 標識を取り込み直して id が変わった状況。**不停止の行は残るが、位置を辿れなくなる。**
    await env.DB.exec("DELETE FROM stop_signs");

    const { body } = await get("?layer=violation&minRides=1");

    expect(body.unlocated).toBe(1);
    expect(body.cells).toEqual([{ lat: CELL_LAT, lon: CELL_LON, rides: 1, hits: 0, rate: 0 }]);
  });

  it("device_id も生の測位点も応答に出さない", async () => {
    await seedRide("aaa00001", { lat: 34.66512, lon: 133.91834 });
    await seedDetection("aaa00001", 1);

    const text = JSON.stringify((await get("?minRides=1")).body);

    expect(text).not.toContain(DEVICE_ID);
    // 生の緯度経度（小数第5位）が混ざっていないこと。出すのはセルに丸めたものだけ。
    expect(text).not.toContain("34.66512");
    expect(text).not.toContain("133.91834");
  });

  it("知らない layer は 400（500 にしない）", async () => {
    const res = await app.request("/api/stats/cells?layer=unknown", {}, env);

    expect(res.status).toBe(400);
  });
});

async function getDetail(
  query = `?lat=${CELL_LAT}&lon=${CELL_LON}`,
): Promise<{ status: number; text: string; body: StatsCellDetailResponse }> {
  const res = await app.request(`/api/stats/cell${query}`, {}, env);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as StatsCellDetailResponse };
}

describe("GET /api/stats/cell", () => {
  it("ランキングの代表座標をそのまま渡すと、そのセルの内訳が返る", async () => {
    // **代表座標はセルの南西の角**なので、渡した値をもう一度丸めて同じセルに戻る必要がある。
    // 戻らないと、順位表の行から飛んだ先が空になる。
    await seedRide("aaa00001");
    await seedDetection("aaa00001", 1);
    await seedDetection("aaa00001", 2, { kind: "rear_object", source: "device" });

    const { status, body } = await getDetail();

    expect(status).toBe(200);
    expect(body).toMatchObject({ lat: CELL_LAT, lon: CELL_LON, sample: "include" });
    expect(body.hours).toEqual([
      {
        hour: new Date(T0 + 9 * 60 * 60 * 1000).getUTCHours(),
        rides: 1,
        detections: [
          { kind: "approach", count: 1 },
          { kind: "rear_object", count: 1 },
        ],
        violations: 0,
      },
    ]);
  });

  it("セルの中のどの点を渡しても同じ内訳が返る（丸めるのはサーバー側）", async () => {
    await seedRide("aaa00001");

    const { body } = await getDetail(`?lat=${LAT}&lon=${LON}`);

    expect(body).toMatchObject({ lat: CELL_LAT, lon: CELL_LON });
    expect(body.totals.rides).toBe(1);
  });

  it("秒単位の時刻も device_id も応答に出さない", async () => {
    // **この画面だけが時刻という次元を持つ。**110m のセルと秒単位の時刻を並べると、
    // 1人の走行経路が復元できる（`docs/adr/0007-keep-raw-ride-logs.md` の前提が崩れる）。
    await seedRide("aaa00001");
    await seedDetection("aaa00001", 1);

    const { text } = await getDetail();

    expect(text).not.toContain(DEVICE_ID);
    expect(text).not.toContain(String(T0));
    expect(text).not.toContain("aaa00001");
  });

  it("`t_est` の検知も出す（地図とランキングからは消えているもの）", async () => {
    await seedRide("aaa00001");
    await seedDetection("aaa00001", 1, { tEst: true, source: "device", kind: "rear_object" });

    const { body } = await getDetail();

    expect(body.totals.detections).toEqual([{ kind: "rear_object", count: 1 }]);
    expect(body.tEstimated).toBe(1);
    // 同じデータで一覧を見ると、この検知は入っていない。
    expect((await get("?minRides=1")).body.cells[0]).toMatchObject({ hits: 0 });
  });

  it("不停止を検知と分けて出す", async () => {
    await seedRide("aaa00001");
    await seedViolation("aaa00001", "sign-1");

    const { body } = await getDetail();

    expect(body.hours[0]).toMatchObject({ detections: [], violations: 1 });
    expect(body.totals.violations).toBe(1);
  });

  it("場所不明を種別ごとに出す（一覧は数だけを返している側）", async () => {
    await seedRide("aaa00001");
    // 測位点から離れた時刻の検知＝測位が出ていない間に発火したもの。
    await seedDetection("aaa00001", 1, { t: T0 + 60_000, kind: "rear_object", source: "device" });

    const { body } = await getDetail();

    expect(body.unlocated).toEqual({
      detections: [{ kind: "rear_object", count: 1 }],
      violations: 0,
    });
  });

  it("sample=exclude でサンプルデータを除く", async () => {
    await seedRide("sss00001", { sample: true });
    await seedDetection("sss00001", 1, { sample: true });

    expect((await getDetail(`?lat=${CELL_LAT}&lon=${CELL_LON}`)).body.totals.rides).toBe(1);
    expect(
      (await getDetail(`?lat=${CELL_LAT}&lon=${CELL_LON}&sample=exclude`)).body.totals,
    ).toEqual({ rides: 0, detections: [], violations: 0 });
  });

  it("走行が1つも無いセルでも空で返す（404 にしない）", async () => {
    const { status, body } = await getDetail();

    expect(status).toBe(200);
    expect(body.hours).toEqual([]);
  });

  it("緯度経度が範囲外なら 400", async () => {
    const res = await app.request("/api/stats/cell?lat=91&lon=133.918", {}, env);

    expect(res.status).toBe(400);
  });
});
