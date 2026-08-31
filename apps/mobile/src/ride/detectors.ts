/**
 * 検知の登録口。**検知を足す人がここに1行足すと、走行ループが回してくれる。**
 *
 * ```ts
 * // 1. 自分のファイルを1つ足す（`../detect/hard-brake.ts`）
 * // 2. 下の配列に1行足す
 * register("brake", detectHardBrake, hardBrakeDefaults),
 * ```
 *
 * **呼び出し側（`./loop.ts`）を書き換えずに検知が増える**ことがこの口の目的である。
 * 3つの検知を別々の担当が並行実装するので（`CLAUDE.md`）、**呼び出し側を直す形にすると
 * 全員が同じファイルの同じ場所を編集して必ずコンフリクトする。**
 * ここなら足すのは1行で、コンフリクトしても解決は「両方残す」で済む。
 *
 * **`docs/interfaces/detectors.md` はもともと「レジストリを作らない」と決めていた。**
 * 検知ごとにしきい値の型が違うので配列にすると型が合わず `any` を挟むことになる、
 * という理由である。**{@link register} が設定を関数の中に閉じ込めるので `any` は要らなくなり、
 * 理由の方が消えた**（あちらの記述もこの PR で直した）。
 */

import { approachDefaults, detectApproach } from "../detect/approach";
import type { Detector, DetectorInput, Warning } from "../detect/types";

/**
 * 登録された検知1つ。**しきい値は中に閉じ込めてある。**
 *
 * 呼び出し側から見ると `DetectorInput` を渡すと結果が返るだけなので、**検知ごとに違う
 * 設定の型が呼び出し側に漏れない。**これが `any` を挟まずに1つの配列へ並べられる理由である。
 */
export type RegisteredDetector = {
  /**
   * 何の検知か。**ログと走行前後の画面のためだけに持つ。**
   *
   * `WarnKind` と同じ値にしておくと読みやすいが、**型としては結び付けていない**——
   * 結び付けると、1つの検知が状況によって別の `kind` を返す形が書けなくなる。
   * デバイスへ渡るのは検知が返した `Warning.kind` であって、この名前ではない。
   */
  name: string;
  /** 1回ぶん動かす。警告が無ければ `null` */
  run: (input: DetectorInput) => Warning | null;
};

/**
 * 検知としきい値を1組にして登録する。
 *
 * @param name ログと画面に出す名前
 * @param detector 検知そのもの（純粋な関数）
 * @param config その検知のしきい値。**既定値はその検知のファイルにある**
 *   （`docs/interfaces/detectors.md`「しきい値は設定として注入する」）
 *
 * @typeParam C - しきい値の型。**呼び出し側に漏れない**（返る型に含まれない）
 */
export function register<C>(name: string, detector: Detector<C>, config: C): RegisteredDetector {
  return { name, run: (input) => detector(input, config) };
}

/**
 * 走行ループが回す検知の一覧。
 *
 * **ここに並んでいないものは動かない。**実装があっても、登録しなければアプリの中では
 * 1行も実行されない。
 *
 * **しきい値を差し替えたいときは、この配列を作り直す**（`register` を別の設定で呼ぶ）。
 * 走行ループは配列を受け取るだけなので、テストでは1つだけ登録した配列を渡せる。
 */
export const registeredDetectors: readonly RegisteredDetector[] = [
  register("approach", detectApproach, approachDefaults),
  // 検知が入ったら、ここに1行ずつ足す。**この上の行を編集しないこと**（担当が違う）。
  // register("brake", detectHardBrake, hardBrakeDefaults),      // #10
  // register("corner", detectBlindCorner, blindCornerDefaults), // #11
  // register("stop", detectStopSign, stopSignDefaults),         // #27
];
