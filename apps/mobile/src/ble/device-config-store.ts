/**
 * いま使うしきい値の上書きを、アプリの中で1つだけ持つ（#124）。
 *
 * **React の state に持たない。**接続は画面より寿命が長く、**設定画面を開いている間も
 * 走行と接続は続いている**（`../ride/riding.ts` と同じ理由）。
 *
 * **端末に保存しない。**上書きは**この接続の間だけ効くもの**で、切断でデバイスが既定へ戻す
 * （`docs/interfaces/ble-gatt.md`「`config`」）。**アプリ側だけが値を覚えていると、
 * 起動のたびに「前回いじった値で走っているつもり」が生まれる**——デバイスに書けたときだけ
 * 効く、というこの機能の形と食い違う。実地調整は走る前にその場で入れる
 * （Issue #124「走行ごとに上書きする」）。
 *
 * **BLE を知らない。**書きに行くのは `./link.ts`、人が触るのは `../app/settings.tsx`。
 */

import { useSyncExternalStore } from "react";
import {
  clampDeviceConfig,
  DEVICE_CONFIG_DEFAULTS,
  type DeviceConfig,
  type DeviceConfigKey,
} from "./device-config";

/**
 * 書いた結果。**「まだ書いていない」と「書けなかった」を混ぜない。**
 *
 * - `default` … 既定のままなので書いていない（正常）
 * - `writing` … 書いて、`cfg` を確かめている最中
 * - `applied` … `cfg` に自分が書いた値が入っていた
 * - `failed` … 書けなかった、または `cfg` に入っていなかった。**既定のまま走っている**
 */
export type DeviceConfigOutcome = {
  state: "default" | "writing" | "applied" | "failed";
  /** `failed` のときの理由。**何をすればよいかまで書く**（`CLAUDE.md`） */
  reason: string | null;
};

let config: DeviceConfig = { ...DEVICE_CONFIG_DEFAULTS };
let outcome: DeviceConfigOutcome = { state: "default", reason: null };

/**
 * **値と結果で購読を分ける。**まとめると、`./link.ts` が結果を書き込むたびに
 * 「値が変わった」として自分自身を呼び戻し、**接続のたびに無限再帰で落ちる**
 * （`setDeviceConfigOutcome` → 購読 → `applyConfig` → `setDeviceConfigOutcome` → …）。
 * **書く側が聞きたいのは値の変更だけ**である。
 */
const configListeners = new Set<() => void>();
const outcomeListeners = new Set<() => void>();

function notify(listeners: ReadonlySet<() => void>): void {
  for (const listen of listeners) listen();
}

function subscribeTo(listeners: Set<() => void>, listen: () => void): () => void {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}

/** いまの値。**React の外から見る用**（接続したときに `./link.ts` が読む）。 */
export function getDeviceConfig(): DeviceConfig {
  return config;
}

/**
 * 1つ変える。**範囲に収めてから入れる**（`clampDeviceConfig`）。
 *
 * **変えたら書き直しが要る。**購読している `./link.ts` が、つながっていれば書き直す
 * ——**つながっている間に変えた値が次の接続まで効かない**のは、画面に出ている値と
 * デバイスの中身が食い違う「動いているつもり」そのものである。
 */
export function setDeviceConfig(key: DeviceConfigKey, value: number): void {
  config = { ...config, [key]: clampDeviceConfig(key, value) };
  notify(configListeners);
}

/**
 * 全部を既定へ戻す。**デバイス側も既定へ戻す。**
 *
 * **「送るものが無くなる」ではない。**`config` は部分更新なので、**すでに書いたキーは
 * 既定の値を明示して書き直す**（`./device-config.ts` の `deviceConfigWrite`）。
 */
export function resetDeviceConfig(): void {
  config = { ...DEVICE_CONFIG_DEFAULTS };
  notify(configListeners);
}

/** 書いた結果を記録する。**呼ぶのは `./link.ts` だけ。** */
export function setDeviceConfigOutcome(next: DeviceConfigOutcome): void {
  outcome = next;
  notify(outcomeListeners);
}

/** 書いた結果。**切断したら `default` に戻す**（デバイス側の上書きも消えるため）。 */
export function getDeviceConfigOutcome(): DeviceConfigOutcome {
  return outcome;
}

/**
 * **値の変更**を購読する。**React の外**（`./link.ts`）から使う。
 *
 * **結果（`DeviceConfigOutcome`）では呼ばれない。**上を見ること。
 */
export function subscribeDeviceConfig(listen: () => void): () => void {
  return subscribeTo(configListeners, listen);
}

/** 画面から見る用。 */
export function useDeviceConfig(): DeviceConfig {
  return useSyncExternalStore(
    (listen) => subscribeTo(configListeners, listen),
    () => config,
    () => config,
  );
}

/** 画面から見る用（書いた結果）。 */
export function useDeviceConfigOutcome(): DeviceConfigOutcome {
  return useSyncExternalStore(
    (listen) => subscribeTo(outcomeListeners, listen),
    () => outcome,
    () => outcome,
  );
}
