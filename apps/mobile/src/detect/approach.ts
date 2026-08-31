/**
 * 急接近する自転車の検知（#9 `approach`）。
 *
 * **後ろから詰めてくる相手だけを見るのではない。**止まっている自転車へ自分が突っ込む形も
 * ここで拾う（`docs/interfaces/detectors.md`「`crs` が `null` の相手を捨てない」）。
 * 見ているのは**距離が縮まる速さ**であって、相手が前か後ろかではない。
 *
 * 共通の約束は `docs/interfaces/detectors.md`。この検知も**入力を受けて結果を返す純粋な
 * 関数**であり、ハードウェアにも通信にも触れず、`Date.now()` も乱数も使わず、前回の
 * 呼び出しを覚えない。おかげで実機なしで Vitest から確かめられる。
 */

import { distanceM } from "./geo";
import type { Detector, DetectorInput, Fix, Track, Warning } from "./types";

/**
 * 急接近のしきい値。
 *
 * **既定値はすべて仮の値**で、実走行で調整する（`docs/unverified.md` 5 / 38 / 39）。
 * だからこそコードに直書きせず、第2引数で受け取る（`CLAUDE.md`）。
 *
 * **他の検知と共有しない。**「接近」の意味は検知ごとに違い、同じ名前の値を共有すると
 * 片方の調整がもう片方を壊す（`docs/interfaces/detectors.md`）。
 */
export type ApproachConfig = {
  /** この距離まで詰まっている相手だけを見る（メートル） */
  warnDistanceM: number;
  /** 距離が縮まる速さがこれ以上なら発火（m/s）。**負なら離れている** */
  closingSpeedMps: number;
  /** 衝突までの見込みがこれ以下なら `lv: 3`（秒） */
  ttcLevel3S: number;
  /** 衝突までの見込みがこれ以下なら `lv: 2`（秒）。それより長ければ `lv: 1` */
  ttcLevel2S: number;
  /**
   * 距離の変化を測る間隔（ミリ秒）。
   *
   * 短くすると測位の揺れがそのまま接近速度になり、長くすると詰まり始めに気づくのが遅れる
   * （`docs/unverified.md` 38）。履歴は `NeighborsConfig.historyMs`（既定 5 秒）ぶんしか
   * 無いので、それより長くしない。
   */
  sampleWindowMs: number;
  /**
   * 判定に使う最新の位置が、これ以上古かったら何も言わない（ミリ秒）。
   *
   * **`sampleWindowMs` ぶん前の位置には適用しない。**そちらは仕組み上必ず
   * `sampleWindowMs` だけ古く、同じ物差しで測ると**窓を広げるほど検知が黙る**という
   * 逆立ちした挙動になる。
   */
  maxFixAgeMs: number;
  /** 水平位置精度がこれより粗い測位は使わない（メートル）。`docs/unverified.md` 38 */
  maxHaccM: number;
};

export const approachDefaults: ApproachConfig = {
  // 自転車同士なら 50m 以内に詰まってから知らせれば足りる。遠くから鳴ると
  // 「いつも鳴っているもの」になり、本当に危ないときに見てもらえない。
  warnDistanceM: 50,
  // 歩く速さぶんの差（1.5 m/s）は追い抜きとして日常的に起きるので、その上に置く。
  closingSpeedMps: 2.0,
  ttcLevel3S: 3,
  ttcLevel2S: 6,
  sampleWindowMs: 2_000,
  maxFixAgeMs: 3_000,
  // 屋外で GNSS が素直に出る範囲（数 m）を少し超えたあたり。**広げるほど、測位の揺れが
  // そのまま接近速度になる**（`docs/unverified.md` 38）。
  maxHaccM: 8,
};

/**
 * 自分の時計に写した1点。
 *
 * **`Fix` をそのまま使わないのは、時刻が2つあるものを1つに畳んでいるから。**
 * 畳んだあとの `atMs` は「自分の時計で言えば、この位置はいつのものか」である。
 */
type LocalFix = { atMs: number; lat: number; lon: number; hacc: number };

/** ある時刻の位置。補間して作るので `Fix` ではない。 */
type Pos = { lat: number; lon: number };

/**
 * 相手の測位を**自分の時計の上に並べ直す。**
 *
 * 距離は2台にまたがるので、比べるには**両者を同じ時間軸に乗せる**必要がある。
 * ところが `t` は相手の端末の時計、`rxAt` は自分の時計であり、そのまま混ぜられない
 * （`docs/interfaces/detectors.md`「時刻が2つある理由」）。そこで
 *
 * - **軸の原点は最新の1点の `rxAt`** から取る（自分の時計に合わせるため）
 * - **点と点の間隔は `t` の差**をそのまま使う（同じ端末の中なら時計のずれは引き算で消える）
 *
 * と分けている。**間隔を `rxAt` の差から作らないのが肝心**で、作ると経路が詰まって
 * 到着がまとまった瞬間に、**動いていない相手が猛烈に近づいて見える**
 * （`docs/interfaces/detectors.md` が減速度について禁じているのと同じ壊れ方）。
 */
function toLocalTimeline(track: Track): LocalFix[] {
  const last = track.fixes[track.fixes.length - 1];
  // 経路の遅れを定数とみなす近似。1回の判定は数秒なので、その間に遅れが動いても
  // 差は小さい。ここで吸収しているのは端末間の時計のずれ（秒〜分の桁）である。
  const offsetMs = last.rxAt - last.t;
  return track.fixes.map((fix) => ({
    atMs: fix.t + offsetMs,
    lat: fix.lat,
    lon: fix.lon,
    hacc: fix.hacc,
  }));
}

