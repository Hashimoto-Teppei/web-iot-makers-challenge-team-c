/**
 * 緯度経度と角度の計算。
 *
 * 4つの検知がどれも距離と方位を必要とするため、共通にしてある
 * （各自が書くと4通りの距離計算ができる）。**それ以上をここに入れない。**
 * 「あると便利そうなもの」を先に足すと、使われないまま各自が自前で書き直すことになる。
 *
 * 外の世界に触れない純粋な関数だけを置く。そのため実機がなくてもテストできる。
 */

/**
 * 地球の半径（メートル）。
 *
 * 岡山県内・数百メートルの範囲なので球体近似で足りる。測地線の厳密な計算
 * （Vincenty など）は要らないし、そのためにライブラリも足さない。
 */
const EARTH_RADIUS_M = 6_371_000;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;
const toDegrees = (rad: number): number => (rad * 180) / Math.PI;

/**
 * 2地点間の距離をメートルで返す（ハーヴァサイン公式）。
 *
 * @param lat1 1点目の緯度（度）
 * @param lon1 1点目の経度（度）
 * @param lat2 2点目の緯度（度）
 * @param lon2 2点目の経度（度）
 */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaPhi = toRadians(lat2 - lat1);
  const deltaLambda = toRadians(lon2 - lon1);

  const a =
    Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * 1点目から見た2点目の方位角を度で返す（真北 0、時計回り、0 以上 360 未満）。
 *
 * `Fix.crs`（進行方角）と同じ向き・同じ範囲に揃えてあるので、そのまま引き算して
 * {@link normalizeAngleDeg} に渡せる。
 *
 * 2点が同じ位置のときは 0 を返す（`atan2(0, 0)` が 0 になるため）。**この 0 に
 * 意味は無い**ので、距離が測位精度（`hacc`）より小さいときは方位を信じないこと。
 */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaLambda = toRadians(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  // atan2 は -180〜180 を返すので、360 を足した剰余で 0〜360 未満に寄せる。
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/**
 * 角度を -180 以上 180 未満に収める。2つの方角の差を出すのに使う。
 *
 * **各自で書かないこと。**359 度と 1 度の差が 358 ではなく 2 であることは
 * 4つの検知すべてが必要とし、ここを間違えると**真後ろから来る自転車を正面と判定する。**
 *
 * ちょうど 180 度（真後ろ）は -180 に寄せる。左右どちらでもない値なので、
 * 大小ではなく絶対値で扱うこと（`Math.abs(normalizeAngleDeg(a - b)) > 150` のように書く）。
 */
export function normalizeAngleDeg(deg: number): number {
  // 剰余は負の値を残す（JavaScript の % は符号が被除数に従う）ので、
  // 360 を足してから再度剰余を取り、0〜360 未満にしてから 180 を引く。
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}
