/**
 * 合成したシナリオ。**検知の担当が最初に触る場所。**
 *
 * 4つの検知それぞれに、**発火するはずの状況**を1つずつ用意してある。
 * `runDetectorInputs(approachFromBehind)` のように回して、自分の検知に流す。
 *
 * **ここに置くのは「起きている状況」だけで、しきい値は置かない。**何 m/s の接近を
 * 危険と見なすかは各検知が決めることで（`docs/interfaces/detectors.md`）、シナリオが
 * 決めると**しきい値を調整した瞬間にシナリオごと嘘になる。**
 *
 * **実走行の GPS ログは使わない**（`CLAUDE.md`）。座標は岡山市付近を選んだ合成値で、
 * 誰かの移動を写したものではない。
 */

import type { StopSign } from "../detect/types";
import { destination, rider } from "./node";
import type { Scenario } from "./run";

/** 観測者。この端末の視点で見る。 */
const ME = "a1000001";
/** 相手。 */
const OTHER = "b2000002";

/** 岡山市付近の基準点（合成）。 */
const BASE = { lat: 34.6617, lon: 133.9344 };

/** 方角の読みやすい名前（度、真北 0、時計回り）。 */
const NORTH = 0;
const EAST = 90;
const SOUTH = 180;
const WEST = 270;

/**
 * 後ろから速い自転車が詰めてくる（#9 `approach`）。
 *
 * 自分は 4 m/s で北へ。相手は 60m 後ろから 9 m/s で同じ方向へ走るので、
 * 相対 5 m/s で詰まり、**12 秒あたりで追いつく。**
 *
 * **相手は最後まで走り続ける。**追い抜いたあとも走らせているのは、
 * **通り過ぎたあとに警告が止まるか**を同じシナリオで見られるようにするため。
 */
export const approachFromBehind: Scenario = {
  name: "後ろから 9 m/s の自転車が詰めてくる",
  observerId: ME,
  durationMs: 20_000,
  nodes: [
    rider({ id: ME, ...BASE, legs: [{ durationMs: 20_000, bearingDeg: NORTH, speedMps: 4 }] }),
    rider({
      id: OTHER,
      ...destination(BASE.lat, BASE.lon, SOUTH, 60),
      legs: [{ durationMs: 20_000, bearingDeg: NORTH, speedMps: 9 }],
    }),
  ],
};

/**
 * 前を走る自転車が急ブレーキをかける（#10 `brake`）。
 *
 * 30m 前を同じ 5 m/s で走っていた相手が、**5 秒目から 1.5 秒かけて止まる**
 * （およそ 3.3 m/s² の減速）。自分は速度を変えないので、そのまま詰まる。
 *
 * **速度を階段状に落としていない。**減速度は `t` の差と `spd` の差から出すので
 * （`docs/interfaces/detectors.md`）、1 ティックで 5 → 0 にすると
 * **しきい値が間隔次第で変わってしまい、調整の意味が無くなる。**
 */
export const hardBrakeAhead: Scenario = {
  name: "30m 前の自転車が 1.5 秒で止まる",
  observerId: ME,
  durationMs: 15_000,
  nodes: [
    rider({ id: ME, ...BASE, legs: [{ durationMs: 15_000, bearingDeg: NORTH, speedMps: 5 }] }),
    rider({
      id: OTHER,
      ...destination(BASE.lat, BASE.lon, NORTH, 30),
      legs: [
        { durationMs: 5_000, bearingDeg: NORTH, speedMps: 5 },
        { durationMs: 1_500, bearingDeg: NORTH, speedMps: 5, endSpeedMps: 0 },
        { durationMs: 8_500, bearingDeg: NORTH, speedMps: 0 },
      ],
    }),
  ],
};

/** {@link blindCorner} の交差点。両者がここで出会う。 */
const CROSSING = destination(BASE.lat, BASE.lon, NORTH, 50);

/**
 * 見えない交差点へ、直交する道から対向車が来る（#11 `corner`）。
 *
 * 自分は南から北へ、相手は東から西へ、**どちらも交差点まで 50m** の位置から
 * 5 m/s で近づく。**10 秒目に両者が交差点に届く。**
 *
 * **「見えない」ことをシナリオでは表せない。**建物の有無はデータに無いので、
 * ここが作るのは**進行方角がほぼ直交していて、交差点までの距離が近い**という幾何だけ。
 * それを「見えない」と見なすかは検知の側が決める（#11 の論点）。
 */
export const blindCorner: Scenario = {
  name: "直交する道から対向車が交差点へ近づく",
  observerId: ME,
  durationMs: 15_000,
  nodes: [
    rider({
      id: ME,
      lat: BASE.lat,
      lon: BASE.lon,
      legs: [{ durationMs: 15_000, bearingDeg: NORTH, speedMps: 5 }],
    }),
    rider({
      id: OTHER,
      ...destination(CROSSING.lat, CROSSING.lon, EAST, 50),
      legs: [{ durationMs: 15_000, bearingDeg: WEST, speedMps: 5 }],
    }),
  ],
};

