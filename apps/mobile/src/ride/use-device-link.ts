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
 *
 * **「デバイスを使わない」がオンのときは、スキャンを始めない**（#185。`./standalone.ts`）。
 * **作って使わないでは足りない**——`BleLink` は作った時点で探し始めるので、
 * **2台目のスマホがラズパイの枠を狙い続ける**（デバイス側は弾くが、繋ぎ直しは止まらない）。
 */

import { useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { BleLink, type BleLinkState } from "../ble/link";
import { createMockDeviceLink, type DeviceLink, STANDALONE_DEVICE_ID } from "./device";
import { useIdleHeartbeat } from "./idle-heartbeat";
import { useStandalone } from "./standalone";

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
  /** 「デバイスを使わない」がオンか。**画面に必ず出す**（#185。警告が出ない端末である） */
  standalone: boolean;
};

/** BLE のネイティブモジュールが入っているか。**Web と Expo Go では入っていない。** */
const HAS_BLE = Platform.OS === "android" || Platform.OS === "ios";

export function useDeviceLink(): DeviceConnection {
  // **設定を先に読む。**オンなら、この下の `BleLink` を作らない。
  const standalone = useStandalone();
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
  //
  // **名乗る `id` は設定で変わる。**デバイス無しのときにモックの既定値を名乗ると、
  // `../lib/mock-guard.ts` が共有のデプロイ先への中継を塞ぐ（`./standalone.ts`）。
  const mock = useMemo(
    () => createMockDeviceLink(standalone ? STANDALONE_DEVICE_ID : undefined),
    [standalone],
  );

  useEffect(() => {
    if (!HAS_BLE || standalone) return;
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
    // **設定が変わったら張り直す。**オンにした瞬間にスキャンを止めたい
    // （止めないと、切り替えたのに枠を狙い続ける）。
  }, [standalone]);

  // **心拍は接続に付いている**（走行ではなく）。ここで出しておかないと、
  // **走り出すまでデバイスが持ち主を 30 秒ごとに切る**（#128。`./idle-heartbeat.ts`）。
  // **フックなので早期 return より前に呼ぶ**——後ろに置くと、モックへ落ちた回と
  // そうでない回で呼ぶ数が変わり、React が壊れる。
  const device = !HAS_BLE || failed || standalone ? mock : state.device;
  // **デバイスが無いなら心拍も要らない**——`useIdleHeartbeat` はモック相手なら
  // 書いた先が捨てられるだけだが、**そもそも書く相手がいない**ことを明示しておく。
  useIdleHeartbeat(standalone ? null : device);

  if (standalone) {
    // **「探している」にしない。**探していないので、点検は待たずに答えを出してよい。
    // **`isMock` は立てない**——BLE を通っていないのは同じだが、**理由も直し方も違う**
    // （あちらは Development Build で直り、こちらは設定でしか変わらない）。
    return { device: mock, link: null, reason: null, searching: false, isMock: false, standalone };
  }

  if (!HAS_BLE || failed) {
    return {
      device: mock,
      link: null,
      reason: null,
      searching: false,
      isMock: true,
      standalone: false,
    };
  }

  return {
    device: state.device,
    link: state.status?.link ?? null,
    reason: state.reason,
    searching: state.searching,
    isMock: false,
    standalone: false,
  };
}
