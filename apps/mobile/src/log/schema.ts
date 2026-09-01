/**
 * 端末が書くデータベース（`app.db`）のスキーマと、その移行。
 *
 * **`signs.db`（標識）と必ず別のファイルにする**——1つにまとめると、標識の更新で
 * 走行ログが消える（`docs/adr/0009-on-device-storage.md`「2」）。
 *
 * **`apps/web` の D1 とスキーマを共有しない。**列も目的も別物で、揃えにいくと片方の
 * 都合がもう片方に漏れる（同 ADR の却下案）。**揃えるのは冪等キーの形だけ**
 * ——`(device_id, source, log_id, seq)`（`docs/interfaces/web-service.md`「データの取り込み」）。
 *
 * **こちらにしか無いのが `sent_at`**（送信済みの印）である。取り込みは冪等なので
 * 二重に送っても増えないが、**印が無いと走行のたびに過去ぶんを全部送り直す**ことになる。
 */

import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
// **ドライバごとに違う型を1つで受ける口**（`better-sqlite3` と `expo-sqlite` の両方が
// これに当てはまる）。標識側で先に置いたものをそのまま使う——2つ目を作ると、
// 「テストで回した SQL がそのまま実機で動く」という前提が2通りになる。
import type { SyncSqliteDatabase } from "../signs/store";

/**
 * 1回の走行。**主キーは `(device_id, log_id)`**（D1 の `rides` と同じ）。
 *
 * **`device_id` は接続していたデバイスの ID。**スマホ側で別の ID を作らない
 * （`docs/interfaces/mobile-api.md`「走行後の同期」）。**行ごとに持つのは、
 * 1台のスマホが日をまたいで別のデバイスにつながりうるから**である——
 * 送るときは `device_id` ごとにリクエストを分ける（1リクエストに1つしか載らない）。
 */
export const rides = sqliteTable(
  "rides",
  {
    deviceId: text("device_id").notNull(),
    /** 走行の識別子（16進の小文字8文字）。**スマホが走行ごとに作る** */
    logId: text("log_id").notNull(),
    startedAt: integer("started_at").notNull(),
    /**
     * 終わった時刻。**走行中は `null`。**
     *
     * **`null` の走行を送らない。**取り込みは開始と終了を確定値として受け取り、
     * **あとから延ばせない**（`docs/interfaces/web-service.md`「1回の送信は分割してよい」）。
     * 走行中に送ると、そのあとの点が全部「走行の期間の外」になり、
     * **地図にもランキングにも出ないまま D1 に残る。**
     */
    endedAt: integer("ended_at"),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.logId] })],
);

/**
 * 測位の連続点。**形は走行中の中継（`../v2v/messages.ts` の `SelfMessage`）と同じ**
 * ——同じ測位を溜めて送るだけである。
 *
 * **足切りをしない。**精度の悪い点も、速度が跳ねた点もそのまま残す
 * （`docs/adr/0007-keep-raw-ride-logs.md`）。**捨てるとしきい値を変えて計算し直せない。**
 */
export const points = sqliteTable(
  "points",
  {
    deviceId: text("device_id").notNull(),
    logId: text("log_id").notNull(),
    /** `log_id` の中で 1 から単調増加する（`docs/interfaces/ble-log-transfer.md`） */
    seq: integer("seq").notNull(),
    /** 測位した時刻（UTC ミリ秒）。**送信した時刻ではない** */
    t: integer("t").notNull(),
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    spd: real("spd").notNull(),
    /** 進行方角。**`null` は「向きが分からない」という正常な値**（0 で埋めない） */
    crs: real("crs"),
    hacc: real("hacc").notNull(),
    /** 送信できた時刻。**`null` が「まだ送っていない」** */
    sentAt: integer("sent_at"),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.logId, table.seq] }),
    // **送っていない点だけを引くための索引。**走行1回で数千行入るので、
    // 走行を重ねるほど全表走査が効いてくる。
    index("points_unsent").on(table.sentAt),
  ],
);

/**
 * 検知。**主キーに `source` が入る**（`docs/interfaces/web-service.md`「データの取り込み」）。
 *
 * **`source` を入れないと、デバイス発の `log_id=1, seq=1` とスマホ発の `log_id=1, seq=1` が
 * 同じキーになる**——`device_id` を共有しているためである。
 * いま書くのはスマホ発（`phone`）だけで、**デバイスから BLE で回収した検知（`device`）は
 * #40 がこの表に足す。**
 *
 * **推定した時刻（`t_est`）の列はまだ置かない。**打つのはデバイスだけで
 * （`docs/interfaces/ble-log-transfer.md`）、**いまこの表に書く経路が無い。**
 * #40 が `device` の行と一緒に足す（そのための移行の仕組みが下にある）。
 */
