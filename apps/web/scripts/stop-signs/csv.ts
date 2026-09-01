/**
 * JARTIC の交通規制情報オープンデータ（CSV）から一時停止の標識を抜き出す。
 *
 * **形式の正本は JARTIC の「交通規制情報（拡張版標準フォーマット）説明書 ver k_2.1」。**
 * 守っている前提はこのファイルのコメントに書くが、**実データで確かめてはいない**
 * （`docs/unverified.md` 61）。
 *
 * **ここにはファイルも通信も出てこない。**入力は文字列、出力は行の配列で、
 * **モックデータだけで Vitest から回せる**ようにしてある（`docs/adr/0002-development-lifecycle.md`）。
 * 実データを持っている人が1人しかいない以上、**持っていない人が直せる形でないと
 * 誰も触れないコードになる。**
 */

import type { StopSign } from "../../src/shared/api";

/**
 * 抽出に使う列。**列名で引く**（項目は 170 個あり、順番に依存すると仕様の版で壊れる）。
 *
 * 説明書の「フォーマット項目」名をそのまま書いてある。比較する前に `normalizeHeader` で
 * 括弧と空白を均すので、全角・半角のゆれは吸収される。
 */
const COLUMN = {
  pref: "都道府県コード",
  regulation: "共通規制種別コード",
  /** 全国でユニークな 32 桁。**都道府県別ではない**（説明書 3.7.1 NO.21） */
  key: "ユニークキー",
  /** **経度と緯度が1つの項目に入る**（NO.24）。別々の列ではない */
  place: "規制場所の経度緯度",
  /** 規制地点に対する車両の進入方向（NO.35）。**複数入りうる** */
  approach: "進入方向(座標)",
  /** 交差点名称（NO.27）。端末には配らないが D1 には残す */
  name: "交差点名称(踏切名含む)",
} as const;

/** 日本の範囲。ここを外れた座標は壊れているものとして捨てる */
const LAT_RANGE = { min: 20, max: 46 } as const;
const LON_RANGE = { min: 122, max: 154 } as const;

/** 複数の座標を区切る文字（説明書 表2）。区間・区域の区切り `/` は点規制では現れない */
const COORD_SEPARATOR = ";";

export type ExtractOptions = {
  /** 都道府県コード（岡山県 = 33） */
  pref: number;
  /** 共通規制種別コード（一時停止 = 63） */
  regulationCode: number;
};

/** D1 に入れる1件。端末に配るのは `StopSign` のぶんだけで、`name` は配らない */
export type ExtractedSign = StopSign & {
  /** 交差点名称。無ければ null */
  name: string | null;
};

export type ExtractResult = {
  /** id の昇順。**並びを固定するのは、版が並び順で変わらないようにするため** */
  signs: ExtractedSign[];
  /** 捨てた行の内訳。**黙って捨てない**——0 件になった理由がここに出る */
  skipped: {
    /** 別の都道府県の行。**1都道府県警察1ファイルなので、本来は 0 になる** */
    otherPref: number;
    /** 一時停止以外の規制の行 */
    otherRegulation: number;
    /** 規制場所の座標が読めない、または日本の範囲を外れている行 */
    badCoordinate: number;
    /**
     * ユニークキーが空の行。**「座標が不正」と混ぜない**——混ぜると、
     * 要約を読んだ人が座標の列を疑い、**実際に壊れているキーの列に辿り着けない。**
     */
    missingKey: number;
    /** 同じ id が二重に入っていた行 */
    duplicate: number;
    /**
     * 列が足りない行。**「他県」と混ぜない**——混ぜると、
     * **CSV の読み方が壊れているのに「別の県をダウンロードした」と読める**要約が出る。
     * 原本を持っているのは1人なので、その人が誤った結論に進むと誰も気づけない。
     */
    malformed: number;
  };
  /**
   * 進入方向が登録されていなかった規制の数。**捨ててはいないが、方向で絞れない。**
   *
   * 説明書では一時停止の進入方向は「条件付必須A」なので、**ここが大きければ
   * 元データか読み方を疑う**（方向が無い標識は、対向車線でも鳴りうる）。
   */
  withoutApproach: number;
};

