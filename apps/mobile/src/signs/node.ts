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
import { SIGNS_DDL } from "./schema.ts";
import {
  createDrizzleSignStore,
  createDrizzleSignWriter,
  type SignStore,
  type SignsMeta,
  type SignWriter,
} from "./store.ts";

/** 開いた `signs.db`。**使い終わったら {@link SignsDatabase.close} を呼ぶ。** */
export type SignsDatabase = {
  store: SignStore;
  /**
   * 入れ替え口。**{@link openSignsDatabase} で開いたものは読み取り専用なので、呼ぶと落ちる。**
   * **それでよい**——読むつもりで開いたものに書けてしまう方が危ない。
   */
  writer: SignWriter;
  close(): void;
};

/**
 * `signs.db` をまっさらから作る。**既にあれば消してから作り直す。**
 *
 * **更新は丸ごと入れ替え**（`docs/interfaces/stop-signs-delivery.md`「差分を作らない」）なので、
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

  // **書き込みは実機と同じ実装を通す**（`./store.ts`）。ここに別の `INSERT` を書くと、
  // **生成では通るが起動時の入れ替えで壊れる**（またはその逆）という差が生まれる。
  const writer = createDrizzleSignWriter(db);
  writer.replace(meta, signs);

  return { store: createDrizzleSignStore(db), writer, close: () => raw.close() };
}

/**
 * できあがった `signs.db` を**読み取り専用で**開く（生成の確認のため）。
 *
 * **書ける口は用意しない。**入れ替えの SQL を Node で確かめるときは
 * {@link buildSignsDatabase} で作った方の `writer` を使う（`./store.test.ts`）。
 */
export function openSignsDatabase(file: string): SignsDatabase {
  const raw = new Database(file, { readonly: true });
  const db = drizzle(raw);
  return {
    store: createDrizzleSignStore(db),
    writer: createDrizzleSignWriter(db),
    close: () => raw.close(),
  };
}
