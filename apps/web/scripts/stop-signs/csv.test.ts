import { describe, expect, it } from "vitest";
import { extractStopSigns, parseCsv } from "./csv";

/** 実データの列並び（説明書 3.7.1）に合わせた合成データ。実データは手元に無い。 */
const HEADER =
  "都道府県コード,共通規制種別コード,ユニークキー,規制場所の経度緯度,進入方向(座標),交差点名称(踏切名含む)";
const OPTIONS = { pref: 33, regulationCode: 63 } as const;

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

describe("parseCsv", () => {
  it("引用符の中のカンマと改行で列がずれない", () => {
    const rows = parseCsv('a,"b,c","d\ne",f');

    expect(rows).toEqual([["a", "b,c", "d\ne", "f"]]);
  });

  it("フィールドの途中の引用符は文字として扱う（そこから先を飲み込まない）", () => {
    // 交差点名に `"` が1つ紛れただけで、次の `"` までの数万行が
    // 1つのフィールドに飲み込まれると、件数が静かに減る。
    const rows = parseCsv('33,15"号交差点,133.9\n33,別の交差点,133.8');

    expect(rows).toEqual([
      ["33", '15"号交差点', "133.9"],
      ["33", "別の交差点", "133.8"],
    ]);
  });

  it("引用符が閉じられていなければ落ちる（黙って飲み込まない）", () => {
    expect(() => parseCsv('a,"b,c\n33,d,e')).toThrow(/引用符/);
  });

  it("CRLF を1つの改行として扱い、BOM を落とす", () => {
    const rows = parseCsv("﻿都道府県コード,経度\r\n33,133.9\r\n");

    expect(rows).toEqual([
      ["都道府県コード", "経度"],
      ["33", "133.9"],
    ]);
  });
});

