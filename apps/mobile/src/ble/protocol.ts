/**
 * BLE GATT の約束（UUID・MTU・`device-info` / `status` の形）。
 *
 * **正本は `docs/interfaces/ble-gatt.md`。**ここはその実装であって、決め直す場所ではない。
 * 受け取る側（デバイス）の実装は `apps/device/src/device/hw/ble.py` で、
 * **Python は TypeScript のスキーマを参照できない**ので、変えるときは両方とドキュメントを
 * 揃えること（`CLAUDE.md`）。
 *
 * **react-native-ble-plx を知らない。**接続の手順は `./link.ts` にあり、ここは
 * 「何という UUID か」「読んだ文字列をどう解釈するか」だけを持つ。分けてあるので
 * **実機も Development Build も無いまま Vitest で回せる**（`docs/adr/0002-development-lifecycle.md`）。
 */

/** この境界のプロトコルバージョン。**`alert` に別の番号を持たせない。** */
export const PROTO_VERSION = 2;

export const SERVICE_UUID = "68666e00-58cc-4540-90ad-18bfae31615f";
export const DEVICE_INFO_UUID = "68666e01-58cc-4540-90ad-18bfae31615f";
export const CONTROL_UUID = "68666e02-58cc-4540-90ad-18bfae31615f";
export const LOG_UUID = "68666e03-58cc-4540-90ad-18bfae31615f";
export const STATUS_UUID = "68666e04-58cc-4540-90ad-18bfae31615f";
export const ALERT_UUID = "68666e06-58cc-4540-90ad-18bfae31615f";

/** 要求する MTU。**上限いっぱいを頼む**（下りてくるのはネゴシエートされた値）。 */
export const REQUESTED_MTU = 247;

/**
 * これを下回ったら接続を諦める最小の MTU。
 *
 * **`alert` の1通の上限 160 バイト + ATT のヘッダ 3 バイト**
 * （`docs/interfaces/ble-log-transfer.md`「転送の約束」の 7）。
 * **足りないまま進むと、書いた `alert` が黙って切れる**——心拍が壊れた JSON として
 * 捨てられ、デバイスは `link` を `down` にする。**接続はできているのに警告が出ない。**
 */
export const MIN_MTU = 163;

/** `device-info`（Read）の中身。 */
export type DeviceInfo = {
  proto: number;
  /** 端末ID（16進の小文字8文字） */
  deviceId: string;
  /** ログの世代。**これが前回と違えば既読位置は無効**（#40 で使う） */
  logId: string;
  /** デバイスが今も持っているレコード番号の範囲。1件も無ければ両方 0 */
  oldestSeq: number;
  latestSeq: number;
};

/** `status`（Read / Notify）の中身。**表示のためのもの**で、完了判定には使わない。 */
export type DeviceStatus = {
  state: "idle" | "sending";
  sent: number;
  remaining: number;
  lastError: string | null;
  /** デバイスから見た心拍の状態（`docs/interfaces/v2v.md`「心拍を必ず見せる」） */
  link: "up" | "nofix" | "down";
  /** 起動から受け取った `warn` の累計。**警告が本当に届いているかを人が確かめるため** */
  warns: number;
  /** 起動から `alert` で壊れているとして捨てた累計 */
  dropped: number;
};

/** 読み取ったものが約束の形をしていないときに投げる。**握りつぶさないこと。** */
export class BleProtocolError extends Error {}

/** 16進の小文字8文字か。**`device_id` と `log_id` の形**（`docs/interfaces/ble-gatt.md`）。 */
export function isHex8(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}$/.test(value);
}

/**
 * `device-info` の JSON を解釈する。
 *
 * **`proto` の不一致をここで落とさない。**落とすと呼ぶ側が「壊れている」と
 * 区別できず、画面に「更新してください」と出せない（`docs/interfaces/ble-gatt.md`）。
 * 一致するかは {@link isCompatible} で別に見る。
 */
export function parseDeviceInfo(text: string): DeviceInfo {
  const value = parseObject(text, "device-info");
  const proto = value.proto;
  if (typeof proto !== "number" || !Number.isInteger(proto)) {
    throw new BleProtocolError("device-info の proto が整数ではありません");
  }
  if (!isHex8(value.device_id)) {
    throw new BleProtocolError("device-info の device_id が16進8文字ではありません");
  }
  if (!isHex8(value.log_id)) {
    throw new BleProtocolError("device-info の log_id が16進8文字ではありません");
  }
  return {
    proto,
    deviceId: value.device_id,
    logId: value.log_id,
    // **範囲は目安なので、欠けていても落とさない。**これで止めると、
    // ログを1件も持っていないデバイスにつなげなくなりうる。
    oldestSeq: asCount(value.oldest_seq),
    latestSeq: asCount(value.latest_seq),
  };
}

/**
 * `status` の JSON を解釈する。
 *
 * **知らないキーは無視する。**項目を足しただけで購読が壊れると、
 * デバイス側が1つ増やすたびにアプリが黙る（`docs/interfaces/ble-gatt.md`）。
 */
export function parseStatus(text: string): DeviceStatus {
  const value = parseObject(text, "status");
  const state = value.state === "sending" ? "sending" : "idle";
  const link =
    value.link === "up" || value.link === "nofix" || value.link === "down" ? value.link : "down";
  return {
    state,
    sent: asCount(value.sent),
    remaining: asCount(value.remaining),
    lastError: typeof value.last_error === "string" ? value.last_error : null,
    link,
    warns: asCount(value.warns),
    dropped: asCount(value.dropped),
  };
}

/** デバイスと話せるバージョンか。**違えば転送も `alert` も行わない。** */
export function isCompatible(info: DeviceInfo): boolean {
  return info.proto === PROTO_VERSION;
}

/**
 * バージョンが合わないときに人へ見せる文言。
 *
 * **「更新するまで警告が出ない」と書く**（`docs/interfaces/ble-gatt.md`）。
 * 「非対応です」だけだと、**警告が1つも出ない状態で走り出せてしまう。**
 */
export function incompatibleReason(info: DeviceInfo): string {
  return (
    `デバイスのプロトコルが ${info.proto}、アプリは ${PROTO_VERSION} です。` +
    "どちらかを更新するまで警告が出ません。"
  );
}

/** MTU が足りないときに人へ見せる文言。 */
export function shortMtuReason(mtu: number): string {
  return (
    `MTU が ${mtu} しかありません（${MIN_MTU} 以上が必要）。` +
    "デバイスを再起動してからつなぎ直してください。"
  );
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BleProtocolError(`${what} が JSON として読めません`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BleProtocolError(`${what} が JSON オブジェクトではありません`);
  }
  return value as Record<string, unknown>;
}

/** 0 以上の整数として読む。**読めなければ 0**（目安の値なので落とさない）。 */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
