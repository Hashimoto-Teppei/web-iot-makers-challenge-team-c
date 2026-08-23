import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { HealthResponse, Ping } from "../shared/api";
import { pings } from "./db/schema";

const app = new Hono<{ Bindings: Env }>();

// ルートをメソッドチェーンで書くことで型が積み上がり、AppType として export できる。
// 途中で app.get(...) と分けて書くとチェーンが切れ、モバイル側の型が空になる。
const routes = app
  .get("/api/health", (c) => {
    const body: HealthResponse = { status: "ok", timestamp: new Date().toISOString() };
    return c.json(body);
  })
  // 以下2つは D1 の疎通確認用。テーブル設計が決まったら差し替える（Issue #7）。
  .get("/api/pings", async (c) => {
    const db = drizzle(c.env.DB);
    const rows = await db.select().from(pings).orderBy(pings.id).all();
    return c.json(rows satisfies Ping[]);
  })
  .post("/api/pings", async (c) => {
    // 壊れた JSON が来たときに例外のまま落とすと 500 になる。送り手の誤りなので 400 を返す。
    const body = await c.req.json<{ message?: string }>().catch(() => null);
    const message = body?.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      return c.json({ error: "message は空でない文字列にしてください" }, 400);
    }

    const db = drizzle(c.env.DB);
    const [row] = await db.insert(pings).values({ message }).returning();
    // 1件の insert なら必ず返るが、返らなければ型が undefined を含んだまま
    // モバイル側まで伝わってしまうため、ここで潰しておく。
    if (!row) return c.json({ error: "保存できませんでした" }, 500);

    return c.json(row satisfies Ping, 201);
  });

/** apps/mobile が hc<AppType>() で使う。実体ではなく型だけを参照させる。 */
export type AppType = typeof routes;

export default app;
