import { describe, expect, it } from "vitest";
import { MAX_STATEMENT_BYTES } from "./config";
import { buildInsertStatements } from "./insert";
import type { LogsRequest } from "./request";

const DEVICE_ID = "0a1b2c3d";
const LOG_ID = "9a1c0000";

function point(seq: number, over: Partial<LogsRequest["points"][number]> = {}) {
  return {
    logId: LOG_ID,
    seq,
    t: 1_756_123_456_000 + seq * 1000,
    lat: 34.6651,
    lon: 133.9183,
    spd: 4.2,
    crs: 91.5,
    hacc: 5,
    ...over,
  };
}

const BODY: LogsRequest = {
  deviceId: DEVICE_ID,
  rides: [{ logId: LOG_ID, startedAt: 1_756_123_456_000, endedAt: 1_756_123_556_000 }],
  points: [point(1)],
  detections: [
    { source: "phone", logId: LOG_ID, seq: 1, t: 1_756_123_460_000, kind: "stop", lv: 2 },
    {
      source: "device",
      logId: "c3f10001",
      seq: 941,
      t: 1_756_123_461_000,
      kind: "rear_object",
      lv: 3,
      tEst: true,
    },
  ],
};

describe("buildInsertStatements", () => {
  it("既にある行を上書きしない（OR IGNORE で入れる）", () => {
    // **冪等性はここが持っている。**UPDATE や REPLACE に変えると、`device_id` を知った
    // 誰かが同じキーで空のレコードを投げて他人の走行を消せる
    // （`docs/interfaces/web-service.md`「割り切っていること」）。
    for (const sql of buildInsertStatements(BODY)) {
      expect(sql.startsWith("INSERT OR IGNORE INTO ")).toBe(true);
    }
  });

  it("サンプルの列を書かない（常に既定＝サンプルではない）", () => {
    // 受け取る形にすると誰でもサンプルを名乗れ、除いたつもりで除けていない集計ができる。
    expect(buildInsertStatements(BODY).join("\n")).not.toContain("sample");
  });

  it("方角の無い測位を 0（真北）に潰さず NULL で入れる", () => {
    const sql = buildInsertStatements({ ...BODY, points: [point(1, { crs: null })] }).join("\n");

    expect(sql).toContain("NULL");
    // 「止まっていて向きが分からない」が真北として入ると、あとから見分けられない
    // （`docs/unverified.md` 57）。
    expect(sql).not.toMatch(/,\s*0,\s*5\)/);
  });

  it("デバイス発の推定した時刻に t_est を立て、スマホ発には立てない", () => {
    const statements = buildInsertStatements(BODY);
    const sql = statements.find((s) => s.includes("INTO detections")) ?? "";

    // 行の末尾（t_est）だけを見る。スマホ発が 0、デバイス発が 1。
    const flags = [...sql.matchAll(/,\s*(0|1)\)/g)].map((m) => m[1]);
    expect(flags).toEqual(["0", "1"]);
  });

  it("空の配列からは1文も作らない", () => {
    expect(
      buildInsertStatements({ deviceId: DEVICE_ID, rides: [], points: [], detections: [] }),
    ).toEqual([]);
  });

  it("1文が D1 の上限（100,000 バイト）を超えない", () => {
    // **超えた文だけが拒まれる**ので、上限を超えると走行の一部が黙って落ちる。
    const points = Array.from({ length: 5_000 }, (_, i) => point(i + 1));

    const statements = buildInsertStatements({ ...BODY, points });

    expect(statements.length).toBeGreaterThan(1);
    for (const sql of statements) {
      expect(new TextEncoder().encode(sql).length).toBeLessThanOrEqual(MAX_STATEMENT_BYTES + 200);
    }
  });

  it("5000 点でも、1回の呼び出しで投げられるクエリ数（無料プランで 50）に収まる", () => {
    // これが Drizzle の insert() ではなく SQL を組み立てている理由そのもの
    // （バインド変数 100 個の制限だと 1 文 11 行にしかならず、455 文になる）。
    const points = Array.from({ length: 5_000 }, (_, i) => point(i + 1));

    expect(buildInsertStatements({ ...BODY, points }).length).toBeLessThan(50);
  });
});
