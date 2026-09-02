/**
 * いま走行中かどうか。**アプリの中で1つだけ持つ。**
 *
 * **React の state に持たない。**走行は**画面より寿命が長い**——走り出したあと
 * 設定画面へ移っても走行は続いており、**そこから標識を入れ替えられては困る**
 * （数万行の入れ替えが 1Hz の中継と同じ接続を握る。
 * `docs/interfaces/stop-signs-delivery.md`「取るのはアプリの起動時。走行中は取りに行かない」）。
 *
 * **保持しているのはここだけ。**`useRideLoop()` の `running` もこの値を読んでおり、
 * **2つ目の「走行中」をどこにも作らない**（`CLAUDE.md`「同じことを2箇所に書かない」）
 * ——食い違うと、**片方の画面から走行中に取りに行ける穴**になる。
 */

import { useSyncExternalStore } from "react";

let riding = false;
const listeners = new Set<() => void>();

/** **呼ぶのは `./use-ride-loop.ts` だけ。** 画面から直に触らない。 */
export function setRiding(next: boolean): void {
  riding = next;
  for (const listen of listeners) listen();
}

/**
 * いま走行中か。**React の外から見る用**（`updateStopSigns` の `canReplace` に渡す）。
 *
 * **取得の最中に走り出したかを見るのはこちら**——フックの値は再描画まで古いままである。
 */
export function isRiding(): boolean {
  return riding;
}

function subscribe(listen: () => void): () => void {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}

/** 画面から見る用。**走行中に押させないボタンはこれで塞ぐ。** */
export function useRiding(): boolean {
  // 第3引数（サーバー側の値）は web ビルドの初期描画で要る。同じものでよい。
  return useSyncExternalStore(
    subscribe,
    () => riding,
    () => riding,
  );
}