/**
 * その時刻にどこに居たかを、前後の2点から線形に求める。
 *
 * **持っている範囲の外は求めない**（`null` を返す）。外挿すると、履歴が足りないときに
 * 想像で作った位置で警告を出すことになる。
 *
 * 数百メートルの範囲なので、緯度経度をそのまま直線で結んで差し支えない。
 *
 * @returns 精度の粗い点を使うことになる場合も `null`（信じられない位置は返さない）
 */
function positionAt(timeline: readonly LocalFix[], atMs: number, maxHaccM: number): Pos | null {
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  if (first === undefined || last === undefined) return null;
  if (atMs < first.atMs || atMs > last.atMs) return null;

  for (let i = timeline.length - 1; i > 0; i--) {
    const before = timeline[i - 1];
    const after = timeline[i];
    if (before === undefined || after === undefined) continue;
    if (before.atMs > atMs) continue;

    if (before.hacc > maxHaccM || after.hacc > maxHaccM) return null;

    const spanMs = after.atMs - before.atMs;
    const ratio = spanMs === 0 ? 0 : (atMs - before.atMs) / spanMs;
    return {
      lat: before.lat + (after.lat - before.lat) * ratio,
      lon: before.lon + (after.lon - before.lon) * ratio,
    };
  }

  // ここに来るのは点が1つしか無いとき（`atMs` が範囲内なら、それは最初の点そのもの）。
  return first.hacc > maxHaccM ? null : { lat: first.lat, lon: first.lon };
}

/** 2地点の距離（メートル）。 */
const gapM = (a: Pos, b: Pos): number => distanceM(a.lat, a.lon, b.lat, b.lon);

/** 1台ぶんの判定結果。**選ぶために距離を残す。** */
type Candidate = { warning: Warning; distanceM: number };

/**
 * 自車と相手1台を見て、警告に値するかを返す。
 *
 * **距離が縮まる速さ（closing speed）で判断する。**相手の進行方角（`crs`）を使わないのは、
 * **止まっている・低速の相手では `crs` が `null` になる**ため。向きが要る計算に頼ると、
 * 急接近が一番見たい相手——進路上に止まっている自転車——で静かに効かなくなる。
 *
 * @param selfTimeline 自車の位置。相手ごとに変わらないので呼び出し側で1度だけ作る
 */
function judgePeer(
  input: DetectorInput,
  selfTimeline: readonly LocalFix[],
  selfLast: Fix,
  peer: Track,
  config: ApproachConfig,
): Candidate | null {
  const peerLast = peer.fixes[peer.fixes.length - 1];
  const peerTimeline = toLocalTimeline(peer);

  // **両方が持っている最新の時点**を判定の「いま」にする。片方だけ新しい時点で比べると、
  // もう片方は範囲外になり、外挿するか黙るかの二択になる。
  const nowMs = Math.min(selfLast.rxAt, peerLast.rxAt);
  // 古さは `now` から測る（`rxAt` は自分の時計なので誰の `Track` でも引き算できる）。
  if (input.now - nowMs > config.maxFixAgeMs) return null;

  const prevMs = nowMs - config.sampleWindowMs;
  const nowSelf = positionAt(selfTimeline, nowMs, config.maxHaccM);
  const nowPeer = positionAt(peerTimeline, nowMs, config.maxHaccM);
  const prevSelf = positionAt(selfTimeline, prevMs, config.maxHaccM);
  const prevPeer = positionAt(peerTimeline, prevMs, config.maxHaccM);
  if (nowSelf === null || nowPeer === null || prevSelf === null || prevPeer === null) return null;

  const nowGapM = gapM(nowSelf, nowPeer);
  // **割るのは設定した窓そのもの。**両者を同じ2つの時刻に揃えてあるので、
  // 到着の遅れやばらつきが接近速度に混ざらない。
  const closingMps = (gapM(prevSelf, prevPeer) - nowGapM) / (config.sampleWindowMs / 1_000);

  if (nowGapM > config.warnDistanceM) return null;
  if (closingMps < config.closingSpeedMps) return null;

  // ここまで来た時点で `closingMps` は正なので 0 除算にならない
  // （`closingSpeedMps` を 0 以下にした場合だけ起きうるが、それは「離れていても鳴らす」
  // という設定であり、その使い方は想定していない）。
  const ttcS = nowGapM / closingMps;
  const lv = ttcS <= config.ttcLevel3S ? 3 : ttcS <= config.ttcLevel2S ? 2 : 1;

  return { warning: { kind: "approach", lv, causeId: peer.id }, distanceM: nowGapM };
}

/**
 * 急接近する自転車を1台選んで返す。無ければ `null`。
 *
 * **`null` は「周りは安全」ではない。**近傍が空（POST が失敗している）ときも、測位が
 * 粗すぎるときも `null` になる。分からないことを人に伝えるのは心拍と `link` の仕組みで
 * あって、検知ではない（`docs/interfaces/detectors.md`「「なし」は「安全」ではない」）。
 *
 * **返すのは最大1つ。**デバイスの出力は1組しかないので、同じ `kind` を2つ渡しても
 * 出せるものは増えない。**`lv` が高いもの、同じなら近いもの**を選ぶ。
 */
export const detectApproach: Detector<ApproachConfig> = (input, config) => {
  const selfLast = input.self.fixes[input.self.fixes.length - 1];
  if (input.now - selfLast.rxAt > config.maxFixAgeMs) return null;
  const selfTimeline = toLocalTimeline(input.self);

  let best: Candidate | null = null;

  for (const peer of input.peers) {
    const candidate = judgePeer(input, selfTimeline, selfLast, peer, config);
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
