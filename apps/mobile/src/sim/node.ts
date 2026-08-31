/**
 * 仮想ノード（シミュレータ上の1台）の動き。
 *
 * **時刻を渡すと位置が返るだけ。**状態を持たないので、同じ時刻を何度渡しても同じ位置が
 * 返り、ティックを飛ばしても結果が変わらない。
 *
 * **実走行の GPS ログは使わない。**位置情報は個人情報であり、自宅や行動パターンが
 * 特定できる（`CLAUDE.md`）。ここで組み立てるのは合成したデータだけ。
 */

/** ある時刻のノードの状態。`docs/interfaces/v2v.md`「メッセージ」の位置ぶんと同じ形。 */
export type NodeState = {
  lat: number;
  lon: number;
  /** 対地速度（m/s） */
  spd: number;
  /** 進行方角（度、真北 0、時計回り 0〜360未満）。低速時は null */
  crs: number | null;
  /** 水平位置精度（メートル） */
  hacc: number;
};

/**
 * 一定の方角へ走る区間。これを並べて1台の動きを作る。
 *
 * 曲がるときは方角の違う区間をつなぐ。**急ブレーキは `endSpeedMps` で表す**（#10 が
 * 見るのは減速度なので、速度が階段状に落ちるとしきい値の意味が変わってしまう）。
 */
export type Leg = {
  /** この区間の長さ（ミリ秒） */
  durationMs: number;
  /** 進む方角（度、真北 0、時計回り） */
  bearingDeg: number;
  /** 区間の始まりの速度（m/s） */
  speedMps: number;
  /** 区間の終わりの速度（m/s）。省略すると等速。間は線形に変わる */
  endSpeedMps?: number;
};

/** 何秒かのあいだ位置を送らない期間（シナリオ開始からの相対ミリ秒、`fromMs` 以上 `toMs` 未満）。 */
export type Span = { fromMs: number; toMs: number };

/** シミュレータ上の1台。 */
export type SimNode = {
  /** 端末ID（16進の小文字8文字）。BLE の `device_id` と同じ形 */
  id: string;
  /**
   * この間は位置を送らない（シナリオ開始からの相対）。
   *
   * **相手が送信をやめたときに近傍から消えるか**を確かめるためのもの。
   * **観測者には書かないこと**——観測者側の故障は `Faults` が表す（`./run.ts`）。
   */
  silentMs?: readonly Span[];
  /**
   * 経過時刻（シナリオ開始からの相対ミリ秒）における状態。
   *
   * 区間の合計を超えたあとは、**最後の区間をそのまま延長する。**その時点で速度を 0 に
   * 落とすと、シナリオの終わり際に**起きていない急ブレーキ**が検知に見える。
   */
  at: (elapsedMs: number) => NodeState;
};

/** 地球の半径（メートル）。`../detect/geo.ts` と同じ球体近似。 */
const EARTH_RADIUS_M = 6_371_000;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;
const toDegrees = (rad: number): number => (rad * 180) / Math.PI;

/**
 * ある地点から方角と距離を指定して進んだ先の座標を返す。
 *
 * **`../detect/geo.ts` に置かない。**あちらは4つの検知が共有するものだけを置く場所で、
 * 「それ以上を入れない」と決まっている（`docs/interfaces/detectors.md`）。
 * これを使うのはシミュレータだけなので、利用者の側に置く（`CLAUDE.md`）。
 */
export function destination(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceM: number,
): { lat: number; lon: number } {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = toRadians(bearingDeg);
  const phi1 = toRadians(lat);
  const lambda1 = toRadians(lon);

  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(sinPhi2);
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * sinPhi2,
    );

  // 経度は -180〜180 に寄せる。岡山県内では跨がないが、日付変更線で破綻する式を
  // 残しておくと、あとで座標を変えた人が原因の分からない結果を見ることになる。
  return { lat: toDegrees(phi2), lon: ((toDegrees(lambda2) + 540) % 360) - 180 };
}

