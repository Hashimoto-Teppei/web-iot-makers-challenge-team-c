/**
 * BLE の `alert`（スマホ → デバイス）に書く2種類のメッセージ。
 *
 * **形の正本は `docs/interfaces/v2v.md`「デバイスへ渡すもの」。**ここはその実装であって、
 * 決め直す場所ではない。受け取る側（デバイス）の実装は `apps/device/src/device/alert.py` で、
 * **Python は TypeScript のスキーマを参照できない**ので、変えるときは両方とドキュメントを
 * 揃えること（`CLAUDE.md`）。
 *
 * **位置・周辺車両・標識をここに載せない。**載せた瞬間に
 * `docs/adr/0006-decision-layer-on-mobile.md` が消した帯域問題が戻る。
 */

import type { WarnKind, WarnLevel } from "../detect/types";

/**
 * 表示指示。**検知が発火したときだけ**書く。
 *
 * `causeId` を載せない（`docs/interfaces/detectors.md`「出力」）。あれは同じ相手の警告を
 * 抑制するためにスマホの中だけで持つもので、BLE も D1 も通らない。
 */
export type WarnMessage = {
  k: "warn";
  kind: WarnKind;
  lv: WarnLevel;
};

/**
 * 心拍。**毎秒1回、必ず**書く。
 *
 * **検知や通信の成否と無関係に出す。**POST の往復や検知の処理にぶら下げると、通信が
 * 詰まるたびに心拍が遅れ、**健全なのにデバイスが「アプリが落ちた」と表示する**
 * （`docs/interfaces/mobile-api.md`「スマホの約束」）。
 */
export type BeatMessage = {
  k: "beat";
  /** UTC ミリ秒。デバイスがログに時刻を打つ唯一の供給源なので、必ず載せる */
  t: number;
  /**
   * 測位が取れているか。
   *
   * **`nofix` を載せて書き続けること。**測位が無いからと黙ると、デバイスは `down`
   * （＝アプリが落ちた）と表示し、**「待てば直る」と「直らない」が区別できなくなる**
   * （`docs/interfaces/v2v.md`「心拍を必ず見せる」）。
   */
  st: "ok" | "nofix";
  /**
   * 走行中か。速度を持っているのはスマホだけなので、**判定もスマホが行う。**
   *
   * デバイス側では**任意項目**である（無ければ「走行中」として扱われる）。
   * こちらは常に載せるが、**受け取る側の必須項目を増やさせないこと**——必須にすると
   * 載せ忘れた `beat` が1通残らず捨てられ、`link` が `down` に落ちる。
   */
  mv: boolean;
};

/** `alert` に書けるもの。これ以外を書かない。 */
export type AlertMessage = WarnMessage | BeatMessage;
