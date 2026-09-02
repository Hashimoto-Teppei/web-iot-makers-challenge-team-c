/**
 * 測位（GNSS）の購読。**expo-location を知っている唯一の場所。**
 *
 * ここだけが React Native 側の API に触れる。**走行ループ（`./loop.ts`）から分けてある**
 * ので、ループと検知は開発機の Vitest で回せる（`docs/adr/0002-development-lifecycle.md`）。
 * **このファイルにはテストを置かない**——実機の測位が要るものは、実機で確かめる。
 *
 * **画面が消えても動き続けるための常駐（フォアグラウンドサービス）は #38 の範囲。**
 * ここで始めるのは前面での購読までで、`docs/interfaces/ble-gatt.md` の接続と同じ
 * ライフサイクルに乗せる。
 */

import * as Location from "expo-location";
import { CRS_MIN_SPD_MPS, roundForWire, type SelfMessage } from "../v2v/messages";

/** 測位の取り方。**しきい値をコードに直書きしない**（`CLAUDE.md`）。 */
export type LocationConfig = {
  /**
   * 測位の間隔（ミリ秒、Android）。
   *
   * **1Hz にしてあるのは中継の周期と同じにするため**（`docs/interfaces/v2v.md`「送る間隔」）。
   * 時間で回すのではなく、**測位が更新されたときに送る**——その更新の間隔がこれである。
   */
  intervalMs: number;
  /**
   * 距離が動かなくても更新を受け取るか（メートル）。**0 にする。**
   *
   * 既定値のまま（`accuracy` 依存）にすると、**止まっている間の更新が届かない。**
   * 止まっている自転車は急接近（#9）が一番見たい相手であり、こちらが止まっている間も
   * 相手からは見えていなければならない。
   */
  distanceIntervalM: number;
};

export const locationDefaults: LocationConfig = {
  intervalMs: 1_000,
  distanceIntervalM: 0,
};

/**
 * 測位を購読する。**返る関数を呼ぶと止まる。**
 *
 * @param onFix 測位1点ぶん。**そのまま `RideLoop.onFix()` に渡せる形**にしてある
 * @throws 権限が下りなかったとき。**黙って測位なしで走り始めない**——
 *   `beat` は `st: "nofix"` を出し続けるので**デバイス側は正しく見える**が、
 *   人は原因（権限）を知りようがない。走行前の画面で伝える
 */
export async function watchFixes(
  onFix: (fix: SelfMessage) => void,
  config: LocationConfig = locationDefaults,
): Promise<() => void> {
  const reason = await checkLocationPermission();
  if (reason !== null) throw new Error(reason);

  const subscription = await Location.watchPositionAsync(
    {
      // 走行中の測位なので最高精度を取りに行く。電池は消えるが、
      // **粗い測位は検知の前提そのものを壊す**（`docs/hardware.md`）。
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: config.intervalMs,
      distanceInterval: config.distanceIntervalM,
    },
    (location) => {
      const fix = toSelfMessage(location);
      // 精度が取れない測位は捨てる（下）。捨てた結果 `beat` が `nofix` に落ちるのは正しい。
      if (fix !== null) onFix(fix);
    },
  );

  return () => subscription.remove();
}

/**
 * 測位できる見込みがあるかを確かめる。**測れない理由、無ければ `null` を返す。**
 *
 * **走行前の点検（`./pre-ride.ts`）が呼ぶ。**走り出すまで測位は動いていないので、
 * **走行前に確かめられるのは権限までである**——実際に測位が出るかは走り始めてから
 * `RideStatus.fix` に出る。
 *
 * **権限を要求する（見るだけにしない）。**この画面はまだ人がスマホを見ている場所で、
 * **ここで訊かないと、走り出した瞬間にダイアログが出る**（そのとき人はもう漕いでいる）。
 */
export async function checkLocationPermission(): Promise<string | null> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return "位置情報の権限が許可されていません";
  // **「おおよその位置」だけの許可でも `granted` は true になる**（Android 12 以降）。
  // このとき `hacc` は数百メートルになり、受け取る側の上限（既定 50m）で**1通残らず
  // 捨てられる。**画面には「測位: 取れていない」としか出ず、**原因が権限であることを
  // 人は知りようがない**ので、ここで分けて伝える。
  if (permission.android?.accuracy === "coarse") {
    return "位置情報が「おおよその位置」になっています。「正確な位置」を許可してください";
  }
  return null;
}

/**
 * expo-location の測位を `self` メッセージにする。**送る前に丸める。**
 *
 * **`null` を返すのは水平精度が得られなかったとき。**`hacc` の無い測位を適当な値で
 * 埋めると「誤差の分からない位置」が「確かな位置」として近傍に配られる
 * （受け取る側は `hacc` で捨てるかを決めている。`docs/interfaces/v2v.md`）。
 */
function toSelfMessage(location: Location.LocationObject): SelfMessage | null {
  const { latitude, longitude, speed, heading, accuracy } = location.coords;
  if (accuracy === null || accuracy <= 0) return null;

  // **速度が無い・負のときは 0 にする。**iOS は測れないときに負の値を返し、
  // Android は `hasSpeed()` が false でも `0.0` を返す（`location.speed.toDouble()`）。
  // 負のまま送ると受け取る側の範囲の検証で1通ごと捨てられる。
  const spd = speed !== null && speed > 0 ? speed : 0;

  return roundForWire({
    k: "self",
    // 測位した時刻。**送信した時刻ではない**（`docs/interfaces/v2v.md`）。
    // **整数に丸める。**iOS は `timestamp.timeIntervalSince1970 * 1000` を返すので
    // 小数になり、サーバーの検証（`t` は整数）を通らない。**Android は整数値なので
    // 主対象では表面化せず、iOS だけが毎回 400 で静かに全滅する。**
    t: Math.round(location.timestamp),
    lat: latitude,
    lon: longitude,
    spd,
    // **止まっているときの進行方角を送らない。**測位では決まらない。
    // **`null` や負の値を当てにしない**——iOS は測れないとき `course` に -1 を返すが、
    // **Android は `hasBearing()` が false でも `0.0`（真北）を返す**
    // （`location.bearing.toDouble()`。ソースで確認済み）。つまり Android で効いている
    // のは速度の条件だけで、**方角の無い測位が「真北」として配られうる**
    // （`docs/unverified.md` 57）。`null` は「向きが分からない」という正常な値で、
    // 受け取る側もそれを捨てない（`docs/interfaces/v2v.md`）。
    crs: heading === null || heading < 0 || spd < CRS_MIN_SPD_MPS ? null : heading % 360,
    hacc: accuracy,
  });
}
