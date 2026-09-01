import { describe, expect, it } from "vitest";
import { refuseMockExchange } from "./api";

describe("refuseMockExchange", () => {
  it("失敗として返す（黙って成功にしない）", async () => {
    // 成功にすると「中継できている」と見えるまま位置が出ていかないことになり、
    // **止まっていることに誰も気づけない。**
    await expect(refuseMockExchange("a1000001", {} as never)).rejects.toThrow(/共有のデプロイ先/);
  });
});
