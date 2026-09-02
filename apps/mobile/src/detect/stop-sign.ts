/**
 * 一時停止の標識が近いことの事前通知（#27 `stop`）。
 *
 * **カメラで標識を読むのではない。**手元に持っている標識の位置（`DetectorInput.signs`）と
 * 現在位置を突き合わせる。おかげで**標識が見える前に**知らせられるし、夜間や逆光でも成立する。
 *
 * **通信が死んでいても動く唯一の検知**である。車車間の3つは `peers` が空になると
 * 何も言えなくなるが、これは標識さえ手元にあれば出続ける
 * （`docs/interfaces/mobile-api.md`「失敗したときの約束」）。**だから `peers` を見ない。**
 *
 * 共通の約束は `docs/interfaces/detectors.md`。この検知も**入力を受けて結果を返す純粋な
 * 関数**であり、ハードウェアにも通信にも触れず、`Date.now()` も乱数も使わず、前回の
 * 呼び出しを覚えない。おかげで実機なしで Vitest から確かめられる。
 *
 * **近傍に絞るのは呼び出し側の責務。**渡ってくるのは自セル + 周囲8セル（岡山でおよそ
 * 300m 四方）ぶんだけなので、**それより先を見に行く判定をここに書かない**
 * （`docs/adr/0009-on-device-storage.md`）。
 */

import { bearingDeg, distanceM, normalizeAngleDeg } from "./geo";
import type { Detector, Fix, StopSign, Warning } from "./types";

/**
 * 一時停止の事前通知のしきい値。
 *
 * **既定値はすべて仮の値**で、実走行で調整する（`docs/unverified.md` 5 / 9 / 21）。
 * だからこそコードに直書きせず、第2引数で受け取る（`CLAUDE.md`）。
 *
 * **他の検知と共有しない。**同じ名前の値を共有すると、片方の調整がもう片方を壊す
 * （`docs/interfaces/detectors.md`）。
 */
export type StopSignConfig = {
  /**
   * 何秒手前で知らせるか（秒）。**警告する距離は速度から作る**——
   * 距離を固定にすると、速い人には手遅れで、遅い人には早すぎる。
   */
  leadTimeS: number;
  /** 上で作った距離の下限（メートル）。止まりかけの低速でも、この距離では知らせる */
  minWarnDistanceM: number;
  /**
   * 上で作った距離の上限（メートル）。
   *
   * **入ってくる標識の側に天井がある。**近傍として渡ってくるのは自セル + 周囲8セルで、
   * セルは岡山で**南北およそ 111m × 東西およそ 92m**（`../signs/cell.ts`）。
   * 3×3 の窓は自セルの外側に**1セルぶん**しか伸びないので、**自車がセルの端に立っている
   * 最悪の場合に保証される半径は東西でおよそ 92m** である。
   * **これを超える値を入れると、超えたぶんは黙って切り詰められる**
   * （`docs/adr/0009-on-device-storage.md`）。
   */
  maxWarnDistanceM: number;
  /**
   * 警告する距離のうち、**手前どこからを `lv: 2` にするか**（0〜1 の割合）。
   *
   * **メートルで置かない。**警告する距離は速度から作るので、絶対値で置くと
   * **遅いときに段階が1つ消える**——たとえば 20m と置くと、下限（15m）が丸ごと
   * その内側に入り、**4 m/s 以下では最初の警告がいきなり `lv: 2` になる。**
   * 割合にしておけば、**どの速度でも「気づく段階」と「対処する段階」が両方通る。**
   */
  level2Ratio: number;
  /**
   * 標識が対象とする進入方向と、自分の進行方角の差の許容（度）。
   *
   * **狭めるほど対向車線や交差道路を拾わなくなるが、道なりのカーブで見逃す。**
   * 標識の直前で道が曲がっていると、進入方向の直線と実際の進行方角はずれる。
   */
  approachToleranceDeg: number;
  /**
   * 標識が「まだ前方にある」と見なす角度の許容（度）。**通り過ぎた標識で鳴らさないため。**
   *
   * {@link StopSignConfig.approachToleranceDeg} より緩くてよい——標識は道路の脇に
   * 立っているので、**近づくほど自分から見た方角は横へ開く。**
   */
  aheadToleranceDeg: number;
  /**
   * 進入方向が分からない標識を拾うか。
   *
   * **`StopSign.approach` が `null` は「全方向が対象」ではなく「元データに登録が無い」**
   * （`docs/interfaces/stop-signs-delivery.md`）。方向で絞れないので、**扱いをここで決める。**
   *
   * **既定は拾う（`true`）。**落とすと、**その標識だけが黙る**——`link` は `up` で、
   * 標識の件数も足りているように見え、**「標識が無い」と見分けがつかない。**
   * `docs/adr/0004-v2v-transport.md` が一番恐れた静かな部分故障そのものである。
   * 対向車線の標識で余計に鳴るのは「余分に止まれと言われる」だけで、見逃しより軽い。
   *
   * **岡山県 202607 の原本では、28,651 件のうち `null` は 2 件だけ**（生成済みの
   * `apps/web/scripts/stop-signs/out/stop-signs-33.sql` を数えた）。**どちらに倒しても
   * 実害はほぼ無い**ので、危ない方の壊れ方（黙る）を避ける側に倒してある。
   */
  warnOnUnknownApproach: boolean;
  /**
   * この速度以下なら何も言わない（m/s）。
   *
   * **もう止まりかけている人に「止まれ」と言わない。**加えて、**低速では `crs` が
   * `null` になる**ので（`docs/interfaces/detectors.md`）、どのみち方向で絞れない。
   */
  alreadySlowMps: number;
  /**
   * 標識までがこの距離以下になったら何も言わない（メートル）。
   *
   * **2つの意味を1つの値で兼ねている。**
   * 1つは**方角を信じられない**こと——標識が近いほど、自分から見た方角は測位の
   * ゆらぎで大きく振れる（`geo.ts` の `bearingDeg`）ので、前方かどうかを判定できない。
   * もう1つは**もう手遅れ**であること——ここまで来て初めて知らせても止まれないし、
   * 有用な警告は 15〜25m 手前で既に出ている。
   *
   * **黙る側に倒すのが肝心。**「近いから前方とみなす」にすると、
   * **停止線で止まって、また漕ぎ出した瞬間に鳴る**——
   * **正しく止まった人を、正しく止まった直後に叱る**ことになる。
   */
  nearZoneM: number;
  /** 最新の測位がこれ以上古かったら何も言わない（ミリ秒） */
  maxFixAgeMs: number;
  /**
   * 水平位置精度がこれより粗い測位は使わない（メートル）。
   *
   * **数 m ずれると隣の道路の標識と区別できない**（`docs/unverified.md` 9 / 21）。
   * **`approach.ts` と既定値が同じでも、共有しない**——あちらは距離の変化を測るための
   * 足切りで、こちらは「狙った標識かどうか」の足切りであり、調整する理由が違う。
   */
  maxHaccM: number;
};

