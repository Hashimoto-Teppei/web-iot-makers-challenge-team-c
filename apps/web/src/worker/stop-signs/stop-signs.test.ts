import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildImportSql, versionOf } from "../../../scripts/stop-signs/sql";
import type { StopSignsResponse } from "../../shared/api";
import app from "../index";

const SIGNS = [
  {
    id: "33-K1@34.664000_133.918000",
    lat: 34.665,
    lon: 133.918,
    approach: { lat: 34.664, lon: 133.918 },
  },
  { id: "33-K2", lat: 34.666, lon: 133.919, approach: null },
];

/**
 * 取り込みは**抽出スクリプトが作る SQL そのもの**で行う。
 * ここでテスト用に別の INSERT を書くと、**生成した SQL が D1 で通らないことに
 * 気づけない**——本番の経路はそちらしか通らない。
 */
async function importSigns(signs: typeof SIGNS, pref = 33): Promise<string> {
  const version = versionOf(signs);
  const sql = buildImportSql({ pref, signs, version, importedAt: "2026-09-01T00:00:00Z" });
  // exec は1行1文として扱うため、生成した複数行の文をそのまま渡せない。
  for (const statement of sql.split(";\n").filter((s) => s.trim().length > 0)) {
    await env.DB.prepare(statement).run();
  }
  return version;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM stop_signs");
  await env.DB.exec("DELETE FROM stop_sign_versions");
});

describe("GET /api/stop-signs", () => {
  it("その県の標識を件数ぶん返す", async () => {
    await importSigns(SIGNS);

    const res = await app.request("/api/stop-signs?pref=33", {}, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as StopSignsResponse;
    expect(body.count).toBe(2);
    // **取り込んだものがそのまま配られる**（D1 に配らない列は無い）。
    expect(body.signs).toEqual(SIGNS);
    expect(body.pref).toBe(33);
  });

  it("別の県の標識を混ぜない", async () => {
    await importSigns(SIGNS, 33);
    await importSigns([{ id: "34-B1", lat: 34.396, lon: 132.459, approach: null }], 34);

    const res = await app.request("/api/stop-signs?pref=33", {}, env);

    const body = (await res.json()) as StopSignsResponse;
    expect(body.signs.map((s) => s.id)).toEqual(["33-K1@34.664000_133.918000", "33-K2"]);
  });

  it("同じ ETag を If-None-Match で送ると 304 を返し、本文を送らない", async () => {
    await importSigns(SIGNS);

    const first = await app.request("/api/stop-signs?pref=33", {}, env);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const second = await app.request(
      "/api/stop-signs?pref=33",
      { headers: { "If-None-Match": etag ?? "" } },
      env,
    );

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("取り込み直して中身が変わったら ETag も変わる（304 にならない）", async () => {
    await importSigns(SIGNS);
    const first = await app.request("/api/stop-signs?pref=33", {}, env);
    const etag = first.headers.get("ETag") ?? "";

    await importSigns([...SIGNS, { id: "33-K3", lat: 34.667, lon: 133.92, approach: null }]);
    const second = await app.request(
      "/api/stop-signs?pref=33",
      { headers: { "If-None-Match": etag } },
      env,
    );

    expect(second.status).toBe(200);
    expect(((await second.json()) as StopSignsResponse).count).toBe(3);
  });

  it("同じ内容を取り込み直しただけなら ETag は変わらない（数 MB を落とし直さない）", async () => {
    await importSigns(SIGNS);
    const first = await app.request("/api/stop-signs?pref=33", {}, env);

    await importSigns(SIGNS);
    const second = await app.request("/api/stop-signs?pref=33", {}, env);

    expect(second.headers.get("ETag")).toBe(first.headers.get("ETag"));
  });

  it("取り込みが途中で落ちて件数が欠けていたら、配らずに 500 で落とす", async () => {
    await importSigns(SIGNS);
    // 取り込みの SQL はトランザクションで囲めないので、版だけ新しく中身が欠ける形が起こりうる。
    await env.DB.exec("DELETE FROM stop_signs WHERE id = '33-K2'");

    const res = await app.request("/api/stop-signs?pref=33", {}, env);

    expect(res.status).toBe(500);
  });

  it("まだ取り込んでいない県は 404。空の配列を返さない", async () => {
    const res = await app.request("/api/stop-signs?pref=13", {}, env);

    expect(res.status).toBe(404);
  });

  it("pref が無い / 範囲外なら 400（500 にしない）", async () => {
    expect((await app.request("/api/stop-signs", {}, env)).status).toBe(400);
    expect((await app.request("/api/stop-signs?pref=48", {}, env)).status).toBe(400);
    expect((await app.request("/api/stop-signs?pref=おかやま", {}, env)).status).toBe(400);
  });

  it("位置を渡しても無視する（引数は都道府県コードだけ）", async () => {
    await importSigns(SIGNS);

    const res = await app.request("/api/stop-signs?pref=33&lat=34.6&lon=133.9", {}, env);

    expect(res.status).toBe(200);
    expect(((await res.json()) as StopSignsResponse).count).toBe(2);
  });
});
