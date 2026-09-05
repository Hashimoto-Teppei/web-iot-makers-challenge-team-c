import { and, asc, eq, gte, lte, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { ridePoints, rides, stopSigns } from "../db/schema";
import type { JudgePoint, JudgeSign } from "./judge";
import type { RideRef } from "./request";

/**
 * 再計算が D1 から読むところ。**読むときは Drizzle を使う**（`stop-signs/query.ts` と同じ）。
 * SQL を組み立てているのは書き込みだけである（`write.ts`）。
 */

/** 走行を1つに指す鍵。`rides` の主キー `(device_id, log_id)` をそのまま文字列にしたもの。 */
export function rideKey(ref: RideRef): string {
  return `${ref.deviceId}/${ref.logId}`;
}

/**
 * 走行を古い順に読む。**`limit` は「上限 + 1」を渡すこと。**
 *
 * 多すぎるかどうかを数えるために別のクエリを投げると、**1回の呼び出しで投げられるクエリ
 * （D1 は 50 個まで）を、数えるためだけに1つ使う。**1件多く取れば同じことが分かる。
 */
export async function listRides(
  db: DrizzleD1Database,
  limit: number,
  offset = 0,
): Promise<RideRef[]> {
  return await db
    .select({ deviceId: rides.deviceId, logId: rides.logId })
    .from(rides)
    // **並びを最後まで決め切る。**開始時刻だけだと同時刻の走行の順が実装依存になり、
    // **`skip` で送っても飛ばされる走行が毎回変わる**（＝計算されない走行が残る）。
    .orderBy(asc(rides.startedAt), asc(rides.deviceId), asc(rides.logId))
    .limit(limit)
    .offset(offset)
    .all();
}

/**
 * 対象の走行の測位点を、**走行ごとにまとめて**返す。
 *
 * **1回のクエリで読む。**走行ごとに投げると 20 走行で 20 クエリになり、
 * **標識の読み取りと書き戻しを足すと D1 の上限（1回の呼び出しで 50 クエリ）に近づく。**
 *
 * **精度で足切りをここでしない。**落とすのは判定の中（`judge.ts`）で、
 * **そのときのしきい値で決める**——ここで落とすと、`points` の数え上げが
 * 「読んだ数」ではなく「使った数」になり、しきい値を変えたときの比較ができなくなる。
 */
export async function readRidePoints(
  db: DrizzleD1Database,
  targets: readonly RideRef[],
): Promise<Map<string, JudgePoint[]>> {
  const byRide = new Map<string, JudgePoint[]>();
  for (const target of targets) byRide.set(rideKey(target), []);
  if (targets.length === 0) return byRide;

  const rows = await db
    .select({
      deviceId: ridePoints.deviceId,
      logId: ridePoints.logId,
      t: ridePoints.t,
      lat: ridePoints.lat,
      lon: ridePoints.lon,
      spd: ridePoints.spd,
      hacc: ridePoints.hacc,
    })
    .from(ridePoints)
    .where(
      or(
        ...targets.map((target) =>
          and(eq(ridePoints.deviceId, target.deviceId), eq(ridePoints.logId, target.logId)),
        ),
      ),
    )
    .orderBy(asc(ridePoints.t))
    .all();

  for (const { deviceId, logId, ...point } of rows) {
    byRide.get(rideKey({ deviceId, logId }))?.push(point);
  }
  return byRide;
}

/** 緯度経度の矩形。 */
export type BoundingBox = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

const M_PER_DEG_LAT = 111_320;

/**
 * 測位点を囲む矩形を、指定した距離だけ広げて返す。**点が無ければ `null`。**
 *
 * **経度の余白は緯度で変わる**（高緯度ほど1度が短い）。**一番赤道から遠い点の緯度で計算する**
 * ——そこが一番余白を要する。cos が 0 に近づくと余白が発散するので下限で止めてあるが、
 * **岡山県（北緯 35 度前後）では効かない。**
 */
export function boundingBoxOf(
  points: readonly { lat: number; lon: number }[],
  padM: number,
): BoundingBox | null {
  const first = points[0];
  if (!first) return null;

  let minLat = first.lat;
  let maxLat = first.lat;
  let minLon = first.lon;
  let maxLon = first.lon;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const latPad = padM / M_PER_DEG_LAT;
  const farthestFromEquator = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const shrink = Math.max(Math.cos((farthestFromEquator * Math.PI) / 180), 0.1);
  const lonPad = padM / (M_PER_DEG_LAT * shrink);

  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLon: minLon - lonPad,
    maxLon: maxLon + lonPad,
  };
}

/**
 * 読み込んだ標識から、矩形の中のものだけを選ぶ。**D1 を触らない。**
 *
 * **標識は再計算で1回しか読まない**（下）が、**その矩形は全走行を囲んだもの**である。
 * **離れた場所を走った走行が混ざると、矩形は県ぶんに膨らむ**——そのまま全部の標識を
 * 1走行の判定に渡すと、**判定は「測位点 × 標識」を回る**ので二乗で効く。
 * **走行ごとにもう一度、その走行の矩形で絞る。**
 */
export function signsInBox(signs: readonly JudgeSign[], box: BoundingBox): JudgeSign[] {
  return signs.filter(
    (s) => s.lat >= box.minLat && s.lat <= box.maxLat && s.lon >= box.minLon && s.lon <= box.maxLon,
  );
}

/**
 * 矩形の中の標識を読む。
 *
 * **都道府県コードで絞らない。**走行がどの県を走ったかは、走った場所そのものが決めることで、
 * **県境をまたいだ走行を県で絞ると、境の向こう側の標識だけが黙って落ちる。**
 *
 * **`stop_signs` の緯度に索引がある**（`db/schema.ts` の `stop_signs_lat_idx`）ので、
 * 走査するのは**矩形の緯度の帯に入る行だけ**である（岡山市内を1回走ったぶんで
 * 28,651 行のうち 2,418 行。#113）。**経度は索引で絞れない**——SQLite が範囲条件に
 * 索引を使えるのは1列までなので、帯の中は行を見て落とす。
 *
 * **それでも1回の再計算につき1度だけ**引く形は変えないこと。帯が数千行残るうえ、
 * **走行ごとに引き直すと走行の数だけクエリが増える。**
 */
export async function readSignsInBox(
  db: DrizzleD1Database,
  box: BoundingBox,
): Promise<JudgeSign[]> {
  return await db
    .select({
      id: stopSigns.id,
      lat: stopSigns.lat,
      lon: stopSigns.lon,
      approachLat: stopSigns.approachLat,
      approachLon: stopSigns.approachLon,
    })
    .from(stopSigns)
    .where(
      and(
        gte(stopSigns.lat, box.minLat),
        lte(stopSigns.lat, box.maxLat),
        gte(stopSigns.lon, box.minLon),
        lte(stopSigns.lon, box.maxLon),
      ),
    )
    .all();
}