export const stopSignDefaults: StopSignConfig = {
  // 自転車の 5 m/s なら 25m 手前。**止まるための距離ではなく、気づいて減速を始める距離**
  // として置いている（自転車の制動距離は数 m）。
  leadTimeS: 5,
  minWarnDistanceM: 15,
  // 近傍として保証される半径（およそ 92m）の内側に置く。**広げるなら、そこが天井。**
  maxWarnDistanceM: 60,
  // 警告する距離の手前半分。5 m/s なら 25m で `lv: 1`、12.5m から `lv: 2`。
  level2Ratio: 0.5,
  // 直交する道（90 度）と対向車線（180 度）を確実に落とし、道なりのカーブは残る幅。
  approachToleranceDeg: 45,
  aheadToleranceDeg: 60,
  warnOnUnknownApproach: true,
  // 徒歩よりやや遅い程度。ここを超えていれば「走っている」と見てよい。
  alreadySlowMps: 1.5,
  // 自転車なら1〜2秒で通り過ぎる距離。**測位精度（下）と同じ大きさだが、意味が違う。**
  nearZoneM: 8,
  maxFixAgeMs: 3_000,
  maxHaccM: 8,
};

/** 標識1つぶんの判定結果。**選ぶために距離を残す。** */
type Candidate = { warning: Warning; distanceM: number };

/**
 * その標識が**自分の進入方向を対象にしているか。**
 *
 * **`approach` から `(lat, lon)` へ向かうベクトルが、規制の対象になる進行方向**である
 * （`docs/interfaces/stop-signs-delivery.md`）。自分の `crs` がそれとおおむね揃っていれば、
 * 自分はその標識の対象である。
 *
 * **単に近いだけで拾わない理由がここ。**1つの交差点には方向のぶんだけ標識の行があり、
 * 距離だけで選ぶと**対向車線と交差道路のぶんまで鳴る。**
 *
 * @param crs 自分の進行方角（度）。呼び出し側で `null` を除いてある
 */
