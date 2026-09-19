/**
 * 検知ログの回収（`control` に書いて、`log` から受け取る）。#40
 *
 * **正本は `docs/interfaces/ble-log-transfer.md`。**ここはその実装であって、決め直す場所ではない。
 * 送る側（デバイス）の実装は `apps/device/src/device/transfer.py` で、**Python は
 * TypeScript のスキーマを参照できない**ので、変えるときは両方とドキュメントを揃えること。
 *
 * **react-native-ble-plx を知らない。**購読と書き込みは `./link.ts` にあり、ここは
 * 「受け取ったバイト列をどう切るか」だけを持つ。分けてあるので**実機も Development Build も
 * 無いまま Vitest で回せる**（`docs/adr/0002-development-lifecycle.md`）。
 */

import { base64ToBytes, bytesToUtf8 } from "./base64";

/** 転送の終わりを表す1バイト（EOT）。**完了の印はこれだけ。** */
const EOT = 0x04;
/** JSON Lines の区切り。 */
const NEWLINE = 0x0a;

/**
 * デバイスから回収した検知1件。
 *
 * **`kind` は `rear_object` だけ。**デバイスの中で起きる検知はこれしかなく
 * （`docs/interfaces/detectors.md`）、**取り込み側もこの値しか受け取らない**
 * （`web/src/worker/logs/request.ts`。**1件混ざるとリクエストが丸ごと 400 になる**）。
 */
export type DeviceDetection = {
  seq: number;
  t: number;
  /** `t` が単調時計からの推定なら `true`。**取り込み側は実測と同じ確からしさで扱わない** */
  tEst: boolean;
  kind: "rear_object";
  lv: 1 | 2 | 3;
};

/** `control` に書く「ここから先をくれ」。`since` が 0 なら持っているぶん全部。 */
export function readCommand(since: number): string {
  return JSON.stringify(since > 0 ? { cmd: "read", since } : { cmd: "read" });
}

/** `control` に書く「やめてくれ」。**EOT は来ない**（それが中断の印）。 */
export function stopCommand(): string {
  return JSON.stringify({ cmd: "stop" });
}

/** {@link LogStreamReader.push} が1回ぶんで返すもの。 */
export type LogChunkResult = {
  /** 切り出せたレコード（古い順） */
  records: DeviceDetection[];
  /** EOT が来たか。**転送が終わったと言えるのはこれが `true` のときだけ** */
  done: boolean;
  /** 読めずに捨てた行の数。**0 でないことを人に見せる**（黙って減らさない） */
  skipped: number;
};

/**
 * `log` から届くバイト列を組み立てて、レコードに切り出す。
 *
 * **Notify 1パケットとレコードの境界は一致しない**（`docs/interfaces/ble-log-transfer.md`）。
 * 1レコードが数パケットに分かれるのは正常なので、**受け取ったバイトを溜めて `\n` で切る。**
 *
 * **バイトのまま溜める。**塊の切れ目は多バイト文字の途中に来うるので、
 * **パケットごとに文字へ直すと化ける**（`./base64.ts` の `bytesToUtf8`）。
 */
export class LogStreamReader {
  private buffer: Uint8Array = new Uint8Array(0);

  /**
   * 受信バッファを空にする。**`read` を書くたびに呼ぶ。**
   *
   * **前の転送が途中で切れていると、`\n` で終わっていない断片が残る**
   * ——そのままだと**先頭の1レコードが壊れた JSON になる**
   * （`docs/interfaces/ble-gatt.md`「接続してから転送するまで」）。
   */
  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  /** Notify で届いた1塊（Base64）を足して、切り出せたぶんを返す。 */
  push(base64: string): LogChunkResult {
    const incoming = base64ToBytes(base64);
    const merged = new Uint8Array(this.buffer.length + incoming.length);
    merged.set(this.buffer);
    merged.set(incoming, this.buffer.length);

    const records: DeviceDetection[] = [];
    let skipped = 0;
    let done = false;
    let start = 0;
    for (let i = 0; i < merged.length; i += 1) {
      const byte = merged[i];
      if (byte === NEWLINE) {
        const record = parseRecord(bytesToUtf8(merged.subarray(start, i)));
        if (record === null) skipped += 1;
        else records.push(record);
        start = i + 1;
        continue;
      }
      if (byte !== EOT) continue;
      // **EOT はレコードの外側にある**（最後の `\n` の直後）。**パケットの区切りで
      // 判断しない**——最後のレコードと同じ Notify に相乗りして届くので、
      // **バイトの並びとして拾う**（`docs/interfaces/ble-log-transfer.md`「`log`」）。
      // 手前に溜まっているのは行として完成していない断片なので、ここで捨てる。
      done = true;
      start = i + 1;
    }

    this.buffer = merged.slice(start);
    return { records, done, skipped };
  }
}

/**
 * 1行を1レコードにする。**読めなければ `null`**（その行だけ捨てる）。
 *
 * **落とさない。**1行の壊れで転送ごと捨てると、**取れるはずの検知まで失う**
 * ——飛びは `seq` で分かるので、受け取った側で扱える
 * （`docs/interfaces/ble-log-transfer.md`「転送の約束」の 5）。
 */
function parseRecord(line: string): DeviceDetection | null {
  if (line.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  // **知らない `type` は捨てる**（増える可能性があるので項目そのものは残っている）。
  if (envelope.type !== "detect") return null;
  if (!isSeq(envelope.seq) || !Number.isInteger(envelope.t)) return null;

  const body = envelope.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const detail = body as Record<string, unknown>;
  // **知らない `kind` も捨てる。**取り込み側が受け取るのは `rear_object` だけで、
  // **1件混ざるとリクエストが丸ごと 400 になる**（上の {@link DeviceDetection}）。
  if (detail.kind !== "rear_object" || !isLevel(detail.lv)) return null;

  return {
    seq: envelope.seq,
    t: envelope.t as number,
    // **無ければ実測。**`t_est` は `true` のときだけ入る。
    tEst: envelope.t_est === true,
    kind: "rear_object",
    lv: detail.lv,
  };
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isLevel(value: unknown): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

/**
 * 読めない行があったことを人に見せる文言。
 *
 * **黙って減らさない。**既読位置は**読めた行の `seq`** まで進むので、
 * **壊れて捨てた1行はデバイスから二度と送られてこない**（`./link.ts`）。
 * 転送そのものは成功しているため、**ここで出さないと、欠けたことは誰にも見えない。**
 */
export function skippedRecordsReason(skipped: number): string {
  return (
    `検知ログの ${skipped} 行を読めませんでした（その行は失われます）。` +
    "続きの取り込みは進んでいます。"
  );
}

/** 転送が終わらなかった理由。**人に見せる**（黙って0件で終えない）。 */
export function transferTimeoutReason(received: number): string {
  return (
    `検知ログの転送が終わりませんでした（${received} 件まで受け取り）。` +
    "つなぎ直すと、続きから取り直します。"
  );
}
