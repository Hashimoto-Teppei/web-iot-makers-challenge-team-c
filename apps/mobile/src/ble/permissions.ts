/**
 * BLE に要る Android の実行時権限。
 *
 * **測位の権限（`expo-location`）とは別に要る。**Android 12 以降はスキャンと接続が
 * `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` に分かれており、**11 以前は代わりに
 * 位置情報の権限でスキャンが通る**（BLE のスキャンから位置が推定できるため）。
 * どちらか片方だけを頼むと、**その OS バージョンだけスキャンが 0 件で返る**
 * ——エラーにならないので、**「近くにデバイスが無い」と見分けが付かない。**
 */

import { PermissionsAndroid, Platform } from "react-native";
import { inPermissionQueue } from "../lib/permission-queue";

/**
 * 権限を要求する。**足りない理由、そろっていれば `null` を返す。**
 *
 * **投げない。**呼ぶ側（`./link.ts`）は再接続のループの中にいるので、
 * ここで投げると**接続の試行そのものが止まる。**
 */
export async function requestBlePermissions(): Promise<string | null> {
  // **Android だけ。**iOS は Info.plist の記述だけで、実行時の要求は接続時に OS が行う。
  if (Platform.OS !== "android") return null;

  const needed =
    // API 31（Android 12）から分かれた。**それ以前は位置情報がスキャンの権限**である。
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          // **12 以降でも位置情報が要る。**`BLUETOOTH_SCAN` に `neverForLocation` を
          // 付けていないため（付けると react-native-ble-plx の config plugin が
          // 位置情報の権限に `maxSdkVersion="30"` を足し、**測位の側が巻き添えで死ぬ**）。
          // **この権限が無いとスキャンは 0 件で返る**——エラーにならないので、
          // 「近くにデバイスが無い」と見分けが付かない。
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  // **測位の要求と重ねない**（`../lib/permission-queue.ts`）。重ねると、
  // ダイアログが出ないまま「拒否」が返る。
  const results = await inPermissionQueue(() => PermissionsAndroid.requestMultiple(needed));
  const denied = needed.filter((permission) => results[permission] !== "granted");
  if (denied.length === 0) return null;
  return (
    "Bluetooth の権限が許可されていません（設定 → アプリ → 権限 から許可してください）。" +
    "許可しないとデバイスを見つけられず、危険を検知しても知らせる先がありません。"
  );
}
