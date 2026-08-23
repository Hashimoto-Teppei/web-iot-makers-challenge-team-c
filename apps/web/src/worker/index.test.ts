import { describe, expect, it } from "vitest";
import app from "./index";

describe("GET /api/health", () => {
  it("200 と status: ok を返す", async () => {
    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });
});
