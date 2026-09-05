/**
 * デバイスを見つけて、接続を保ち続ける（#38）。
 *
 * **手順の正本は `docs/interfaces/ble-gatt.md`「接続してから転送するまで」。**
 * 順番を変えないこと——GATT の操作は一度に1つしか出せず、重ねると**片方が黙って落ちる。**
 *
 * **ここが react-native-ble-plx を知っている唯一の場所。**UUID と JSON の解釈は
 * `./protocol.ts` にあり、そちらは開発機の Vitest で回せる
 * （`docs/adr/0002-development-lifecycle.md`）。**このファイルにテストを置かない**
 * ——実機の BLE が要るものは実機で確かめる。
 *
 * **`log`（検知ログの転送）はまだ扱わない**（#40）。ここで作るのは接続と `alert` の出口だけ。
 */

import { BleManager, type Device, type Subscription } from "react-native-ble-plx";
import type { DeviceLink } from "../ride/device";
import type { AlertMessage } from "../v2v/alert";
import { base64ToUtf8, utf8ToBase64 } from "./base64";
import { requestBlePermissions } from "./permissions";
import {
  ALERT_UUID,
  DEVICE_INFO_UUID,
  type DeviceStatus,
  incompatibleReason,
  isCompatible,
  MIN_MTU,
  parseDeviceInfo,
  parseStatus,
  REQUESTED_MTU,
  SERVICE_UUID,
  STATUS_UUID,
  shortMtuReason,
} from "./protocol";

/** 接続の見え方。**画面（走行前の点検）が見るのはこれだけ。** */
export type BleLinkState = {
  /** 接続中のデバイス。**つながっていなければ `null`**（`../ride/device.ts`） */
  device: DeviceLink | null;
  /** デバイスが Notify で送ってくる `status`。**購読が始まるまでは `null`** */
  status: DeviceStatus | null;
  /** つながっていない理由。**探している最中は `null`** */
  reason: string | null;
  /** まだ探している最中か。**「探している」と「駄目だった」を混ぜない**（`../ride/pre-ride.ts`） */
  searching: boolean;
};

/** 切れてからつなぎ直すまでの待ち（ミリ秒）。**しきい値を直書きしない**（`CLAUDE.md`）。 */
export type BleLinkConfig = {
  /** スキャンをこの時間見つからなければ、一度やり直す */
  scanTimeoutMs: number;
  /** 失敗したあと次の試行までの待ち */
  retryDelayMs: number;
  /**
   * 権限が下りなかったあと、もう一度訊くまでの待ち。**普通の再試行より長くする。**
   *
   * **短くしない。**測位の権限（`../ride/location.ts`）と同時に立ち上がるため、
   * **片方のダイアログが出ている間に頼むと、出ないまま「拒否」が返る**
   * ——実際にそうなり、走行前の点検が「許可されていません」で固まった。
   * **人が触らなくても直る**ように、間を置いて訊き直す。
   */
  permissionRetryDelayMs: number;
};

export const bleLinkDefaults: BleLinkConfig = {
  // **長めに取る。**デバイスは常時アドバタイズするが、接続中はアドバタイズを止めるので、
  // 他人がつなぎっぱなしのときは見つからない（`docs/interfaces/ble-security.md`「運用で気をつけること」）。
  // **待てば戻る。**心拍の書かれない接続はデバイスが 30 秒ほどで自分から切るので
  // （`docs/interfaces/ble-gatt.md`「前提」）、**探し続けていれば人が触らなくても繋がる。**
  scanTimeoutMs: 20_000,
  retryDelayMs: 2_000,
  permissionRetryDelayMs: 5_000,
};

/**
 * 接続を1本、保ち続けるもの。
 *
 * **`start()` を呼ぶと、つながるまで（そして切れたら何度でも）自分で試み続ける。**
 * 止めるのは `stop()` だけ。
 */
export class BleLink {
  private readonly manager = new BleManager();
  private readonly config: BleLinkConfig;
  private readonly onChange: (state: BleLinkState) => void;

