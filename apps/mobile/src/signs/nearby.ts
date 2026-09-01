/**
 * 走行中に「いまの近傍の標識」を保つ。**セルをまたいだときだけ引き直す。**
 *
 * **毎周期 SQL を投げない**ためのもの。セルは岡山でおよそ 111m × 92m なので、
 * 5 m/s で走っても引き直しは 20 秒に1回程度に落ちる（`docs/unverified.md` 59 が
 * 外れたときに効く保険でもある）。
 *
 * **キャッシュ以上のことをここでやらない。**距離も方角も見ない（それは検知の仕事）。
 * 引く範囲を変えたくなったら `./cell.ts` を直す——**ここに2つ目の絞り込みを足さない。**
 */

import type { StopSign } from "../detect/types";
import { type Cell, cellOf, sameCell } from "./cell";
import type { SignStore } from "./store";

export type NearbySigns = {
  /**
   * その地点の近傍の標識。**毎周期呼んでよい**（同じセルの間は引き直さない）。
   *
   * 返す配列は引き直すまで同じもので、**呼び出し側が書き換えないこと**
   * （`readonly` にしてあるのはそのため）。
   */
  at(lat: number, lon: number): readonly StopSign[];
};

export function createNearbySigns(store: SignStore): NearbySigns {
  let cell: Cell | null = null;
  let signs: readonly StopSign[] = [];

  return {
    at(lat, lon) {
      const next = cellOf(lat, lon);
      if (cell !== null && sameCell(cell, next)) return signs;

      cell = next;
      signs = store.near(lat, lon);
      return signs;
    },
  };
}
