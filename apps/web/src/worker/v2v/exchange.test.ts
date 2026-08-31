import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../index";
import type { ExchangeResponse } from "./messages";

/**
 * `POST /api/v2v/exchange` を Worker ごと動かす。
 *
 * **近傍は Durable Object のメモリに残り、テストの間で消えない**（永続化していない
 * ものを消す手段が無い。これは仕様どおり）。**テストごとに別の端末IDと、互いに
 * 半径の外になる場所を使うこと。**同じ座標を使い回すと、他のテストが置いた自転車が
 * 混ざって台数が合わなくなる。
 */
async function exchange(id: string, self: Record<string, unknown>) {
  const res = await app.request(
    "/api/v2v/exchange",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, self }),
    },
    env,
  );
  return res;
}

/** 測位1点。場所はテストごとに十分離す。 */
function fix(lat: number, lon: number, over: Record<string, unknown> = {}) {
  return { k: "self", t: 1_756_123_456_789, lat, lon, spd: 5.24, crs: 118.4, hacc: 4, ...over };
}

describe("POST /api/v2v/exchange", () => {
  it("先に送った相手を、同じレスポンスで受け取れる", async () => {
    await exchange("10000001", fix(34.7, 133.9));

    const res = await exchange("10000002", fix(34.7001, 133.9));

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExchangeResponse;
    expect(body.peers.map((p) => p.id)).toContain("10000001");
    expect(body.peers.every((p) => p.k === "peer")).toBe(true);
  });

  it("自分を返さない", async () => {
    await exchange("20000001", fix(34.8, 133.9));

    const res = await exchange("20000001", fix(34.8, 133.9));

    const body = (await res.json()) as ExchangeResponse;
    expect(body.peers.map((p) => p.id)).not.toContain("20000001");
  });

  it("半径の外の相手は返さない（1台目と 500m 離す）", async () => {
    await exchange("30000001", fix(34.9, 133.9));

    const res = await exchange("30000002", fix(34.9045, 133.9));

    const body = (await res.json()) as ExchangeResponse;
    expect(body.peers.map((p) => p.id)).not.toContain("30000001");
  });

  it("JSON として壊れた body なら 400 を返す（500 にしない）", async () => {
    const res = await app.request(
      "/api/v2v/exchange",
      { method: "POST", headers: { "content-type": "application/json" }, body: "not json" },
      env,
    );

    expect(res.status).toBe(400);
  });

  it("範囲外の値を含む1通は 400 で捨てる（他人の近傍に入れない）", async () => {
    const res = await exchange("40000001", fix(34.95, 133.9, { hacc: 500 }));

    expect(res.status).toBe(400);
  });

  it("端末ID の形が違えば 400 を返す", async () => {
    const res = await exchange("zzzz", fix(34.96, 133.9));

    expect(res.status).toBe(400);
  });
});
