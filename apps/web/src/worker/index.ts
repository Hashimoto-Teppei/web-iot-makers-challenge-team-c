import { zValidator } from "@hono/zod-validator";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { HealthResponse, Ping, StatsResponse, StopSignsResponse } from "../shared/api";
import { pings } from "./db/schema";
import { insertLogs } from "./logs/insert";
import { type LogsResponse, logsErrorOf, logsRequest } from "./logs/request";
import { authorize } from "./recompute/auth";
import { recomputeLimitDefaults } from "./recompute/config";
import { judgeRide } from "./recompute/judge";
import {
  boundingBoxOf,
  listRides,
  // 集計にも同じ名前の関数がある（`stats/query.ts`）。**読む列も絞り方も違う**ので、
  // 呼び分けを間違えないよう、こちらに別名を付ける。
  readRidePoints as readRidePointsForRecompute,
  readSignsInBox,
  rideKey,
  signsInBox,
} from "./recompute/query";
import {
  type RecomputeError,
  type RecomputeResponse,
  type RideRef,
  recomputeRequest,
} from "./recompute/request";
import { type RideResult, replaceViolations } from "./recompute/write";
import { aggregateCells, matchDetections } from "./stats/aggregate";
import { MAX_MATCH_GAP_MS, statsDefaults } from "./stats/config";
import { readDetections, readRidePoints, readViolations } from "./stats/query";
import { type StatsError, statsQuery } from "./stats/request";
import { etagOf, matchesIfNoneMatch } from "./stop-signs/etag";
import { readStopSigns, readStopSignVersion } from "./stop-signs/query";
import { stopSignsQuery } from "./stop-signs/request";
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
   * 一時停止の標識を都道府県ぶん丸ごと配る。
   *
   * **走行中には使われない。**アプリの起動時にだけ取りに行き、走行中は端末の手元
   * （`signs.db`）を見る（`docs/adr/0009-on-device-storage.md`）。**それでも壊すと、
   * 走行中ではなくアプリのビルドが止まる**——各自の同梱物はこの経路から作る。
   *
   * **認証を置かない。**公開されている交通規制情報であり、隠す意味がない
   * （`docs/interfaces/web-service.md`「割り切っていること」）。
   */
  .get(
    "/api/stop-signs",
    zValidator("query", stopSignsQuery, (result, c) => {
      // 範囲外の県コードは送り手の誤り。例外のまま落とすと 500 になる。
      if (!result.success) return c.json({ error: "pref は 1〜47 の都道府県コードです" }, 400);
    }),
    async (c) => {
      const { pref } = c.req.valid("query");
      const db = drizzle(c.env.DB);

      // **まず版だけを読む。**標識の本体を先に読むと、`304` で捨てるだけの数万行を
      // アプリの起動のたびに D1 から引くことになる。
      const found = await readStopSignVersion(db, pref);
      // **空の配列を返さない。**「まだ取り込んでいない県」を 200 + 0 件で返すと、
      // 端末からは「標識が無い県」と区別が付かない（`docs/interfaces/mobile-api.md`
      // 「『持っていない』と『0件』を混ぜない」）。
      if (!found) return c.json({ error: `都道府県コード ${pref} の標識がまだありません` }, 404);

      const etag = etagOf(pref, found.version);
      // **`no-cache` は「キャッシュするな」ではなく「使う前に必ず確かめろ」。**
      // 月に1回しか変わらないデータなので、中継に握られたまま古い版を返されると
      // 端末が更新を取り逃す。ETag の検証だけは毎回通す。
      const headers = { ETag: etag, "Cache-Control": "no-cache" };

      // 版が変わっていなければ本文を送らない。**同梱直後の最初の起動はここに来る**
      // （`docs/adr/0009-on-device-storage.md`）。
      if (matchesIfNoneMatch(c.req.header("If-None-Match"), etag)) {
        return c.body(null, 304, headers);
      }

      const signs = await readStopSigns(db, pref);
      // **取り込んだときの件数と食い違っていたら配らない。**取り込みの SQL は
      // トランザクションで囲めない（D1 が `BEGIN` を受け付けない）ので、途中で
      // 落ちれば**新しい版のまま中身が欠ける。**そのまま 200 で返すと、端末は
      // **正しく揃っている手元の `signs.db` を、欠けたもので置き換える。**
      if (signs.length !== found.count) {
        return c.json(
          {
            error:
              `都道府県コード ${pref} の標識が壊れています` +
              `（取り込み時 ${found.count} 件 / いま ${signs.length} 件）。取り込み直してください`,
          },
          500,
        );
      }

      const body: StopSignsResponse = { pref, version: found.version, count: signs.length, signs };
      return c.json(body, 200, headers);
    },
  )
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
  )
  /**
   * 走行後の同期。**スマホが走行ログ・検知をまとめて送る**受け口
   * （`docs/interfaces/web-service.md`「データの取り込み」）。
   *
   * **配列で受ける。**1件ずつだと、1回の走行で数千往復することになる。
   *
   * **このリクエストの中で重い集計をしない。**不停止の判定（#85）も、集計表の更新も
   * ここではやらない。**しきい値を変えて何度でも計算し直せることが、生ログを残す目的
   * そのもの**であり（`docs/adr/0007-keep-raw-ride-logs.md`）、取り込みに埋め込むと
   * **過去ぶんを作り直せなくなる。**
   *
   * **認証を置かない**（`docs/interfaces/web-service.md`「割り切っていること」）。
   * `device_id` を知った人が偽の検知を投げられるが、**他人の走行を消すことはできない**
   * （既にある行を上書きせず無視するため）。**再計算（#85）だけは `ADMIN_TOKEN` で守る**
   * ——あちらは既存の行を丸ごと置き換えるので、壊せる範囲が違う。
   */
  .post(
    "/api/logs",
    zValidator("json", logsRequest, (result, c) => {
      // **壊れた入力では 1 行も入れない**（検証を通ってからしか D1 を触らない）。
      // **「多すぎる」と「形が違う」だけは区別して返す**（`logs/request.ts` の `LogsError`）。
      // スマホはこの2つで正反対に振る舞う——前者は分けて送り直し、後者は送り直しても通らない。
      if (!result.success) return c.json(logsErrorOf(result.error), 400);
    }),
    async (c) => {
      const body = c.req.valid("json");

      await insertLogs(drizzle(c.env.DB), body);

      // **返すのは受け取った件数。**入った件数ではない（`logs/request.ts` の `LogsResponse`）。
      const received: LogsResponse = {
        received: {
          rides: body.rides.length,
          points: body.points.length,
          detections: body.detections.length,
        },
      };
      return c.json(received, 201);
    },
  )
  /**
   * 不停止の再計算。**走行ログと一時停止の標識を突き合わせて `stop_violations` を作り直す**
   * （`docs/interfaces/web-service.md`「不停止の判定」「いつ計算するか」）。
   *
   * **スクリプトではなくここに置いてある。**判定は D1 の中身を読んで書き戻す処理で、
   * **リモートの D1 を触れるのは Worker から**である（`wrangler d1 execute --remote` は
   * SQL しか送れず、判定のコードを持ち込めない）。
   *
   * **しきい値はリクエストで受け取る。サーバーに既定値を持たない**（`recompute/request.ts`）
   * ——**その場で数字を変えて叩き直せることが、この経路を持つ理由そのもの**である。
   *
   * **この1本だけ `ADMIN_TOKEN` で守る**（`recompute/auth.ts`）。
   */
  .post(
    "/api/admin/recompute",
    // **認証を検証より先に置く。**あとにすると、**トークンを持たない相手に
    // 「リクエストの形は合っている」を教える**ことになる。
    async (c, next) => {
      const result = authorize(c.env.ADMIN_TOKEN, c.req.header("Authorization"));
      if (result === "unauthorized") {
        const body: RecomputeError = { error: "認証が必要です" };
        return c.json(body, 401);
      }
      if (result === "not-configured") {
        // **未設定を 401 にしない。**トークンを探して延々と試すことになる。
        const body: RecomputeError = { error: "ADMIN_TOKEN が設定されていません" };
        return c.json(body, 503);
      }
      await next();
    },
    zValidator("json", recomputeRequest, (result, c) => {
      if (!result.success) {
        const body: RecomputeError = { error: "リクエストの形式が正しくありません" };
        return c.json(body, 400);
      }
    }),
    async (c) => {
      const { thresholds, rides: requested, skip } = c.req.valid("json");
      const db = drizzle(c.env.DB);
      const { maxRides } = recomputeLimitDefaults;

      // **省略されたら古い順に上限ぶん。**1件多く読んで「続きがあるか」を数える
      // （数えるためだけに `COUNT` をもう1クエリ使わない）。
      const listed = requested ?? (await listRides(db, maxRides + 1, skip ?? 0));
      const more = requested === undefined && listed.length > maxRides;

      // **明示された走行が多すぎたら、1行も触らずに返す**——途中まで作り直すと、
      // **どこまで置き換わったのかが呼んだ側に分からない。**`rides` を省略した側は
      // 上で切ってあるので、ここへ来るのは呼んだ側が数を決めたときだけである。
      if (requested && requested.length > maxRides) {
        const body: RecomputeError = {
          error: `走行が多すぎます（上限 ${maxRides}）。rides を分けて叩き直してください`,
        };
        return c.json(body, 400);
      }

      // **同じ走行が2度入っていたら1つにする。**そのままだと**同じ判定を2度書き込む**
      // ——`DELETE` は1回しか効かないうえ、この表は代理キーを持つので**重複が残る。**
      const targets: RideRef[] = [
        ...new Map(listed.slice(0, maxRides).map((ride) => [rideKey(ride), ride])).values(),
      ];

      const pointsByRide = await readRidePointsForRecompute(db, targets);
      const allPoints = [...pointsByRide.values()].flat();

      // **標識は1回だけ読む**（走行ごとに引くと、県ぶんの走査をそのぶん繰り返す）。
      // 走行の範囲を半径ぶん広げた矩形で絞る（`recompute/query.ts`）。
      const box = boundingBoxOf(allPoints, thresholds.radiusM);
      const signs = box ? await readSignsInBox(db, box) : [];

      const results: RideResult[] = targets.map((ride) => {
        const points = pointsByRide.get(rideKey(ride)) ?? [];
        // **走行ごとにもう一度絞る。**上の矩形は全走行を囲んだもので、
        // **離れた場所を走った走行が混ざると県ぶんに膨らむ**（`recompute/query.ts`）。
        const rideBox = boundingBoxOf(points, thresholds.radiusM);
        const nearby = rideBox ? signsInBox(signs, rideBox) : [];
        return { ride, violations: judgeRide(points, nearby, thresholds) };
      });

      // **不停止が0件だった走行も渡す。**前回の結果を消すために要る。
      await replaceViolations(db, results, thresholds);

      const body: RecomputeResponse = {
        computed: {
          rides: targets.length,
          points: allPoints.length,
          violations: results.reduce((n, r) => n + r.violations.length, 0),
          more,
        },
        thresholds,
      };
      return c.json(body);
    },
  )
  /**
   * セルごとの集計。**マップとランキングが見るのはこれ1本**
   * （`docs/interfaces/web-ui.md`「マップとランキングを1ページに並べる理由」——
   * **同じデータの2つの見せ方**なので、2本に分けると2つがずれる）。
   *
   * **返すのはセルに丸めたものだけ。生の測位点を返さない**
   * （`docs/adr/0007-keep-raw-ride-logs.md`。**これを守ることが生ログを保存する条件そのもの**）。
   * **`device_id` も返さない**——出すと、**同じ端末の行を拾い集めれば経路が並ぶ。**
   *
   * **時刻の次元を持たない。**時間帯の内訳は場所の詳細画面（#87）が別に持つ。
   *
   * **認証を置かない**（`docs/interfaces/web-service.md`「割り切っていること」）。
   * 読むだけで、丸めた値しか出さない。
   */
  .get(
    "/api/stats/cells",
    zValidator("query", statsQuery, (result, c) => {
      // 範囲外の値や綴り違いは送り手の誤り。例外のまま落とすと 500 になる。
      if (!result.success) {
        const body: StatsError = { error: "クエリの形式が正しくありません" };
        return c.json(body, 400);
      }
    }),
    async (c) => {
      const { layer, sample, minRides } = c.req.valid("query");
      const db = drizzle(c.env.DB);

      // **測位点はレイヤーによらず読む。**通過（率の分母）はこれだけで決まる
      // （`docs/interfaces/web-service.md`「率で見る」）。
      const points = await readRidePoints(db, sample);
      if (!points) {
        // **打ち切って返さない。**途中まで読んだ点で数えると**分母だけが小さい率**
        // ——実際より危険に見える順位——が出る（`stats/config.ts`）。
        const body: StatsError = {
          error:
            "走行ログが多すぎて、読むたびの集計では追いつきません。" +
            "集計結果のテーブルを足してください（docs/interfaces/web-service.md）",
        };
        return c.json(body, 503);
      }

      // **検知は場所を持たないので、測位点に突き合わせて決める。**
      // **不停止は標識の位置から決まる**ので、突き合わせは要らない（経路が違う）。
      // **どちらも「場所が分からなかった数」を返す**——不停止の側は、標識を取り込み直して
      // `sign_id` が変わったときにここへ落ちる。
      const found =
        layer === "detection"
          ? matchDetections(points, await readDetections(db, sample), MAX_MATCH_GAP_MS)
          : await readViolations(db, sample);

      const { cells, truncated } = aggregateCells(points, found.located, {
        minRides,
        maxCells: statsDefaults.maxCells,
      });

      const body: StatsResponse = {
        layer,
        sample,
        minRides,
        cells,
        unlocated: found.unlocated,
        truncated,
      };
      return c.json(body);
    },
  );

/** apps/mobile が hc<AppType>() で使う。実体ではなく型だけを参照させる。 */
export type AppType = typeof routes;

export default app;
