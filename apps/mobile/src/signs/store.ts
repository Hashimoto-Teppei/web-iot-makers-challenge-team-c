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
 *
 * **読む口（`SignStore`）と書く口（`SignWriter`）を分けてある。**走行ループと検知が
 * 触れるのは読む方だけで、**書けるものを渡すと、1Hz の経路から標識を書き換えられる**
 * ——更新は起動時にしか走らない（`docs/interfaces/stop-signs-delivery.md`
 * 「取るのはアプリの起動時。走行中は取りに行かない」）。
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
  /** サーバーが返した `ETag` そのまま（`docs/interfaces/stop-signs-delivery.md`） */
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
 * 標識の入れ替え口。**丸ごと差し替えるだけで、差分を当てる道は持たない**
 * （`docs/interfaces/stop-signs-delivery.md`「差分を作らない」）。
 *
 * **1件でも失敗したら1件も変わらないこと。**途中まで書けた状態を残すと、
 * **どこが古いのか誰にも分からない `signs.db`** が端末に残る。
 * SQL 実装はトランザクションで囲んでこれを満たす（{@link createDrizzleSignWriter}）。
 */
export type SignWriter = {
  /**
   * 手元の標識を、渡されたもので丸ごと置き換える。
   *
   * @param meta 新しい素性。**`version` はサーバーが返した ETag そのまま**
   *   （端末で作らない。`docs/interfaces/stop-signs-delivery.md`「版はサーバーが決める」）
   * @param signs 新しい標識の全件。**空を渡さない**——0 件で入れ替えると
   *   **何も持っていない端末**ができる。呼ぶ前に弾くのは `./update.ts` の仕事
   */
  replace(meta: SignsMeta, signs: readonly StopSign[]): void;
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
  return createMemorySigns(signs, meta).store;
}

/**
 * メモリ実装の、**書ける方**。読む口と書く口が同じ中身を見る。
 *
 * **更新（`./update.ts`）のテストはこれで回す。**同じテストを `better-sqlite3` にも
 * 回すこと（`./store.test.ts`）——**入れ替えの SQL こそ、間違えると
 * 「何も持っていない端末」を作る**側である。
 */
export function createMemorySigns(
  signs: readonly StopSign[] = [],
  meta: SignsMeta | null = null,
): { store: SignStore; writer: SignWriter } {
  // **入れ替えで差し替わる**ので、引数をそのまま閉じ込めない。
  let current: readonly StopSign[] = signs;
  let currentMeta = meta;

  return {
    store: {
      near(lat, lon) {
        const range = cellRange(cellOf(lat, lon));
        return current.filter((sign) => {
          const cell = cellOf(sign.lat, sign.lon);
          return (
            cell.lat >= range.latMin &&
            cell.lat <= range.latMax &&
            cell.lon >= range.lonMin &&
            cell.lon <= range.lonMax
          );
        });
      },
      meta: () => currentMeta,
    },
    writer: {
      replace(nextMeta, nextSigns) {
        // **SQL 実装と同じ順で、同じものだけを差し替える。**片方だけ更新する道を作らない。
        current = [...nextSigns];
        currentMeta = nextMeta;
      },
    },
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
      // 「その県に標識が無い」は別のこと（`docs/interfaces/stop-signs-delivery.md`）。
      return row ?? null;
    },
  };
}

/**
 * 1回の `INSERT` にまとめる件数。
 *
 * SQLite には1文あたりのパラメータ数の上限があるので、全件を1文に入れない
 * （**数万件で必ず超える**）。8列 × 500 行 = 4000 個で、既定の上限に十分収まる。
 */
const INSERT_CHUNK = 500;

/**
 * SQL の入れ替え実装。**`better-sqlite3`（生成・テスト）と `expo-sqlite`（実機）で同じもの。**
 *
 * **トランザクションで囲む。**囲まないと、**消したあとで落ちた端末が「何も持っていない端末」**
 * になる（`docs/interfaces/stop-signs-delivery.md`「差分を作らない」）。
 * Drizzle の同期ドライバは `begin` / `commit` / `rollback` をそのまま流すので、
 * **落ちれば消す前の状態に戻る**（`drizzle-orm/expo-sqlite` の `session.js` で確認済み）。
 */
export function createDrizzleSignWriter(db: SyncSqliteDatabase): SignWriter {
  return {
    replace(meta, signs) {
      const rows = toSignRows(meta.pref, signs);

      db.transaction((tx) => {
        // **`meta` を先に消す。**途中で落ちれば丸ごと巻き戻るので順序は本来どちらでもよいが、
        // **「素性が無い＝持っていない」を先に立てておく**方が、万一トランザクションが
        // 効かないドライバに差し替わったときの壊れ方が軽い（0 件ではなく `null` になる）。
        tx.delete(metaTable).run();
        tx.delete(signsTable).run();

        // **1件ずつ書かない。**数万件を1件ずつ commit すると、生成に何分もかかる。
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          tx.insert(signsTable)
            .values(rows.slice(i, i + INSERT_CHUNK))
            .run();
        }
        tx.insert(metaTable)
          .values({ id: 1, ...meta })
          .run();
      });
    },
  };
}

/** `StopSign` を `signs` の行にする。**セルはここで計算する**（配られてくるのは位置だけ）。 */
function toSignRows(pref: number, signs: readonly StopSign[]) {
  return signs.map((sign) => {
    const cell = cellOf(sign.lat, sign.lon);
    return {
      id: sign.id,
      pref,
      lat: sign.lat,
      lon: sign.lon,
      // **セルは規制地点で切る。**進入方向の点では切らない——引きたいのは
      // 「近づいている標識」であって、その手前の点ではない。
      latCell: cell.lat,
      lonCell: cell.lon,
      approachLat: sign.approach?.lat ?? null,
      approachLon: sign.approach?.lon ?? null,
    };
  });
}
