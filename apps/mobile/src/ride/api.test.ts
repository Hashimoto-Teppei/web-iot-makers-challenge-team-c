import { describe, expect, it } from "vitest";
import { DEFAULT_API_BASE_URL } from "../lib/api-base";
import { blocksMockExchange, refuseMockExchange } from "./api";
import { MOCK_DEVICE_ID } from "./device";

describe("blocksMockExchange", () => {
  it("モックの ID で共有のデプロイ先へ送ろうとしたら止める", () => {
    expect(blocksMockExchange(MOCK_DEVICE_ID, DEFAULT_API_BASE_URL)).toBe(true);
  });

  it("手元のサーバーへなら通す（自分のサーバーなら害が無い）", () => {
    expect(blocksMockExchange(MOCK_DEVICE_ID, "http://10.0.2.2:5173")).toBe(false);
    expect(blocksMockExchange(MOCK_DEVICE_ID, "http://192.168.1.5:5173")).toBe(false);
  });

  it("実機の ID なら共有のデプロイ先でも通す（#38 が入ったあとの姿）", () => {
    expect(blocksMockExchange("b2c3d4e5", DEFAULT_API_BASE_URL)).toBe(false);
  });
});

describe("refuseMockExchange", () => {
  it("失敗として返す（黙って成功にしない）", async () => {
    // 成功にすると「中継できている」と見えるまま位置が出ていかないことになり、
    // **止まっていることに誰も気づけない。**
    await expect(refuseMockExchange("a1000001", {} as never)).rejects.toThrow(/共有のデプロイ先/);
  });
});
