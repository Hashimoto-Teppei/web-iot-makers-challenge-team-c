/**
 * Node 上で `app.db` を開く（`better-sqlite3`）。**使うのは Vitest だけ。**
 *
 * **アプリからこのファイルを import しないこと。**`better-sqlite3` はネイティブの
 * 拡張で、React Native では動かない（実機は `./expo.ts`）。
 *
 * **実機と同じ SQL をここで回すことに意味がある**（`docs/adr/0009-on-device-storage.md`「5」）。
 * 走行ログの表は**アプリが書く**ので、標識と違って「読めるか」だけでは足りない
 * ——採番も、送信済みの印も、ここで確かめる。
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateAppDatabase } from "./schema";
import { createRideLogStore, type RideLogStore } from "./store";

export type AppDatabase = {
  store: RideLogStore;
  close(): void;
};

/**
 * `app.db` を開いて、足りない移行を流す。
 *
 * @param file `":memory:"` を渡せばファイルを作らない（テスト用）
 */
export function openAppDatabase(
  file: string,
  options: { random?: () => number } = {},
): AppDatabase {
  const raw = new Database(file);
  const db = drizzle(raw);
  migrateAppDatabase(db);
  return { store: createRideLogStore(db, options), close: () => raw.close() };
}
