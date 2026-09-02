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
 */

import { MOCK_DEVICE_ID } from "../ride/device";
import { DEFAULT_API_BASE_URL } from "./api-base";

export function blocksMockDevice(deviceId: string, baseUrl: string): boolean {
  return deviceId === MOCK_DEVICE_ID && baseUrl === DEFAULT_API_BASE_URL;
}
