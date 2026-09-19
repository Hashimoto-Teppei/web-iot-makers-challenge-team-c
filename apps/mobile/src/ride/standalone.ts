/**
 * **デバイスを使わずに走るかどうか**を、アプリの中で1つ持つ（#185）。
 *
 * **デモはラズパイ1台・スマホ2台**で、2台目は**相手役の自転車**として走る。
 * 位置の中継だけを担い、BLE には一切触らない（`docs/interfaces/mobile-api.md`
 * 「`id`」の例外）。**オンにした端末には警告が出ない**——出す先が無いので、
 * **そのことを設定画面と走行前の点検に必ず出す**（隠すと「動いているつもり」を作る）。
 *
 * **端末に保存する。**デモの途中でアプリが落ちるたびに入れ直すのは現実的でない
 * （`../ble/device-config-store.ts` が保存しないのとは逆の判断で、**あちらは接続の間だけ
 * 効く値**、こちらは**その端末の役回り**である）。
 * 置き場所は `expo-sqlite/kv-store`（`docs/adr/0009-on-device-storage.md`「小さな設定値」。
 * **`expo-sqlite` は既に入っている**ので依存を足さない）。
 *
 * **既定はオフ。**オンで走る端末は**同時に1台まで**——同じ `id` を2台が名乗ると、
 * Durable Object の中で互いを上書きし合う。
 */

import Storage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { createStore } from "../lib/store";

const KEY = "ride.standalone";

function readStored(): boolean {
  try {
    return Storage.getItemSync(KEY) === "1";
  } catch (error: unknown) {
    // **読めなくても画面を落とさない。**オフとして扱えば、いつもどおり BLE を探しに行く。
    console.warn("[standalone] 保存した設定を読めません（オフとして扱います）", error);
    return false;
  }
}

const store = createStore<boolean>(readStored());

/** いまの設定。**React の外から見る用。** */
export function getStandalone(): boolean {
  return store.get();
}

/** 画面から見る。 */
export function useStandalone(): boolean {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * 切り替える。**書けなくても画面の値は変える**——この走行の間は効いてほしい。
 *
 * **走行中に呼ばせないこと**は画面の側で守る（`../app/settings.tsx`）。
 * 走行中に切り替えると、**名乗る `id` が走行の途中で変わる。**
 */
export function setStandalone(on: boolean): void {
  store.set(on);
  try {
    Storage.setItemSync(KEY, on ? "1" : "0");
  } catch (error: unknown) {
    console.warn("[standalone] 設定を保存できません（次の起動では戻ります）", error);
  }
}