export const detections = sqliteTable(
  "detections",
  {
    deviceId: text("device_id").notNull(),
    /** 出どころ。いまは `"phone"` だけが入る（`"device"` は #40） */
    source: text("source").notNull(),
    logId: text("log_id").notNull(),
    seq: integer("seq").notNull(),
    t: integer("t").notNull(),
    /** 何の検知か（`../detect/types.ts` の `WarnKind`）。**短く書き換えない** */
    kind: text("kind").notNull(),
    lv: integer("lv").notNull(),
    sentAt: integer("sent_at"),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.source, table.logId, table.seq] }),
    index("detections_unsent").on(table.sentAt),
  ],
);

/**
 * `app.db` の移行。**1要素が1つの版で、中身は1文ずつ**に分ける。
 *
 * **`signs.db` と違い、こちらは育てていくもの**である（`./schema.ts` の DDL を
 * まっさらから流し直せるのは、アプリが書かないファイルだけ）。**部品が増えるたびに
 * 表が増える**ことは分かっているので（#40 のデバイス発の検知、#72 の範囲外の記録）、
 * **最初から版を持たせて、足せる形にしておく。**
 *
 * **配列に追記するだけ。既に配った要素を書き換えない**——書き換えても、
 * 既に上の版まで進んだ端末では二度と流れない。
 *
 * **1文ずつが流し直せる形（`IF NOT EXISTS`）であること。**`user_version` を上げるのは
 * 全文が流れ終わってからなので、**途中で落ちると次の起動で同じ版を頭から流し直す**
 * ——流し直せない文が混ざっていると、**そこから先、起動のたびに必ず落ちる端末ができる。**
 *
 * **drizzle-kit のマイグレーション（`driver: "expo"` + `useMigrations`）を使わない。**
 * `docs/adr/0009-on-device-storage.md`「1」はそちらを書いていたが、
 * **`babel-plugin-inline-import` と生成物（`drizzle/`）が要るわりに、
 * ここでやることは `PRAGMA user_version` を見て DDL を流すだけ**だったので、
 * **同じ SQL を Node のテストでも実機でも流せる**この形に変えた（2026-09-01）。
 */
export const APP_DB_MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE IF NOT EXISTS rides (
       device_id TEXT NOT NULL,
       log_id TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       ended_at INTEGER,
       PRIMARY KEY (device_id, log_id)
     )`,
    `CREATE TABLE IF NOT EXISTS points (
       device_id TEXT NOT NULL,
       log_id TEXT NOT NULL,
       seq INTEGER NOT NULL,
       t INTEGER NOT NULL,
       lat REAL NOT NULL,
       lon REAL NOT NULL,
       spd REAL NOT NULL,
       crs REAL,
       hacc REAL NOT NULL,
       sent_at INTEGER,
       PRIMARY KEY (device_id, log_id, seq)
     )`,
    `CREATE INDEX IF NOT EXISTS points_unsent ON points (sent_at)`,
    `CREATE TABLE IF NOT EXISTS detections (
       device_id TEXT NOT NULL,
       source TEXT NOT NULL,
       log_id TEXT NOT NULL,
       seq INTEGER NOT NULL,
       t INTEGER NOT NULL,
       kind TEXT NOT NULL,
       lv INTEGER NOT NULL,
       sent_at INTEGER,
       PRIMARY KEY (device_id, source, log_id, seq)
     )`,
    `CREATE INDEX IF NOT EXISTS detections_unsent ON detections (sent_at)`,
  ],
];

/**
 * 足りない版を流す。**開いた直後に必ず1回呼ぶ**（`./node.ts` / `./expo.ts`）。
 *
 * **トランザクションで囲んでいない。**囲む書き方がドライバごとに違うためで、
 * 代わりに**1文ずつを流し直せる形にしてある**（`APP_DB_MIGRATIONS` の注記）。
 * 途中で落ちても、次の起動が同じ版を頭から流し直して追いつく。
 */
export function migrateAppDatabase(db: SyncSqliteDatabase): void {
  const row = db.get<{ user_version: number }>(sql`PRAGMA user_version`);
  const current = row?.user_version ?? 0;
  if (current >= APP_DB_MIGRATIONS.length) return;

  for (const statements of APP_DB_MIGRATIONS.slice(current)) {
    for (const statement of statements) db.run(sql.raw(statement));
  }
  // **`PRAGMA` に値を束縛できない**ので、ここだけ文字列に埋め込む。
  // 埋めるのは配列の長さ（プログラムが決めた整数）であって、外から来た値ではない。
  db.run(sql.raw(`PRAGMA user_version = ${APP_DB_MIGRATIONS.length}`));
}
