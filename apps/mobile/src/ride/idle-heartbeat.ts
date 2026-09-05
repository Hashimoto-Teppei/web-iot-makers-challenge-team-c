/**
 * 走行を始める前の心拍。**つながっている間ずっと書く。**
 *
 * **仕様どおりに戻すもの。** `docs/interfaces/ble-gatt.md`「接続してから転送するまで」の 4 は
 * 「**接続できた時点から**、走行中はずっと心拍を毎秒書き続ける」「**ログを回収しないときも、
 * ここまでは必ず行う**」と決めている。ところが心拍を出しているのは走行ループ
 * （`./loop.ts` の `startHeartbeat()`）だけで、**走り出すまで1通も飛んでいなかった**（#128）。
 *
 * **黙っていると、デバイスが持ち主を切る。** デバイスは「心拍の来ない接続は、定義上、
 * 持ち主のアプリではない」を根拠に 30 秒で接続を手放す（同「前提」）。
 * 走行前の点検の画面で**繋がっては切られるを、走り出すまで繰り返していた**
 * ——模擬ペリフェラルと実機で再現した。
 *
 * **走行中は書かない。** 走行ループが自分の心拍を持っており、**2つ動かすと
 * `st` と `mv` が交互に入れ替わって、デバイスの `link` が毎秒ちらつく**
 * （デバイスは直近の1通から引き直すため。`docs/interfaces/v2v.md`「心拍を必ず見せる」）。
 * 走行中かは `./riding.ts` が1つだけ持っているので、**2つ目の「走行中」を作らない。**
 */

import { useEffect } from "react";
import type { BeatMessage } from "../v2v/alert";
import type { DeviceLink } from "./device";
import { useRiding } from "./riding";

/** 心拍の間隔（ミリ秒）。**走行ループと同じ**（`./loop.ts` の `startHeartbeat`） */
const INTERVAL_MS = 1_000;

/**
 * 走り出す前の心拍を1通作る。
 *
 * **`st` は `nofix`。**走り出す前は測位を始めていないので、これが正しい。黙ると
 * `down`（＝アプリが落ちた）になり、**待てば直るものと直らないものが区別できなくなる**
 * （`docs/interfaces/v2v.md`）。
 *
 * **`mv` は「走行中」に倒す。**速度を測っていないので、止まっているかを本当は知らない。
 * `docs/notifications.md`「迷ったら走行中に倒す」に従う——**止まっていることにしたうえで
 * 実は走っていた場合、デバイスが走行中に文章を出す。**仕様側も、`mv` の無い `beat` を
 * 「走行中」として扱うと決めてある（`v2v.md`）。
 */
export function idleBeat(now: number): BeatMessage {
  return { k: "beat", t: now, st: "nofix", mv: true };
}

/**
 * 心拍を書き始める。**止めるための関数を返す。**
 *
 * **React を知らない。**`setInterval` を直に使うので、Vitest の擬似タイマーで回せる
 * （`./loop.ts` の `startHeartbeat()` と同じ形）。
 */
export function startIdleHeartbeat(device: DeviceLink, intervalMs = INTERVAL_MS): () => void {
  const beat = (): void => device.writeAlert(idleBeat(Date.now()));
  // **1通目を待たない。**待つと、つないだ直後の1秒がいつも `down` から始まる。
  beat();
  const timer = setInterval(beat, intervalMs);
  return () => clearInterval(timer);
}

/** 画面から使う形。**つながっていて、走行中でない間だけ書く。** */
export function useIdleHeartbeat(device: DeviceLink | null): void {
  const riding = useRiding();

  useEffect(() => {
    // **走行中は走行ループに任せる**（上の注記。2つ動かすと `link` がちらつく）。
    if (device === null || riding) return;
    return startIdleHeartbeat(device);
  }, [device, riding]);
}
