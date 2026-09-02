/**
 * 前方車両の急ブレーキの検知（#10 `brake`）。
 *
 * **見ているのは「前を走っている相手の速度がどれだけ急に落ちたか」**であって、
 * 2台の距離ではない。距離が縮まることを見るのは急接近（#9 `approach`）の仕事で、
 * **こちらは距離がまだ縮まりきる前——相手がブレーキを踏んだ瞬間に言える**ことに意味がある。
 * 追突は「気づいたときには詰まっている」形の事故なので、**詰まる前に出す。**
 *
 * 共通の約束は `docs/interfaces/detectors.md`。この検知も**入力を受けて結果を返す純粋な
 * 関数**であり、ハードウェアにも通信にも触れず、`Date.now()` も乱数も使わず、前回の
 * 呼び出しを覚えない。おかげで実機なしで Vitest から確かめられる。
 */

import { bearingDeg, distanceM, normalizeAngleDeg } from "./geo";
import type { Detector, DetectorInput, Fix, Track, Warning } from "./types";

/**
 * 前方急ブレーキのしきい値。
 *
 * **既定値はすべて仮の値**で、実走行で調整する（`docs/unverified.md` 5 / 36）。
 * だからこそコードに直書きせず、第2引数で受け取る（`CLAUDE.md`）。
 *
 * **他の検知と共有しない。**同じ名前の値を共有すると、片方の調整がもう片方を壊す
 * （`docs/interfaces/detectors.md`）。
 */
export type HardBrakeConfig = {
  /** この距離まで近い相手だけを見る（メートル） */
  warnDistanceM: number;
  /**
   * 自分の進行方角から見て、この範囲に居る相手を「前方」とする（度）。
   *
   * **狭めるほど確実に前方の相手だけになるが、カーブの先の相手を落とす。**
   * 道が曲がっていれば、同じ車線を走っていても自分から見た方角は横へ開く。
   */
  aheadToleranceDeg: number;
  /**
   * 相手の進行方角が自分とこの範囲にあれば「同じ向き」とする（度）。
   *
   * **対向車と、交差点を横切る車のブレーキは追突の危険にならない**ので落とす。ただし
   * **`crs` が `null` の相手は落とさない**（`docs/interfaces/detectors.md`）——
   * 止まりきった相手がそれであり、**急ブレーキの終着点そのもの**である。
   *
   * **落としたい角度をそのまま入れないこと。**判定は「これを超えたら落とす」なので、
   * 90 と置くと**直交する道の車が 89.9 度で通り抜ける。**
   */
  sameCourseToleranceDeg: number;
  /** 減速度がこれ以上なら発火（m/s²）。**自転車の常用の減速はこれより緩い** */
  decelMps2: number;
  /**
   * 減速度を測る窓（ミリ秒）。
   *
   * 短くすると測位のゆらぎがそのまま減速度になり、長くすると**ブレーキが窓から
   * 出るまで鳴り続ける。**履歴は `NeighborsConfig.historyMs`（既定 5 秒）ぶんしか
   * 無いので、それより長くしない（`docs/unverified.md` 36）。
   */
  sampleWindowMs: number;
  /**
   * 窓の中で速度がこれだけ落ちていなければ見ない（m/s）。
   *
   * **減速度だけでは足りない。**1Hz の測位では点が数個しか無いので、
   * **0.5 m/s のゆらぎが1秒の間に起きただけで 0.5 m/s² の減速に見える。**
   * 「実際にそれなりの速度を失った」ことを別に求めることで、ゆらぎを弾く。
   */
  minSpeedDropMps: number;
  /** 相手の位置まで今の速度で何秒かかるか。これ以下なら `lv: 3`（秒） */
  headwayLevel3S: number;
  /** 同上。これ以下なら `lv: 2`（秒）。それより長ければ `lv: 1` */
  headwayLevel2S: number;
  /**
   * 自分がこの速度以下なら何も言わない（m/s）。
   *
   * **止まっている自分に「前がブレーキした」と言う意味が無い。**加えて低速では
   * 自分の `crs` が `null` になるので、どのみち前方かどうかを決められない。
   */
  minSelfSpeedMps: number;
  /**
   * 相手までがこの距離以下になったら何も言わない（メートル）。
   *
   * **前方かどうかを方角で決めているから要る。**相手が近いほど、自分から見た方角は
   * 測位のゆらぎで大きく振れる（`geo.ts` の `bearingDeg`）。**すぐ横に並んで走る相手が
   * 信号で止まると、振れた拍子に「前方」に入り、猶予が短いぶん `lv: 3` で鳴る**——
   * 一番大きな警告が、一番関係のない相手で出ることになる。
   *
   * **黙っても穴は開かない。**この距離まで詰まった相手は急接近（#9）が距離の変化で
   * 見ており、あちらは方角を使わないのでゆらぎの影響を受けない。
   * ここまで来て「前がブレーキした」と足しても、できることは増えない。
   */
  nearZoneM: number;
  /** 最新の測位がこれ以上古かったら何も言わない（ミリ秒） */
  maxFixAgeMs: number;
  /**
   * 水平位置精度がこれより粗い測位は使わない（メートル）。
   *
   * **`approach.ts` と既定値が同じでも共有しない。**あちらは距離の変化を測るための
   * 足切りで、こちらは「前方に居るか」を方角で決めるための足切りであり、調整する理由が違う。
   */
  maxHaccM: number;
};

