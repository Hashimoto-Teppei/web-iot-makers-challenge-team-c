import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { HealthResponse, Ping } from "../shared/api";
import { pings } from "./db/schema";
import { NEIGHBORS_DO_NAME, NEIGHBORS_LOCATION_HINT } from "./v2v/config";
import { type ExchangeResponse, exchangeRequest } from "./v2v/messages";

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
  })
  /**
   * 走行中の位置の中継。1Hz で自分の位置を受け取り、**同じレスポンスで半径内の
   * 周辺車両を返す**（`docs/adr/0005-realtime-transport.md`）。
   *
   * **このリクエストの中で D1 に書かない**（`CLAUDE.md`）。蓄積が要るなら Durable Object の
   * アラームか `ctx.waitUntil()` で非同期に流す。リアルタイム経路の遅延に永続化を載せない。
   */
  .post(
    "/api/v2v/exchange",
    // **検証は zValidator に通す。**自分で `c.req.json()` を読んで検証すると、
    // **送る側（モバイル）の型が AppType に載らない。**綴りを間違えた項目や欠けた
    // `crs` がコンパイルを通ってしまい、走行中の POST が毎回 400 になる——しかも
    // スマホは再送せず `beat` を書き続けるので、デバイスの `link` は `up` のまま。
    // **車車間の3検知だけが、誰にも見えないまま丸ごと死ぬ。**
    zValidator("json", exchangeRequest, (result, c) => {
      // **1通ぶんの誤りで落とさない。**次の測位が1秒後に来るので、スマホは再送しない
      // （`docs/interfaces/mobile-api.md`「運び方」）。壊れた JSON も範囲外の値も
      // ここへ来る（例外のまま落とすと 500 になる）。
      //
      // **中身の詳細を返さない。**レスポンスの形はそのままモバイル側の型になるので、
      // zod の issue をそのまま載せると、受け取る側の型がその union で埋まる。
      if (!result.success) return c.json({ error: "リクエストの形式が正しくありません" }, 400);
    }),
    async (c) => {
      const { id, self } = c.req.valid("json");

      // **DO は1個。**`idFromName()` に固定の名前を渡す。geohash などでセルに割ると、
      // 境界をまたいだ自転車が互いに見えなくなる。
      const doId = c.env.NEIGHBORS.idFromName(NEIGHBORS_DO_NAME);
      const neighbors = c.env.NEIGHBORS.get(doId, { locationHint: NEIGHBORS_LOCATION_HINT });
      // **戻り値に型注釈を付ける。**モバイル側は Cloudflare の型を持たないため、
      // ここで `c.env` 由来の型がそのまま漏れると、モバイルが受け取る AppType の
      // レスポンスが any になる（型が伝わらなくなる）。
      const body: ExchangeResponse = { peers: await neighbors.exchange(id, self) };

      return c.json(body);
    },
  );

/** apps/mobile が hc<AppType>() で使う。実体ではなく型だけを参照させる。 */
export type AppType = typeof routes;

export default app;
