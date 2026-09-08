/**
 * **画面より寿命が長い値を1つ持つための、最小のストア。**
 *
 * `useSyncExternalStore` の呼び出しをここに1つだけ置く。**同じ 15 行が
 * `../ride/riding.ts` / `../ride/last-ride.ts` / `../ble/device-config-store.ts` /
 * `../signs/expo.ts` に写経されていた**ため、4つ目が出た時点でまとめた
 * （`CLAUDE.md`「2〜3個目が出てきた時点で共通化する」）。
 *
 * **汎用のストア機構にしない。**セレクタも比較関数も持たない——
 * いま要るのは「1つの値を差し替えて、購読している全員に知らせる」だけである。
 *
 * **「なぜ画面の state に持たないか」は、値ごとに違う。**その理由は各ファイルに残すこと。
 * ここが持っているのは仕組みだけである。
 */

export type Store<T> = {
  /** いまの値。**React の外から見る用。** */
  get: () => T;
  /** 差し替えて、購読者に知らせる。 */
  set: (next: T) => void;
  /**
   * 購読する。返るのは解除する関数。
   *
   * **画面から見るときは、各ファイルで
   * `useSyncExternalStore(store.subscribe, store.get, store.get)` と書く**
   * （第3引数は web ビルドの初期描画で要る。同じものでよい）。
   * **`use()` のようなメソッドでくるまない**——`useSyncExternalStore` の呼び出しが
   * メソッドの奥に隠れると、**Biome の Rules of Hooks が呼び出し側を見なくなる。**
   * 条件分岐の中に置いても誰も止めず、**分岐が切り替わった瞬間に
   * 「Rendered fewer hooks than expected」で落ちる。**
   */
  subscribe: (listen: () => void) => () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();

  const get = (): T => value;
  const subscribe = (listen: () => void): (() => void) => {
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
    };
  };

  return {
    get,
    subscribe,
    set(next: T): void {
      value = next;
      for (const listen of listeners) listen();
    },
  };
}
