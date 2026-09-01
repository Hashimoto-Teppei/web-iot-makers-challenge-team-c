import { describe, expect, it } from "vitest";
import type { StopSign } from "../../src/shared/api";
import { buildImportSql, versionOf } from "./sql";

const SIGNS: StopSign[] = [
  {
    id: "33-K1@34.664000_133.918000",
    lat: 34.665,
    lon: 133.918,
    approach: { lat: 34.664, lon: 133.918 },
  },
  { id: "33-K2", lat: 34.666, lon: 133.919, approach: null },
];

describe("versionOf", () => {
  it("同じ標識の集合なら同じ版になる", () => {
    expect(versionOf(SIGNS)).toBe(versionOf([...SIGNS]));
  });

  it("1件でも変われば版が変わる", () => {
    const moved = [{ ...SIGNS[0], lat: 34.6651 } as StopSign, SIGNS[1] as StopSign];

    expect(versionOf(moved)).not.toBe(versionOf(SIGNS));
  });

  it("進入方向が変われば版が変わる", () => {
    const turned = [
      { ...SIGNS[0], approach: { lat: 34.6, lon: 133.9 } } as StopSign,
      SIGNS[1] as StopSign,
    ];

    expect(versionOf(turned)).not.toBe(versionOf(SIGNS));
  });
});

describe("buildImportSql", () => {
  it("1文が長くなりすぎないように分ける（D1 は1文 100,000 バイトまで）", () => {
    // **実データの id は 90 バイト前後**なので、ここは分割そのものを動かすための
    // 合成データである（実データでこの長さの id は出ない）。**上限の根拠を元データの
    // 形に預けない**という意図を、行数ではなくバイト長で切ることで守れているか見ている。
    const long: StopSign[] = Array.from({ length: 50 }, (_, i) => ({
      id: `33-${"K".repeat(2_000)}${i}`,
      lat: 34.665,
      lon: 133.918,
      approach: null,
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

  it("進入方向が無ければ NULL を入れる", () => {
    expect(sql).toContain("('33-K1@34.664000_133.918000', 33, 34.665, 133.918, 34.664, 133.918)");
    expect(sql).toContain("('33-K2', 33, 34.666, 133.919, NULL, NULL)");
  });

  it("引用符が入っていても SQL が壊れない", () => {
    const escaped = buildImportSql({
      pref: 33,
      signs: [{ id: "33-O'Hara", lat: 34.665, lon: 133.918, approach: null }],
      version: "abc123",
      importedAt: "2026-09-01T00:00:00Z",
    });

    expect(escaped).toContain("('33-O''Hara', 33, 34.665, 133.918, NULL, NULL)");
  });
});
