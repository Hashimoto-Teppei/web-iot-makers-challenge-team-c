/**
 * JARTIC の交通規制情報オープンデータ（CSV）から一旦停止の標識を抜き出し、
 * D1 に流し込む SQL を作る。
 *
 *   pnpm --filter web stop-signs:extract --in <CSV へのパス> --pref 33
 *
 * **このスクリプトを走らせるのは、原本を持っている人だけ**（月に1回）。
 * 他のメンバーは `GET /api/stop-signs` から同梱物を作るので、原本を触らない
 * （`docs/adr/0009-on-device-storage.md`）。
 *
 * **CSV も、生成した SQL もコミットしない。**このリポジトリは public であり、
 * 置くと配布に当たる（`docs/interfaces/stop-signs-source.md`）。`.gitignore` で止めてある。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  PREF_CODE_MAX,
  PREF_CODE_MIN,
  PREF_OKAYAMA,
  REGULATION_CODE_STOP,
} from "../../src/worker/stop-signs/config.ts";
import { extractStopSigns } from "./csv.ts";
import { buildImportSql, versionOf } from "./sql.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 文字コードを当てる。
 *
 * JARTIC の CSV は Shift_JIS で配られることがある。**UTF-8 として読んで文字化けした
 * まま進むと、列名が一致せず「必要な列がありません」という無関係な失敗に化ける**ので、
 * 置換文字（U+FFFD）が出た時点で Shift_JIS に切り替える。
 */
function decode(bytes: Uint8Array, encoding: string | undefined): string {
  if (encoding) return new TextDecoder(encoding).decode(bytes);

  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8;
  return new TextDecoder("shift_jis").decode(bytes);
}

const { values } = parseArgs({
  // `pnpm ... -- --in x` と `pnpm ... --in x` のどちらでも動くようにする。
  // pnpm の版によって `--` が引数に残り、parseArgs はそれ以降をオプションとして読まない
  // ——**「--in が位置引数だ」という、原因の分からないエラーで止まる。**
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    in: { type: "string" },
    pref: { type: "string", default: String(PREF_OKAYAMA) },
    out: { type: "string" },
    encoding: { type: "string" },
  },
});

if (!values.in) {
  console.error(
    [
      "使い方: pnpm --filter web stop-signs:extract --in <CSV へのパス> [--pref 33]",
      "",
      "  --in        JARTIC からダウンロードした CSV。scripts/stop-signs/data/ に置くと gitignore される",
      "  --pref      都道府県コード（既定: 33 = 岡山県）",
      "  --out       生成する SQL の出力先（既定: scripts/stop-signs/out/stop-signs-<pref>.sql）",
      "  --encoding  CSV の文字コード（既定: UTF-8 で読み、化けたら Shift_JIS）",
    ].join("\n"),
  );
  process.exit(1);
}

const pref = Number(values.pref);
// **API と同じ範囲でここでも止める。**`--pref 330` のような打ち間違いは、SQL も
// D1 への投入も素通りして、**`GET /api/stop-signs` が 400 を返す日まで表に出ない**——
// 原因から何日も離れた場所で見つかることになる。
if (!Number.isInteger(pref) || pref < PREF_CODE_MIN || pref > PREF_CODE_MAX) {
  console.error(
    `--pref は ${PREF_CODE_MIN}〜${PREF_CODE_MAX} の都道府県コードです: ${values.pref}`,
  );
  process.exit(1);
}

const inputPath = resolve(process.cwd(), values.in);
const outputPath = values.out
  ? resolve(process.cwd(), values.out)
  : join(here, "out", `stop-signs-${pref}.sql`);

const csv = decode(await readFile(inputPath), values.encoding);
const { signs, skipped, withoutApproach } = extractStopSigns(csv, {
  pref,
  regulationCode: REGULATION_CODE_STOP,
});

// **0 件でも SQL は作る。**作らずに止めると、既に入っている標識が残ったまま
// 「取り込んだつもり」になる。0 件だと分かる形で D1 に反映させ、走行前の画面で気づかせる。
if (signs.length === 0) {
  console.warn(
    `⚠ 都道府県コード ${pref} の一旦停止（規制種別 ${REGULATION_CODE_STOP}）が1件も見つかりませんでした。` +
      `\n  CSV の県が違うか、列の意味が変わっている可能性があります。`,
  );
}

const version = versionOf(signs);
const sql = buildImportSql({ pref, signs, version, importedAt: new Date().toISOString() });

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, sql, "utf-8");

console.log(
  [
    `抽出しました: ${signs.length} 件（都道府県コード ${pref} / 版 ${version}）`,
    `  捨てた行: 他県 ${skipped.otherPref} / 他の規制 ${skipped.otherRegulation} / ` +
      `座標が不正 ${skipped.badCoordinate} / キーが無い ${skipped.missingKey} / ` +
      `重複 ${skipped.duplicate} / 列が足りない ${skipped.malformed}`,
    // **進入方向が無い標識は、対向車線でも鳴りうる。**多ければ元データか読み方を疑う。
    `  進入方向が無かった規制: ${withoutApproach}`,
    `  出力: ${outputPath}`,
    "",
    "次に、手元の D1 へ流し込む（apps/web で実行）:",
    `  pnpm exec wrangler d1 execute team-c-db --local --file=${outputPath}`,
    "Cloudflare 上の D1 へ入れるのはデプロイ担当だけ（--local を --remote に変える）。",
  ].join("\n"),
);