/**
 * {@link stopSignAhead} の標識。進路上 80m 先に置いてある。
 *
 * **進入方向は標識の 20m 手前**（南）。北へ走る自車は、この点から標識へ向かっている。
 */
const SIGN_AHEAD: StopSign = {
  id: "sim-stop-1",
  ...destination(BASE.lat, BASE.lon, NORTH, 80),
  approach: destination(BASE.lat, BASE.lon, NORTH, 60),
};

/**
 * 進路の先に一時停止の標識がある（#27 `stop`）。
 *
 * 5 m/s で北へ走り、**16 秒目に 80m 先の標識へ届く。**
 *
 * **すぐ横の道にある標識も一緒に渡してある。**単に近いだけで拾うと、
 * **自分が向かっていない標識で警告が鳴る**——#27 が進行方角を見なければならない理由。
 * 相手（`peers`）は登場しない。この検知は通信が死んでいても動くものだから。
 */
export const stopSignAhead: Scenario = {
  name: "進路の 80m 先に一時停止の標識がある",
  observerId: ME,
  durationMs: 20_000,
  signs: [
    SIGN_AHEAD,
    // 東へ 40m 外れた、別の道の標識。距離だけを見ると先に引っかかる。
    // **進入方向はさらに東**——東から西へ走る車が対象で、北へ走る自車は対象ではない。
    {
      id: "sim-stop-2",
      ...destination(BASE.lat, BASE.lon, EAST, 40),
      approach: destination(BASE.lat, BASE.lon, EAST, 60),
    },
  ],
  nodes: [
    rider({ id: ME, ...BASE, legs: [{ durationMs: 20_000, bearingDeg: NORTH, speedMps: 5 }] }),
  ],
};

/**
 * 走行中に測位を失う（故障 1）。
 *
 * 5 秒目から 9 秒目まで測位できない。この間、スマホは **POST せず、`beat` に
 * `st: "nofix"` を書き続ける。**検知は1つも呼ばれない（`input` が `null` になる）。
 *
 * デバイス側では `link` が `nofix` になる（#36）。**`down` ではない**——
 * アプリは動いており、待てば直る状態である。
 */
export const positionLostMidRide: Scenario = {
  ...approachFromBehind,
  name: "走行中に 4 秒間 測位を失う",
  faults: { nofix: [{ fromMs: 5_000, toMs: 9_000 }] },
};

/**
 * 走行中に POST が失敗し続ける（故障 2）。
 *
 * 5 秒目から 10 秒目まで、サーバーとの交換が成立しない。**近傍は空になるが、
 * 測位は生きているので `beat` は `st: "ok"` のまま**で、`link` は `up` のままである。
 *
 * **この空を「周りに誰もいない」と読み替えないこと。**読み替えると、
 * 自分だけが静かに警告を受け取れなくなり、他の全員からは正常に見える
 * （`docs/interfaces/detectors.md`「「なし」は「安全」ではない」）。
 */
export const postFailureMidRide: Scenario = {
  ...approachFromBehind,
  name: "走行中に POST が 5 秒間 失敗する",
  faults: { postFails: [{ fromMs: 5_000, toMs: 10_000 }] },
};

/**
 * 走行中にアプリが落ちる（故障 3）。
 *
 * 8 秒目以降、**`beat` が1通も出ない。**デバイスは自分で気づいて `link` を `down` に
 * しなければならない（#36）。**これが無いと `adr/0006` は成立しない**——
 * デバイスから見て「警告が来ていないだけ」と区別が付かないため。
 */
export const appCrashMidRide: Scenario = {
  ...approachFromBehind,
  name: "走行中にアプリが落ちて心拍が途切れる",
  faults: { appDown: [{ fromMs: 8_000, toMs: Number.POSITIVE_INFINITY }] },
};

/**
 * 相手が送信をやめる。
 *
 * 追いついてきた相手が 10 秒目に黙る。サーバー側とモバイル側の失効が**足し算になる**ので
 * （`docs/interfaces/mobile-api.md`）、近傍から消えるまでには最悪でおよそ6秒かかる。
 * **その間、相手はその場に止まっている自転車として残り続ける。**
 */
export const peerGoesSilent: Scenario = {
  name: "詰めてきた相手が途中で送信をやめる",
  observerId: ME,
  durationMs: 25_000,
  nodes: [
    rider({ id: ME, ...BASE, legs: [{ durationMs: 25_000, bearingDeg: NORTH, speedMps: 4 }] }),
    rider({
      id: OTHER,
      ...destination(BASE.lat, BASE.lon, SOUTH, 60),
      legs: [{ durationMs: 25_000, bearingDeg: NORTH, speedMps: 9 }],
      silentMs: [{ fromMs: 10_000, toMs: Number.POSITIVE_INFINITY }],
    }),
  ],
};

/** 用意してあるシナリオの一覧。**テストで全部を回すために使う。** */
export const scenarios = [
  approachFromBehind,
  hardBrakeAhead,
  blindCorner,
  stopSignAhead,
  positionLostMidRide,
  postFailureMidRide,
  appCrashMidRide,
  peerGoesSilent,
] as const;
