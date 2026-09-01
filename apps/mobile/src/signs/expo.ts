/**
 * 実機で `signs.db` を開く（`expo-sqlite`）。
 *
 * **このファイルだけが React Native に触れる。**`./store.ts` も `./nearby.ts` も
 * `expo-sqlite` を知らないので、走行ループと検知は実機なしで回せる
 * （`docs/adr/0002-development-lifecycle.md`）。
 *
 * **同梱物（`assets/signs.db`）は生成物で、リポジトリに無い。**
 * 作っていないと **Metro がここで解決に失敗してビルドが止まる**——
 * それが狙いである（`docs/adr/0009-on-device-storage.md`「7」）。
 * 作り方は `docs/setup.md`。
 */

import { drizzle } from "drizzle-orm/expo-sqlite";
import { type SQLiteDatabase, type SQLiteProviderAssetSource, useSQLiteContext } from "expo-sqlite";
import { useMemo } from "react";
// Metro の資産として読み込む。返るのは中身ではなく資産の ID である
// （`src/types/assets.d.ts`）。`metro.config.js` の `assetExts` に `db` を足してある。
import signsAssetId from "../../assets/signs.db";
import { createDrizzleSignStore, type SignStore, type SignsMeta } from "./store";

/**
 * 端末の中でのファイル名。**`app.db`（アプリが書く方）と必ず別のファイルにする**
 * ——1つにまとめると、標識の更新で走行ログが消える（`docs/adr/0009-on-device-storage.md`）。
 */
export const SIGNS_DATABASE_NAME = "signs.db";

/**
 * 同梱した `signs.db` の在り処。`<SQLiteProvider assetSource={...}>` に渡す。
 *
 * **`forceOverwrite` を付けない。**このファイルはアプリが書かないので上書きの必要が無く、
 * 付ける癖がそのまま `app.db` へ移ると**走行ログが毎回消える。**
 *
 * **その代わり、同梱物は端末に `signs.db` が無いときしかコピーされない。**
 * 作り直して入れ直しても、**アプリを消さない限り端末の中身は古いまま**である
 * （設定画面には古い版と件数が「そろっている」顔で出る）。
 * **いまは入れ直す前にアプリを消す**しかない。手順は `docs/setup.md`。
 * 版で入れ替える仕組みは、起動時の更新（`GET /api/stop-signs` + `If-None-Match`）と
 * 一緒に入れる——**どちらも「手元の版とサーバーの版を見比べる」同じ処理**である。
 */
export const signsAssetSource: SQLiteProviderAssetSource = { assetId: signsAssetId };

/** 開いてある `signs.db` から口を作る。**引く SQL は Node のテストと同じもの。** */
export function createExpoSignStore(db: SQLiteDatabase): SignStore {
  return createDrizzleSignStore(drizzle(db));
}

/**
 * 画面から使う。**`<SQLiteProvider>` の内側でだけ呼べる**（`src/app/_layout.tsx`）。
 *
 * これをそのまま `useRideLoop()` に渡す。**セルをまたいだときだけ引き直すのは
 * 走行ループ側**（`./nearby.ts` を `../ride/use-ride-loop.ts` が使う）。
 */
export function useSignStore(): SignStore {
  const db = useSQLiteContext();
  // 画面が再描画されるたびに口を作り直さない（作り直しても壊れないが、意味が無い）。
  return useMemo(() => createExpoSignStore(db), [db]);
}

/**
 * 手元の標識の素性（件数・版）。**走行前の画面が読む。**
 *
 * **描画のたびに引き直さない。**`signs.db` はアプリが書かないので、
 * 起動している間この値は変わらない（更新は丸ごと入れ替えで、次の起動から効く。
 * `docs/interfaces/mobile-api.md`「差分を作らない」）。
 */
export function useSignsMeta(store: SignStore): SignsMeta | null {
  return useMemo(() => store.meta(), [store]);
}
