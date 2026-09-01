import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { MAX_STATEMENT_BYTES } from "./config";
import type { LogsRequest } from "./request";

/**
 * 受け取った走行ログを D1 に入れる SQL を組み立てる。
 *
 * **Drizzle の `insert()` ではなく SQL の文字列を作っている。**理由は `config.ts` の
 * `MAX_STATEMENT_BYTES`（バインド変数 100 個 / 1回の呼び出しで 50 クエリという D1 の制限に、
 * 数千点の取り込みが収まらない）。**値を埋め込んでよいのは、Zod が形を確かめたあと**である。
 *
 * **読むときは Drizzle を使う**（`stop-signs/query.ts` と同じ）。組み立てているのは
 * 取り込みだけで、ここに `SELECT` を書き足さないこと。
 */

/** SQL の文字列リテラル。**通るのは 16進8文字か決まった語だけ**だが、素通しにはしない。 */
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

/** SQL の真偽値。SQLite に真偽値型は無いので 0 / 1 で持つ（Drizzle の `mode: "boolean"` と同じ）。 */
function bool(value: boolean): string {
  return value ? "1" : "0";
}

/**
 * 行を**バイト長で**区切って `INSERT OR IGNORE` の文にする。
 *
 * **`OR IGNORE` が冪等性そのもの**である。同じ一意キーの行が既にあれば、
 * **上書きせず黙って捨てる**（`docs/interfaces/web-service.md`「データの取り込み」）。
 * **上書きにしないのは、認証を持たないため**——`device_id` を知った誰かが、
 * 同じキーで空のレコードを投げて他人の走行を消せてしまう。
 *
 * **行数ではなくバイト長で切る**のは、1行の長さが値次第で変わるため
 * （緯度経度の桁数は端末が決める）。`scripts/stop-signs/sql.ts` と同じ考え方。
 */
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

/**
 * リクエスト1つぶんの SQL を作る。**空の配列からは1文も作らない。**
 *
 * `sample` の列を書いていないのは、**この経路が受け取らないから**である
 * （`docs/interfaces/web-service.md`「サンプルデータは列で見分ける」）。
 * 既定値の `0`（サンプルではない）が入る。**ここに列を足さないこと。**
 */
export function buildInsertStatements(body: LogsRequest): string[] {
  const { deviceId, rides, points, detections } = body;
  const id = quote(deviceId);

  return [
    ...buildStatements(
      "INSERT OR IGNORE INTO rides (device_id, log_id, started_at, ended_at)",
      rides.map((r) => `(${id}, ${quote(r.logId)}, ${num(r.startedAt)}, ${num(r.endedAt)})`),
    ),
    ...buildStatements(
      "INSERT OR IGNORE INTO ride_points (device_id, log_id, seq, t, lat, lon, spd, crs, hacc)",
      points.map(
        (p) =>
          `(${id}, ${quote(p.logId)}, ${num(p.seq)}, ${num(p.t)}, ${num(p.lat)}, ${num(p.lon)}, ` +
          // 方角の無い測位は `null` のまま入れる。**0（真北）に潰さない**
          // （`docs/unverified.md` 57 が起きているのがまさにそれである）。
          `${num(p.spd)}, ${p.crs === null ? "NULL" : num(p.crs)}, ${num(p.hacc)})`,
      ),
    ),
    ...buildStatements(
      "INSERT OR IGNORE INTO detections (device_id, source, log_id, seq, kind, lv, t, t_est)",
      detections.map(
        (d) =>
          `(${id}, ${quote(d.source)}, ${quote(d.logId)}, ${num(d.seq)}, ${quote(d.kind)}, ` +
          // スマホ発には `tEst` の項目そのものが無い（`request.ts`）ので、必ず 0 になる。
          `${num(d.lv)}, ${num(d.t)}, ${bool(d.source === "device" && d.tEst === true)})`,
      ),
    ),
  ];
}

/**
 * 走行ログを D1 に入れる。
 *
 * **1回の `batch()` で送る。**D1 の `batch()` は暗黙のトランザクションなので、
 * **途中で落ちたら1行も入らない**——`INSERT` を順に `await` すると、
 * **走行の行だけ入って測位点が入っていない状態**が残りうる（そのまま集計すると
 * 通過の分母だけが増え、率が下がる）。
 *
 * **重い集計をここでしない。**不停止の判定も集計表の更新もしない
 * （`docs/interfaces/web-service.md`）。**取り込みが遅いとスマホがリトライを繰り返し、
 * 重複が増える。**
 */
export async function insertLogs(db: DrizzleD1Database, body: LogsRequest): Promise<void> {
  // **`D1Database`（Cloudflare のグローバル型）をここに書かない。**この関数の型は
  // `index.ts` 経由で `AppType` に載り、**Cloudflare の型を持たないモバイル側で
  // 型チェックが落ちる**（`apps/mobile` は Worker の型だけを参照する）。
  const [first, ...rest] = buildInsertStatements(body).map((statement) =>
    db.run(sql.raw(statement)),
  );
  if (!first) return;

  await db.batch([first, ...rest]);
}
