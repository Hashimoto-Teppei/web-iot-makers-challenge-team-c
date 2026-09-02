/**
 * 見えない曲がり角の対向車の検知（#11 `corner`）。
 *
 * **「見えない」ことはデータに無い。**建物の位置も塀の高さも手元に無いので、
 * この検知が判断できるのは**幾何だけ**である。そこで
 *
 * > **進路が交わり、両者がその交点にほぼ同時に着き、相手が自分の正面から外れている**
 *
 * を「見えない曲がり角の対向車」の近似として使う。**正面に居る相手は見えている**
 * （それは急接近 #9 か前方急ブレーキ #10 の領分）ので、
 * **横から来る相手だけがここに残る。**交差点の角に建つものが視界を切るのは、まさに
 * その方向である。**近似であることは `docs/unverified.md` に積んである。**
 *
 * 共通の約束は `docs/interfaces/detectors.md`。この検知も**入力を受けて結果を返す純粋な
 * 関数**であり、ハードウェアにも通信にも触れず、`Date.now()` も乱数も使わず、前回の
 * 呼び出しを覚えない。おかげで実機なしで Vitest から確かめられる。
 */

import { bearingDeg, distanceM, normalizeAngleDeg } from "./geo";
import type { Detector, DetectorInput, Fix, Track, Warning } from "./types";

/**
 * 見えない曲がり角のしきい値。
 *
 * **既定値はすべて仮の値**で、実走行で調整する（`docs/unverified.md` 5 / 21 / 57）。
 * だからこそコードに直書きせず、第2引数で受け取る（`CLAUDE.md`）。
 *
 * **他の検知と共有しない。**同じ名前の値を共有すると、片方の調整がもう片方を壊す
 * （`docs/interfaces/detectors.md`）。
 */
export type BlindCornerConfig = {
  /** 交点に着くまでの見込みがこれ以内なら見る（秒） */
  maxEtaS: number;
  /** 交点に着くまでの見込みがこれ以下なら `lv: 3`（秒） */
  etaLevel3S: number;
  /** 同上。これ以下なら `lv: 2`（秒）。それより長ければ `lv: 1` */
  etaLevel2S: number;
  /**
   * 2台が交点に着く時刻の差がこれ以内なら「出会う」とする（秒）。
   *
   * **交わる進路そのものは危険ではない。**同じ交差点を1分違いで通る2台は、
   * 一生出会わない。**時間で絞らないと、街中のほぼ全員が該当する。**
   */
  maxArrivalGapS: number;
  /**
   * 2台の進行方角の差の下限（度）。**これ未満なら見ない。**
   *
   * 並走・追走は交わる進路ではなく、急接近（#9）が見る形である。
   */
  minCourseAngleDeg: number;
  /**
   * 2台の進行方角の差の上限（度）。**これを超えたら見ない。**
   *
   * 180 度に近いのは**同じ道の対向車**で、互いに正面に居るので見えている。
   */
  maxCourseAngleDeg: number;
  /**
   * 相手が自分の正面からこれだけ外れていること（度）。
   *
   * **これが「見えない」の近似のすべて。**正面に居る相手は見えているので、
   * 横から来る相手だけを残す。**狭めるほど拾う範囲は広がるが、目の前の相手でも鳴る。**
   */
  minOffAxisDeg: number;
  /**
   * 相手までがこの距離以下になったら何も言わない（メートル）。
   *
   * **「正面から外れているか」を方角で決めているから要る。**相手が近いほど、
   * 自分から見た方角は測位のゆらぎで大きく振れる（`geo.ts` の `bearingDeg`）ので、
   * 正面かどうかをティックごとに取り違える。
   *
   * **黙っても筋が通る。**数メートルの距離まで来た相手は、もう角の向こうに居ない——
   * **見えている相手はこの検知の対象ではない**というこのファイルの前提そのものである。
   */
  nearZoneM: number;
  /**
   * 両者ともこの速度以上であること（m/s）。
   *
   * **止まっている相手は交点に着かない**し、`crs` も `null` になるので進路が引けない。
   */
  minSpeedMps: number;
  /** 最新の測位がこれ以上古かったら何も言わない（ミリ秒） */
  maxFixAgeMs: number;
  /**
   * 水平位置精度がこれより粗い測位は使わない（メートル）。
   *
   * **`approach.ts` と既定値が同じでも共有しない。**あちらは距離の変化を測るための
   * 足切りで、こちらは**進路を引いて交点を求める**ための足切りである。
   * 位置が数 m ずれると交点は数十 m 動きうるので、調整する理由が違う。
   */
  maxHaccM: number;
};

