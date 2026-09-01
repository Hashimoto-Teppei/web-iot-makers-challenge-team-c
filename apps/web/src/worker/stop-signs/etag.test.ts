import { describe, expect, it } from "vitest";
import { etagOf, matchesIfNoneMatch } from "./etag";

describe("etagOf", () => {
  it("県が違えば ETag も違う（版が偶然一致しても 304 にしない）", () => {
    expect(etagOf(33, "abc123")).not.toBe(etagOf(34, "abc123"));
  });
});

describe("matchesIfNoneMatch", () => {
  const etag = etagOf(33, "abc123");

  it("同じ値なら一致する", () => {
    expect(matchesIfNoneMatch(etag, etag)).toBe(true);
  });

  it("ヘッダが無ければ一致しない（初回の取得）", () => {
    expect(matchesIfNoneMatch(undefined, etag)).toBe(false);
  });

  it("版が違えば一致しない", () => {
    expect(matchesIfNoneMatch(etagOf(33, "old"), etag)).toBe(false);
  });

  it("W/ が付いていても一致と見なす（毎回落とし直さないため）", () => {
    expect(matchesIfNoneMatch(`W/${etag}`, etag)).toBe(true);
  });

  it("カンマ区切りで複数送られても、含まれていれば一致する", () => {
    expect(matchesIfNoneMatch(`${etagOf(33, "old")}, ${etag}`, etag)).toBe(true);
  });

  it("* はすべてに一致する", () => {
    expect(matchesIfNoneMatch("*", etag)).toBe(true);
  });
});
