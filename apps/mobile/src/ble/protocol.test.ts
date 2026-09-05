import { describe, expect, it } from "vitest";
import {
  BleProtocolError,
  isCompatible,
  PROTO_VERSION,
  parseDeviceInfo,
  parseStatus,
} from "./protocol";

const DEVICE_INFO = JSON.stringify({
  proto: 2,
  device_id: "c3f1a20b",
  log_id: "9a1c0b31",
  oldest_seq: 941,
  latest_seq: 1284,
});

describe("parseDeviceInfo", () => {
  it("約束どおりの JSON を読む", () => {
    expect(parseDeviceInfo(DEVICE_INFO)).toEqual({
      proto: 2,
      deviceId: "c3f1a20b",
      logId: "9a1c0b31",
      oldestSeq: 941,
      latestSeq: 1284,
    });
  });

  it("1件も持っていないデバイス（範囲が 0）も読める", () => {
    const info = parseDeviceInfo(
      JSON.stringify({
        proto: 2,
        device_id: "c3f1a20b",
        log_id: "9a1c0b31",
        oldest_seq: 0,
        latest_seq: 0,
      }),
    );
    expect(info.oldestSeq).toBe(0);
  });

  it("知らないキーは無視する", () => {
    // **足しただけで壊れないこと**（`docs/interfaces/ble-gatt.md`）。
    expect(parseDeviceInfo(`${DEVICE_INFO.slice(0, -1)},"future":1}`).deviceId).toBe("c3f1a20b");
  });

  it("device_id がハイフン付きの UUID なら落とす", () => {
    // **16進8文字でないと、取り込みの一意キーが揃わない**（`docs/interfaces/ble-gatt.md`）。
    expect(() =>
      parseDeviceInfo(JSON.stringify({ proto: 2, device_id: "c3f1a20b-0000", log_id: "9a1c0b31" })),
    ).toThrow(BleProtocolError);
  });

  it("JSON でなければ落とす", () => {
    expect(() => parseDeviceInfo("<html>")).toThrow(BleProtocolError);
  });

  it("proto が違っても落とさない", () => {
    // **落とすと「壊れている」と区別できず、画面に「更新してください」と出せない。**
    const info = parseDeviceInfo(
      JSON.stringify({ proto: 1, device_id: "c3f1a20b", log_id: "9a1c0b31" }),
    );
    expect(info.proto).toBe(1);
    expect(isCompatible(info)).toBe(false);
  });

  it("proto が一致すれば話せる", () => {
    expect(isCompatible({ ...parseDeviceInfo(DEVICE_INFO), proto: PROTO_VERSION })).toBe(true);
  });
});

describe("parseStatus", () => {
  it("約束どおりの JSON を読む", () => {
    const status = parseStatus(
      JSON.stringify({
        state: "sending",
        sent: 32,
        remaining: 52,
        last_error: null,
        link: "up",
        warns: 3,
        dropped: 0,
      }),
    );
    expect(status).toEqual({
      state: "sending",
      sent: 32,
      remaining: 52,
      lastError: null,
      link: "up",
      warns: 3,
      dropped: 0,
      cfg: {},
    });
  });

  it("知らない link は down として読む", () => {
    // **分からないときは安全側（届いていない）に倒す。**`up` に倒すと、
    // 届いていないのに届いているように見える。
    expect(parseStatus(JSON.stringify({ link: "???" })).link).toBe("down");
  });

  it("項目が欠けていても落とさない", () => {
    // **`status` は人に見せるためのもの**で、欠けたら接続ごと切る類のものではない。
    expect(parseStatus("{}")).toEqual({
      state: "idle",
      sent: 0,
      remaining: 0,
      lastError: null,
      link: "down",
      warns: 0,
      dropped: 0,
      cfg: {},
    });
  });

  it("JSON でなければ落とす", () => {
    expect(() => parseStatus("nope")).toThrow(BleProtocolError);
  });
});

describe("parseStatus の cfg", () => {
  it("上書きを読む", () => {
    expect(parseStatus('{"state":"idle","cfg":{"hold2":5000}}').cfg).toEqual({ hold2: 5000 });
  });

  it("cfg が無ければ空（古いデバイスでも購読を壊さない）", () => {
    expect(parseStatus('{"state":"idle"}').cfg).toEqual({});
  });

  it("数でない値は落とす", () => {
    expect(parseStatus('{"state":"idle","cfg":{"hold2":"5000"}}').cfg).toEqual({});
  });
});
