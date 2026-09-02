import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { StatsSample } from "../../shared/api";
import { detections, ridePoints, rides, stopSigns, stopViolations } from "../db/schema";
import type { DetectionRow, LocatedEvent, RidePoint } from "./aggregate";
import { MAX_RIDE_POINTS } from "./config";

/**
 * 集計が D1 から読むところ。**読むだけで、数えない**（数えるのは `aggregate.ts`）。
 *
 * **セルの丸めを SQL でやらない。**`CAST(lat * 1000 AS INTEGER)` と書けば
 * `GROUP BY` で行数を減らせるが、**丸め方が TypeScript と SQL の2箇所に割れる**
 * （`cell.ts` の冒頭）。**割れた時点で、地図の円とランキングが別のセルを指しうる。**
 *
 * **行数が増えたら、集計結果のテーブルを足す**（`docs/interfaces/web-service.md`
 * 「テーブル（D1）」。**遅くなってから足す**と決めてある）。その合図が
 * {@link MAX_RIDE_POINTS} である。
 */

/**
 * サンプルデータを除くときの条件。**混ぜるときは条件そのものを足さない。**
 *
 * `undefined` を返すのは Drizzle の `where` / `and` がそれを無視するためで、
 * **「常に真」の条件を書くより、条件が無いことをそのまま表せる。**
 */
const excludeSample = (sample: StatsSample, column: SQLiteColumn) =>
  sample === "exclude" ? eq(column, false) : undefined;

/**
 * 測位点を読む。**通過（率の分母）と、検知の突き合わせの両方がこれを使う。**
 *
 * **`rides` と内部結合する。**サンプルかどうかは走行の側にしか無く
 * （`ride_points` は列を持たない。`docs/interfaces/web-service.md`）、
 * **どの走行にも属さない点を集計に混ぜない**ためでもある。
 *
 * **上限を超えたら落とす**（`null` を返す）。**途中まで読んで数えると、
 * 分母だけが小さい率＝実際より危険に見える順位**が出る。
 */
export async function readRidePoints(
  db: DrizzleD1Database,
  sample: StatsSample,
): Promise<RidePoint[] | null> {
  const rows = await db
    .select({
      deviceId: ridePoints.deviceId,
      logId: ridePoints.logId,
      t: ridePoints.t,
      lat: ridePoints.lat,
      lon: ridePoints.lon,
    })
    .from(ridePoints)
    .innerJoin(
      rides,
      and(eq(ridePoints.deviceId, rides.deviceId), eq(ridePoints.logId, rides.logId)),
    )
    .where(excludeSample(sample, rides.sample))
    // **1件多く読んで、超えたことに気づく。**`COUNT` をもう1クエリ投げない
    // （D1 は1回の呼び出しで 50 クエリまで。`recompute/query.ts` と同じ数え方）。
    .limit(MAX_RIDE_POINTS + 1)
    .all();

  return rows.length > MAX_RIDE_POINTS ? null : rows;
}

/**
 * 場所に結びつける前の検知を読む。
 *
 * **既定では `t_est` が立った検知を外す**（`docs/interfaces/web-stats.md`
 * 「検知を場所に結びつける」）。BLE が切れている間デバイスが打つ推定の時刻で、
 * **切断が長いほどずれ、ずれた時刻に一番近い点＝別のセル**に積まれる。
 * **地図とランキングからは除き、場所の詳細画面（#87）には出す。**
 *
 * **読む列は2つの画面で同じにしてある。**`kind` は地図とランキングでは使わないが、
 * **1列増えるだけ**であり、**分けると突き合わせの入口が2つになる**——
 * `matchDetections` に渡る行の形が画面ごとに違うと、**片方だけ直した変更が静かに通る。**
 *
 * @param includeEstimated `t_est` の検知も返すか。**詳細画面だけが `true` を渡す**
 */
export async function readDetections(
  db: DrizzleD1Database,
  sample: StatsSample,
  includeEstimated = false,
): Promise<DetectionRow[]> {
  return await db
    .select({
      deviceId: detections.deviceId,
      t: detections.t,
      kind: detections.kind,
      tEst: detections.tEst,
    })
    .from(detections)
    .where(
      and(
        includeEstimated ? undefined : eq(detections.tEst, false),
        excludeSample(sample, detections.sample),
      ),
    )
    .all();
}

/**
 * 不停止を、標識の位置つきで読む。
 *
 * **場所は `stop_violations` に入っていない**（`docs/interfaces/web-service.md`「テーブル（D1）」）。
 * `sign_id` から `stop_signs` を辿って緯度経度を得る——**検知が測位点を辿るのとは経路が違う。**
 *
 * **`stop_violations.id` を返さない。**再計算のたびに行を作り直すので**値が変わる**
 * （#85）。画面や URL の識別子に使えるものではない。
 *
 * **サンプルかどうかは走行の側にある**ので `rides` を辿る（この表も列を持たない）。
 *
 * **標識が見つからない行を黙って捨てない。****数だけ残す**（`unlocated`）——
 * 標識を取り込み直して `id` が変われば、**古い不停止は場所を失う。**捨てると、
 * **地図にも順位にも出ないまま「起きていない」に見える**（検知の側と同じ扱いにそろえてある）。
 */
export async function readViolations(
  db: DrizzleD1Database,
  sample: StatsSample,
): Promise<{ located: LocatedEvent[]; unlocated: number }> {
  const rows = await db
    .select({
      deviceId: stopViolations.deviceId,
      logId: stopViolations.logId,
      // **標識を通過したと判定した時刻。**使うのは場所の詳細画面（#87）だけで、
      // 地図とランキングは時刻の次元を持たない。
      t: stopViolations.t,
      lat: stopSigns.lat,
      lon: stopSigns.lon,
    })
    .from(stopViolations)
    // **外部結合にする。**内部結合だと、標識が消えた行はそもそも返ってこないので
    // **数えることすらできない。**
    .leftJoin(stopSigns, eq(stopViolations.signId, stopSigns.id))
    // 走行の方は内部結合でよい（`rides` が無い不停止は再計算が作らない）。
    .innerJoin(
      rides,
      and(eq(stopViolations.deviceId, rides.deviceId), eq(stopViolations.logId, rides.logId)),
    )
    .where(excludeSample(sample, rides.sample))
    .all();

  const located: LocatedEvent[] = [];
  let unlocated = 0;
  for (const row of rows) {
    if (row.lat === null || row.lon === null) {
      unlocated += 1;
      continue;
    }
    located.push({
      deviceId: row.deviceId,
      logId: row.logId,
      lat: row.lat,
      lon: row.lon,
      t: row.t,
    });
  }
  return { located, unlocated };
}
