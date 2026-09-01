/**
 * 実機で `app.db` を開く（`expo-sqlite`）。
 *
 * **このファイルだけが React Native に触れる。**`./store.ts` も `./sync.ts` も
 * `expo-sqlite` を知らないので、走行ループと送信の組み立ては実機なしで回せる
 * （`docs/adr/0002-development-lifecycle.md`）。
 *
 * **`<SQLiteProvider>` を使わない。**標識（`../signs/expo.ts`）が既に Provider で
 * `signs.db` を開いており、**入れ子にすると `useSQLiteContext()` が内側だけを返す**
 * ——標識を読んでいるつもりで `app.db` を引くことになる。**開くファイルが2つある以上、
 * 名前で取り違えようのない形にする。**
 *
 * **同梱物が無いので、`assetSource` も要らない。**この DB は空から作られる
 * （`./schema.ts` の移行）。
 */

import { drizzle } from "drizzle-orm/expo-sqlite";
import { openDatabaseSync } from "expo-sqlite";
import { migrateAppDatabase } from "./schema";
import { createDiscardingRideLogStore, createRideLogStore, type RideLogStore } from "./store";

/**
 * 端末の中でのファイル名。**`signs.db` と必ず別のファイル**
 * （`docs/adr/0009-on-device-storage.md`「2」）。
 */
export const APP_DATABASE_NAME = "app.db";

/**
 * 開いた結果。**開けなかったことを `null` で表さない**——受け取る側が
 * 「まだ開いていない」と取り違え、**記録できていないことが画面に出ないまま走る。**
 */
export type RideLogStorage = {
  /** 保存層。**開けなかったときは何も残さない実装**が入る（`./store.ts`） */
  store: RideLogStore;
  /** 開けなかった理由。**開けていれば `null`** */
  error: string | null;
};

/**
 * アプリの中で1つだけ持つ。
 *
 * **開き直さない。**走行中に書き込む口なので、画面が再描画されるたびに開くと
 * **同じファイルへの接続が増え続ける。**
 *
 * **開けなかった結果も覚える。**毎回開き直すと、**返る `store` が描画のたびに
 * 別のものになり**、それを依存に持つフックが延々と回り続ける
 * （`./use-ride-log-sync.ts` の `useEffect`）。**次の起動でやり直す。**
 */
let opened: RideLogStorage | null = null;

/**
 * 走行ログの保存層。**初回の呼び出しで開いて移行する。**
 *
 * **投げない。**画面のレンダーの中から呼ばれるので、投げると**ホーム画面ごと落ちて
 * 走行を始められなくなる**——記録できないことより、**検知が動かないことの方が危険**である
 * （`docs/unverified.md` 67）。
 */
export function getRideLogStore(): RideLogStorage {
  if (opened !== null) return opened;

  try {
    const db = drizzle(openDatabaseSync(APP_DATABASE_NAME));
    migrateAppDatabase(db);
    opened = { store: createRideLogStore(db), error: null };
  } catch (reason: unknown) {
    opened = {
      store: createDiscardingRideLogStore(),
      error: `走行ログを開けません（この端末では走行が記録されません）: ${String(reason)}`,
    };
  }
  return opened;
}
