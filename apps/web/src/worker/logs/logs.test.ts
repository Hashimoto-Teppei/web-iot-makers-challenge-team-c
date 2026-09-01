import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../index";
import type { LogsRequest, LogsResponse } from "./request";

const DEVICE_ID = "0a1b2c3d";
const LOG_ID = "9a1c0000";

/** 合成データ。**実走行の GPS ログを使わない**（`CLAUDE.md`）。岡山駅の周辺に置いてある。 */
const BODY: LogsRequest = {
  deviceId: DEVICE_ID,
  rides: [{ logId: LOG_ID, startedAt: 1_756_123_456_000, endedAt: 1_756_123_460_000 }],
  points: [
    {
      logId: LOG_ID,
      seq: 1,
      t: 1_756_123_456_000,
      lat: 34.6651,
      lon: 133.9183,
      spd: 4.2,
      crs: 91.5,
      hacc: 5,
    },
    {
      logId: LOG_ID,
      seq: 2,
      t: 1_756_123_457_000,
      lat: 34.6652,
      lon: 133.9185,
      // 止まっていて向きが分からない点。**捨てないこと**——不停止の判定が一番見たい点である。
      spd: 0.3,
      crs: null,
      hacc: 4,
    },
  ],
  detections: [
    { source: "phone", logId: LOG_ID, seq: 1, t: 1_756_123_457_500, kind: "stop", lv: 2 },
    {
      source: "device",
      logId: "c3f10001",
      seq: 941,
      t: 1_756_123_458_000,
      kind: "rear_object",
      lv: 3,
      tEst: true,
    },
  ],
};

