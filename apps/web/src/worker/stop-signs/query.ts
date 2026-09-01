import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { StopSign } from "../../shared/api";
import { stopSigns, stopSignVersions } from "../db/schema";

/**
 * その都道府県の版を読む。**取り込まれていなければ `null`。**
 *
 * **標識の本体と分けて読めるようにしてある。**ETag は版だけで決まるので、
 * `304` を返すときに数万行を D1 から引く必要がない——**アプリの起動のたびに
 * 県ぶんを読み出して捨てることになる**（`304` は例外ではなく通常の応答である。
 * `docs/interfaces/mobile-api.md`「版はサーバーが決める」）。
 *
 * **「取り込まれていない」と「0 件」を混ぜない**（`docs/interfaces/mobile-api.md`
 * 「『持っていない』と『0件』を混ぜない」）。空の配列を返すと、端末からは
 * 「その県には標識が1つも無い」と区別が付かず、**静かに黙るアプリが出来上がる。**
 * 呼び出し側はこの `null` を 404 にする。
 */
export async function readStopSignVersion(
  db: DrizzleD1Database,
  pref: number,
): Promise<{ version: string; count: number } | null> {
  const [row] = await db
    .select({ version: stopSignVersions.version, count: stopSignVersions.count })
    .from(stopSignVersions)
    .where(eq(stopSignVersions.pref, pref))
    .limit(1);

  return row ?? null;
}

/**
 * その都道府県の標識を丸ごと読む。
 *
 * **絞り込みは都道府県コードだけ。位置を引数に取らない**——取ると、走り出す前に
 * 現在地をサーバーへ送ることになる（`docs/interfaces/mobile-api.md`）。
 */
export async function readStopSigns(db: DrizzleD1Database, pref: number): Promise<StopSign[]> {
  // id で並べるのは、同じ版なら毎回同じ並びで返すため。端末は丸ごと入れ替えるので
  // 並び自体に意味は無いが、**差分を目で見るときに並びが揺れると比べられない。**
  const rows = await db
    .select({
      id: stopSigns.id,
      lat: stopSigns.lat,
      lon: stopSigns.lon,
      approachLat: stopSigns.approachLat,
      approachLon: stopSigns.approachLon,
    })
    .from(stopSigns)
    .where(eq(stopSigns.pref, pref))
    .orderBy(stopSigns.id)
    .all();

  // **交差点名称は配らない。**走行中のディスプレイに文章は出せず（`CLAUDE.md`）、
  // 数万件ぶんの文字列は同梱物をそのまま重くする。D1 には残してある。
  return rows.map(({ id, lat, lon, approachLat, approachLon }) => ({
    id,
    lat,
    lon,
    // 片方だけある行は作らない（取り込みが両方そろえて入れる）。
    approach:
      approachLat !== null && approachLon !== null ? { lat: approachLat, lon: approachLon } : null,
  }));
}
