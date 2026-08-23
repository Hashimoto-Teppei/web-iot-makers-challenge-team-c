import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