export const hardBrakeDefaults: HardBrakeConfig = {
  // 自転車の 5 m/s なら 12 秒ぶん。**急接近（50m）より広い**——距離が縮まる前の
  // 出来事を見るので、詰まってから見に行くのでは遅い。
  warnDistanceM: 60,
  aheadToleranceDeg: 60,
  // **直交する道（90 度）を確実に落とし**、道なりのカーブ（数十度）は残す幅。
  // 90 と置くと境目そのものになり、交差点を曲がりながら減速する車が通り抜ける。
  sameCourseToleranceDeg: 60,
  // 自転車が普通に止まるときの減速は 1〜1.5 m/s² 程度。その上に置いて、
  // **信号で普通に止まる前の車両**で鳴らないようにする。
  decelMps2: 2.0,
  sampleWindowMs: 3_000,
  minSpeedDropMps: 2.0,
  headwayLevel3S: 2,
  headwayLevel2S: 4,
  // 徒歩よりやや遅い程度。`crs` が出る下限（1.0 m/s）より上に置く。
  minSelfSpeedMps: 1.5,
  // **測位精度（下の `maxHaccM`）と同じ大きさにしてある。**位置が 8m ずれうるなら、
  // 8m 先の相手の方角は信じられない。`stop-sign.ts` の `nearZoneM` と同じ理屈だが、
  // **あちらは「もう手遅れ」も兼ねている**ので、共有せず別に持つ。
  nearZoneM: 8,
  maxFixAgeMs: 3_000,
  maxHaccM: 8,
};

/** 1台ぶんの判定結果。**選ぶために距離を残す。** */
type Candidate = { warning: Warning; distanceM: number };

/** 窓の中で最も強かった減速。 */
type Braking = {
  /** 減速度（m/s²）。**正の値が減速** */
  decelMps2: number;
  /**
   * その区間の**始まりの**進行方角（度）。`null` なら分からない。
   *
   * **終わりの方角を使わない。**ブレーキの終わりでは止まっていて `crs` が `null` に
   * なるので、**急ブレーキの相手ほど向きが分からなくなる**という逆立ちが起きる。
   * 始まりなら、まだ走っていたときの向きが残っている。
   */
  crs: number | null;
};

/**
 * 窓の中で**最も強く速度を落とした区間**を探す。
 *
 * **隣り合う2点だけを見ない。**1Hz では点が数個しか無く、隣どうしの差はゆらぎの影響を
 * まともに受ける。かといって窓の両端だけを見ると、**ブレーキのあとに止まったままの
 * 時間が長いほど減速度が薄まり、強いブレーキほど見逃す**——止まっている区間が
 * 平均に混ざるためである。そこで**窓の中のすべての組から一番強いものを選ぶ。**
 *
 * **間隔は `t` の差で出す**（`docs/interfaces/detectors.md`）。同じ端末の中の2点なので
 * 時計のずれは引き算で消える。**`rxAt` の差で出さないこと**——経路が詰まって到着が
 * 固まると、**止まっていないのに減速して見える。**
 */
function hardestBraking(track: Track, config: HardBrakeConfig): Braking | null {
  const last = track.fixes[track.fixes.length - 1];
  const fromT = last.t - config.sampleWindowMs;
  const window = track.fixes.filter((fix) => fix.t >= fromT);

  let best: Braking | null = null;
  for (let i = 0; i < window.length; i++) {
    for (let j = i + 1; j < window.length; j++) {
      const before = window[i];
      const after = window[j];
      if (before === undefined || after === undefined) continue;

      const spanMs = after.t - before.t;
      if (spanMs <= 0) continue;
      const dropMps = before.spd - after.spd;
      // ゆらぎで拾わないための足切り。**減速度と2つ揃って初めてブレーキと見なす。**
      if (dropMps < config.minSpeedDropMps) continue;

      const decelMps2 = dropMps / (spanMs / 1_000);
      if (best === null || decelMps2 > best.decelMps2) best = { decelMps2, crs: before.crs };
    }
  }
  return best;
}