describe("extractStopSigns", () => {
  it("指定した県の一時停止だけを取り出す", () => {
    const result = extractStopSigns(
      csv(
        "33,63,K1,133.918 34.665,133.918 34.664,岡山交差点",
        "33,11,K2,133.919 34.666,,", // 別の規制
        "34,63,K3,132.459 34.396,132.459 34.395,広島交差点", // 別の県
      ),
      OPTIONS,
    );

    expect(result.signs).toEqual([
      {
        id: "33-K1@34.664000_133.918000",
        lat: 34.665,
        lon: 133.918,
        approach: { lat: 34.664, lon: 133.918 },
      },
    ]);
    expect(result.skipped).toMatchObject({ otherPref: 1, otherRegulation: 1 });
  });

  it("経度が先、緯度が後（1つの項目に入っている）", () => {
    const result = extractStopSigns(csv("33,63,K1,133.918 34.665,,"), OPTIONS);

    // 岡山は北緯 34 度・東経 133 度。取り違えると日本の範囲を外れて捨てられる。
    expect(result.signs[0]).toMatchObject({ lat: 34.665, lon: 133.918 });
  });

  it("全項目がダブルクォートで囲まれていても読める（実データの形式）", () => {
    const quoted = [
      '"都道府県コード","共通規制種別コード","ユニークキー","規制場所の経度緯度","進入方向(座標)","交差点名称(踏切名含む)"',
      '"33","000063","K1","133.918 34.665","133.918 34.664",""',
    ].join("\r\n");

    const result = extractStopSigns(quoted, OPTIONS);

    // 共通規制種別コードは6バイトなので "000063" もありうる。数値で比べている。
    expect(result.signs).toHaveLength(1);
    expect(result.signs[0]).toMatchObject({ id: "33-K1@34.664000_133.918000" });
  });

  it("列名の括弧が全角でも引ける", () => {
    const zenkaku = [
      "都道府県コード,共通規制種別コード,ユニークキー,規制場所の経度緯度,進入方向（座標）,交差点名称（踏切名含む）",
      "33,63,K1,133.918 34.665,133.918 34.664,岡山交差点",
    ].join("\n");

    expect(extractStopSigns(zenkaku, OPTIONS).signs[0]?.approach).toEqual({
      lat: 34.664,
      lon: 133.918,
    });
  });

  it("進入方向が複数あれば、方向のぶんだけ標識に分ける", () => {
    // 交差点単位で登録されると、規制地点1点に対して進入方向が複数入る（説明書 3.5.2）。
    const result = extractStopSigns(
      csv("33,63,K1,133.918 34.665,133.918 34.664;133.917 34.665,岡山交差点"),
      OPTIONS,
    );

    expect(result.signs.map((s) => s.id)).toEqual([
      "33-K1@34.664000_133.918000",
      "33-K1@34.665000_133.917000",
    ]);
    // 規制地点はどちらも同じ。違うのは進入方向だけ。
    expect(result.signs.every((s) => s.lat === 34.665 && s.lon === 133.918)).toBe(true);
    expect(result.signs[0]?.approach).toEqual({ lat: 34.664, lon: 133.918 });
    expect(result.signs[1]?.approach).toEqual({ lat: 34.665, lon: 133.917 });
  });

  it("進入方向の並びが変わっても id が入れ替わらない", () => {
    const forward = extractStopSigns(
      csv("33,63,K1,133.918 34.665,133.918 34.664;133.917 34.665,"),
      OPTIONS,
    );
    const reversed = extractStopSigns(
      csv("33,63,K1,133.918 34.665,133.917 34.665;133.918 34.664,"),
      OPTIONS,
    );

    expect(reversed.signs).toEqual(forward.signs);
  });

  it("進入方向が1つ増えても、既にある方向の id は変わらない", () => {
    // 通し番号（#1 #2）で採番すると、南寄りの方向が1つ増えただけで
    // **その交差点の標識が全部「別の標識」になって鳴り直す。**
    const before = extractStopSigns(
      csv("33,63,K1,133.918 34.665,133.918 34.664;133.917 34.665,"),
      OPTIONS,
    );
    const after = extractStopSigns(
      csv("33,63,K1,133.918 34.665,133.918 34.663;133.918 34.664;133.917 34.665,"),
      OPTIONS,
    );

    for (const sign of before.signs) {
      expect(after.signs).toContainEqual(sign);
    }
  });

  it("同じ進入方向が2回入っていても標識は1件にする", () => {
    // 残すと、1つの標識に causeId が2つ付き、端末の抑制をすり抜けて二重に鳴る。
    const result = extractStopSigns(
      csv("33,63,K1,133.918 34.665,133.918 34.664;133.918 34.664,"),
      OPTIONS,
    );

    expect(result.signs).toHaveLength(1);
    expect(result.skipped.duplicate).toBe(1);
  });

  it("進入方向が無ければ approach は null で、数に出る", () => {
    // 方向で絞れない標識は対向車線でも鳴りうるので、多ければ元データを疑う材料になる。
    const result = extractStopSigns(csv("33,63,K1,133.918 34.665,,岡山交差点"), OPTIONS);

    expect(result.signs[0]).toMatchObject({ id: "33-K1", approach: null });
    expect(result.withoutApproach).toBe(1);
  });

  it("範囲を外れた進入方向は落とすが、標識そのものは残す", () => {
    const result = extractStopSigns(csv("33,63,K1,133.918 34.665,0 0,"), OPTIONS);

    expect(result.signs).toHaveLength(1);
    expect(result.signs[0]?.approach).toBeNull();
  });

  it("規制場所が壊れている行は黙って捨てず、数に出す", () => {
    const result = extractStopSigns(
      csv(
        "33,63,K1,,133.918 34.664,", // 座標が空
        "33,63,K2,133.918 999,,", // 範囲外
        "33,63,K3,あいう えお,,", // 数値でない
      ),
      OPTIONS,
    );

    expect(result.signs).toEqual([]);
    expect(result.skipped.badCoordinate).toBe(3);
  });

  it("ユニークキーが無い行を「座標が不正」と数えない", () => {
    // 要約で座標の列を疑わせると、原本を持っている1人が壊れている列に辿り着けない。
    const result = extractStopSigns(csv("33,63,,133.918 34.665,,"), OPTIONS);

    expect(result.skipped).toMatchObject({ missingKey: 1, badCoordinate: 0 });
  });

  it("同じ規制が二重に入っていたら1件にまとめる", () => {
    const result = extractStopSigns(
      csv("33,63,K1,133.918 34.665,133.918 34.664,", "33,63,K1,133.918 34.665,133.918 34.664,"),
      OPTIONS,
    );

    expect(result.signs).toHaveLength(1);
    expect(result.skipped.duplicate).toBe(1);
  });

  it("取り込み直しても id が変わらない（同じ標識が鳴り直さない）", () => {
    const source = csv("33,63,K1,133.918 34.665,133.918 34.664,岡山交差点");

    expect(extractStopSigns(source, OPTIONS).signs).toEqual(
      extractStopSigns(source, OPTIONS).signs,
    );
  });

  it("列が足りない行を「他県」と数えない", () => {
    // 「他県 40000」と出ると、原本を持っている人は
    // 「違う県をダウンロードした」と読む。壊れているのは読み方の方である。
    const result = extractStopSigns(csv("33,63,K1", "33,63,K2,133.918 34.665,,"), OPTIONS);

    expect(result.skipped.malformed).toBe(1);
    expect(result.skipped.otherPref).toBe(0);
    expect(result.signs).toHaveLength(1);
  });

  it("末尾の空欄が省かれていても取り込める（必要な列まであればよい）", () => {
    // ヘッダ全幅を要求すると、末尾を省く出力に当たった瞬間に全行が「列が足りない」になり、
    // 0 件の理由として「県が違う」という誤った当たりを出してしまう。
    const result = extractStopSigns(csv("33,63,K1,133.918 34.665"), OPTIONS);

    expect(result.signs).toHaveLength(1);
    expect(result.skipped.malformed).toBe(0);
  });

  it("必要な列が無ければ、どの列が無いかを言って落ちる", () => {
    expect(() => extractStopSigns("都道府県コード,ユニークキー\n33,K1", OPTIONS)).toThrow(
      /規制場所の経度緯度/,
    );
  });

  it("進入方向の列が無くても取り込める（方向で絞れなくなるだけ）", () => {
    const minimal = [
      "都道府県コード,共通規制種別コード,ユニークキー,規制場所の経度緯度",
      "33,63,K1,133.918 34.665",
    ].join("\n");

    expect(extractStopSigns(minimal, OPTIONS).signs[0]).toMatchObject({
      id: "33-K1",
      approach: null,
    });
  });

  it("id の昇順で返す（版が並び順で変わらないように）", () => {
    const result = extractStopSigns(
      csv("33,63,K3,133.918 34.665,,", "33,63,K1,133.919 34.666,,"),
      OPTIONS,
    );

    expect(result.signs.map((s) => s.id)).toEqual(["33-K1", "33-K3"]);
  });
});
