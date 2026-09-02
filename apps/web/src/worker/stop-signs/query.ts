import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { StopSign, StopSignPref } from "../../shared/api";
import { stopSigns, stopSignVersions } from "../db/schema";

/**
 * その都道府県の版を読む。**取り込まれていなければ `null`。**
 *
 * **標識の本体と分けて読めるようにしてある。**ETag は版だけで決まるので、
 * `304` を返すときに数万行を D1 から引く必要がない——**アプリの起動のたびに
 * 県ぶんを読み出して捨てることになる**（`304` は例外ではなく通常の応答である。
 * `docs/interfaces/stop-signs-delivery.md`「版はサーバーが決める」）。
 *
 * **「取り込まれていない」と「0 件」を混ぜない**（`docs/interfaces/stop-signs-delivery.md`
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
 * 現在地をサーバーへ送ることになる（`docs/interfaces/stop-signs-delivery.md`）。
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

  // **返すのは端末に配るぶんだけ**（`StopSign`）。いまは D1 の列もこれで全部だが、
  // **配らない列を足したときにここへ混ぜない**こと——同梱物がそのぶん重くなる。
  return rows.map(({ id, lat, lon, approachLat, approachLon }) => ({
    id,
    lat,
    lon,
    // 片方だけある行は作らない（取り込みが両方そろえて入れる）。
    approach:
      approachLat !== null && approachLon !== null ? { lat: approachLat, lon: approachLon } : null,
  }));
}

/**
 * 取り込んである県を全部読む。**選択肢を作るのはこの結果だけ**
 * （`docs/interfaces/stop-signs-delivery.md`「どの県を選べるかはサーバーが決める」）。
 *
 * **標識の本体は読まない。**読むのは版の表だけなので、県が増えても数十行で済む。
 *
 * **1件も無いときは空の配列。**ここは `null` と分けない——**上の
 * {@link readStopSignVersion} と違い、「県を1つも取り込んでいない」ことは
 * そのまま「選べる県が無い」**であって、区別すべき2つの状態が無い。
 */
export async function readStopSignPrefs(db: DrizzleD1Database): Promise<StopSignPref[]> {
  // 県コード順に返す。**並びが揺れると、選択画面の並びが起動のたびに変わる。**
  return await db
    .select({
      pref: stopSignVersions.pref,
      version: stopSignVersions.version,
      count: stopSignVersions.count,
    })
    .from(stopSignVersions)
    .orderBy(stopSignVersions.pref)
    .all();
}
