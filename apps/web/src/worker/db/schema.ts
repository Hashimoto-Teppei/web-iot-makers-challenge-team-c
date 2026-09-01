import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * D1 が動いていることを確かめるための仮のテーブル。
 *
 * 本来のテーブル設計は Issue #7（モバイル ⇄ API の仕様と D1 のテーブル設計）で決める。
 * 決まったらこのテーブルは削除する。ここに本番のカラムを足していかないこと。
 */
export const pings = sqliteTable("pings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  message: text("message").notNull(),
  // D1（SQLite）に日時型はない。文字列で ISO 8601（UTC）を持たせる。
  // datetime('now') だと "2026-08-23 07:11:33" 形式になり、JavaScript の Date が確実には解釈できない。
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export type Ping = typeof pings.$inferSelect;

/**
 * 一時停止の標識。JARTIC の交通規制情報オープンデータ（共通規制種別コード 63）から
 * 抽出したもの。取り込みは `scripts/stop-signs/`、配るのは `GET /api/stop-signs`。
 *
 * **端末側（`apps/mobile` の `signs.db`）とスキーマを共有しない。**列も目的も別物で、
 * 揃えにいくと片方の都合がもう片方に漏れる（`docs/adr/0009-on-device-storage.md`）。
 * 端末はセルの列を持つが、こちらは持たない——D1 側でセルが要るのは集計（走行ログとの
 * 突き合わせ）で、そちらは `ride_points` を切る話であって標識の列ではない。
 */
export const stopSigns = sqliteTable(
  "stop_signs",
  {
    /**
     * 標識の識別子。**取り込み直しても同じ標識には同じ値が付くこと。**
     *
     * この値は端末まで運ばれ、警告の抑制キー（`causeId`）になる
     * （`apps/mobile/src/ride/warn-gate.ts`）。取り込みのたびに変わると、
     * **同じ標識が毎回「別の標識」として鳴り直す。**
     */
    id: text("id").primaryKey(),
    /** 都道府県コード（岡山県 = 33） */
    pref: integer("pref").notNull(),
    /** 規制地点の緯度（度、WGS84）。**停止線の位置とは限らず、交差点中央部のこともある** */
    lat: real("lat").notNull(),
    /** 規制地点の経度（度、WGS84） */
    lon: real("lon").notNull(),
    /**
     * **この標識が対象とする車両の進入方向**を表す点。
     * **この点から規制地点へ向かって走る車両**が規制の対象になる。
     *
     * **単に近いだけで拾うと、対向車線や交差する道路の標識で警告が鳴る**ので、
     * 一時停止の事前通知（#27）はこの点を見る。元データ（JARTIC の「進入方向（座標）」）が
     * 方向ごとに座標を持っているので、**1つの交差点に複数の進入方向があれば、
     * 行も方向のぶんだけ分かれる。**
     *
     * **`null` は「全方向が対象」ではなく「元データに登録が無い」。**
     */
    approachLat: real("approach_lat"),
    approachLon: real("approach_lon"),
    /**
     * 交差点名称（元データの「交差点名称（踏切名含む）」）。
     *
     * **端末には配らない**——走行中のディスプレイに文章は出せない（`CLAUDE.md`）。
     * ここに残すのは**走行後の振り返りで場所が人に読めるようにする**ためで、
     * 緯度経度のセルだけでは土地勘とつながらない（`docs/interfaces/web-service.md`）。
     *
     * **取り込みで捨てると取り戻せない。**元データは月次更新で、前月ぶんは取得できない。
     */
    name: text("name"),
  },
  // 配るときは常に都道府県ぶんを丸ごと引く（`docs/interfaces/mobile-api.md`）。
  (t) => [index("stop_signs_pref_idx").on(t.pref)],
);

export type StopSignRow = typeof stopSigns.$inferSelect;

/**
 * 標識の版。**都道府県ごとに1行**で、取り込みのたびに置き換える。
 *
 * **版をサーバーが持つことが、この表がある理由のすべて**である
 * （`docs/interfaces/mobile-api.md`「版はサーバーが決める」）。ここで作らないと
 * 端末が独自の版番号を作り始め、`If-None-Match` で突き合わせられなくなる。
 *
 * `count` は**取り込んだ時点の件数の記録**。`GET /api/stop-signs` は配る前にこの値と
 * 実際の行数を突き合わせ、**食い違っていたら配らずに落とす**（`src/worker/index.ts`）。
 * 取り込みの SQL はトランザクションで囲めない（D1 が `BEGIN` を受け付けない）ので、
 * 途中で落ちると**版だけが新しくなって中身が欠ける**——そのまま配ると、端末が
 * 正しく揃っている手元の `signs.db` を欠けたもので置き換える。
 */
export const stopSignVersions = sqliteTable("stop_sign_versions", {
  /** 都道府県コード。**この表は都道府県ごとに1行しか持たない** */
  pref: integer("pref").primaryKey(),
  /** ETag の元になる値。**取り込んだ中身から決まる**（同じ CSV を入れ直しても変わらない） */
  version: text("version").notNull(),
  /** その版に入っている標識の件数 */
  count: integer("count").notNull(),
  /** 取り込んだ時刻（ISO 8601、UTC） */
  importedAt: text("imported_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

export type StopSignVersionRow = typeof stopSignVersions.$inferSelect;
