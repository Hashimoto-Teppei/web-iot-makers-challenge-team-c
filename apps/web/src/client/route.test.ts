import { describe, expect, it } from "vitest";
import { cellPath, parseRoute } from "./route";

describe("parseRoute", () => {
  it("詳細のパスから代表座標を読む", () => {
    expect(parseRoute("/cell/34.665/133.918")).toEqual({
      name: "cell",
      lat: 34.665,
      lon: 133.918,
      sample: "include",
    });
  });

  it("サンプルの扱いを URL から読む（飛んだ先で件数が変わって見えないように）", () => {
    expect(parseRoute("/cell/34.665/133.918", "?sample=exclude")).toMatchObject({
      sample: "exclude",
    });
    expect(parseRoute("/cell/34.665/133.918", "?sample=nonsense")).toMatchObject({
      sample: "include",
    });
  });

  it("南半球・西半球の座標も読む", () => {
    expect(parseRoute("/cell/-33.868/-70.669")).toMatchObject({ lat: -33.868, lon: -70.669 });
  });

  it("知らないパスは一覧に落とす（404 の画面を作らない）", () => {
    const stats = { name: "stats", sample: "include" };

    expect(parseRoute("/")).toEqual(stats);
    expect(parseRoute("/cell")).toEqual(stats);
    expect(parseRoute("/cell/abc/def")).toEqual(stats);
    expect(parseRoute("/cell/34.665")).toEqual(stats);
  });

  it("一覧でもサンプルの扱いを URL が持つ（詳細から戻っても見ていた形のまま）", () => {
    expect(parseRoute("/", "?sample=exclude")).toEqual({ name: "stats", sample: "exclude" });
  });
});

describe("cellPath", () => {
  it("小数第3位まで（丸めた意味を残す）", () => {
    expect(cellPath({ lat: 34.665, lon: 133.918 }, "include")).toBe("/cell/34.665/133.918");
  });

  it("往復して同じセルに戻る", () => {
    const cell = { lat: 34.665, lon: 133.918 };

    expect(parseRoute(cellPath(cell, "include"))).toMatchObject(cell);
  });

  it("除いて見ているときだけ sample を付ける（既定は付けない）", () => {
    expect(cellPath({ lat: 34.665, lon: 133.918 }, "exclude")).toBe(
      "/cell/34.665/133.918?sample=exclude",
    );
  });
});