async function post(body: unknown): Promise<Response> {
  return app.request(
    "/api/logs",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

async function countOf(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  for (const table of ["rides", "ride_points", "detections", "stop_violations"]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("POST /api/logs", () => {
  it("配列を送ると D1 に行が増える", async () => {
    const res = await post(BODY);

    expect(res.status).toBe(201);
    expect((await res.json<LogsResponse>()).received).toEqual({
      rides: 1,
      points: 2,
      detections: 2,
    });
    expect(await countOf("rides")).toBe(1);
    expect(await countOf("ride_points")).toBe(2);
    expect(await countOf("detections")).toBe(2);
  });

  it("同じものを2回送っても件数が増えない（冪等）", async () => {
    // **重複は例外ではなく通常運転**である（BLE の転送は切れて取り直す。
    // `docs/interfaces/ble-log-transfer.md`）。増えると率も順位も意味を持たない。
    await post(BODY);
    const second = await post(BODY);

    expect(second.status).toBe(201);
    // **2回目も受け取った件数を返す。**0 件を返すと、送り直したスマホが
    // 「入っていない」と判断して送り続ける。
    expect((await second.json<LogsResponse>()).received.points).toBe(2);
    expect(await countOf("rides")).toBe(1);
    expect(await countOf("ride_points")).toBe(2);
    expect(await countOf("detections")).toBe(2);
  });

  it("同じキーで送り直しても、既にある行を上書きしない", async () => {
    await post(BODY);

    await post({
      ...BODY,
      points: [{ ...BODY.points[0], lat: 0, lon: 0, spd: 99 }],
    });

    const row = await env.DB.prepare(
      "SELECT lat, spd FROM ride_points WHERE device_id = ? AND log_id = ? AND seq = 1",
    )
      .bind(DEVICE_ID, LOG_ID)
      .first<{ lat: number; spd: number }>();
    // 認証が無いので、上書きにすると他人の走行を消せてしまう
    // （`docs/interfaces/web-service.md`「割り切っていること」）。
    expect(row?.lat).toBe(34.6651);
    expect(row?.spd).toBe(4.2);
  });

  it("スマホ発とデバイス発が同じ (log_id, seq) でも別の行として入る", async () => {
    // `source` をキーに入れていないと、片方が黙って消える。
    await post({
      ...BODY,
      points: [],
      detections: [
        { source: "phone", logId: LOG_ID, seq: 1, t: 1, kind: "approach", lv: 1 },
        { source: "device", logId: LOG_ID, seq: 1, t: 2, kind: "rear_object", lv: 1 },
      ],
    });

    expect(await countOf("detections")).toBe(2);
  });

  it("方角の無い測位を NULL のまま入れる（0＝真北にしない）", async () => {
    await post(BODY);

    const row = await env.DB.prepare(
      "SELECT crs FROM ride_points WHERE device_id = ? AND log_id = ? AND seq = 2",
    )
      .bind(DEVICE_ID, LOG_ID)
      .first<{ crs: number | null }>();
    expect(row?.crs).toBeNull();
  });

  it("デバイス発の推定した時刻に t_est が立つ", async () => {
    await post(BODY);

    const row = await env.DB.prepare("SELECT t_est FROM detections WHERE source = 'device'").first<{
      t_est: number;
    }>();
    // 立っている検知は地図とランキングから除かれる（`docs/interfaces/web-service.md`）。
    expect(row?.t_est).toBe(1);
  });

  it("スマホ発の t_est を受け取らない（送られても立てない）", async () => {
    await post({
      ...BODY,
      points: [],
      detections: [
        { source: "phone", logId: LOG_ID, seq: 1, t: 1, kind: "stop", lv: 2, tEst: true },
      ],
    });

    const row = await env.DB.prepare("SELECT t_est FROM detections WHERE source = 'phone'").first<{
      t_est: number;
    }>();
    // 立つと、その検知は理由の分からないまま地図とランキングから消える。
    expect(row?.t_est).toBe(0);
  });

  it("サンプルを名乗れない（送られても「サンプルではない」として入る）", async () => {
    await post({ ...BODY, rides: [{ ...BODY.rides[0], sample: true }] });

    const row = await env.DB.prepare("SELECT sample FROM rides").first<{ sample: number }>();
    // 名乗れると、サンプルを除いた集計が「除いたつもりで除けていない」状態になる。
    expect(row?.sample).toBe(0);
  });

  it("速すぎる・精度の悪い測位でも取り込む（1点で走行ごと落とさない）", async () => {
    // **捨てたら二度と戻らない生ログ**である（`docs/adr/0007-keep-raw-ride-logs.md`）。
    // 1点でも弾くと走行が丸ごと上がらず、**スマホの手元は変わらないので送り直しても
    // 同じところで落ちる。**足切りは計算する側（#85）がそのときの設定で行う。
    const res = await post({
      ...BODY,
      points: [{ ...BODY.points[0], spd: 120, hacc: 3_000 }],
      detections: [],
    });

    expect(res.status).toBe(201);
    expect(await countOf("ride_points")).toBe(1);
  });

  it("走行の開始と終了は最初の1通が残る（分割して送っても書き換わらない）", async () => {
    // **走行が終わってから送る**経路なので（`docs/interfaces/mobile-api.md`「走行後の同期」）、
    // **確定した開始と終了を毎回同じ値で送る。**途中経過を送って後から直す使い方はできない
    // ——検知は `(device_id, t)` がこの期間に入るかだけで走行に結びつくので、
    // **期間の外に出た検知は地図にもランキングにも出ない。**
    await post(BODY);

    await post({ ...BODY, rides: [{ logId: LOG_ID, startedAt: 0, endedAt: 1 }], points: [] });

    const row = await env.DB.prepare("SELECT started_at, ended_at FROM rides").first<{
      started_at: number;
      ended_at: number;
    }>();
    expect(row?.started_at).toBe(1_756_123_456_000);
    expect(row?.ended_at).toBe(1_756_123_460_000);
  });

  it("この API から stop_violations を書かない", async () => {
    await post(BODY);

    // 再計算（#85）が作り直す表であって、取り込みが触る表ではない。
    expect(await countOf("stop_violations")).toBe(0);
  });

  it("走行だけ・検知だけでも送れる", async () => {
    const res = await post({ deviceId: DEVICE_ID, rides: BODY.rides });

    expect(res.status).toBe(201);
    expect(await countOf("rides")).toBe(1);
    expect(await countOf("ride_points")).toBe(0);
  });

  describe("壊れた入力は 400 で、D1 に何も入らない", () => {
    const broken: Record<string, unknown> = {
      "device_id の形が違う": { ...BODY, deviceId: "ZZZ" },
      "log_id の形が違う": { ...BODY, rides: [{ ...BODY.rides[0], logId: "xyz" }] },
      緯度が範囲外: { ...BODY, points: [{ ...BODY.points[0], lat: 91 }] },
      "crs のキーが無い": {
        ...BODY,
        points: [{ logId: LOG_ID, seq: 1, t: 1, lat: 34.6, lon: 133.9, spd: 1, hacc: 5 }],
      },
      "hacc が負": { ...BODY, points: [{ ...BODY.points[0], hacc: -1 }] },
      "spd が負": { ...BODY, points: [{ ...BODY.points[0], spd: -1 }] },
      終わりが始まりより前: {
        ...BODY,
        rides: [{ logId: LOG_ID, startedAt: 2_000, endedAt: 1_000 }],
      },
      走行の行が無い測位点: { deviceId: DEVICE_ID, rides: [], points: BODY.points },
      "スマホが rear_object を名乗る": {
        ...BODY,
        points: [],
        detections: [{ source: "phone", logId: LOG_ID, seq: 1, t: 1, kind: "rear_object", lv: 1 }],
      },
      "知らない source": {
        ...BODY,
        points: [],
        detections: [{ source: "server", logId: LOG_ID, seq: 1, t: 1, kind: "stop", lv: 1 }],
      },
      "lv が範囲外": {
        ...BODY,
        points: [],
        detections: [{ source: "phone", logId: LOG_ID, seq: 1, t: 1, kind: "stop", lv: 4 }],
      },
      配列ではなく1件だけ: { deviceId: DEVICE_ID, rides: BODY.rides[0] },
      上限を超える件数: {
        ...BODY,
        points: Array.from({ length: 5_001 }, (_, i) => ({ ...BODY.points[0], seq: i + 1 })),
      },
    };

    for (const [name, body] of Object.entries(broken)) {
      it(name, async () => {
        const res = await post(body);

        expect(res.status).toBe(400);
        expect(await countOf("rides")).toBe(0);
        expect(await countOf("ride_points")).toBe(0);
        expect(await countOf("detections")).toBe(0);
      });
    }

    it("「多すぎる」と「形が違う」を区別して返す", async () => {
      // **スマホはこの2つで正反対に振る舞う。**分けないと、送り直しても通らない 400 に
      // 対して送り直し続ける（か、分ければ通るものを諦める）。
      const tooMany = await post({
        ...BODY,
        points: Array.from({ length: 5_001 }, (_, i) => ({ ...BODY.points[0], seq: i + 1 })),
      });
      const invalid = await post({ ...BODY, deviceId: "ZZZ" });

      expect((await tooMany.json<{ code: string }>()).code).toBe("too_many");
      expect((await invalid.json<{ code: string }>()).code).toBe("invalid");
    });

    it("壊れた JSON でも 500 にしない", async () => {
      const res = await app.request(
        "/api/logs",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" },
        env,
      );

      expect(res.status).toBe(400);
    });
  });
});
