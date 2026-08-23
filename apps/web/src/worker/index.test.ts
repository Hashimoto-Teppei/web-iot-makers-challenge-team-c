import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./index";

// テストの間で行が残ると、実行順によって結果が変わってしまう。
beforeEach(async () => {
  await env.DB.exec("DELETE FROM pings");
});

describe("GET /api/health", () => {
  it("200 と status: ok を返す", async () => {
    const res = await app.request("/api/health", {}, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });
});

describe("/api/pings", () => {
  it("POST で保存した内容を GET で読み出せる", async () => {
    const posted = await app.request(
      "/api/pings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "こんにちは" }),
      },
      env,
    );
    expect(posted.status).toBe(201);

    const listed = await app.request("/api/pings", {}, env);

    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject([{ message: "こんにちは" }]);
  });

  it("JSON として壊れた body なら 400 を返す（500 にしない）", async () => {
    const res = await app.request(
      "/api/pings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      },
      env,
    );

    expect(res.status).toBe(400);
  });

  it("message が空白だけなら 400 を返す", async () => {
    const res = await app.request(
      "/api/pings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "   " }),
      },
      env,
    );

    expect(res.status).toBe(400);
  });

  it("message が空なら 400 を返す", async () => {
    const res = await app.request(
      "/api/pings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "" }),
      },
      env,
    );

    expect(res.status).toBe(400);
  });
});
