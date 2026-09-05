/**
 * 接続中のデバイスを1つ持つフック。
 *
 * **走行ループの外に置いてある。**接続は走行より寿命が長い——**走り出す前に
 * つながっていることを確かめられなければ、走行前の点検（`./pre-ride.ts`）が
 * 「デバイス」を判定できない**（`docs/interfaces/ble-gatt.md`「接続してから転送するまで」）。
 *
 * **BLE の手順はここに書かない**（`../ble/link.ts`）。ここがやるのは、
 * 画面のライフサイクルに1本の接続を載せることだけである。
 *
 * **モックに落とせるようにしてある。** BLE のネイティブモジュールが無い環境
 * （Expo Go・Web）では `BleManager` を作った時点で落ちるので、そこでは
 * **モックを返して画面が開くようにする**（`../ride/device.ts`）。
 * **モックであることは走行前の点検に必ず出る**ので、黙って実機のふりをすることはない。
 */

import { useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { BleLink, type BleLinkState } from "../ble/link";
import { createMockDeviceLink, type DeviceLink } from "./device";
import { useIdleHeartbeat } from "./idle-heartbeat";

export type DeviceConnection = {
  /** 接続中のデバイス。**つながっていなければ `null`** */
  device: DeviceLink | null;
  /** デバイスが `status` で言ってくる `link`。**購読が始まるまでは `null`** */
  link: "up" | "nofix" | "down" | null;
  /** つながっていない理由。**探している最中は `null`** */
  reason: string | null;
  /** まだ探している最中か */
  searching: boolean;
  /** BLE を通っていない（モック）か。**画面に必ず出す** */
  isMock: boolean;
};

/** BLE のネイティブモジュールが入っているか。**Web と Expo Go では入っていない。** */
const HAS_BLE = Platform.OS === "android" || Platform.OS === "ios";

export function useDeviceLink(): DeviceConnection {
  const [state, setState] = useState<BleLinkState>({
    device: null,
    status: null,
    reason: null,
    // **最初は「探している」から始める。**赤で始めると、起動直後がいつも故障に見える。
    searching: HAS_BLE,
  });
  const [failed, setFailed] = useState(false);
  // **毎回作り直さない。**`DeviceLink` は `useRideLoop` の依存に入っているので、
  // render のたびに別のオブジェクトになると**走行ループが作り直され続ける。**
  const mock = useMemo(() => createMockDeviceLink(), []);

  useEffect(() => {
    if (!HAS_BLE) return;
    let link: BleLink;
    try {
      link = new BleLink(setState);
    } catch (error: unknown) {
      // **落ちたら画面ごと落とさない。**Development Build でないときにここへ来る。
      console.warn("[ble] BleManager を作れません（モックに落とします）", error);
      setFailed(true);
      return;
    }
    link.start();
    return () => link.destroy();
  }, []);

  // **心拍は接続に付いている**（走行ではなく）。ここで出しておかないと、
  // **走り出すまでデバイスが持ち主を 30 秒ごとに切る**（#128。`./idle-heartbeat.ts`）。
  // **フックなので早期 return より前に呼ぶ**——後ろに置くと、モックへ落ちた回と
  // そうでない回で呼ぶ数が変わり、React が壊れる。
  const device = !HAS_BLE || failed ? mock : state.device;
  useIdleHeartbeat(device);

  if (!HAS_BLE || failed) {
    return { device: mock, link: null, reason: null, searching: false, isMock: true };
  }

  return {
    device: state.device,
    link: state.status?.link ?? null,
    reason: state.reason,
    searching: state.searching,
    isMock: false,
  };
}
