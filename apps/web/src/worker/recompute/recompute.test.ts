import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../index";
import type { RecomputeRequest, RecomputeResponse } from "./request";

/** `vitest.config.ts` の miniflare バインディングに合わせた値。**実物とは関係がない。** */
const TOKEN = "test-admin-token";

const DEVICE_ID = "0a1b2c3d";
const LOG_ID = "9a1c0000";

/**
 * 合成データ。**実走行の GPS ログを使わない**（`CLAUDE.md`）。岡山駅の周辺に置いてある。
 *
 * **しきい値はここで決める。**サーバーに既定値が無い（`recompute/config.ts`）ので、
 * `docs/interfaces/web-stats.md`「しきい値の既定値」から写している。
 */
const THRESHOLDS: RecomputeRequest["thresholds"] = {
  stopSpeedMps: 1.5,
  radiusM: 20,
  bearingToleranceDeg: 60,
  maxHaccM: 30,
};

const SIGN_LAT = 34.6651;
const SIGN_LON = 133.9183;
const M_PER_DEG_LAT = 111_320;

/** 標識から北へ `northM` メートルの緯度。（経度は動かさないので、走行は真南北になる） */
const latAt = (northM: number): number => SIGN_LAT + northM / M_PER_DEG_LAT;

const T0 = 1_756_123_456_000;

async function post(body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return app.request(
    "/api/admin/recompute",
    { method: "POST", headers, body: JSON.stringify(body) },
    env,
  );
}

/** 南から北へ、5m 刻み・1Hz で走る走行を1つ入れる。`spd` は全点に同じ値を入れる。 */
async function seedRide(spd: number, hacc = 5, logId = LOG_ID, startedAt = T0): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO rides (device_id, log_id, started_at, ended_at) VALUES (?, ?, ?, ?)",
  )
    .bind(DEVICE_ID, logId, startedAt, startedAt + 24_000)
    .run();

  const statements = [];
  for (let i = 0; i <= 24; i++) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO ride_points (device_id, log_id, seq, t, lat, lon, spd, crs, hacc) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
      ).bind(
        DEVICE_ID,
        logId,
        i + 1,
        startedAt + i * 1000,
        latAt(-60 + i * 5),
        SIGN_LON,
        spd,
        hacc,
      ),
    );
  }
  await env.DB.batch(statements);
}

/** 16進8文字の走行の識別子を、番号から作る。 */
const logIdOf = (n: number): string => `9a1c${n.toString(16).padStart(4, "0")}`;

/** 南から進入する（＝北へ走る車両が対象の）標識を1つ入れる。 */
async function seedSign(id = "33-0001"): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO stop_signs (id, pref, lat, lon, approach_lat, approach_lon) VALUES (?, 33, ?, ?, ?, ?)",
  )
    .bind(id, SIGN_LAT, SIGN_LON, latAt(-25), SIGN_LON)
    .run();
}

