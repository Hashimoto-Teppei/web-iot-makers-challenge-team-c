/**
 * `GET /api/stop-signs` の応答を、同梱物にできる形まで確かめる。
 *
 * **同梱物を作るときにしか使わない**（`scripts/build-signs-db.ts`）。走行中には通らない。
 *
 * **ここで落とすことに意味がある。**通り抜けたものはそのまま数万件の `signs.db` になり、
 * **アプリは中身が欠けていることに気づけない**——「近くに標識が無い」と
 * 見分けが付かないためである（`docs/interfaces/mobile-api.md`
 * 「『持っていない』と『0件』を混ぜない」）。**静かに欠けるより、生成の時点で落とす。**
 */

import type { StopSign } from "../detect/types";
import type { SignsMeta } from "./store";

export type ParsedStopSigns = {
  meta: SignsMeta;
  signs: StopSign[];
};

/** 応答が壊れている・足りないときに投げる。**握りつぶさないこと。** */
export class StopSignsResponseError extends Error {}

function fail(message: string): never {
  throw new StopSignsResponseError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberAt(row: Record<string, unknown>, key: string, where: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${where} の ${key} が数値ではありません`);
  }
  return value;
}

/**
 * 応答の本文と `ETag` から、`signs.db` に書くものを作る。
 *
 * @param body `GET /api/stop-signs` の JSON
 * @param etag 応答の `ETag` ヘッダ。**そのまま `meta.version` になる**
 *   （`docs/interfaces/mobile-api.md`「版はサーバーが決める」）。端末側で作らない
 * @param builtAt 生成した時刻
 */
export function parseStopSignsResponse(
  body: unknown,
  etag: string | null,
  builtAt: Date,
): ParsedStopSigns {
  if (!isRecord(body)) fail("応答が JSON のオブジェクトではありません");

  // **ETag が無ければ作らない。**端末が独自の版を持ち始めると、次回の
  // `If-None-Match` が成立せず、**毎回 数 MB を落とし直す**ことになる。
  if (etag === null || etag.length === 0) {
    fail("応答に ETag がありません（版はサーバーが決めるので、端末側では作れません）");
  }

  const pref = numberAt(body, "pref", "応答");
  const count = numberAt(body, "count", "応答");
  const rawSigns = body.signs;
  if (!Array.isArray(rawSigns)) fail("応答の signs が配列ではありません");

  // **件数が食い違ったら作らない。**サーバー側にも同じ確認があるが
  // （`apps/web/src/worker/index.ts`）、**受け取った側で確かめるのをやめない。**
  if (rawSigns.length !== count) {
    fail(`応答の件数が食い違っています（count=${count} / signs=${rawSigns.length}）`);
  }

  const signs = rawSigns.map((row: unknown, i: number): StopSign => {
    if (!isRecord(row)) fail(`signs[${i}] がオブジェクトではありません`);
    const id = row.id;
    if (typeof id !== "string" || id.length === 0) fail(`signs[${i}] の id が空です`);

    return {
      id,
      lat: numberAt(row, "lat", `signs[${i}]`),
      lon: numberAt(row, "lon", `signs[${i}]`),
      approach: parseApproach(row.approach, i),
    };
  });

  return {
    meta: { pref, version: etag, count, builtAt: builtAt.toISOString() },
    signs,
  };
}

/**
 * 進入方向。**`null` は「全方向が対象」ではなく「元データに登録が無い」**ので、
 * そのまま運ぶ（読み替えるのは検知の側。#27）。
 *
 * **片方の座標だけがある行を通さない。**通すと、検知は「方向がある」と読んで
 * 見当違いの向きで絞り込む（`numberAt` がその場で落とす）。
 */
function parseApproach(value: unknown, i: number): StopSign["approach"] {
  if (value === null) return null;
  if (!isRecord(value)) fail(`signs[${i}] の approach が座標でも null でもありません`);

  return {
    lat: numberAt(value, "lat", `signs[${i}].approach`),
    lon: numberAt(value, "lon", `signs[${i}].approach`),
  };
}