export const blindCornerDefaults: BlindCornerConfig = {
  // 自転車の 5 m/s なら 40m 手前。**急接近（#9）より早く出す**——交差点は
  // 相手が見えないまま近づくので、見えてからでは間に合わない。
  maxEtaS: 8,
  etaLevel3S: 3,
  etaLevel2S: 5,
  // 交差点に同時に飛び込む形を拾う幅。広げるほど「たまたま同じ交差点を通る2台」が混ざる。
  maxArrivalGapS: 3,
  minCourseAngleDeg: 30,
  maxCourseAngleDeg: 150,
  // 正面から 30 度。自転車の前方視界の中心はここに収まるので、外れていれば
  // 「角の向こう」に近い。**仮の値である**（`docs/unverified.md`）。
  minOffAxisDeg: 30,
  // **測位精度（下の `maxHaccM`）と同じ大きさ。**位置が 8m ずれうるなら、
  // 8m 先の相手の方角は信じられない。
  nearZoneM: 8,
  // 徒歩よりやや遅い程度。`crs` が出る下限（1.0 m/s）より上に置く。
  minSpeedMps: 1.5,
  maxFixAgeMs: 3_000,
  maxHaccM: 8,
};

/** 1台ぶんの判定結果。**選ぶために交点までの距離を残す。** */
type Candidate = { warning: Warning; distanceM: number };

/**
 * 自車を原点とした平面上のベクトル（メートル）。
 *
 * **数百メートルの範囲なので平面で差し支えない。**緯度経度のまま交点を解くと式が
 * 読めなくなるので、`geo.ts` の距離と方位で一度メートルに直してから解く。
 * **`geo.ts` に足さない**——ここでしか使わないものは利用者の側に置く（`CLAUDE.md`）。
 */
type Vec = {
  /** 東向き（メートル） */
  e: number;
  /** 北向き（メートル） */
  n: number;
};

/** 方角（度、真北 0、時計回り）を長さ 1 のベクトルにする。 */
function heading(deg: number): Vec {
  const rad = (deg * Math.PI) / 180;
  return { e: Math.sin(rad), n: Math.cos(rad) };
}

/** 2次元の外積。**0 なら平行**（交点が無い）。 */
const cross = (a: Vec, b: Vec): number => a.e * b.n - a.n * b.e;

/** 交点までの、それぞれの進む距離（メートル）。**負なら後ろ**（もう通り過ぎている）。 */
type Crossing = { selfM: number; peerM: number };

/**
 * 自車と相手の進路（半直線）が交わる点を求める。平行なら `null`。
 *
 * 自車を原点、相手を `peerAt` に置き、`原点 + s * selfDir = peerAt + w * peerDir` を解く。
 * 両辺と各方向ベクトルの外積を取ると、`s` と `w` がそれぞれ1本の式で出る。
 *
 * **半直線であることが肝心。**直線として解くと、**すでに通り過ぎた交差点**や
 * **後ろへ延ばした先**で交わった点まで拾い、居もしない相手で鳴る。
 */
function crossingOf(peerAt: Vec, selfDir: Vec, peerDir: Vec): Crossing | null {
  const denom = cross(selfDir, peerDir);
  if (denom === 0) return null;
  return { selfM: cross(peerAt, peerDir) / denom, peerM: cross(peerAt, selfDir) / denom };
}

/**
 * 自車と相手1台を見て、警告に値するかを返す。
 *
 * @param selfDir 自車の進む向き。相手ごとに変わらないので呼び出し側で1度だけ作る
 */
