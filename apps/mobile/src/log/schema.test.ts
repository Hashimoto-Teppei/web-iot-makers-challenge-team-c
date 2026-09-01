/**
 * 移行の確認。**確かめるのは「上の版まで進んだ端末が、次の版で壊れないか」**である。
 *
 * **まっさらから流す経路は `./store.test.ts` が毎回通っている**（`openAppDatabase`）。
 * ここにしか無いのは、**途中の版で止まっている端末を進める**経路——
 * **実機でしか起きず、間違えると起動のたびに落ちる端末ができる。**
 */

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { APP_DB_MIGRATIONS, migrateAppDatabase } from "./schema";

let open: Database.Database[] = [];

/** `version` 版まで流した `app.db`。**アプリを配ったあとの端末を作る。** */
function databaseAt(version: number) {
  const raw = new Database(":memory:");
  open.push(raw);
  const db = drizzle(raw);
  for (const statements of APP_DB_MIGRATIONS.slice(0, version)) {
    for (const statement of statements) db.run(sql.raw(statement));
  }
  db.run(sql.raw(`PRAGMA user_version = ${version}`));
  return { raw, db };
}

afterEach(() => {
  for (const raw of open) raw.close();
  open = [];
});

describe("app.db の移行", () => {
  it("何度流しても落ちない（途中で落ちた端末が次の起動で追いつく）", () => {
    const { raw, db } = databaseAt(0);
    migrateAppDatabase(db);
    migrateAppDatabase(db);

    expect(raw.pragma("user_version", { simple: true })).toBe(APP_DB_MIGRATIONS.length);
  });

  it("既に送ったことがある端末は、最後に送れた時刻を引き継ぐ", () => {
    // **引き継がないと、走行後の画面が「一度も送っていない」と出す。**
    const { raw, db } = databaseAt(1);
    raw
      .prepare(
        `INSERT INTO points (device_id, log_id, seq, t, lat, lon, spd, hacc, sent_at)
         VALUES ('a1000001', 'deadbeef', 1, 1000, 34.6, 133.9, 4.2, 8, 5000)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO detections (device_id, source, log_id, seq, t, kind, lv, sent_at)
         VALUES ('a1000001', 'phone', 'deadbeef', 1, 1200, 'stop', 2, 7000)`,
      )
      .run();

    migrateAppDatabase(db);

    expect(raw.prepare(`SELECT value FROM app_meta WHERE key = 'last_sent_at'`).get()).toEqual({
      value: 7_000,
    });
  });

  it("一度も送っていない端末では、最後に送れた時刻を作らない", () => {
    // **`max()` は行が無くても1行（`null`）を返す。**そのまま入れると
    // `NOT NULL` に触れて、**その端末は起動のたびに移行で落ちる。**
    const { raw, db } = databaseAt(1);
    raw
      .prepare(
        `INSERT INTO points (device_id, log_id, seq, t, lat, lon, spd, hacc, sent_at)
         VALUES ('a1000001', 'deadbeef', 1, 1000, 34.6, 133.9, 4.2, 8, NULL)`,
      )
      .run();

    migrateAppDatabase(db);

    expect(raw.prepare(`SELECT count(*) AS n FROM app_meta`).get()).toEqual({ n: 0 });
  });
});
