/**
 * **手元の標識の範囲から出たことを、走行のあいだ記録する**（#72）。
 *
 * **走行中には出さない。**危険の警告ではないので、デバイスの出力を取り合わせない
 * （`docs/notifications.md`）。**走行後に人が見るもの**である。
 *
 * **なぜ要るか。** 岡山県ぶんしか持っていない端末が県境を越えると、
 * 一時停止の事前通知は黙る。**その黙り方は「標識が無い」と見分けがつかない**
 * ——`link` は `up`、`beat` も出ている（`docs/adr/0004-v2v-transport.md`）。
 *
 * **範囲そのものの定義は `../signs/bounds.ts`。**ここは時刻と回数を数えるだけである。
 */

import { isOutsideBounds, type SignBounds } from "../signs/bounds";

/** 走行中に手元の範囲の外に居たこと。**一度でも出たら、戻ってきても消さない。** */
export type OutsideCoverage = {
  /** 最初に外へ出た時刻（UTC ミリ秒） */
  since: number;
  /** 最後に外で測位した時刻（UTC ミリ秒） */
  until: number;
  /** 外で測位した回数。**1点だけの飛びと、走り続けたのとを見分けるため** */
  fixes: number;
};

/**
 * 測位を順に食わせて、範囲の外に出たかを覚えておくもの。
 *
 * **矩形を持っていなければ何も記録しない**（`bounds` が `null`）。
 * **「外に居ない」と「判定できない」を混ぜない**ようにするのは呼び出し側の仕事で、
 * ここは判定できないなら黙る（走行後の画面が矩形の有無を見て文言を分ける）。
 */
export class CoverageWatch {
  private outsideSince: number | null = null;
  private outsideUntil = 0;
  private outsideFixes = 0;

  constructor(private readonly bounds: SignBounds | null) {}

  /** 測位を1つ食わせる。**走行ループから毎周期呼んでよい**（矩形との比較4回だけ）。 */
  record(lat: number, lon: number, t: number): void {
    if (this.bounds === null) return;
    if (!isOutsideBounds(this.bounds, lat, lon)) return;

    // **最初に出た時刻は上書きしない。**戻って再び出たときも、
    // 走行として見たい値は「いつから手元が足りなくなったか」である。
    this.outsideSince ??= t;
    this.outsideUntil = t;
    this.outsideFixes += 1;
  }

  /** 出ていなければ `null`。**走行前後の画面が読む。** */
  outside(): OutsideCoverage | null {
    if (this.outsideSince === null) return null;
    return { since: this.outsideSince, until: this.outsideUntil, fixes: this.outsideFixes };
  }
}