function judgePeer(
  input: DetectorInput,
  selfLast: Fix,
  selfCrs: number,
  selfDir: Vec,
  peer: Track,
  config: BlindCornerConfig,
): Candidate | null {
  const peerLast = peer.fixes[peer.fixes.length - 1];
  // 古さは `rxAt`（自分の時計）から測る。`t` は相手の時計なので混ぜない
  // （`docs/interfaces/detectors.md`「時刻が2つある理由」）。
  if (input.now - peerLast.rxAt > config.maxFixAgeMs) return null;
  if (peerLast.hacc > config.maxHaccM) return null;
  if (peerLast.spd < config.minSpeedMps) return null;

  // 進路が引けなければ交点も出せない。**ここで `null` を捨てているのは向きが
  // 要る計算だから**であって、相手を軽く見ているのではない（急接近 #9 は同じ相手を見る）。
  const peerCrs = peerLast.crs;
  if (peerCrs === null) return null;

  const courseGapDeg = Math.abs(normalizeAngleDeg(peerCrs - selfCrs));
  if (courseGapDeg < config.minCourseAngleDeg) return null;
  if (courseGapDeg > config.maxCourseAngleDeg) return null;

  const awayM = distanceM(selfLast.lat, selfLast.lon, peerLast.lat, peerLast.lon);
  // **すぐそばの相手では黙る。**方角が振れて正面かどうかを決められないし、
  // ここまで来た相手はもう角の向こうに居ない（{@link BlindCornerConfig.nearZoneM}）。
  if (awayM <= config.nearZoneM) return null;
  const towardPeerDeg = bearingDeg(selfLast.lat, selfLast.lon, peerLast.lat, peerLast.lon);
  // **正面に居る相手は見えている。**見えている相手はこの検知の対象ではない。
  if (Math.abs(normalizeAngleDeg(towardPeerDeg - selfCrs)) < config.minOffAxisDeg) return null;

  const peerAt = heading(towardPeerDeg);
  const crossing = crossingOf(
    { e: peerAt.e * awayM, n: peerAt.n * awayM },
    selfDir,
    heading(peerCrs),
  );
  if (crossing === null) return null;
  // **どちらかが通り過ぎていたら、もう出会わない。**
  if (crossing.selfM <= 0 || crossing.peerM <= 0) return null;

  const selfEtaS = crossing.selfM / selfLast.spd;
  const peerEtaS = crossing.peerM / peerLast.spd;
  if (selfEtaS > config.maxEtaS) return null;
  // **同じ交点に着くだけでは危なくない。**ほぼ同時に着くから危ない。
  if (Math.abs(selfEtaS - peerEtaS) > config.maxArrivalGapS) return null;

  const lv = selfEtaS <= config.etaLevel3S ? 3 : selfEtaS <= config.etaLevel2S ? 2 : 1;

  return { warning: { kind: "corner", lv, causeId: peer.id }, distanceM: crossing.selfM };
}

/**
 * 見えない曲がり角で出会う相手を1台選んで返す。無ければ `null`。
 *
 * **`null` は「曲がり角は安全」ではない。**近傍が空（POST が失敗している）ときも、
 * 相手が低速で `crs` を持たないときも `null` になる
 * （`docs/interfaces/detectors.md`「「なし」は「安全」ではない」）。
 *
 * **返すのは最大1つ。**デバイスの出力は1組しかないので、同じ `kind` を2つ渡しても
 * 出せるものは増えない。**`lv` が高いもの、同じなら交点が近いもの**を選ぶ。
 */
export const detectBlindCorner: Detector<BlindCornerConfig> = (input, config) => {
  const selfLast = input.self.fixes[input.self.fixes.length - 1];
  if (input.now - selfLast.rxAt > config.maxFixAgeMs) return null;
  if (selfLast.hacc > config.maxHaccM) return null;
  if (selfLast.spd < config.minSpeedMps) return null;

  // 自分の進路が引けなければ交点も出せない。
  const selfCrs = selfLast.crs;
  if (selfCrs === null) return null;
  const selfDir = heading(selfCrs);

  let best: Candidate | null = null;

  for (const peer of input.peers) {
    const candidate = judgePeer(input, selfLast, selfCrs, selfDir, peer, config);
    if (candidate === null) continue;

    if (
      best === null ||
      candidate.warning.lv > best.warning.lv ||
      (candidate.warning.lv === best.warning.lv && candidate.distanceM < best.distanceM)
    ) {
      best = candidate;
    }
  }

  return best?.warning ?? null;
};
