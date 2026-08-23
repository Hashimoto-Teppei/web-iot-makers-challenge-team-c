import { Hono } from "hono";
import type { HealthResponse } from "../shared/api";

const app = new Hono<{ Bindings: Env }>();

// ルートをメソッドチェーンで書くことで型が積み上がり、AppType として export できる。
// 途中で app.get(...) と分けて書くとチェーンが切れ、モバイル側の型が空になる。
const routes = app.get("/api/health", (c) => {
  const body: HealthResponse = { status: "ok", timestamp: new Date().toISOString() };
  return c.json(body);
});

/** apps/mobile が hc<AppType>() で使う。実体ではなく型だけを参照させる。 */
export type AppType = typeof routes;

export default app;
