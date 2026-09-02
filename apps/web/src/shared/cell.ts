/**
 * セル（集計の升目）。**切り方の正本は `docs/interfaces/web-service.md`「セルの切り方」。**
 *
 * **`src/shared/` に置いてある**のは、**画面と API の両方が丸めるから**である——
 * API は集計のために（`src/worker/stats/`）、画面は円を置く点を出すために（`src/client/stats/`）
 * 同じ升目を使う。**`src/client/` から `src/worker/` は import できない**（`CLAUDE.md`）ので、
 * ここに無いと**半セルの足し方が画面側にもう1つ書かれる。**
 *
 * **`apps/mobile/src/signs/cell.ts` と同じ切り方を、こちらにも置いてある。**
 * 共有しないのは `worker/geo.ts` と同じ理由（モバイルは Worker の**型**だけを参照する）。
 * **切り方を変えるときは両方を直すこと**——片方だけ変えると、
 * **画面に出る場所と、端末が標識を引く場所がずれる。**
 *
 * **丸め方をここ以外に書かない。**特に SQL 側で `CAST(lat * 1000 AS INTEGER)` と
 * 書き直さないこと——`CAST` は 0 方向へ丸めるので `Math.floor` とは南半球で食い違い、
 * **「切り捨てで統一する」という決定が2つの実装に割れる。**
 */

/**
 * 1度あたりのセルの数。**小数第3位で切り捨てる**ので 1000。
 *
 * 大きさは岡山（北緯 34.6°）で南北およそ 111m × 東西およそ 92m。**正方形ではない。**
 */
const CELL_SCALE = 1_000;

/** セルの座標。緯度と経度をそれぞれ整数にしたもの。 */
export type Cell = {
  /** `Math.floor(lat * 1000)` */
  lat: number;
  /** `Math.floor(lon * 1000)` */
  lon: number;
};

/**
 * 緯度経度が入るセルを返す。
 *
 * **切り捨て（`Math.floor`）で統一する。**四捨五入と混ぜるとセルの境界が半セルずれ、
 * **地図の円・ランキング・詳細画面が別のセルを指す**（`docs/interfaces/web-service.md`）。
 */
export function cellOf(lat: number, lon: number): Cell {
  return {
    lat: Math.floor(lat * CELL_SCALE),
    lon: Math.floor(lon * CELL_SCALE),
  };
}

/**
 * セルを 1 つの文字列にする。**`Map` と `Set` の鍵にするためだけのもの。**
 *
 * **画面にも URL にも出さない。**外に出す識別子は代表座標（{@link cellCorner}）で、
 * そちらは「切り捨てた緯度経度」という意味を持つ（`docs/interfaces/web-ui.md`）。
 */
export function cellKey(cell: Cell): string {
  return `${cell.lat}/${cell.lon}`;
}

/**
 * セルの**南西の角**の緯度経度。**これがランキングに出す代表座標**である
 * （`docs/interfaces/web-ui.md`「場所は地図が示す」）。
 *
 * **「中心」と呼ばないこと。**切り捨てた値は角であって中心ではない。
 */
export function cellCorner(cell: Cell): { lat: number; lon: number } {
  return { lat: cell.lat / CELL_SCALE, lon: cell.lon / CELL_SCALE };
}

/**
 * セルの**中心**の緯度経度。**地図に円を置くのはこちら。**
 *
 * **角に置いてはいけない**——**南へ 55m・西へ 46m ずれる**（岡山の緯度で。
 * `docs/interfaces/web-ui.md`）。半セル（緯度 +0.0005 / 経度 +0.0005）足した点になる。
 */
export function cellCenter(cell: Cell): { lat: number; lon: number } {
  return {
    lat: (cell.lat + 0.5) / CELL_SCALE,
    lon: (cell.lon + 0.5) / CELL_SCALE,
  };
}
