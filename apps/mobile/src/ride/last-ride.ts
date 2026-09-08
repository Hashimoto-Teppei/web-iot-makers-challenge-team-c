/**
 * **直前の走行が残したもの。走行を終えたあとに画面が読む**（#72 / #143）。
 *
 * **React の state に持たない。寿命を `./riding.ts` の「走行中か」と揃える。**
 * 走行の停止は**画面のアンマウントの後片付けからも走る**
 * （`./use-ride-loop.ts` の `useEffect(() => stop, [stop])`）。画面の state に置くと、
 * **その経路で走行を終えたときだけ、結果が書かれた瞬間に一緒に捨てられる。**
 * これは**静かに黙る故障を人に見せるためのもの**なので、
 * **見せる経路が終わり方次第で消えるなら、出していないのとあまり変わらない**
 * （`docs/interfaces/stop-signs-delivery.md`）。
 *
 * **#143 が書いていた「ホーム→設定で消える」は起きない。**`Stack` は下の画面を
 * マウントしたままにし、遷移は push だけなので、後片付けはそこでは走らない
 * （`../app/index.tsx`「この画面は再マウントされない」と同じ理由）。
 * **残る経路は開発中の Fast Refresh と、将来ホームを差し替える形にしたとき**である。
 *
 * **永続化しない。**見せたいのは直前の走行1回ぶんで、**アプリを起動し直したら消えてよい**
 * （位置に由来する情報を端末に溜めない。`CLAUDE.md`）。
 */

import { useSyncExternalStore } from "react";
import { createStore } from "../lib/store";
import type { OutsideCoverage } from "./coverage";

export type LastRide = {
  /** 手元の標識の範囲の外に居たか。**出ていなければ `null`**（`./coverage.ts`） */
  outsideCoverage: OutsideCoverage | null;
};

const store = createStore<LastRide | null>(null);

/**
 * **呼ぶのは `./use-ride-loop.ts` だけ。** 画面から直に触らない。
 *
 * 走り出すときに `null` を渡して消す——残すと、**今回の走行で出たことと
 * 前回出たことが見分けられない。**
 */
export function setLastRide(next: LastRide | null): void {
  store.set(next);
}

/** 画面から見る用。**まだ1回も走っていなければ `null`。** */
export function useLastRide(): LastRide | null {
  // 第3引数（サーバー側の値）は web ビルドの初期描画で要る。同じものでよい。
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
