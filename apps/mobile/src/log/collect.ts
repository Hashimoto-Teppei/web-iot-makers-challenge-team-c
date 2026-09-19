/**
 * デバイスから検知ログを回収して、端末に取り込む（#40）。
 *
 * **BLE も SQL も知らない。**渡された {@link DeviceLink} に頼み、渡された
 * {@link RideLogStore} に入れるだけなので、**開発機の Vitest で回せる**
 * （`docs/adr/0002-development-lifecycle.md`）。
 * 転送そのものは `../ble/link.ts`、切り出しは `../ble/log-transfer.ts`。
 *
 * **走行を終えたあとに1回だけ呼ぶ**（`../app/index.tsx`）。走行中に呼ぶと、
 * `alert` と同じ接続の上で警告の書き込みと競る（`docs/interfaces/ble-gatt.md`）。
 */

import type { DeviceLink } from "../ride/device";
import type { RideLogStore } from "./store";

/**
 * 回収して取り込む。**うまくいかなかった理由を返す**（成功なら `null`）。
 *
 * **例外を投げない。**呼ぶのは走行後の同期の入口なので、**投げると送信ごと止まる**
 * ——回収できなくても、**スマホ発の走行ログは送れる**（別々のことである）。
 *
 * **つながっていなければ、何もしないで `null` を返す。**デバイスは検知ログを消さないので
 * （`docs/interfaces/ble-log-transfer.md`「転送済みログの扱い」）、
 * **次につないだときに取りに行けばよい。**赤い理由を出すことではない。
 */
export async function collectDeviceLogs(
  device: DeviceLink | null,
  store: RideLogStore,
): Promise<string | null> {
  if (device === null) return null;
  const { deviceId, logId } = device;

  try {
    // **既読位置は保存してあるものを使う。**`log_id` が前回と違えば 0 が返り、
    // **全件を取り直す**（世代が変われば `seq` は 1 に戻るため）。
    const since = store.deviceLogSince(deviceId, logId);
    const outcome = await device.collectLogs(since, (records) => {
      // **届いた端から取り込む。**途中で切れても、そこまでは残る
      // （進めてよいのは取り込みを終えたところまで）。
      store.addDeviceDetections(deviceId, logId, records);
    });
    return outcome.reason;
  } catch (reason: unknown) {
    // **黙って0件にしない。**取り込めていないことは件数にも出ないので、
    // ここで返さないと**誰も気づけない**（`./use-ride-log-sync.ts` が画面に出す）。
    return `検知ログを取り込めませんでした: ${String(reason)}`;
  }
}
