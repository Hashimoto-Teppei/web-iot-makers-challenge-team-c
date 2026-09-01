import { describe, expect, it } from "vitest";
import type { ExtractedSign } from "./csv";
import { buildImportSql, versionOf } from "./sql";

const SIGNS: ExtractedSign[] = [
  {
    id: "33-K1@34.664000_133.918000",
    lat: 34.665,
    lon: 133.918,
    approach: { lat: 34.664, lon: 133.918 },
    name: "岡山交差点",
  },
  { id: "33-K2", lat: 34.666, lon: 133.919, approach: null, name: null },
];

describe("versionOf", () => {
  it("同じ標識の集合なら同じ版になる", () => {
    expect(versionOf(SIGNS)).toBe(versionOf([...SIGNS]));
  });

  it("1件でも変われば版が変わる", () => {
    const moved = [{ ...SIGNS[0], lat: 34.6651 } as ExtractedSign, SIGNS[1] as ExtractedSign];

    expect(versionOf(moved)).not.toBe(versionOf(SIGNS));
  });

  it("進入方向が変われば版が変わる", () => {
    const turned = [
      { ...SIGNS[0], approach: { lat: 34.6, lon: 133.9 } } as ExtractedSign,
      SIGNS[1] as ExtractedSign,
    ];

    expect(versionOf(turned)).not.toBe(versionOf(SIGNS));
  });

  it("交差点名称だけが変わっても版は変わらない（端末へ配らないため）", () => {
    const renamed = [{ ...SIGNS[0], name: "別の名前" } as ExtractedSign, SIGNS[1] as ExtractedSign];

    expect(versionOf(renamed)).toBe(versionOf(SIGNS));
  });
});

describe("buildImportSql", () => {
  it("1文が長くなりすぎないように分ける（D1 は1文 100,000 バイトまで）", () => {
    // 交差点名称は元データ由来で長さに上限が無い。行数で切ると、
    // 名前の長い塊が1つあるだけで上限を超え、その文だけが拒まれる。
    const long: ExtractedSign[] = Array.from({ length: 50 }, (_, i) => ({
      id: `33-K${i}`,
      lat: 34.665,
      lon: 133.918,
      approach: null,
      name: "交".repeat(2_000),
    }));

    const statements = buildImportSql({
      pref: 33,
      signs: long,
      version: "abc123",
      importedAt: "2026-09-01T00:00:00Z",
    })
      .split(";\n")
      .filter((s) => s.includes("INSERT INTO stop_signs"));

    expect(statements.length).toBeGreaterThan(1);
    for (const statement of statements) {
      expect(new TextEncoder().encode(statement).length).toBeLessThan(100_000);
    }
  });

  const sql = buildImportSql({
    pref: 33,
    signs: SIGNS,
    version: "abc123",
    importedAt: "2026-09-01T00:00:00Z",
  });

  it("その県ぶんを消してから入れ直す（差分にしない）", () => {
    expect(sql).toContain("DELETE FROM stop_signs WHERE pref = 33;");
    expect(sql.indexOf("DELETE FROM")).toBeLessThan(sql.indexOf("INSERT INTO stop_signs"));
  });

  it("版は最後に書く（途中で落ちても新しい版だけが残らないように）", () => {
    expect(sql.indexOf("INSERT INTO stop_signs")).toBeLessThan(
      sql.indexOf("INSERT INTO stop_sign_versions"),
    );
  });

  it("進入方向と交差点名称が無ければ NULL を入れる", () => {
    expect(sql).toContain(
      "('33-K1@34.664000_133.918000', 33, 34.665, 133.918, 34.664, 133.918, '岡山交差点')",
    );
    expect(sql).toContain("('33-K2', 33, 34.666, 133.919, NULL, NULL, NULL)");
  });

  it("引用符が入っていても SQL が壊れない", () => {
    const escaped = buildImportSql({
      pref: 33,
      signs: [{ id: "33-O'Hara", lat: 34.665, lon: 133.918, approach: null, name: "O'Hara 前" }],
      version: "abc123",
      importedAt: "2026-09-01T00:00:00Z",
    });

    expect(escaped).toContain("('33-O''Hara', 33, 34.665, 133.918, NULL, NULL, 'O''Hara 前')");
  });
});
