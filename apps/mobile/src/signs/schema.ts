/**
 * 端末が持つ標識のデータベース（`signs.db`）のスキーマ。
 *
 * **`apps/web` の D1 とスキーマを共有しない**（列も目的も別物。
 * `docs/adr/0009-on-device-storage.md`）。**`app.db`（走行ログ）とも混ぜない**——
 * 同梱した DB は既にファイルがあると上書きされないため、1つにまとめると
 * **標識の更新で走行ログごと初期状態に戻る。**
 *
 * **このファイルは書き込みを想定していない。**`signs.db` を作るのは
 * `scripts/build-signs-db.ts` だけで、アプリは読むだけである。
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 一時停止の標識。**1件が1つの進入方向**を表す
 * （`docs/interfaces/mobile-api.md`「進入方向を一緒に配る」）。
 */
export const signs = sqliteTable(
  "signs",
  {
    /**
     * D1 の `stop_signs.id` をそのまま持つ。
     * **警告の抑制キー（`causeId`）になる**ので、取り込み直しても値が変わらないこと
     * （`apps/mobile/src/ride/warn-gate.ts`）。
     */
    id: text("id").primaryKey(),
    /**
     * 都道府県コード（岡山県 = 33）。
     *
     * **当面この DB は1県ぶんしか持たない**ので、この列は必ず `meta.pref` と一致する。
     * **画面に出す県は `meta` を読む**こと——「この DB が何県ぶんか」を決めるのは
     * `meta` であって、行ではない（#71 で県を選べるようにするときも、
     * 入れ替えるのは DB ごとである）。
     */
    pref: integer("pref").notNull(),
    /** 規制地点の緯度（度、WGS84）。**停止線の位置とは限らず、交差点中央部のこともある** */
    lat: real("lat").notNull(),
    /** 規制地点の経度（度、WGS84） */
    lon: real("lon").notNull(),
    /**
     * **この標識が対象とする車両の進入方向**を表す点。この点から規制地点へ向かって
     * 走る車両が規制の対象になる。**`null` は「全方向が対象」ではなく
     * 「元データに登録が無い」**（`../detect/types.ts` の `StopSign`）。
     */
    approachLat: real("approach_lat"),
    approachLon: real("approach_lon"),
    /**
     * 規制地点が入るセル（`./cell.ts`）。**走行中はこの2列だけで絞る。**
     *
     * **緯度経度そのもので範囲検索しない。**セルにしておくと整数の索引1つで済み、
     * 切り方が集計（`docs/interfaces/web-service.md`）と同じになる。
     */
    latCell: integer("lat_cell").notNull(),
    lonCell: integer("lon_cell").notNull(),
  },
  (table) => [
    // **索引が無いと、毎周期 数万行を走査する。**1Hz で回るので効いてくる
    // （`docs/unverified.md` 59）。
    index("signs_cell").on(table.latCell, table.lonCell),
  ],
);

/**
 * この DB が何を持っているか。**必ず1行だけ**。
 *
 * **件数と版は人に見せるためのもの**でもある——標識を持っていないことは
 * 「近くに標識が無い」と区別が付かず、デバイスの表示では絶対に気づけない
 * （`docs/interfaces/mobile-api.md`「『持っていない』と『0件』を混ぜない」）。
 */
export const meta = sqliteTable("meta", {
  /**
   * 常に 1。**2行目を入れられないようにするための固定値**であって、意味は無い。
   * （SQLite に「1行しか持てないテーブル」は無いので、主キーを固定して代用する。）
   */
  id: integer("id").primaryKey(),
  /** 都道府県コード（岡山県 = 33） */
  pref: integer("pref").notNull(),
  /**
   * 版。**サーバーが返した `ETag` をそのまま入れる**（引用符ごと）。
   *
   * **端末が独自の版番号を作らない**（`docs/interfaces/mobile-api.md`
   * 「版はサーバーが決める」）。次に更新を取りに行くとき、この値をそのまま
   * `If-None-Match` に載せる。
   */
  version: text("version").notNull(),
  /**
   * `signs` の件数。**0 なら走行を始めさせない**（`docs/adr/0009-on-device-storage.md`）。
   *
   * 行を数えれば分かる値をあえて持つのは、**走行前の確認で数万行を数えないため**と、
   * **同梱物が途中で欠けたことに気づくため**である（生成の時点でサーバーの件数と突き合わせる）。
   */
  count: integer("count").notNull(),
  /** 同梱物を作った時刻（ISO 8601、UTC）。**人が「いつのものか」を見るためだけに持つ** */
  builtAt: text("built_at").notNull(),
});

/**
 * `signs.db` を作るときの DDL。
 *
 * **drizzle-kit のマイグレーションを使わない。**`signs.db` は毎回まっさらから作る
 * **生成物**であり、育てていくものではない（更新は丸ごと入れ替え。
 * `docs/interfaces/mobile-api.md`「差分を作らない」）。マイグレーションが要るのは
 * アプリが書く `app.db` の方で、そちらは走行ログのテーブルと一緒に入る（#73）。
 *
 * **上のスキーマ定義と食い違うと、`SELECT` は実行時に落ちる。**そうならないことは
 * `./store.test.ts` が、この DDL で作った DB を Drizzle で引いて確かめている
 * （`docs/adr/0009-on-device-storage.md`「5. 保存層に口を1つ置き、3つの実装を差す」）。
 */
export const SIGNS_DDL = `
CREATE TABLE signs (
  id TEXT PRIMARY KEY NOT NULL,
  pref INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  approach_lat REAL,
  approach_lon REAL,
  lat_cell INTEGER NOT NULL,
  lon_cell INTEGER NOT NULL
);
CREATE INDEX signs_cell ON signs (lat_cell, lon_cell);
CREATE TABLE meta (
  id INTEGER PRIMARY KEY NOT NULL,
  pref INTEGER NOT NULL,
  version TEXT NOT NULL,
  count INTEGER NOT NULL,
  built_at TEXT NOT NULL
);
`;
