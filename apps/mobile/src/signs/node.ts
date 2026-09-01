/**
 * Node 上で `signs.db` を作る・開く（`better-sqlite3`）。
 *
 * **アプリからこのファイルを import しないこと。**`better-sqlite3` はネイティブの
 * 拡張で、React Native では動かない（実機は `./expo.ts`）。**使うのは2か所だけ**——
 * `scripts/build-signs-db.ts`（同梱物の生成）と Vitest（`./store.test.ts`）である。
 *
 * **実機と同じ SQL をここで回すことに意味がある。**メモリ実装だけだと
 * 「メモリでは通るが実機の SQL が間違っている」が素通りする
 * （`docs/adr/0009-on-device-storage.md`「5」）。
 */

import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { StopSign } from "../detect/types";
import { cellOf } from "./cell.ts";
import { meta as metaTable, SIGNS_DDL, signs as signsTable } from "./schema.ts";
import { createDrizzleSignStore, type SignStore, type SignsMeta } from "./store.ts";

/**
 * 1回の `INSERT` にまとめる件数。
 *
 * SQLite には1文あたりのパラメータ数の上限があるので、全件を1文に入れない
 * （**数万件で必ず超える**）。8列 × 500 行 = 4000 個で、既定の上限に十分収まる。
 */
const INSERT_CHUNK = 500;

/** 開いた `signs.db`。**使い終わったら {@link SignsDatabase.close} を呼ぶ。** */
export type SignsDatabase = {
  store: SignStore;
  close(): void;
};

/**
 * `signs.db` をまっさらから作る。**既にあれば消してから作り直す。**
 *
 * **更新は丸ごと入れ替え**（`docs/interfaces/mobile-api.md`「差分を作らない」）なので、
 * 追記も移行もしない。`file` に `":memory:"` を渡せばファイルを作らずに済む（テスト用）。
 *
 * @param meta `count` は渡された `signs` の件数と一致すること（呼び出し側で突き合わせる）
 */
export function buildSignsDatabase(
  file: string,
  meta: SignsMeta,
  signs: readonly StopSign[],
): SignsDatabase {
  if (file !== ":memory:") rmSync(file, { force: true });

  const raw = new Database(file);
  const db = drizzle(raw);
  raw.exec(SIGNS_DDL);

  const rows = signs.map((sign) => {
    const cell = cellOf(sign.lat, sign.lon);
    return {
      id: sign.id,
      pref: meta.pref,
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

  // **1件ずつ書かない。**数万件を1件ずつ commit すると、生成に何分もかかる。
  raw.transaction(() => {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      db.insert(signsTable)
        .values(rows.slice(i, i + INSERT_CHUNK))
        .run();
    }
    db.insert(metaTable)
      .values({ id: 1, ...meta })
      .run();
  })();

  return { store: createDrizzleSignStore(db), close: () => raw.close() };
}

/** できあがった `signs.db` を読む（生成の確認と、テストで作り直さずに引くため）。 */
export function openSignsDatabase(file: string): SignsDatabase {
  const raw = new Database(file, { readonly: true });
  return { store: createDrizzleSignStore(drizzle(raw)), close: () => raw.close() };
}
