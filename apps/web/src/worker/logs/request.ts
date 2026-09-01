import { z } from "zod";
import { type LogLimits, logLimitDefaults } from "./config";

/**
 * `POST /api/logs` のリクエストの検証。
 *
 * **仕様の正本は `docs/interfaces/web-service.md`「データの取り込み」**と
 * `docs/interfaces/mobile-api.md`「走行後の同期」。ここはその実装であって、
 * 決め直す場所ではない。
 *
 * **検証を `zValidator` に通す**（自分で `c.req.json()` を読んで確かめない）。
 * 読んでしまうと**送る側（モバイル）の型が `AppType` に載らず**、綴りを間違えた項目が
 * コンパイルを通る。走行後の同期は**1日の終わりに1回**しか走らないので、
 * そこで 400 が続いても気づけるのは走行データが1件も無いと分かったときになる。
 */

/** 端末ID・走行の識別子の形（16進の小文字8文字）。`docs/interfaces/ble-gatt.md` */
const hexId = z.string().regex(/^[0-9a-f]{8}$/);

/** レコード番号。`log_id` の中で 1 から単調増加する（`docs/interfaces/ble-log-transfer.md`） */
const seq = z.number().int().min(1);

/** UTC のミリ秒。 */
const timestamp = z.number().int();

/**
 * 1回の走行。
 *
 * **開始と終了をサーバーで測位点から作り直さない。**点は分割して送られうるので、
 * **最初の1通が届いた時点の「最初と最後」は走行の全体ではない。**
 */
const rideSchema = z
  .object({
    logId: hexId,
    startedAt: timestamp,
    endedAt: timestamp,
  })
  // **終わりが始まりより前の走行を受け取らない。**期間で検知を引く規則
  // （`(device_id, t)` が `rides` の期間に入るか）が、この走行だけ永久に空振りする。
  .refine((r) => r.endedAt >= r.startedAt, {
    message: "endedAt は startedAt 以降にしてください",
  });

/**
 * 測位1点。**形は走行中の中継（`v2v/messages.ts`）と揃えてある**——同じ測位を送るため。
 *
 * **速度と精度に上限を置かない**（理由は `config.ts`）。**1点でも弾くと走行が丸ごと上がらず、
 * スマホの手元は変わらないので、送り直しても同じところで落ちる。**
 * 確かめるのは「読みようがない値ではないこと」だけにして、**足切りは計算する側（#85）に任せる。**
 */
const pointSchema = z.object({
  logId: hexId,
  seq,
  t: timestamp,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  spd: z.number().min(0),
  // **`null` を範囲外として捨てない。**「止まっていて向きが分からない」は正常な値で、
  // **不停止の判定が一番見たいのは止まった点**である（`docs/unverified.md` 57 のとおり、
  // どのみち判定はこの列を使わないが、**捨てると点そのものが消える**）。
  crs: z.number().min(0).lt(360).nullable(),
  // **0 を弾かない。**中継では「誤差 0 の確かな位置は無い」として弾いているが、
  // **こちらは信じるためではなく残すために受け取る**（信じるかどうかは #85 が決める）。
  hacc: z.number().min(0),
});

/**
 * 検知。**出どころで形が違うので、`source` で分岐する union にしてある。**
 *
 * - **スマホ発に `tEst` を持たせない。**推定した時刻を打つのはデバイスだけで
 *   （`docs/interfaces/ble-log-transfer.md`）、スマホは自分の時計を持っている。
 *   **項目そのものを置かなければ、間違えて立てられた `t_est` が入る余地が無い**
 *   （zod は知らないキーを黙って剥がす）。立った行は地図とランキングから除かれるので、
 *   **受け取ると、除かれた理由が誰にも分からないまま集計から消える**
 * - **`kind` も出どころで分ける。**`rear_object` はデバイスの中でしか発生せず、
 *   スマホ側の実装がこの値を送ることは無い（`docs/interfaces/detectors.md`）
 */
const detectionSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("phone"),
    logId: hexId,
    seq,
    t: timestamp,
    kind: z.enum(["approach", "brake", "corner", "stop"]),
    lv: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.object({
    source: z.literal("device"),
    logId: hexId,
    seq,
    t: timestamp,
    kind: z.enum(["rear_object"]),
    lv: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    /** `t` が単調時計からの推定なら `true`。**無ければ実測** */
    tEst: z.boolean().optional(),
  }),
]);

