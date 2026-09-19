/**
 * デバイスとの口（BLE）を、走行ループから見た形で1つに絞ったもの。
 *
 * **ここに BLE の実装を書かない。**走行ループ（`./loop.ts`）が知ってよいのは
 * 「名乗る `device_id`」と「`alert` に1通書く」の2つだけで、スキャン・MTU・
 * サービス探索・再接続は `../ble/link.ts` にある。
 * **検知ログの回収（#40）もここには無い**——口だけを {@link DeviceLink.collectLogs} に置く。
 * 分けてあるおかげで、**実機も Development Build も無いまま走行ループを Vitest で回せる**
 * （`docs/adr/0002-development-lifecycle.md`）。
 *
 * **実装に差し替えても `./loop.ts` は変わらない**——変わるなら、この境界の切り方が
 * 間違っている。{@link MockDeviceLink} は開発機と、BLE のネイティブモジュールが
 * 無い環境（Web）でだけ使う（`./use-device-link.ts`）。
 */

import type { DeviceDetection } from "../ble/log-transfer";
import type { AlertMessage } from "../v2v/alert";

/**
 * 検知ログを1回ぶん回収した結果（#40）。
 *
 * **`done` が `true` のときだけ「取り切った」と言える**——完了の印は EOT だけで、
 * 件数でも `status` でも判定しない（`docs/interfaces/ble-log-transfer.md`「転送の約束」）。
 */
export type CollectOutcome = {
  /** 受け取ったレコードの数（取り込みは呼び出し側が済ませている） */
  received: number;
  /** EOT まで届いたか。**途中で終わっていれば、次につないだときに続きから取り直す** */
  done: boolean;
  /** うまくいかなかった理由。**画面に出す**（黙って0件にしない） */
  reason: string | null;
};

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
   * デバイスが持つログの世代（#40。`device-info` の `log_id`）。
   *
   * **走行の `log_id` とは別物。**既読位置はこれとの組で覚えるので、
   * **変わったら全件を取り直す**（`docs/interfaces/ble-log-transfer.md`）。
   */
  logId: string;
  /**
   * `alert` に1通書く。
   *
   * **返り値を待たない（`void`）。**呼ぶ側は書けたかを知らないし、知る必要もない。
   *
   * - **書けなかった1通を溜めない。**警告は古くなれば無価値で、**遅れて出る警告は
   *   出ないより悪い**（もう通り過ぎた危険で光る。`docs/interfaces/mobile-api.md`）
   * - **例外を投げない。**実装の中で握りつぶす。投げると、書けなかった1回で
   *   **心拍のタイマーごと止まりうる**
   * - **再送しない。**心拍は次の1秒後に、警告は次の測位で作り直される
   */
  writeAlert: (message: AlertMessage) => void;
  /**
   * 検知ログを回収する（#40）。**走行を終えたあとに1回だけ呼ぶ。**
   *
   * **走行中に呼ばない。**`alert` と同じ接続を使うので、**警告の書き込みと競る。**
   *
   * @param since ここまでは取り込み済み（0 なら全件）。
   *   **呼び出し側が保存しているもの**を渡す（`../log/store.ts` の `deviceLogSince`）
   * @param onRecords 届いたぶんを渡す先。**届いた端から取り込む**——
   *   途中で切れても、そこまでは残る（既読位置もそこまで進む）
   */
  collectLogs: (
    since: number,
    onRecords: (records: readonly DeviceDetection[]) => void,
  ) => Promise<CollectOutcome>;
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
 * 「デバイスを使わない」で走る端末が名乗る ID（#185。`./standalone.ts`）。
 *
 * **{@link MOCK_DEVICE_ID} とは別の値にする。**あちらは `../lib/mock-guard.ts` が
 * 共有のデプロイ先に対して塞ぐので、名乗ると中継が止まり、**この設定の目的そのものが
 * 果たせない。**同じ理由で **`MOCK_DEVICE_IDS` に足さない**（`./standalone.test.ts`）。
 *
 * **固定値である。**毎回作ると、**近傍に毎回別の自転車が現れる。**
 * 裏を返すと、**同時に2台がこのモードで走ると同じ ID を名乗る**ので、
 * 1台までにすること（設定画面が出している）。
 *
 * **ここに置いてあるのは、`./standalone.ts` が `expo-sqlite` を読むため。**
 * あちらから import すると、Vitest がこの値を見るだけで落ちる。
 */
export const STANDALONE_DEVICE_ID = "a1000003";

/**
 * @param deviceId 名乗る端末ID。既定は合成した値（実在の機器の ID ではない）
 */
export function createMockDeviceLink(deviceId = MOCK_DEVICE_ID): MockDeviceLink {
  const written: AlertMessage[] = [];
  return {
    deviceId,
    // **合成した値**（実在のログの世代ではない）。モックは検知ログを持たない。
    logId: "a0000001",
    written,
    writeAlert: (message) => {
      written.push(message);
    },
    // **0件で「取り切った」を返す。**モックにはデバイスが無いので、**回収するものが無いのが
    // 正しい結果**である（失敗として画面を赤くしない。モックであることは点検に出ている）。
    collectLogs: () => Promise.resolve({ received: 0, done: true, reason: null }),
    warns: () => written.filter((m) => m.k === "warn"),
    clear: () => {
      written.length = 0;
    },
  };
}
