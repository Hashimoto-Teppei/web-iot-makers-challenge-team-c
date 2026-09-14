import { describe, expect, it } from "vitest";
import { MOCK_DEVICE_ID } from "../ride/device";
import { DEFAULT_API_BASE_URL } from "./api-base";
import { blocksMockDevice, MOCK_PERIPHERAL_DEVICE_ID } from "./mock-guard";

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

  // **開発機の疑似ペリフェラルは本物の BLE を通る**ので、画面からは本物と見分けられない
  // （`apps/device/tools/mock_peripheral.py`）。**ここが抜けると、机の上で走行を終えた
  // 瞬間に実際の位置が D1 へ永久に入る。**
  it("疑似ペリフェラルの ID も止める", () => {
    expect(blocksMockDevice(MOCK_PERIPHERAL_DEVICE_ID, DEFAULT_API_BASE_URL)).toBe(true);
  });

  it("疑似ペリフェラルでも手元のサーバーへなら通す", () => {
    expect(blocksMockDevice(MOCK_PERIPHERAL_DEVICE_ID, "http://192.168.1.5:5173")).toBe(false);
  });

  // **Python 側と食い違ったら気づけるようにする。**正本はこちらで、
  // `mock_peripheral.py` の `MOCK_PERIPHERAL_DEVICE_ID` が書き写している。
  it("2つの ID は別のもの", () => {
    expect(MOCK_PERIPHERAL_DEVICE_ID).not.toBe(MOCK_DEVICE_ID);
  });
});