/**
 * 自車と相手1台を見て、警告に値するかを返す。
 *
 * **距離は互いの最新の測位から出す。**急接近（#9）のように時間軸へ並べ直していないのは、
 * **この検知が距離の変化を見ていない**ため。距離は「前方に居るか」と「どれだけ猶予が
 * あるか」にしか使わないので、数百ミリ秒のずれは段階を1つ動かすほどの差にならない。
 */
function judgePeer(
  input: DetectorInput,
  selfLast: Fix,
  selfCrs: number,
  peer: Track,
  config: HardBrakeConfig,
): Candidate | null {
  const peerLast = peer.fixes[peer.fixes.length - 1];
  // 古さは `rxAt`（自分の時計）から測る。`t` は相手の時計なので混ぜない
  // （`docs/interfaces/detectors.md`「時刻が2つある理由」）。
  if (input.now - peerLast.rxAt > config.maxFixAgeMs) return null;
  if (peerLast.hacc > config.maxHaccM) return null;

  const gapM = distanceM(selfLast.lat, selfLast.lon, peerLast.lat, peerLast.lon);
  if (gapM > config.warnDistanceM) return null;
  // **すぐそばの相手では黙る。**方角が測位のゆらぎで振れ、前方かどうかを決められない
  // （{@link HardBrakeConfig.nearZoneM}）。ここまで詰まった相手は急接近（#9）が見ている。
  if (gapM <= config.nearZoneM) return null;

  // **前方に居るか。**後ろの相手がブレーキしても、こちらが追突することはない。
  const toPeerDeg = bearingDeg(selfLast.lat, selfLast.lon, peerLast.lat, peerLast.lon);
  if (Math.abs(normalizeAngleDeg(toPeerDeg - selfCrs)) > config.aheadToleranceDeg) return null;

  const braking = hardestBraking(peer, config);
  if (braking === null) return null;
  if (braking.decelMps2 < config.decelMps2) return null;

  // **向きが分かるときだけ絞る。**`null` は「止まっていて向きが出ない」であって
  // 「対向車である」ではない（`docs/interfaces/detectors.md`）。捨てると、
  // **止まりきった相手＝一番危ない相手**が静かに落ちる。
  const peerCrs = braking.crs ?? peerLast.crs;
  if (
    peerCrs !== null &&
    Math.abs(normalizeAngleDeg(peerCrs - selfCrs)) > config.sameCourseToleranceDeg
  ) {
    return null;
  }

  // **猶予は「相手の位置に自分が届くまでの秒数」で測る。**相手の速度を引かないのは、
  // 相手が止まりに行っている最中だから——**引くと、止まった瞬間に猶予が縮んで
  // 段階が跳ね上がる**（`minSelfSpeedMps` で 0 除算にならないことは呼び出し側が保証する）。
  const headwayS = gapM / selfLast.spd;
  const lv = headwayS <= config.headwayLevel3S ? 3 : headwayS <= config.headwayLevel2S ? 2 : 1;

  return { warning: { kind: "brake", lv, causeId: peer.id }, distanceM: gapM };
}

/**
 * 急ブレーキをかけた前方車両を1台選んで返す。無ければ `null`。
 *
 * **`null` は「前方は安全」ではない。**近傍が空（POST が失敗している）ときも、測位が
 * 粗いときも、自分が止まっているときも `null` になる
 * （`docs/interfaces/detectors.md`「「なし」は「安全」ではない」）。
 *
 * **返すのは最大1つ。**デバイスの出力は1組しかないので、同じ `kind` を2つ渡しても
 * 出せるものは増えない。**`lv` が高いもの、同じなら近いもの**を選ぶ。
 */
export const detectHardBrake: Detector<HardBrakeConfig> = (input, config) => {
  const selfLast = input.self.fixes[input.self.fixes.length - 1];
  if (input.now - selfLast.rxAt > config.maxFixAgeMs) return null;
  if (selfLast.hacc > config.maxHaccM) return null;
  if (selfLast.spd < config.minSelfSpeedMps) return null;

  // 自分の向きが無ければ、相手が前方かどうかを決められない。
  const selfCrs = selfLast.crs;
  if (selfCrs === null) return null;

  let best: Candidate | null = null;

  for (const peer of input.peers) {
    const candidate = judgePeer(input, selfLast, selfCrs, peer, config);
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
