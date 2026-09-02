/**
 * 接続中のデバイスを1つ持つフック。**#38 が差し替わるのはここ。**
 *
 * **走行ループの外に置いてある。**接続は走行より寿命が長い——**走り出す前に
 * つながっていることを確かめられなければ、走行前の点検（`./pre-ride.ts`）が
 * 「デバイス」を判定できない**（`docs/interfaces/ble-gatt.md`「接続してから転送するまで」）。
 *
 * いまはモック（`./device.ts`）を返すだけで、**常につながっている。**
 * #38 でスキャン・MTU・サービス探索・再接続がここに入り、**つながっていない間は
 * `device` が `null` になる**——点検の「デバイス」はそれで赤に変わる。
 */

import { useMemo } from "react";
import { createMockDeviceLink, type DeviceLink } from "./device";

export type DeviceConnection = {
  /** 接続中のデバイス。**つながっていなければ `null`** */
  device: DeviceLink | null;
};

export function useDeviceLink(): DeviceConnection {
  // TODO(#38): BLE でスキャンして接続を保つものに差し替える。
  // **口（`DeviceLink`）は変えないこと**——変えるなら、この境界の切り方が間違っている。
  const device = useMemo(() => createMockDeviceLink(), []);
  return { device };
}