/**
 * `spd` がこれ未満なら `crs` を `null` にする（m/s）。
 *
 * **`../v2v/messages.ts` の `CRS_MIN_SPD_MPS` と同じ値にしてある**が、あちらを import
 * していない。ここは「測位がそう振る舞う」ことの再現であって、送信側の丸めではないため。
 */
const CRS_MIN_SPD_MPS = 1.0;

/** 1台ぶんの動きを組み立てる。 */
export function rider(opts: {
  id: string;
  /** 出発点の緯度 */
  lat: number;
  /** 出発点の経度 */
  lon: number;
  /** 走る区間。順に辿る */
  legs: readonly Leg[];
  /** 水平位置精度（メートル）。既定 4.0（屋外で GNSS が素直に出る程度の仮の値） */
  haccM?: number;
  silentMs?: readonly Span[];
}): SimNode {
  const { id, lat, lon, legs, haccM = 4.0, silentMs } = opts;
  if (legs.length === 0) throw new Error(`rider(${id}): legs が空。動かない台は作らない`);
  // 長さ 0 の区間があると、減速の割合が 0/0 で NaN になる。NaN は受信側の検証で
  // 丸ごと捨てられるので、**その台が理由の分からないまま消える。**
  if (legs.some((leg) => leg.durationMs <= 0)) {
    throw new Error(`rider(${id}): durationMs は正の値にする（0 だと速度が NaN になる）`);
  }

  return {
    id,
    ...(silentMs === undefined ? {} : { silentMs }),
    at: (elapsedMs: number): NodeState => {
      let position = { lat, lon };
      let left = Math.max(0, elapsedMs);
      let index = 0;

      // 終わった区間を丸ごと進める。**最後の区間は抜けない**ので、指定の長さを過ぎても
      // そのまま延長される（速度が急に 0 になると、起きていない急ブレーキが検知に見える）。
      while (index < legs.length - 1 && left >= (legs[index] as Leg).durationMs) {
        const leg = legs[index] as Leg;
        position = destination(
          position.lat,
          position.lon,
          leg.bearingDeg,
          travelM(leg, leg.durationMs),
        );
        left -= leg.durationMs;
        index += 1;
      }

      const current = legs[index] as Leg;
      if (left > 0) {
        position = destination(
          position.lat,
          position.lon,
          current.bearingDeg,
          travelM(current, left),
        );
      }

      const spd = speedAt(current, left);
      return {
        ...position,
        spd,
        crs: spd < CRS_MIN_SPD_MPS ? null : current.bearingDeg,
        hacc: haccM,
      };
    },
  };
}

/** 区間の中で `elapsedInLegMs` ミリ秒進んだときの速度（m/s）。線形に変える。 */
function speedAt(leg: Leg, elapsedInLegMs: number): number {
  const end = leg.endSpeedMps ?? leg.speedMps;
  if (end === leg.speedMps) return leg.speedMps;
  // 指定の長さを過ぎたあとは終わりの速度のまま。延長した区間で減速が続くと、
  // いずれ速度が負になる。
  const ratio = Math.min(1, Math.max(0, elapsedInLegMs / leg.durationMs));
  return leg.speedMps + (end - leg.speedMps) * ratio;
}

/** 区間の中で `elapsedInLegMs` ミリ秒進むあいだに動く距離（メートル）。 */
function travelM(leg: Leg, elapsedInLegMs: number): number {
  const end = leg.endSpeedMps ?? leg.speedMps;
  if (end === leg.speedMps) return (leg.speedMps * elapsedInLegMs) / 1000;

  // 速度が線形に変わるので、その間の平均速度は始点と終点の平均。指定の長さを
  // 超えたぶんは、終わりの速度で等速に進む。
  const rampMs = Math.min(elapsedInLegMs, leg.durationMs);
  const rampSpeed = (leg.speedMps + speedAt(leg, rampMs)) / 2;
  const restMs = elapsedInLegMs - rampMs;
  return (rampSpeed * rampMs) / 1000 + (end * restMs) / 1000;
}
