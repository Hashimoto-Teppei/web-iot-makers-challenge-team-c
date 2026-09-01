import { describe, expect, it } from "vitest";
import { parseStopSignsResponse, StopSignsResponseError } from "./response";

const BUILT_AT = new Date("2026-09-01T09:00:00.000Z");
const ETAG = '"33.a1b2c3"';

const ok = {
  pref: 33,
  version: "a1b2c3",
  count: 2,
  signs: [
    { id: "s-1", lat: 34.6612, lon: 133.9345, approach: { lat: 34.661, lon: 133.9345 } },
    { id: "s-2", lat: 34.6625, lon: 133.9355, approach: null },
  ],
};

describe("parseStopSignsResponse", () => {
  it("版にはサーバーの ETag をそのまま入れる（本文の version ではない）", () => {
    const parsed = parseStopSignsResponse(ok, ETAG, BUILT_AT);
    expect(parsed.meta).toEqual({
      pref: 33,
      version: ETAG,
      count: 2,
      builtAt: "2026-09-01T09:00:00.000Z",
    });
  });

  it("進入方向が無い標識は null のまま通す", () => {
    const parsed = parseStopSignsResponse(ok, ETAG, BUILT_AT);
    expect(parsed.signs[1]?.approach).toBeNull();
  });

  it("弱い検証子（W/）は剥がして持つ（圧縮の有無で版が変わらない）", () => {
    // Cloudflare は gzip した応答の ETag に W/ を付けて返す。剥がさないと、
    // **同じ中身でも取得経路によって版が変わり**、起動時の更新が毎回落とし直す。
    const weak = parseStopSignsResponse(ok, `W/${ETAG}`, BUILT_AT);
    const strong = parseStopSignsResponse(ok, ETAG, BUILT_AT);
    expect(weak.meta.version).toBe(ETAG);
    expect(weak.meta.version).toBe(strong.meta.version);
  });

  it("ETag が無ければ落とす（端末が版を作らない）", () => {
    expect(() => parseStopSignsResponse(ok, null, BUILT_AT)).toThrow(StopSignsResponseError);
  });

  it("件数が食い違ったら落とす（欠けた同梱物を作らない）", () => {
    expect(() => parseStopSignsResponse({ ...ok, count: 3 }, ETAG, BUILT_AT)).toThrow(
      /件数が食い違って/,
    );
  });

  it("進入方向の座標が片方だけなら落とす", () => {
    const broken = { ...ok, signs: [{ ...ok.signs[0], approach: { lat: 34.661 } }], count: 1 };
    expect(() => parseStopSignsResponse(broken, ETAG, BUILT_AT)).toThrow(/approach の lon/);
  });

  it("標識の座標が欠けていたら落とす", () => {
    const broken = { ...ok, signs: [{ id: "s-1", lon: 133.9345, approach: null }], count: 1 };
    expect(() => parseStopSignsResponse(broken, ETAG, BUILT_AT)).toThrow(/lat/);
  });
});
