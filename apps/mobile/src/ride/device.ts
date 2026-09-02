/**
 * デバイスとの口（BLE）を、走行ループから見た形で1つに絞ったもの。
 *
 * **ここに BLE の実装を書かない。**走行ループ（`./loop.ts`）が知ってよいのは
 * 「名乗る `device_id`」と「`alert` に1通書く」の2つだけで、スキャン・MTU・
 * サービス探索・再接続は `../ble/link.ts` にある。分けてあるおかげで、**実機も
 * Development Build も無いまま走行ループを Vitest で回せる**
 * （`docs/adr/0002-development-lifecycle.md`）。
 *
 * **実装に差し替えても `./loop.ts` は変わらない**——変わるなら、この境界の切り方が
 * 間違っている。{@link MockDeviceLink} は開発機と、BLE のネイティブモジュールが
 * 無い環境（Web）でだけ使う（`./use-device-link.ts`）。
 */

import type { AlertMessage } from "../v2v/alert";

/**
 * 接続中のデバイス1台。
 *
 * **`deviceId` はデバイスから `device-info` で読んだ `device_id`**であって、スマホ側で
 * 作った ID ではない（`docs/interfaces/mobile-api.md`）。同じデバイスを2つの名前で
 * 呼ぶと、中継とログの突き合わせが割れる。
 *
 * **デバイスにつながっていない間は、この値が存在しない。**つながっていなければ
 * 名乗る `id` が無いだけでなく、**検知しても警告を出す先が無い**ので、走行ループ自体を
 * 始めない（`./loop.ts`）。
 */
export type DeviceLink = {
  /** 端末ID（16進の小文字8文字） */
  deviceId: string;
  /**
   * `alert` に1通書く。
   *
   * **返り値を待たない（`void`）。**呼ぶ側は書けたかを知らないし、知る必要もない。
   *
   * - **書けなかった1通を溜めない。**警告は古くなれば無価値で、**遅れて鳴る警告は
   *   鳴らないより悪い**（もう通り過ぎた危険で鳴る。`docs/interfaces/mobile-api.md`）
   * - **例外を投げない。**実装の中で握りつぶす。投げると、書けなかった1回で
   *   **心拍のタイマーごと止まりうる**
   * - **再送しない。**心拍は次の1秒後に、警告は次の測位で作り直される
   */
  writeAlert: (message: AlertMessage) => void;
};

/**
 * 開発機で走行ループを回すためのモック。
 *
 * 書かれたものを配列に溜めるだけ。**溜めるのは確認のためであって、送り直すためではない。**
 * 実装（`../ble/link.ts`）は溜めずに捨てる。
 */
export type MockDeviceLink = DeviceLink & {
  /** 書かれたもの（古い順） */
  readonly written: readonly AlertMessage[];
  /** `warn` だけを取り出す */
  warns: () => readonly AlertMessage[];
  /** 溜めたものを捨てる */
  clear: () => void;
};

/**
 * モックが名乗る端末ID。**全員が同じ値を名乗る**ので、これを名乗ったまま共有の
 * デプロイ先へ中継すると、**開発者どうしが Durable Object の同じ枠を上書きし合う**
 * （`../lib/mock-guard.ts` の歯止めが止める）。**実機につながれば、名乗る ID が
 * デバイスから読んだものに変わるので、歯止めは自然に外れる。**
 */
export const MOCK_DEVICE_ID = "a1000001";

/**
 * @param deviceId 名乗る端末ID。既定は合成した値（実在の機器の ID ではない）
 */
export function createMockDeviceLink(deviceId = MOCK_DEVICE_ID): MockDeviceLink {
  const written: AlertMessage[] = [];
  return {
    deviceId,
    written,
    writeAlert: (message) => {
      written.push(message);
    },
    warns: () => written.filter((m) => m.k === "warn"),
    clear: () => {
      written.length = 0;
    },
  };
}
