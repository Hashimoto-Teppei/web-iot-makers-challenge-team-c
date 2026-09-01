/**
 * 2地点間の距離と方位角。**Worker の中で位置を扱うところが共通で使う。**
 *
 * **`apps/mobile/src/detect/geo.ts` の `distanceM` と同じ式**を、こちらにも置いてある。
 * 共有しないのは、モバイルが Worker の**型**だけを参照する関係（Hono RPC）を保つためで、
 * 実体を跨いで import すると Worker のバンドルにモバイル側のコードが混ざる。
 * **2つ目の共有したいものが出てきた時点で `packages/` を検討する**（`CLAUDE.md`）。
 *
 * **もとは `v2v/geo.ts` にあった。**不停止の判定（`recompute/`）が2人目の利用者になったので
 * `v2v/` から出した（2026-09-02）。車車間の下に置いたまま別の機能から import すると、
 * **中継の都合で変えてよいコードなのかが読めなくなる。**
 *
 * 岡山県内・数百メートルの範囲なので球体近似で足りる。
 */

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;
const toDegrees = (rad: number): number => (rad * 180) / Math.PI;

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

/**
 * 1点目から2点目へ向かう方位角（度、真北 0、東回り）。
 *
 * **`ride_points.crs`（端末が打った方角）の代わりに使う。**方角の無い測位が `0`（真北）
 * として入っていることがあり（`docs/unverified.md` 57）、**それを信じると東西に走った走行が
 * 北向きの標識に付く**（`docs/interfaces/web-service.md`「不停止の判定」）。
 *
 * **2点が同じなら方位は定義できない**ので `null` を返す。呼ぶ側は「分からない」として扱うこと
 * ——0（真北）に潰すと、まさに上と同じ間違いをこちらで作ることになる。
 */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number | null {
  if (lat1 === lat2 && lon1 === lon2) return null;

  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaLambda = toRadians(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  // atan2 は -180〜180 を返す。0〜360 に寄せてから返す（呼ぶ側で符号を気にしないため）。
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/**
 * 2つの方位角の差を 0〜180 で返す。**どちら回りかは捨てる。**
 *
 * 進入方向のずれを見るのに使う。**359° と 1° の差は 2°** であって 358° ではない
 * ——単純な引き算にすると、真北を向いた標識でだけ判定が壊れる。
 */
export function angleDiffDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}
