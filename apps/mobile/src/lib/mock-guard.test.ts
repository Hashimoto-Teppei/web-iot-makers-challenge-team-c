import { describe, expect, it } from "vitest";
import { MOCK_DEVICE_ID } from "../ride/device";
import { DEFAULT_API_BASE_URL } from "./api-base";
import { blocksMockDevice } from "./mock-guard";

describe("blocksMockDevice", () => {
  it("モックの ID で共有のデプロイ先へ送ろうとしたら止める", () => {
    expect(blocksMockDevice(MOCK_DEVICE_ID, DEFAULT_API_BASE_URL)).toBe(true);
  });

  it("手元のサーバーへなら通す（自分のサーバーなら害が無い）", () => {
    expect(blocksMockDevice(MOCK_DEVICE_ID, "http://10.0.2.2:5173")).toBe(false);
    expect(blocksMockDevice(MOCK_DEVICE_ID, "http://192.168.1.5:5173")).toBe(false);
  });

  it("実機の ID なら共有のデプロイ先でも通す（#38 が入ったあとの姿）", () => {
    expect(blocksMockDevice("b2c3d4e5", DEFAULT_API_BASE_URL)).toBe(false);
  });
});
