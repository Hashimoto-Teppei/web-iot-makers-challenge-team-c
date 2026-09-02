import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { MAX_STATEMENT_BYTES } from "./config";
import type { Thresholds, Violation } from "./judge";
import type { RideRef } from "./request";

/**
 * 不停止を D1 に入れ直す SQL を組み立てる。
 *
 * **Drizzle の `insert()` ではなく SQL の文字列を作っている。**理由は `logs/insert.ts` と同じ
 * （D1 は1クエリにバインド変数 100 個まで、1回の呼び出しで 50 クエリまで）。
 * **値を埋め込んでよいのは、Zod が形を確かめたあと**である——ここへ来る文字列は
 * 16進8文字（`request.ts`）と標識の識別子だけだが、素通しにはしない。
 *
 * **この表だけは追記ではなく置き換えである**（`db/schema.ts`）。同じ走行を計算し直したら、
 * **その走行ぶんを消してから入れる**（`docs/interfaces/web-stats.md`「いつ計算するか」）。
 */

/** SQL の文字列リテラル。 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * SQL の数値リテラル。
 *
 * **有限でない数を文字列にすると `Infinity` や `NaN` という識別子が SQL に混ざり、
 * 文ごと落ちる。**Zod が通さないので起きないはずだが、**起きたときに落ちる場所を
 * ここにしておく**（D1 のエラーより原因が読める）。
 */
function num(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`数値として入れられません: ${value}`);
  return String(value);
}

/** 行を**バイト長で**区切って `INSERT` の文にする（考え方は `logs/insert.ts` と同じ）。 */
function buildStatements(insertInto: string, rows: readonly string[]): string[] {
  const encoder = new TextEncoder();
  const statements: string[] = [];
  let batch: string[] = [];
  let bytes = 0;

  const flush = () => {
    if (batch.length > 0) statements.push(`${insertInto} VALUES\n${batch.join(",\n")}`);
    batch = [];
    bytes = 0;
  };

  for (const row of rows) {
    const size = encoder.encode(row).length + 2; // 区切りの ",\n" ぶん
    if (batch.length > 0 && bytes + size > MAX_STATEMENT_BYTES) flush();
    batch.push(row);
    bytes += size;
  }
  flush();

  return statements;
}

/** 走行ごとの判定の結果。**不停止が0件だった走行も渡すこと**（消すために要る）。 */
export type RideResult = {
  ride: RideRef;
  violations: readonly Violation[];
};

/**
 * 「消してから入れる」1回ぶんの SQL を作る。
 *
 * **消す文を必ず先に置く。**入れてから消すと、**作り直した行を自分で消す。**
 *
 * **対象の走行を1文でまとめて消す。**走行ごとに `DELETE` を投げると、20 走行で
 * 20 クエリを使う（D1 は1回の呼び出しで 50 クエリまで）。
 */
export function buildReplaceStatements(results: readonly RideResult[], thr: Thresholds): string[] {
  if (results.length === 0) return [];

  const where = results
    .map(({ ride }) => `(device_id = ${quote(ride.deviceId)} AND log_id = ${quote(ride.logId)})`)
    .join(" OR ");

  const rows = results.flatMap(({ ride, violations }) =>
    violations.map(
      (v) =>
        `(${quote(ride.deviceId)}, ${quote(ride.logId)}, ${quote(v.signId)}, ${num(v.t)}, ` +
        `${num(thr.stopSpeedMps)}, ${num(thr.radiusM)}, ${num(thr.bearingToleranceDeg)}, ` +
        `${num(thr.maxHaccM)})`,
    ),
  );

  return [
    `DELETE FROM stop_violations WHERE ${where}`,
    ...buildStatements(
      "INSERT INTO stop_violations (device_id, log_id, sign_id, t, " +
        "thr_stop_speed_mps, thr_radius_m, thr_bearing_tolerance_deg, thr_max_hacc_m)",
      rows,
    ),
  ];
}

/**
 * 不停止を入れ直す。
 *
 * **1回の `batch()` で送る。**D1 の `batch()` は暗黙のトランザクションなので、
 * **途中で落ちたら1行も変わらない**——順に `await` すると、**消しただけで入っていない状態**
 * （＝全員が停止したことになった集計）が残りうる。
 */
export async function replaceViolations(
  db: DrizzleD1Database,
  results: readonly RideResult[],
  thr: Thresholds,
): Promise<void> {
  // **`D1Database`（Cloudflare のグローバル型）をここに書かない。**この関数の型は
  // `index.ts` 経由で `AppType` に載り、**Cloudflare の型を持たないモバイル側で
  // 型チェックが落ちる**（`logs/insert.ts` と同じ）。
  const [first, ...rest] = buildReplaceStatements(results, thr).map((statement) =>
    db.run(sql.raw(statement)),
  );
  if (!first) return;

  await db.batch([first, ...rest]);
}