/**
 * 取り込みのリクエスト。
 *
 * **`device_id` は1リクエストに1つ。**スマホ発のレコードでも「接続していたデバイスの ID」を
 * 使うと決まっている（`docs/interfaces/mobile-api.md`「走行後の同期」）ので、
 * **レコードごとに持たせる意味が無い。**持たせると、1回の送信に別の端末のデータを
 * 混ぜられるようになる。
 *
 * **サンプルかどうかの列を受け取らない**（`docs/interfaces/web-service.md`）。
 * 受け取ると誰でもサンプルを名乗れ、**サンプルを除いた集計が、除いたつもりで除けていない**
 * 状態になる。
 */
export function logsRequestSchema(limits: LogLimits) {
  return (
    z
      .object({
        deviceId: hexId,
        // **3つとも省略できる。**デバイスから回収した検知だけを送る回や、
        // 分割の最後の1通で点しか残っていない回がある。
        rides: z.array(rideSchema).max(limits.maxRides).default([]),
        points: z.array(pointSchema).max(limits.maxPoints).default([]),
        detections: z.array(detectionSchema).max(limits.maxDetections).default([]),
      })
      // **点は、同じリクエストに走行の行があるものだけ受け取る。**
      // 走行を分けて送るときは、**毎回その走行の行を一緒に送る**こと（同じ行を何度送っても
      // 増えない）。**認めると、どの走行にも属さない測位点が D1 に溜まる**——
      // 通過の分母は走行を数えるので（`docs/interfaces/web-service.md`「率で見る」）、
      // **その点は集計に出ないまま位置情報だけが残る。**
      .refine((body) => body.points.every((p) => body.rides.some((r) => r.logId === p.logId)), {
        message: "points の log_id は、同じリクエストの rides に含めてください",
      })
  );
}

/** 既定の上限での検証。ルートはこれを使う（テストだけが上限を差し替える）。 */
export const logsRequest = logsRequestSchema(logLimitDefaults);

export type LogsRequest = z.infer<typeof logsRequest>;
export type RideRecord = LogsRequest["rides"][number];
export type PointRecord = LogsRequest["points"][number];
export type DetectionRecord = LogsRequest["detections"][number];

/**
 * 取り込みの応答。
 *
 * **返すのは「受け取った件数」であって、「新しく入った件数」ではない。**
 * 重複は通常運転なので（`docs/interfaces/ble-log-transfer.md`「転送済みログの扱い」）、
 * **入った件数を返すと、正しく取り込めた2回目が 0 件に見える。**
 * 送り直したスマホが「入っていない」と判断して送り続ける形にしない。
 */
/**
 * 400 の中身。
 *
 * **「多すぎるので分けて送り直せば入る」と「形が違うので送り直しても無駄」を区別する。**
 * 分けないと、**スマホは同じ 400 に対して正反対の振る舞い**——分割して送り直すのと、
 * 諦めて人に見せるの——を選べない。**送り直しても通らない 400 を送り続けるのが一番悪い。**
 *
 * **zod の issue をそのまま載せない。**レスポンスの形はモバイル側の型になるので、
 * 載せると受け取る側の型がその union で埋まる。
 */
export type LogsError = {
  error: string;
  /** `too_many`: 件数の上限を超えた（分けて送り直せば入る） / `invalid`: 形が違う */
  code: "too_many" | "invalid";
};

/**
 * 上限を超えたのか、形が違うのかを見分ける。
 *
 * 引数を `ZodError` そのものではなく `issues` を持つ形で受けるのは、**`zValidator` が渡すのが
 * `$ZodError`（zod の内部表現）だから**である。型を狭く取ると、zod の版が上がるたびに
 * ここが落ちる。
 */
export function logsErrorOf(error: {
  issues: readonly { code: string; path: readonly PropertyKey[] }[];
}): LogsError {
  const tooMany = error.issues.some(
    (issue) =>
      issue.code === "too_big" &&
      typeof issue.path[0] === "string" &&
      ["rides", "points", "detections"].includes(issue.path[0]),
  );

  return tooMany
    ? { error: "1回に送れる件数を超えています。分けて送り直してください", code: "too_many" }
    : { error: "リクエストの形式が正しくありません", code: "invalid" };
}

export type LogsResponse = {
  received: {
    rides: number;
    points: number;
    detections: number;
  };
};
