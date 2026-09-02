/**
 * 測位（GNSS）の購読。**expo-location を知っている唯一の場所。**
 *
 * ここだけが React Native 側の API に触れる。**走行ループ（`./loop.ts`）から分けてある**
 * ので、ループと検知は開発機の Vitest で回せる（`docs/adr/0002-development-lifecycle.md`）。
 * **このファイルにはテストを置かない**——実機の測位が要るものは、実機で確かめる。
 *
 * **画面が消えても動き続けるための常駐（フォアグラウンドサービス）はここが立てる**（#38）。
 * `watchPositionAsync` は**前面にいる間だけの購読**なので、それだけでは走行中ずっと
 * 測位も中継も止まりうる——**走行中はスマホを画面を消してハンドルに固定する前提**
 * （`CLAUDE.md`）なので、常駐が無いと**通常の使い方でだけ全部が黙る。**
 *
 * **サービスの種別は `connectedDevice` ではなく `location` にした**（`docs/interfaces/ble-gatt.md`
 * は `connectedDevice` と書いているが、Android が求めるのは「プロセスが生き続けること」で、
 * **種別が違っても BLE の接続は同じように保たれる**）。`location` にしたのは、
 * expo-location が `LocationTaskService` を種別 `location` で同梱しており、
 * **ネイティブのモジュールを自分で書かずに済む**ため。**測位と BLE の両方がこの1本に乗る。**
 *
 * **`app.json` の `android.permissions` から `RECEIVE_BOOT_COMPLETED` を消さないこと。**
 * expo-task-manager は測位を届けるのに**永続化した JobScheduler のジョブ**を使い、
 * この権限が無いと `IllegalArgumentException` で**アプリが起動時に落ちる**
 * （走行を止めずにアプリを終了させると、次の起動で必ず起きる。実機で再現済み）。
 * expo-task-manager 自身のマニフェストには入っていないので、**こちらで宣言する。**
 */

import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { inPermissionQueue } from "../lib/permission-queue";
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
 * 常駐している間、通知領域に出す文言。
 *
 * **走行中に読ませるためのものではない**（走行中にスマホを見る行為は取り締まり対象。
 * `CLAUDE.md`）。**止め忘れに気づくため**のもので、走り終えたのに通知が残っていれば
 * 電池が減り続けている。
 */
const FOREGROUND_NOTIFICATION = {
  notificationTitle: "走行中",
  notificationBody: "測位とデバイスとの接続を続けています（走行を終えると消えます）。",
  notificationColor: "#208AEF",
} as const;

/** フォアグラウンドサービスに結びつくタスクの名前。**変えると走行中に止まる。** */
const RIDE_LOCATION_TASK = "ride-location";

/**
 * いま測位を受け取る先。**モジュールに1つだけ持つ。**
 *
 * **タスクはアプリの外（OS）から呼ばれる**ので、React の中に閉じ込められない。
 * 走行は同時に1つだけなので、1つで足りる。
 */
let deliverFix: ((fix: SelfMessage) => void) | null = null;

// **トップレベルで定義する。**`TaskManager.defineTask` は起動のたびに、
// **タスクが呼ばれるより前に**呼ばれている必要がある（アプリが落ちて OS に起こされた
// 場合を含む）。関数の中に入れると、**その関数を通らなかった起動でだけ測位が届かない。**
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(
  RIDE_LOCATION_TASK,
  // **`async` にしてあるのは expo-task-manager が `Promise` を要求するため。**
  // 中で待つものは無い。
  async ({ data, error }) => {
    // **投げない。**タスクから例外を抜けさせると、以後この測位が届かなくなる。
    if (error !== null || data == null) return;
    for (const location of data.locations) {
      const fix = toSelfMessage(location);
      if (fix !== null) deliverFix?.(fix);
    }
  },
);

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

  deliverFix = onFix;
  // **前回の走行が残っていたら先に止める。**二重に登録すると、止めたはずの走行の
  // 測位が新しい走行に混ざる。
  if (await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(RIDE_LOCATION_TASK);
  }

  await Location.startLocationUpdatesAsync(RIDE_LOCATION_TASK, {
    // 走行中の測位なので最高精度を取りに行く。電池は消えるが、
    // **粗い測位は検知の前提そのものを壊す**（`docs/hardware.md`）。
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: config.intervalMs,
    distanceInterval: config.distanceIntervalM,
    // **OS に間引かせない。**既定では止まっている間の更新が止まりうるが、
    // 止まっている自転車こそ急接近（#9）で一番見たい相手である。
    pausesUpdatesAutomatically: false,
    // **これがあるから画面を消しても止まらない**（`ACCESS_BACKGROUND_LOCATION` は
    // 要らない——expo-location は前面から始めた常駐を背景の権限なしで認める。
    // `LocationModule.kt` の `startLocationUpdatesAsync` で確認済み）。
    foregroundService: FOREGROUND_NOTIFICATION,
  });

  return () => {
    deliverFix = null;
    // **待たない。**止める側は走行を閉じる流れの中にいる（`./use-ride-loop.ts`）。
    void Location.stopLocationUpdatesAsync(RIDE_LOCATION_TASK).catch(() => undefined);
  };
}

/**
 * 前回の走行が残した常駐を止める。**アプリを開いたときに1回だけ呼ぶ。**
 *
 * **走行中にアプリを終了させると、常駐だけが残る。**登録は OS 側にあるので
 * アプリが死んでも消えず、**「走行中」の通知が出たまま電池を食い続ける**
 * （測位は届く先が無いので捨てられる。誰も気づけない）。
 *
 * **走行中は何もしない。**走り出したあとに呼ばれても止めないこと。
 */
export async function stopStaleRideLocationUpdates(): Promise<void> {
  if (deliverFix !== null) return;
  if (await Location.hasStartedLocationUpdatesAsync(RIDE_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(RIDE_LOCATION_TASK);
  }
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
  // **BLE の要求と重ねない**（`../lib/permission-queue.ts`）。重ねると、
  // この Promise が解決しないまま「確かめています…」で固まる。
  const permission = await inPermissionQueue(() => Location.requestForegroundPermissionsAsync());
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