  private state: BleLinkState = {
    device: null,
    status: null,
    reason: null,
    searching: false,
  };

  /** 接続中の相手。`writeAlert` はこれに書く */
  private connected: Device | null = null;
  private statusSubscription: Subscription | null = null;
  private disconnectSubscription: Subscription | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 止めたあとに走っている非同期を捨てるための世代番号 */
  private generation = 0;
  private stopped = true;

  constructor(onChange: (state: BleLinkState) => void, config: BleLinkConfig = bleLinkDefaults) {
    this.onChange = onChange;
    this.config = config;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.attempt();
  }

  /**
   * スキャンを止める。**必ずこれを通す**（`manager.stopDeviceScan()` を直に呼ばない）。
   *
   * **`stopDeviceScan()` は Promise を返す。**`react-native-ble-plx` の中で
   * `_callPromise()` を通っており（`BleManager.js`）、**`manager.destroy()` は
   * 進行中の操作をすべて拒否する**（`_destroyPromises()`）。**受け取り手を付けずに
   * 呼ぶと、画面を離れるたびに `Uncaught (in promise) BleError: BleManager was destroyed`
   * が出る**——実機で実際に出ていた。
   *
   * **握りつぶしてよい。** スキャンを止められなかったところで、直後に
   * `destroy()` がネイティブ側ごと片付ける。
   */
  private stopScan(): void {
    this.manager.stopDeviceScan().catch(() => undefined);
  }

