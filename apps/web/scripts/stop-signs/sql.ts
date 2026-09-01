/**
 * 抽出した標識から、D1 に流し込む SQL を組み立てる。
 *
 * **ここもファイルも通信も持たない**（`csv.ts` と同じ理由）。文字列を返すだけなので、
 * 生成される SQL を Vitest から目で確かめられる。
 */

import { createHash } from "node:crypto";
import type { StopSign } from "../../src/shared/api";

/**
 * 1つの INSERT 文の上限（バイト）。
 *
 * **D1 は1文 100,000 バイトまで**しか受け付けない。数万行を1文にすると数 MB になって
 * 丸ごと拒まれ、逆に1行ずつにすると往復が数万行ぶんになる。
 *
 * **行数ではなくバイト長で切る。**いまの実データなら1行 90 バイト前後なので、
 * 「500 行」で切っても上限には遠い。**それでも行数で切らないのは、行の長さが
 * 元データ次第だから**——id は元データのユニークキーから作られ、**その付与規則は
 * 版で改訂されている**（`docs/unverified.md` 63）。**行数で切ると、上限を守れる根拠を
 * 元データの形に預けることになる。**
 *
 * 超えた文だけが拒まれると、**トランザクションが無いので版だけ新しく中身が欠ける**
 * （API はそれを 500 で捕まえるが、原因は手元では分かりにくい）。
 */
const MAX_STATEMENT_BYTES = 80_000;

/**
 * 版を中身から決める。**同じ標識の集合なら、いつ誰が取り込んでも同じ値になる。**
 *
 * 時刻や乱数で作らないのは、**同じ CSV を入れ直しただけで全端末が数 MB を
 * 落とし直す**のを避けるため。逆に1件でも変われば値は変わる。
 *
 * 長さを 16 桁に切るのは ETag として読みやすくするため。衝突の心配は、
 * 月に1度しか変わらないものに対しては問題にならない。
 */
export function versionOf(signs: readonly StopSign[]): string {
  const hash = createHash("sha256");
  // **端末に配る値だけを混ぜる。**配らない列を足すときは、ここに混ぜないこと——
  // その列だけが直った取り込みで版が変わると、**全端末が同じ中身を数 MB 落とし直す。**
  for (const s of signs) {
    hash.update(`${s.id},${s.lat},${s.lon},${s.approach?.lat ?? ""},${s.approach?.lon ?? ""}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

/** SQL の文字列リテラル。id は元データ由来なので、引用符が入っていても壊れないようにする */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export type ImportSqlOptions = {
  pref: number;
  signs: readonly StopSign[];
  version: string;
  /** 取り込んだ時刻（ISO 8601、UTC）。呼び出し側から渡す——**テストが時刻に左右されないように** */
  importedAt: string;
};

/**
 * その都道府県の標識を**丸ごと入れ替える** SQL を作る。
 *
 * **差分を作らない**（`docs/interfaces/mobile-api.md`）。失敗したときに
 * 「何割か古い標識」が残ると、どこが古いのか誰にも分からなくなる。
 *
 * **トランザクションで囲まない。**D1 は `BEGIN` / `COMMIT` を受け付けず、
 * `wrangler d1 execute --file` が文をまとめて実行する。
 */
export function buildImportSql({ pref, signs, version, importedAt }: ImportSqlOptions): string {
  const statements: string[] = [
    `-- 一時停止の標識（都道府県コード ${pref} / ${signs.length} 件 / 版 ${version}）`,
    `-- scripts/stop-signs/extract.ts が生成。手で編集しない。`,
    `DELETE FROM stop_signs WHERE pref = ${pref};`,
  ];

  const encoder = new TextEncoder();
  const insertInto = "INSERT INTO stop_signs (id, pref, lat, lon, approach_lat, approach_lon)";
  let batch: string[] = [];
  let batchBytes = 0;

  const flush = () => {
    if (batch.length === 0) return;
    statements.push(`${insertInto} VALUES\n  ${batch.join(",\n  ")};`);
    batch = [];
    batchBytes = 0;
  };

  for (const s of signs) {
    const row =
      `(${quote(s.id)}, ${pref}, ${s.lat}, ${s.lon}, ` +
      `${s.approach?.lat ?? "NULL"}, ${s.approach?.lon ?? "NULL"})`;
    // 区切りと改行のぶんを少し多めに見ておく。
    const size = encoder.encode(row).length + 4;

    // **1行だけで上限を超える場合はそのまま出す。**分けようがなく、
    // 空の文を挟むより「その行が長すぎる」という形で落ちた方が原因に近い。
    if (batch.length > 0 && batchBytes + size > MAX_STATEMENT_BYTES) flush();
    batch.push(row);
    batchBytes += size;
  }
  flush();

  // 版は最後に書く。**先に書くと、途中で落ちたときに「新しい版で中身が空」になる。**
  statements.push(
    `INSERT INTO stop_sign_versions (pref, version, count, imported_at) VALUES\n` +
      `  (${pref}, ${quote(version)}, ${signs.length}, ${quote(importedAt)})\n` +
      `  ON CONFLICT(pref) DO UPDATE SET\n` +
      `    version = excluded.version, count = excluded.count, imported_at = excluded.imported_at;`,
  );

  return `${statements.join("\n\n")}\n`;
}
