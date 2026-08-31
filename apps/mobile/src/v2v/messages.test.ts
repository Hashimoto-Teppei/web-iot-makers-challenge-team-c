import { describe, expect, it } from "vitest";
import {
  type MessageLimits,
  messageLimitDefaults,
  type PeerMessage,
  parsePeer,
  parseSelf,
  roundForWire,
  type SelfMessage,
} from "./messages";

const limits: MessageLimits = messageLimitDefaults;

/** 通る `self`。各テストで1項目だけ壊して使う。 */
const validSelf: SelfMessage = {
  k: "self",
  t: 1_756_123_456_789,
  lat: 34.6617512,
  lon: 133.9344061,
  spd: 5.24,
  crs: 118.4,
  hacc: 4.0,
};

const validPeer: PeerMessage = { ...validSelf, k: "peer", id: "7d02e5b1" };

describe("roundForWire", () => {
  it("桁を仕様どおりに丸める（lat/lon 7桁・spd 2桁・crs/hacc 1桁）", () => {
    const rounded = roundForWire({
      k: "self",
      t: 1,
      lat: 34.66175123456,
      lon: 133.93440617777,
      spd: 5.2449,
      crs: 118.44,
      hacc: 5.500000238418579,
    });
    expect(rounded.lat).toBe(34.6617512);
    expect(rounded.lon).toBe(133.9344062);
    expect(rounded.spd).toBe(5.24);
    expect(rounded.crs).toBe(118.4);
    expect(rounded.hacc).toBe(5.5);
  });

  it("丸めた crs が 360.0 になったら 0 にする", () => {
    // 受信側の範囲は 0 以上 360 未満。ここで 360 のまま出すと、その1通が丸ごと捨てられる。
    expect(roundForWire({ ...validSelf, crs: 359.98 }).crs).toBe(0);
  });

  it("丸めた hacc が 0 になったら下限に寄せる", () => {
    // 受信側は hacc が 0 以下のものを捨てる。crs の 360 と同じ形の穴。
    const rounded = roundForWire({ ...validSelf, hacc: 0.04 });
    expect(rounded.hacc).toBeGreaterThan(0);
    expect(parseSelf(rounded, limits)).not.toBeNull();
  });

  it("crs の null をそのまま通す", () => {
    expect(roundForWire({ ...validSelf, crs: null }).crs).toBeNull();
  });
});

describe("parseSelf", () => {
  it("そろっていれば通る", () => {
    expect(parseSelf(validSelf, limits)).toEqual(validSelf);
  });

  it("id が無くても通る", () => {
    // `self` に `id` は入らない。必須にすると `self` が1通残らず捨てられる。
    expect(parseSelf({ ...validSelf, id: undefined }, limits)).not.toBeNull();
  });

  it("k が peer のものは self として読まない", () => {
    expect(parseSelf(validPeer, limits)).toBeNull();
  });

  it("crs の null は通す（止まっている自転車が丸ごと消えないため）", () => {
    expect(parseSelf({ ...validSelf, crs: null }, limits)?.crs).toBeNull();
  });

  it("crs のキーごと無いものは捨てる", () => {
    const { crs: _crs, ...withoutCrs } = validSelf;
    expect(parseSelf(withoutCrs, limits)).toBeNull();
  });

  it.each([
    ["t", { t: "1756123456789" }],
    ["lat", { lat: 91 }],
    ["lat", { lat: -91 }],
    ["lon", { lon: 181 }],
    ["spd", { spd: -0.1 }],
    ["spd", { spd: 31 }],
    ["crs", { crs: 360 }],
    ["crs", { crs: -1 }],
    ["hacc", { hacc: 0 }],
    ["hacc", { hacc: 51 }],
    ["NaN", { spd: Number.NaN }],
    ["Infinity", { lat: Number.POSITIVE_INFINITY }],
  ])("範囲外・型違いの %s を捨てる", (_label, broken) => {
    expect(parseSelf({ ...validSelf, ...broken }, limits)).toBeNull();
  });

  it("上限は設定から来る（既定を変えれば通る値が変わる）", () => {
    const fast = { ...validSelf, spd: 40 };
    expect(parseSelf(fast, limits)).toBeNull();
    expect(parseSelf(fast, { ...limits, maxSpdMps: 50 })).not.toBeNull();
  });

  it.each([[null], [undefined], ["self"], [42], [[]]])("オブジェクトでない %s で落ちない", (v) => {
    expect(parseSelf(v, limits)).toBeNull();
  });
});

describe("parsePeer", () => {
  it("そろっていれば通る", () => {
    expect(parsePeer(validPeer, limits)).toEqual(validPeer);
  });

  it("id が無いものは捨てる（誰の位置か分からない）", () => {
    const { id: _id, ...withoutId } = validPeer;
    expect(parsePeer(withoutId, limits)).toBeNull();
  });

  it.each([["7D02E5B1"], ["7d02e5b"], ["7d02e5b12"], ["7d02e5bz"]])(
    "device_id の形（16進の小文字8文字）でない %s を捨てる",
    (id) => {
      expect(parsePeer({ ...validPeer, id }, limits)).toBeNull();
    },
  );

  it("k が self のものは peer として読まない", () => {
    expect(parsePeer(validSelf, limits)).toBeNull();
  });
});
