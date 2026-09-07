/**
 * 手元の標識が覆っている範囲（外接矩形）。
 *
 * **「標識を持っていない」と「近くに標識が無い」を混ぜない**（`docs/interfaces/stop-signs-delivery.md`）
 * の続きである。件数と版は走行前に見せているが、**持っている県の外へ出たこと**は
 * それでは見えない——手元は 28,651 件のままで、**一時停止の事前通知だけが黙る。**
 * `docs/adr/0004-v2v-transport.md` が一番恐れた静かな部分故障そのものなので、
 * **出たことを走行後に人へ見せる**（#72）。
 *
 * **矩形しか持たない。** 県の形は矩形ではないので、**中に居ても県外**ということはある
 * （岡山県の外接矩形には広島県と兵庫県の一部が入る）。それでも矩形にしているのは、
 * **走行中に毎秒判定するものだから**である——多角形の内外判定を 1Hz の経路に置かない。
 * **見逃す側に倒れる**（外に出たのに気づかない）ので、**濡れ衣は着せない。**
 */

import type { StopSign } from "../detect/types";

/** 外接矩形（度、WGS84）。**`signs.db` の `meta` に1つだけ持つ。** */
export type SignBounds = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

/**
 * 標識の全件から外接矩形を作る。**空なら `null`**（0 件と矩形が無いことは同じ）。
 *
 * **規制地点だけで作る。**進入方向の点は数十メートル手前にあるが、
 * **矩形が県ぶんの大きさである**ので誤差にもならない
 * （`docs/adr/0009-on-device-storage.md`「同じ切り方を2つ持たない」と同じ立場で、
 * **入れる点を増やすほど、生成側と判定側で食い違う余地が増える**）。
 */
export function boundsOf(signs: readonly StopSign[]): SignBounds | null {
  if (signs.length === 0) return null;

  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  for (const sign of signs) {
    if (sign.lat < minLat) minLat = sign.lat;
    if (sign.lat > maxLat) maxLat = sign.lat;
    if (sign.lon < minLon) minLon = sign.lon;
    if (sign.lon > maxLon) maxLon = sign.lon;
  }

  return { minLat, maxLat, minLon, maxLon };
}

/**
 * その地点が矩形の外か。**境界の上は「中」**（等号を含める）。
 *
 * **経度の 180 度線をまたぐ矩形を考えない。** 配るのは日本の1県ぶんだけである
 * （`docs/interfaces/stop-signs-delivery.md`「都道府県ぶんを一度に配る」）。
 */
export function isOutsideBounds(bounds: SignBounds, lat: number, lon: number): boolean {
  return lat < bounds.minLat || lat > bounds.maxLat || lon < bounds.minLon || lon > bounds.maxLon;
}
