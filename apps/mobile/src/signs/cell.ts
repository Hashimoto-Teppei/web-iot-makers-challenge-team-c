/**
 * セル（集計と検索の升目）。
 *
 * **切り方の正本は `docs/interfaces/web-service.md`「セルの切り方」**で、
 * そこで決めた「緯度経度を小数第3位で切り捨てる」をそのまま実装している。
 * **2通りの切り方を持たないこと**——片方だけ変えると、
 * **画面に出る場所と警告が出る場所がずれる**（`docs/adr/0009-on-device-storage.md`）。
 *
 * 端末側でこれを使うのは「標識を近傍だけ引く」ためで、集計のためではない。
 * それでも同じ切り方にしてあるのは上のとおり。
 */

/**
 * 1度あたりのセルの数。**小数第3位で切り捨てる**ので 1000。
 *
 * 大きさは岡山（北緯 34.6°）で南北およそ 111m × 東西およそ 92m。**正方形ではない。**
 */
const CELLS_PER_DEGREE = 1_000;

/** セルの座標。緯度と経度をそれぞれ整数にしたもの。 */
export type Cell = {
  /** 緯度のセル。`Math.floor(lat * 1000)` */
  lat: number;
  /** 経度のセル。`Math.floor(lon * 1000)` */
  lon: number;
};

/**
 * 緯度経度が入るセルを返す。
 *
 * **切り捨て（`Math.floor`）で統一する。**四捨五入と混ぜるとセルの境界が半セルずれる
 * （`docs/interfaces/web-service.md`）。負の座標でも「南西の角へ寄せる」向きに
 * そろえたいので、0 方向へ丸める `Math.trunc` ではなく `Math.floor` を使う
 * （日本国内では差が出ないが、切り方の定義に曖昧さを残さない）。
 *
 * **境界ちょうどの値は浮動小数の誤差で隣のセルに入りうる。**ずれる幅は
 * ナノメートルの桁で、同じ入力なら必ず同じセルになる（同梱物を作るときも、
 * 走行中に引くときも、この関数を通す）ので実害は無い。
 */
export function cellOf(lat: number, lon: number): Cell {
  return {
    lat: Math.floor(lat * CELLS_PER_DEGREE),
    lon: Math.floor(lon * CELLS_PER_DEGREE),
  };
}

/** 2つのセルが同じか。**引き直すかどうかの判定に使う**（`./nearby.ts`）。 */
export function sameCell(a: Cell, b: Cell): boolean {
  return a.lat === b.lat && a.lon === b.lon;
}

/**
 * 自セル + 周囲8セルの範囲（両端を含む）。
 *
 * **1セルだけを引かない。**セルの大きさは 100m 前後で、自車がセルの端にいれば
 * **数メートル先の標識が隣のセルに入っている。**3×3 なら、どこに立っていても
 * 最低 100m 先までは手元に入る（`docs/adr/0009-on-device-storage.md`）。
 */
export function cellRange(cell: Cell): {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
} {
  return {
    latMin: cell.lat - 1,
    latMax: cell.lat + 1,
    lonMin: cell.lon - 1,
    lonMax: cell.lon + 1,
  };
}