/**
 * CSV を行と列に分ける。**引用符の中の区切り文字と改行を落とさない。**
 *
 * 説明書（表2）では**ヘッダを含む全項目がダブルクォートで囲まれる**が、
 * 囲まれていない出力も受け取れるようにしてある。
 */
export function parseCsv(text: string): string[][] {
  // BOM 付きで配られることがある。残すと最初の列名が "﻿都道府県コード" になり、
  // 列が見つからないという分かりにくい失敗になる。
  const source = text.replace(/^﻿/, "");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];

    if (quoted) {
      if (c === '"') {
        // "" は引用符そのもの。閉じ引用符と区別する。
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    // **フィールドの先頭でだけ引用符を開く。**途中に現れた `"` は文字そのもの
    // （RFC 4180）。どこでも開けるようにすると、交差点名に1つ紛れた `"` から
    // **次の `"` までの数万行が1つのフィールドとして飲み込まれる**——
    // 例外は出ず、件数が静かに減るだけなので気づけない。
    if (c === '"' && field.length === 0) {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      // CRLF を2行と数えない（説明書の改行コードは CR+LF）。
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }

  // 閉じられていない引用符は、そこから先を丸ごと飲み込んでいる。**黙って進まない。**
  if (quoted) {
    throw new Error("CSV の引用符が閉じられていません。ファイルが途中で切れている可能性があります");
  }

  // 末尾に改行が無いファイルの最終行を落とさない。
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((v) => v.trim().length > 0));
}

/** 列名のゆれ（全角の括弧・空白）を均す。**中身の比較には使わない** */
function normalizeHeader(name: string): string {
  return name
    .replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"))
    .replace(/[\s　]/g, "")
    .trim();
}

/**
 * 座標の項目を点の配列にする。
 *
 * 形式は `"経度 緯度;経度 緯度;…"`（説明書 3.7.1 NO.24）。
 * **経度が先**で、緯度との間は半角スペース、点と点の間はセミコロン。
 * **順番を取り違えると、岡山の標識が中国大陸に並ぶ**——日本の範囲の検査で落ちる。
 */
function parseCoordinates(value: string | undefined): { lat: number; lon: number }[] {
  if (!value?.trim()) return [];

  const points: { lat: number; lon: number }[] = [];
  for (const part of value.split(COORD_SEPARATOR)) {
    const [lon, lat] = part.trim().split(/\s+/).map(Number);
    if (lat === undefined || lon === undefined) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < LAT_RANGE.min || lat > LAT_RANGE.max) continue;
    if (lon < LON_RANGE.min || lon > LON_RANGE.max) continue;
    points.push({ lat, lon });
  }
  return points;
}

/** 列名から列の位置を引く。**見つからない列があれば、その名前を挙げて落とす。** */
function indexColumns(header: readonly string[]): Record<keyof typeof COLUMN, number> {
  const normalized = header.map(normalizeHeader);
  const at = (name: string) => normalized.indexOf(normalizeHeader(name));
  const found = {
    pref: at(COLUMN.pref),
    regulation: at(COLUMN.regulation),
    key: at(COLUMN.key),
    place: at(COLUMN.place),
    approach: at(COLUMN.approach),
    name: at(COLUMN.name),
  };

  // 進入方向と交差点名称は無くても取り込める（方向で絞れなくなるだけ）。
  // **止めないのは、方向が無いことより「1件も取り込めないこと」の方が悪いから。**
  const missing = (["pref", "regulation", "key", "place"] as const).filter((k) => found[k] < 0);
  if (missing.length > 0) {
    throw new Error(
      `CSV に必要な列がありません: ${missing.map((k) => COLUMN[k]).join(" / ")}\n` +
        `見つかった列: ${header.join(" / ")}`,
    );
  }

  return found;
}

/** 進入方向を id に埋めるときの桁。小数第6位はおよそ 0.1m で、標識を取り違えない細かさ */
const APPROACH_ID_DIGITS = 6;

