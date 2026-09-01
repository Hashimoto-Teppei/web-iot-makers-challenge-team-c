/**
 * 標識の保存層の口（`SignStore`）と、その3つの実装のうち2つ。
 *
 * ```
 * Vitest（既定）            → createMemorySignStore    （このファイル）
 * Vitest（SQL を確かめる）   → better-sqlite3           （./node.ts）
 * 実機                      → expo-sqlite              （./expo.ts）
 * ```
 *
 * **走行ループも検知も SQL を知らない**（`docs/adr/0009-on-device-storage.md`）。
 * ここを通すことで、**実機なしで検知とループを回せる**という土台
 * （`docs/adr/0002-development-lifecycle.md`）を SQLite を入れても壊さずに済む。
 *
 * **メモリ実装だけにしないこと。**「メモリ実装は通るが実機の SQL が間違っている」が
 * 素通りするので、`better-sqlite3` の実装を必ず併置して**同じテスト**を回す
 * （`./store.test.ts`）。
 */

import { and, between, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
// **相対 import に `.ts` を付けているのは、このファイルを Node から直接読むため**
// （同梱物を作る `scripts/build-signs-db.ts` がここを通る。Node の ESM 解決は
// 拡張子を省けない）。Metro も Vitest もそのまま解決する。
import type { StopSign } from "../detect/types";
import { cellOf, cellRange } from "./cell.ts";
import { meta as metaTable, signs as signsTable } from "./schema.ts";

/** 手元の標識が何県ぶんの、いつの、何件か。`signs.db` の `meta` の1行。 */
export type SignsMeta = {
  /** 都道府県コード（岡山県 = 33） */
  pref: number;
  /** サーバーが返した `ETag` そのまま（`docs/interfaces/mobile-api.md`） */
  version: string;
  /** 件数。**0 なら走行を始めさせない**（`docs/adr/0009-on-device-storage.md`） */
  count: number;
  /** 同梱物を作った時刻（ISO 8601、UTC） */
  builtAt: string;
};

/**
 * 標識の引き出し口。**実装は差し替えられるが、口はこれ1つ。**
 *
 * **同期で読む。**`expo-sqlite` も `better-sqlite3` も同期の API を持っており、
 * 走行ループ（1Hz）の中で `await` を挟まずに引ける。非同期にすると、
 * **測位のコールバックの中に待ちが1つ増える**（`docs/unverified.md` 59）。
 */
export type SignStore = {
  /**
   * その地点の近傍（自セル + 周囲8セル）の標識。
   *
   * **半径では絞らない。**距離と方角を見るのは検知の仕事で（#27）、
   * ここは「検知に渡す候補を、県ぶんの全件から常識的な数まで減らす」だけである。
   */
  near(lat: number, lon: number): readonly StopSign[];
  /** 手元の標識の素性。**持っていなければ `null`**（0 件とは違う） */
  meta(): SignsMeta | null;
};

/**
 * メモリ実装。**Vitest の既定**であり、シミュレータもこれを使う。
 *
 * **`near()` の意味を SQL 実装と1文字も変えないこと。**ここでの絞り込みが
 * 半径や件数の上限に変わると、**メモリでは鳴るが実機では鳴らない検知**ができあがる。
 */
export function createMemorySignStore(
  signs: readonly StopSign[],
  meta: SignsMeta | null = null,
): SignStore {
  return {
    near(lat, lon) {
      const range = cellRange(cellOf(lat, lon));
      return signs.filter((sign) => {
        const cell = cellOf(sign.lat, sign.lon);
        return (
          cell.lat >= range.latMin &&
          cell.lat <= range.latMax &&
          cell.lon >= range.lonMin &&
          cell.lon <= range.lonMax
        );
      });
    },
    meta: () => meta,
  };
}

/**
 * Drizzle の同期ドライバなら何でも受ける型。
 *
 * **`better-sqlite3`（Node）と `expo-sqlite`（実機）の両方がこれに当てはまる。**
 * おかげで {@link createDrizzleSignStore} は1つで済み、**テストで回した SQL が
 * そのまま実機で動く**（`docs/adr/0009-on-device-storage.md`）。
 */
// biome-ignore lint/suspicious/noExplicitAny: ドライバごとに違う型（実行結果・スキーマ）を受けるための口。
export type SyncSqliteDatabase = BaseSQLiteDatabase<"sync", any>;

/**
 * SQL 実装。**`better-sqlite3` と `expo-sqlite` で同じものを使う。**
 *
 * **走行ループから見えるのは `SignStore` だけ**なので、ここに検知の都合
 * （半径・件数の上限・並び順）を持ち込まない。
 */
export function createDrizzleSignStore(db: SyncSqliteDatabase): SignStore {
  // **文を1回だけ用意して使い回す。**Drizzle の expo-sqlite ドライバは
  // 引くたびに `prepareSync()` を呼び、**終わった文を片付けない**
  // （後始末は DB を閉じたときだけ）。走行のたびに引き直すこの経路で毎回作ると、
  // **長い走行で用意した文が端末に溜まり続ける。**
  const nearQuery = db
    .select({
      id: signsTable.id,
      lat: signsTable.lat,
      lon: signsTable.lon,
      approachLat: signsTable.approachLat,
      approachLon: signsTable.approachLon,
    })
    .from(signsTable)
    .where(
      and(
        between(signsTable.latCell, sql.placeholder("latMin"), sql.placeholder("latMax")),
        between(signsTable.lonCell, sql.placeholder("lonMin"), sql.placeholder("lonMax")),
      ),
    )
    .prepare();

  const metaQuery = db
    .select({
      pref: metaTable.pref,
      version: metaTable.version,
      count: metaTable.count,
      builtAt: metaTable.builtAt,
    })
    .from(metaTable)
    .limit(1)
    .prepare();

  return {
    near(lat, lon) {
      const rows = nearQuery.all(cellRange(cellOf(lat, lon)));

      return rows.map(({ id, lat: signLat, lon: signLon, approachLat, approachLon }) => ({
        id,
        lat: signLat,
        lon: signLon,
        // 片方だけある行は作らない（生成の時点で両方そろえて入れる）。
        approach:
          approachLat !== null && approachLon !== null
            ? { lat: approachLat, lon: approachLon }
            : null,
      }));
    },
    meta() {
      const [row] = metaQuery.all();

      // **行が無いことを 0 件に潰さない。**「まだ持っていない」と
      // 「その県に標識が無い」は別のこと（`docs/interfaces/mobile-api.md`）。
      return row ?? null;
    },
  };
}