  /** 止める。**接続も切る**——止めたのに `alert` が書ける状態を残さない。 */
  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopScan();
    this.teardown();
    this.publish({ device: null, status: null, reason: null, searching: false });
  }

  /** フックが捨てられるときに呼ぶ。**`BleManager` は使い捨てにしない**（ネイティブ側が残る）。 */
  destroy(): void {
    this.stop();
    // **`destroy()` も Promise を返す。**しかも `_destroyPromises()` は
    // **自分自身の Promise も拒否する**ので、受け取り手を付けないと
    // ここが最後の1件を出す（`stopScan()` と同じ話）。
    this.manager.destroy().catch(() => undefined);
  }

  /**
   * `alert` に1通書く。**返り値を待たず、投げず、溜めない**（`../ride/device.ts`）。
   *
   * **Write Request（応答あり）で書く。**応答なしは送信キューが埋まると黙って落ち、
   * 落ちたことを誰も知れない（`docs/interfaces/ble-gatt.md`）。
   */
  private writeAlert(message: AlertMessage): void {
    const device = this.connected;
    if (device === null) return;
    const payload = utf8ToBase64(JSON.stringify(message));
    device
      .writeCharacteristicWithResponseForService(SERVICE_UUID, ALERT_UUID, payload)
      // **握りつぶす。**書けなかった1通は捨てる——古い警告は無価値で、
      // **遅れて鳴る警告は鳴らないより悪い。**心拍は次の1秒後に作り直される。
      .catch(() => undefined);
  }

  /** 1回ぶんの接続の試み。**失敗したら自分で次を予約する。** */
  private async attempt(): Promise<void> {
    if (this.stopped) return;
    const generation = this.generation;
    this.publish({ device: null, status: null, reason: null, searching: true });

    try {
      const reason = await requestBlePermissions();
      if (this.isStale(generation)) return;
      if (reason !== null) {
        // **訊き直す。**測位のダイアログと重なって「出ないまま拒否」になることがあり、
        // そこで止まると**人が何もしていないのに赤で固まる。**
        // 本当に拒否されたあとは Android がダイアログを出さずに即返すので、
        // 繰り返しても人には見えない（赤の文言が設定への行き方を伝える）。
        this.fail(reason, { retry: true, delayMs: this.config.permissionRetryDelayMs });
        return;
      }

      // Bluetooth が入っていなければ、入るまで待つ（第2引数 true で今の状態も届く）。
      await this.waitPoweredOn(generation);
      if (this.isStale(generation)) return;

      const found = await this.scan(generation);
      if (this.isStale(generation)) return;
      if (found === null) {
        // **故障として出さない**（`reason` を立てない）。別のスマホがつながっている間は
        // アドバタイズが出ないが、デバイスは心拍の来ない接続を 30 秒ほどで自分から切る
        // （`docs/interfaces/ble-gatt.md`「前提」）。**探し続けていれば戻るので、
        // 人にさせることは「待つ」だけ**——ここで電源の入れ直しを促さない。
        //
        // **`fail()` を呼ぶと、走行前の点検で ✗ が出る**（`../ride/pre-ride.ts`）。
        // スキャンは 20 秒ごとにやり直すので、**✗ が 20 秒おきに点滅する**ことになり、
        // **本物の ✗（権限が下りていないなど、人が直さないと進まないもの）が
        // 読み飛ばされるようになる。** 実機で確かめて直した（#126）。
        this.keepSearching();
        return;
      }

      await this.handshake(found, generation);
    } catch (error: unknown) {
      if (this.isStale(generation)) return;
      this.fail(`デバイスにつなげません: ${String(error)}`, { retry: true });
    }
  }

  /**
   * 接続してから `alert` を書き始めるまで。**順番を守る。**
   *
   * MTU → サービス探索 → `device-info` → `status` の購読。**それぞれ完了を待ってから
   * 次へ進む**——重ねると片方が黙って落ちる（`docs/interfaces/ble-gatt.md`）。
   */
  private async handshake(scanned: Device, generation: number): Promise<void> {
    const device = await scanned.connect({ autoConnect: false });
    if (this.isStale(generation)) {
      await device.cancelConnection().catch(() => undefined);
      return;
    }

    // 1. MTU を要求してから、サービス探索。**同時に走らせない。**
    const negotiated = await device.requestMTU(REQUESTED_MTU);
    await negotiated.discoverAllServicesAndCharacteristics();
    if (this.isStale(generation)) {
      await device.cancelConnection().catch(() => undefined);
      return;
    }

    // **足りなければここで止める。**進むと `alert` が黙って切れ、
    // 接続できているのに警告が出ない状態になる。
    const mtu = negotiated.mtu;
    if (mtu < MIN_MTU) {
      await device.cancelConnection().catch(() => undefined);
      this.fail(shortMtuReason(mtu), { retry: true });
      return;
    }
    // **ネゴシエートされた MTU をログに出す**（#38 の完了条件。`docs/unverified.md` 13）。
    console.log(`[ble] MTU=${mtu}（要求 ${REQUESTED_MTU} / 下限 ${MIN_MTU}）`);

    // 2. `device-info` を読んでデバイスを識別する。
    const info = parseDeviceInfo(await this.readString(device, DEVICE_INFO_UUID));
    if (this.isStale(generation)) {
      await device.cancelConnection().catch(() => undefined);
      return;
    }
    if (!isCompatible(info)) {
      // **転送も `alert` も行わない。**中途半端に書くと、デバイスは
      // 心拍として解釈できず `link` を `down` に落とす一方、
      // スマホは警告が届いていると信じ続ける（`docs/interfaces/ble-gatt.md`）。
      await device.cancelConnection().catch(() => undefined);
      this.fail(incompatibleReason(info), { retry: false });
      return;
    }

    // 3. `status` の Notify を購読する。**CCCD への Write も1つの GATT 操作**なので、
    //    ここまでの読み書きが終わってから張る。
    this.statusSubscription = device.monitorCharacteristicForService(
      SERVICE_UUID,
      STATUS_UUID,
      (error, characteristic) => {
        if (error !== null || characteristic?.value == null) return;
        try {
          this.publish({ ...this.state, status: parseStatus(decode(characteristic.value)) });
        } catch {
          // **1通壊れても購読を捨てない。**捨てると `link` が二度と更新されない。
        }
      },
    );

    this.disconnectSubscription = device.onDisconnected(() => {
      if (this.isStale(generation)) return;
      // **自動でつなぎ直す**（#38）。走行中に切れるのは普通に起きる。
      this.teardown();
      this.fail("デバイスとの接続が切れました。つなぎ直しています…", { retry: true });
    });

    this.connected = device;
    this.publish({
      device: {
        // **デバイスから読んだ `device_id` を名乗る。**スマホ側で作った ID にすると、
        // 中継とログの突き合わせが割れる（`../ride/device.ts`）。
        deviceId: info.deviceId,
        writeAlert: (message) => this.writeAlert(message),
      },
      status: null,
      reason: null,
      searching: false,
    });
  }

  private async readString(device: Device, uuid: string): Promise<string> {
    const characteristic = await device.readCharacteristicForService(SERVICE_UUID, uuid);
    return decode(characteristic.value ?? "");
  }

  /** Service UUID でスキャンする。**名前で探さない**（名前は人が見分けるためだけ）。 */
  private scan(generation: number): Promise<Device | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopScan();
        resolve(null);
      }, this.config.scanTimeoutMs);

      this.manager.startDeviceScan([SERVICE_UUID], null, (error, device) => {
        if (this.isStale(generation)) return;
        if (error !== null) {
          clearTimeout(timer);
          this.stopScan();
          reject(error);
          return;
        }
        if (device === null) return;
        clearTimeout(timer);
        this.stopScan();
        resolve(device);
      });
    });
  }

  /** Bluetooth が使える状態になるまで待つ。 */
  private waitPoweredOn(generation: number): Promise<void> {
    return new Promise((resolve) => {
      // **第2引数（今の状態も届ける）を使わない。**`react-native-ble-plx` の中で
      // `this._callPromise(this.state()).then(...)` と、**拒否側のハンドラを付けずに**
      // 呼んでいる（`BleManager.js` の `onStateChange`）。`destroy()` は進行中の操作を
      // すべて拒否するので、**画面を離れるたびに `Uncaught (in promise) BleError` が
      // ライブラリの中から出る**——こちらのコードでは捕まえられない。
      // **今の状態は自分で訊く**（下）。そうすれば拒否を受け取れる。
      const subscription = this.manager.onStateChange((state) => {
        if (this.isStale(generation)) {
          subscription.remove();
          resolve();
          return;
        }
        if (state === "PoweredOn") {
          subscription.remove();
          resolve();
        }
      }, false);

      // **今の状態を1回だけ訊く。**入っていれば待たずに進む。
      // **失敗は握りつぶしてよい**——入っていなければ、上の購読が変化を拾う。
      this.manager
        .state()
        .then((state) => {
          if (this.isStale(generation) || state === "PoweredOn") {
            subscription.remove();
            resolve();
          }
        })
        .catch(() => undefined);
    });
  }

  /**
   * **理由を出さずに**、次の試行だけ予約する。
   *
   * **`fail()` との違いは「人が直すことがあるか」。** 見つからないだけなら、
   * 待てば直る（`attempt()` の中の注記）。**そこに ✗ を出さない。**
   */
  private keepSearching(): void {
    this.publish({ device: null, status: null, reason: null, searching: true });
    if (this.stopped) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.attempt(), this.config.retryDelayMs);
  }

  /** 理由を出して、必要なら次の試行を予約する。**人が直すもの**はこちら。 */
  private fail(reason: string, { retry, delayMs }: { retry: boolean; delayMs?: number }): void {
    this.publish({ device: null, status: null, reason, searching: retry });
    if (!retry || this.stopped) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.attempt(), delayMs ?? this.config.retryDelayMs);
  }

  private teardown(): void {
    this.statusSubscription?.remove();
    this.statusSubscription = null;
    this.disconnectSubscription?.remove();
    this.disconnectSubscription = null;
    const device = this.connected;
    this.connected = null;
    device?.cancelConnection().catch(() => undefined);
  }

  /** 止められた・やり直しが始まった試行か */
  private isStale(generation: number): boolean {
    return this.stopped || generation !== this.generation;
  }

  private publish(state: BleLinkState): void {
    this.state = state;
    this.onChange(state);
  }
}

/** 読んだ値を文字列にする。**呼ぶ側に Base64 を持ち回らせない。** */
function decode(value: string): string {
  return base64ToUtf8(value);
}
