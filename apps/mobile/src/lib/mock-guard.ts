/**
 * **モックのデバイスのまま、共有のデプロイ先へ実際の位置を出さないための歯止め。**
 *
 * BLE のネイティブモジュールが無い環境では `createMockDeviceLink()` に落ちる
 * （`../ride/use-device-link.ts`）。そのとき**全員が同じ `MOCK_DEVICE_ID` を名乗る**
 * （`../ride/device.ts`）ので、既定のデプロイ先へ投げると2つのことが起きる。
 *
 * - **実際の緯度経度が共有の Cloudflare に出ていく。**位置情報は個人情報であり、
 *   自宅や行動パターンが特定できる（`CLAUDE.md`）
 * - 同じ ID なので、**開発者どうしのデータが混ざる**
 *
 * **走行ログ（`POST /api/logs`）の方が重い。**中継（`POST /api/v2v/exchange`）が
 * 置くのは Durable Object のメモリで数秒で消えるが、**走行ログは D1 に永続する行**で、
 * しかも**取り込みは上書きも削除もできない**（`docs/interfaces/web-service.md`）。
 * **一度入れたら、入れた本人にも消せない。**
 *
 * **手元の `apps/web` に向けているときは通す**——自分のサーバーならどちらの害も無い。
 * **文書だけでは止まらない**ので、経路の中で止める。
 *
 * **止める入口は2つある。**ネイティブモジュールが無いときの
 * {@link MOCK_DEVICE_ID} と、開発機の疑似ペリフェラルの
 * {@link MOCK_PERIPHERAL_DEVICE_ID} である。**後者の方が見つけにくい**
 * ——実機の BLE を通るので、アプリ側からは本物と区別がつかない。
 */

import { MOCK_DEVICE_ID } from "../ride/device";
import { DEFAULT_API_BASE_URL } from "./api-base";

/**
 * 開発機の疑似ペリフェラル（`apps/device/tools/mock_peripheral.py`）が名乗る端末ID。
 *
 * **本物の BLE を通るので、画面からは見分けられない。**`../ride/use-device-link.ts` の
 * `isMock` は立たず、走行前の点検にも「モック」とは出ない（出ないのが正しい——
 * BLE は本当に通っている）。**だから ID で止めるしかない。**
 *
 * **正本はここ。**Python 側（`mock_peripheral.py` の `MOCK_PERIPHERAL_DEVICE_ID`）は
 * この値を書き写している。**Python から TypeScript は参照できない**ため
 * （`CLAUDE.md`）、GATT の UUID と同じ扱いにする。
 */
export const MOCK_PERIPHERAL_DEVICE_ID = "a1000002";

/** 共有のデプロイ先へ出してはいけない端末ID。**足すときは Python 側も揃える。** */
const MOCK_DEVICE_IDS: readonly string[] = [MOCK_DEVICE_ID, MOCK_PERIPHERAL_DEVICE_ID];

export function blocksMockDevice(deviceId: string, baseUrl: string): boolean {
  return MOCK_DEVICE_IDS.includes(deviceId) && baseUrl === DEFAULT_API_BASE_URL;
}
