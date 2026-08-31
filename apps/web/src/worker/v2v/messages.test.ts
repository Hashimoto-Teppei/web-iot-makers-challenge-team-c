import { describe, expect, it } from "vitest";
import { messageLimitDefaults } from "./config";
import { exchangeRequest } from "./messages";

/** 通るはずのリクエスト。ここから1項目だけ壊して確かめる。 */
function request(selfOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    id: "7d02e5b1",
    self: {
      k: "self",
      t: 1_756_123_456_789,
      lat: 34.6617512,
      lon: 133.9344061,
      spd: 5.24,
      crs: 118.4,
      hacc: 4,
      ...selfOver,
    },
    ...over,
  };
}

const parses = (value: unknown) => exchangeRequest.safeParse(value).success;

describe("exchangeRequest", () => {
  it("まっとうな1通を通す", () => {
    expect(parses(request())).toBe(true);
  });

  it("`crs` の null を通す（止まっていて向きが分からないという正常な値）", () => {
    expect(parses(request({ spd: 0, crs: null }))).toBe(true);
  });

  it("`crs` のキーごと無いものは捨てる（null と区別する）", () => {
    const { self, ...rest } = request();
    const { crs: _crs, ...selfWithoutCrs } = self;
    expect(parses({ ...rest, self: selfWithoutCrs })).toBe(false);
  });

  it("`crs` は 0 以上 360 未満", () => {
    expect(parses(request({ crs: 0 }))).toBe(true);
    expect(parses(request({ crs: 359.9 }))).toBe(true);
    expect(parses(request({ crs: 360 }))).toBe(false);
    expect(parses(request({ crs: -1 }))).toBe(false);
  });

  it("`hacc` は 0 より大きく上限以下（0 を通すと誤差 0 の確かな位置になってしまう）", () => {
    expect(parses(request({ hacc: 0 }))).toBe(false);
    expect(parses(request({ hacc: messageLimitDefaults.maxHaccM }))).toBe(true);
    expect(parses(request({ hacc: messageLimitDefaults.maxHaccM + 1 }))).toBe(false);
  });

  it("`spd` は 0 以上上限以下（桁違いの速度を検知に届かせない）", () => {
    expect(parses(request({ spd: 0 }))).toBe(true);
    expect(parses(request({ spd: messageLimitDefaults.maxSpdMps + 1 }))).toBe(false);
    expect(parses(request({ spd: -1 }))).toBe(false);
  });

  it("緯度経度の範囲外を捨てる", () => {
    expect(parses(request({ lat: 91 }))).toBe(false);
    expect(parses(request({ lon: 181 }))).toBe(false);
  });

  it("NaN と Infinity を捨てる", () => {
    expect(parses(request({ spd: Number.NaN }))).toBe(false);
    expect(parses(request({ lat: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it("`k` が self でないものを捨てる", () => {
    expect(parses(request({ k: "peer" }))).toBe(false);
  });

  it("端末ID は16進の小文字8文字", () => {
    expect(parses(request({}, { id: "7D02E5B1" }))).toBe(false);
    expect(parses(request({}, { id: "7d02e5b" }))).toBe(false);
    expect(parses(request({}, { id: 12345678 }))).toBe(false);
  });

  it("知らないキーは無視する（項目が増えても古い実装が落ちないため）", () => {
    const parsed = exchangeRequest.safeParse(request({ alt: 12.3 }, { future: true }));

    expect(parsed.success).toBe(true);
    expect(parsed.data?.self).not.toHaveProperty("alt");
  });
});