function isTargetedApproach(sign: StopSign, crs: number, config: StopSignConfig): boolean {
  const approach = sign.approach;
  if (approach === null) return config.warnOnUnknownApproach;

  // 2点が重なっていると方位に意味が無い（`geo.ts` の `bearingDeg` が 0 を返す）。
  // **元データの登録が同じ点になっている場合**がこれで、「向きが無い」のと変わらない。
  // 岡山県 202607 では**2点の距離の中央値が 20.9m、1m 未満は 1 件**なので、
  // **ここで落ちるのは実質その1件だけ**である（正常な標識を巻き添えにしない）。
  if (distanceM(approach.lat, approach.lon, sign.lat, sign.lon) < 1) {
    return config.warnOnUnknownApproach;
  }

  const targetDeg = bearingDeg(approach.lat, approach.lon, sign.lat, sign.lon);
  return Math.abs(normalizeAngleDeg(targetDeg - crs)) <= config.approachToleranceDeg;
}

/**
 * その標識が**まだ前方にあり、かつ言うだけの猶予が残っているか。**
 *
 * **{@link isTargetedApproach} とは別の話である。**あちらは「この標識は自分向きか」、
 * こちらは「もう過ぎたか」で、**通り過ぎたあとも進行方角は変わらない**ので
 * あちらだけでは止まらない。
 *
 * @param gapM 標識までの距離（メートル）。呼び出し側で計算済みのものを渡す
 */
function isAhead(fix: Fix, crs: number, sign: StopSign, gapM: number, config: StopSignConfig) {
  // **すぐそばの標識では黙る**（{@link StopSignConfig.nearZoneM}）。方角が信じられず、
  // 前方か後方かを決められないうえ、**ここで「前方」に倒すと停止線で止まった人が
  // 漕ぎ出した瞬間に鳴る**（検知は前回を覚えないので、止まったことを知らない）。
  if (gapM <= config.nearZoneM) return false;

  const toSignDeg = bearingDeg(fix.lat, fix.lon, sign.lat, sign.lon);
  return Math.abs(normalizeAngleDeg(toSignDeg - crs)) <= config.aheadToleranceDeg;
}

/**
 * 近づいている一時停止の標識を1つ選んで返す。無ければ `null`。
 *
 * **`null` は「一時停止が無い」ではない。**標識を持っていない・測位が粗い・止まりかけて
 * いる、のどれでも `null` になる（`docs/interfaces/detectors.md`「「なし」は「安全」ではない」）。
 *
 * **返すのは最大1つ。**デバイスの出力は1組しかないので、同じ `kind` を2つ渡しても
 * 出せるものは増えない。**`lv` が高いもの、同じなら近いもの**を選ぶ。
 *
 * **`causeId` には `StopSign.id` を入れる。**入れないと、呼び出し側の抑制
 * （`../ride/warn-gate.ts`）が**別の標識を同じ警告として畳んでしまい**、
 * 続けて現れる2つ目の交差点で黙る。
 */
export const detectStopSign: Detector<StopSignConfig> = (input, config) => {
  const last = input.self.fixes[input.self.fixes.length - 1];
  // 古さは `rxAt`（自分の時計）から測る。`t` は測位した端末の時計なので混ぜない
  // （`docs/interfaces/detectors.md`「時刻が2つある理由」）。
  if (input.now - last.rxAt > config.maxFixAgeMs) return null;
  if (last.hacc > config.maxHaccM) return null;
  if (last.spd <= config.alreadySlowMps) return null;

  // 低速では方角が出ない。方角が無ければ、狙った標識かどうかを決められない。
  const crs = last.crs;
  if (crs === null) return null;

  // **速度から作る。**上限と下限で挟むのは、止まる寸前と全力の下りで極端にならないため。
  const warnDistanceM = Math.min(
    Math.max(last.spd * config.leadTimeS, config.minWarnDistanceM),
    config.maxWarnDistanceM,
  );

  let best: Candidate | null = null;

  for (const sign of input.signs) {
    const gapM = distanceM(last.lat, last.lon, sign.lat, sign.lon);
    if (gapM > warnDistanceM) continue;
    if (!isTargetedApproach(sign, crs, config)) continue;
    if (!isAhead(last, crs, sign, gapM, config)) continue;

    // **`lv: 3` は使わない。**標識は動かず猶予も長いので、「間に合わないかもしれない」
    // にあたる状況がここには無い（`docs/notifications/arbitration.md`）。
    // **段階の境目は警告する距離に比例させる**——絶対値で置くと、遅いときに
    // 境目が下限の内側へ入り込み、**`lv: 1` が一度も出ないまま `lv: 2` から始まる。**
    const lv = gapM <= warnDistanceM * config.level2Ratio ? 2 : 1;
    const candidate: Candidate = {
      warning: { kind: "stop", lv, causeId: sign.id },
      distanceM: gapM,
    };

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
