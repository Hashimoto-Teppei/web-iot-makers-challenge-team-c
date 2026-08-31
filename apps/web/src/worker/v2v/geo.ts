/**
 * 2地点間の距離。半径で絞るためだけに使う。
 *
 * **`apps/mobile/src/detect/geo.ts` の `distanceM` と同じ式**を、こちらにも置いてある。
 * 共有しないのは、モバイルが Worker の**型**だけを参照する関係（Hono RPC）を保つためで、
 * 実体を跨いで import すると Worker のバンドルにモバイル側のコードが混ざる。
 * **2つ目の共有したいものが出てきた時点で `packages/` を検討する**（`CLAUDE.md`）。
 *
 * 岡山県内・数百メートルの範囲なので球体近似で足りる。方位角はサーバー側では要らない
 * （向きを見るのは検知の仕事で、それはスマホにある）ので移していない。
 */

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/** 2地点間の距離をメートルで返す（ハーヴァサイン公式）。 */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaPhi = toRadians(lat2 - lat1);
  const deltaLambda = toRadians(lon2 - lon1);

  const a =
    Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