/**
 * 進入方向ごとに id を作る。
 *
 * **1つの交差点に複数の進入方向があると、規制は1レコードでも標識は方向のぶんだけ要る**
 * （説明書 3.5.2 の点規制(2)B）。
 *
 * **id は端末で警告の抑制キー（`causeId`）になる。**取り込みのたびに変わると、
 * **同じ標識が毎回「別の標識」として鳴り直す。**そのため接尾辞には**進入方向の座標そのもの**を
 * 使う——`#1` `#2` のような通し番号にすると、**翌月にその交差点の進入方向が1つ増えただけで
 * 残りの番号が全部ずれ、交差点まるごと鳴り直す。**
 *
 * **進入方向の登録が付いたり消えたりすれば id は変わる**（`33-K1` ⇄ `33-K1@…`）。
 * これは避けられない——方向が付いた時点で、対象の違う別の標識になっている。
 */
function idOf(pref: number, key: string, approach: { lat: number; lon: number } | null): string {
  const base = `${pref}-${key}`;
  if (!approach) return base;
  return `${base}@${approach.lat.toFixed(APPROACH_ID_DIGITS)}_${approach.lon.toFixed(APPROACH_ID_DIGITS)}`;
}

/**
 * CSV の中身から、指定した都道府県の一時停止の標識だけを取り出す。
 *
 * **同じ id の行が2回出てきたら、先に出た方を残す。**元データの重複であり、
 * **どちらが正しいかを決める材料がここには無い。**
 */
export function extractStopSigns(text: string, options: ExtractOptions): ExtractResult {
  const rows = parseCsv(text);
  const [header, ...body] = rows;
  if (!header) throw new Error("CSV が空です");

  const at = indexColumns(header);
  const skipped = {
    otherPref: 0,
    otherRegulation: 0,
    badCoordinate: 0,
    missingKey: 0,
    duplicate: 0,
    malformed: 0,
  };
  // **ヘッダ全体の幅を要求しない。**末尾の空欄を省く出力や、ヘッダにだけ余分な列がある
  // 出力に当たると、**全データ行が「列が足りない」になって 0 件**になる。
  const requiredWidth = Math.max(at.pref, at.regulation, at.key, at.place) + 1;
  const byId = new Map<string, ExtractedSign>();
  let withoutApproach = 0;

  for (const row of body) {
    if (row.length < requiredWidth) {
      skipped.malformed++;
      continue;
    }
    if (Number(row[at.pref]?.trim()) !== options.pref) {
      skipped.otherPref++;
      continue;
    }
    // コードは 6 バイトなので "63" と "000063" の両方がありうる。数値にして比べる。
    if (Number(row[at.regulation]?.trim()) !== options.regulationCode) {
      skipped.otherRegulation++;
      continue;
    }

    // **規制場所は点規制なので1点。**複数あっても先頭だけを使う。
    const place = parseCoordinates(row[at.place])[0];
    if (!place) {
      skipped.badCoordinate++;
      continue;
    }
    const key = row[at.key]?.trim();
    if (!key) {
      skipped.missingKey++;
      continue;
    }

    const name = (at.name >= 0 ? row[at.name]?.trim() : "") || null;
    const approaches = at.approach >= 0 ? parseCoordinates(row[at.approach]) : [];
    if (approaches.length === 0) withoutApproach++;

    // 進入方向が無ければ方向なしで1件、あれば方向のぶんだけ行を作る。
    // **同じ座標が2回入っていたら1件にする**（id が同じになるので下の重複で畳まれる）——
    // 残すと中身の完全に同じ標識が2件でき、**1つの標識に `causeId` が2つ付いて、
    // 端末の抑制をすり抜けて二重に鳴る。**
    const entries: { id: string; approach: { lat: number; lon: number } | null }[] =
      approaches.length === 0
        ? [{ id: idOf(options.pref, key, null), approach: null }]
        : approaches.map((approach) => ({ id: idOf(options.pref, key, approach), approach }));

    for (const { id, approach } of entries) {
      if (byId.has(id)) {
        skipped.duplicate++;
        continue;
      }
      byId.set(id, { id, lat: place.lat, lon: place.lon, approach, name });
    }
  }

  const signs = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { signs, skipped, withoutApproach };
}