async function countViolations(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM stop_violations").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  for (const table of ["rides", "ride_points", "detections", "stop_violations", "stop_signs"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("POST /api/admin/recompute", () => {
  it("止まらずに通り抜けた走行から stop_violations に行ができる", async () => {
    await seedSign();
    await seedRide(5);

    const res = await post({ thresholds: THRESHOLDS });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RecomputeResponse;
    expect(body.computed).toEqual({ rides: 1, points: 25, violations: 1, more: false });
    // **どの設定の結果を見ているかが応答だけで分かること。**
    expect(body.thresholds).toEqual(THRESHOLDS);

    const row = await env.DB.prepare("SELECT * FROM stop_violations").first<{
      device_id: string;
      log_id: string;
      sign_id: string;
      thr_stop_speed_mps: number;
      thr_max_hacc_m: number;
    }>();
    expect(row?.device_id).toBe(DEVICE_ID);
    expect(row?.log_id).toBe(LOG_ID);
    expect(row?.sign_id).toBe("33-0001");
    // **判定に使ったしきい値が行に残っていること**（`db/schema.ts`）。
    expect(row?.thr_stop_speed_mps).toBe(1.5);
    expect(row?.thr_max_hacc_m).toBe(30);
  });

  it("同じ走行を2回叩いても行が増えない（置き換わる）", async () => {
    await seedSign();
    await seedRide(5);

    await post({ thresholds: THRESHOLDS });
    await post({ thresholds: THRESHOLDS });

    expect(await countViolations()).toBe(1);
  });

  it("しきい値を変えて叩き直すと、同じデータで結果が変わる", async () => {
    await seedSign();
    await seedRide(5);

    await post({ thresholds: THRESHOLDS });
    expect(await countViolations()).toBe(1);

    // 5 m/s を「停止」と見なせば、同じ走行が不停止でなくなる。
    // **前回の行が残らないこと**——追記なら 1 件のまま残ってしまう。
    const res = await post({ thresholds: { ...THRESHOLDS, stopSpeedMps: 6 } });

    expect(res.status).toBe(200);
    expect(await countViolations()).toBe(0);
  });

  it("止まった走行では行ができない", async () => {
    await seedSign();
    await seedRide(0.4);

    await post({ thresholds: THRESHOLDS });

    expect(await countViolations()).toBe(0);
  });

  it("rides で対象を指定できる（指定しなかった走行の行は触らない）", async () => {
    await seedSign();
    await seedRide(5);
    await post({ thresholds: THRESHOLDS });
    expect(await countViolations()).toBe(1);

    // 別の走行だけを指定して叩く。**既にある走行の行は消えない。**
    const res = await post({
      thresholds: THRESHOLDS,
      rides: [{ deviceId: DEVICE_ID, logId: "9a1c0001" }],
    });

    expect(res.status).toBe(200);
    expect((await res.json<RecomputeResponse>()).computed.rides).toBe(1);
    expect(await countViolations()).toBe(1);
  });

  it("トークンなしで叩くと 401 が返り、D1 に何も入らない", async () => {
    await seedSign();
    await seedRide(5);

    const res = await post({ thresholds: THRESHOLDS }, null);

    expect(res.status).toBe(401);
    expect(await countViolations()).toBe(0);
  });

  it("違うトークンでも 401", async () => {
    await seedSign();
    await seedRide(5);

    const res = await post({ thresholds: THRESHOLDS }, "wrong-token");

    expect(res.status).toBe(401);
    expect(await countViolations()).toBe(0);
  });

  // **認証を検証より先に置いてある。**あとにすると、トークンを持たない相手に
  // 「リクエストの形は合っている」を教えることになる。
  it("形が壊れていても、トークンが無ければ 401（400 ではない）", async () => {
    const res = await post({ thresholds: { stopSpeedMps: "はやい" } }, null);

    expect(res.status).toBe(401);
  });

  it("しきい値が欠けていたら 400", async () => {
    const res = await post({ thresholds: { stopSpeedMps: 1.5 } });

    expect(res.status).toBe(400);
  });

  it("しきい値そのものを省略したら 400（サーバーの既定値で埋めない）", async () => {
    const res = await post({});

    expect(res.status).toBe(400);
  });

  it("標識が無ければ何も起きない（走行だけがある状態で落ちない）", async () => {
    await seedRide(5);

    const res = await post({ thresholds: THRESHOLDS });

    expect(res.status).toBe(200);
    expect(await countViolations()).toBe(0);
  });

  // 同じ走行が2度入っていると、**同じ判定を2度書き込む。**`DELETE` は1回しか効かず、
  // この表は代理キーを持つので、重複がそのまま残る。
  it("rides に同じ走行が2度入っていても行は増えない", async () => {
    await seedSign();
    await seedRide(5);

    const res = await post({
      thresholds: THRESHOLDS,
      rides: [
        { deviceId: DEVICE_ID, logId: LOG_ID },
        { deviceId: DEVICE_ID, logId: LOG_ID },
      ],
    });

    expect(res.status).toBe(200);
    expect((await res.json<RecomputeResponse>()).computed.rides).toBe(1);
    expect(await countViolations()).toBe(1);
  });

  it("rides が上限を超えたら「多すぎる」と分かる 400 が返る", async () => {
    const res = await post({
      thresholds: THRESHOLDS,
      rides: Array.from({ length: 21 }, (_, i) => ({ deviceId: DEVICE_ID, logId: logIdOf(i) })),
    });

    expect(res.status).toBe(400);
    // **「形が違う」と混ぜない。**分けて叩き直せば入ることが読めること。
    expect(((await res.json()) as { error: string }).error).toContain("多すぎ");
  });

  it("rides と skip は混ぜられない", async () => {
    const res = await post({
      thresholds: THRESHOLDS,
      rides: [{ deviceId: DEVICE_ID, logId: LOG_ID }],
      skip: 1,
    });

    expect(res.status).toBe(400);
  });

  // **上限を超えても、全走行の経路が使えなくなってはいけない。**
  // 走行は増え続けるので、突き返すだけだと 21 本目が入った時点で詰む。
  it("上限を超える走行があっても、skip で最後まで計算できる", async () => {
    await seedSign();
    // 上限（20）+ 2 走行。開始時刻をずらして並びを決める。
    for (let i = 0; i < 22; i++) await seedRide(5, 5, logIdOf(i), T0 + i * 100_000);

    const first = await post({ thresholds: THRESHOLDS });
    const firstBody = await first.json<RecomputeResponse>();
    expect(firstBody.computed.rides).toBe(20);
    expect(firstBody.computed.more).toBe(true);

    const second = await post({ thresholds: THRESHOLDS, skip: 20 });
    const secondBody = await second.json<RecomputeResponse>();
    expect(secondBody.computed.rides).toBe(2);
    // **続きが無いことが分かること**——分からないと、いつまで叩けばよいか決められない。
    expect(secondBody.computed.more).toBe(false);

    // 22 走行すべてに1件ずつ。**飛ばされた走行が残っていないこと。**
    expect(await countViolations()).toBe(22);
  });

  it("走行が1つも無くても 200 を返す", async () => {
    const res = await post({ thresholds: THRESHOLDS });

    expect(res.status).toBe(200);
    expect((await res.json<RecomputeResponse>()).computed).toEqual({
      rides: 0,
      points: 0,
      violations: 0,
      more: false,
    });
  });
});
