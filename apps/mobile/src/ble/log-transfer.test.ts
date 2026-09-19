/**
 * 検知ログの切り出しのテスト。**実機も BLE も要らない**
 * （`docs/adr/0002-development-lifecycle.md`）。
 *
 * **確かめるのは「守らないと片方の実装が壊れること」**
 * （`docs/interfaces/ble-log-transfer.md`「転送の約束」）。
 */

import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "./base64";
import { LogStreamReader, readCommand, stopCommand } from "./log-transfer";

/** 文字列を Notify の1塊（Base64）にする。 */
function chunk(text: string): string {
  const bytes = [...text].flatMap((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x80 ? [code] : [...new TextEncoder().encode(character)];
  });
  return bytesToBase64(Uint8Array.from(bytes));
}

/** 生のバイト列を1塊にする（EOT を混ぜるため）。 */
function rawChunk(bytes: number[]): string {
  return bytesToBase64(Uint8Array.from(bytes));
}

const RECORD = '{"seq":1,"type":"detect","t":1756123456789,"body":{"kind":"rear_object","lv":2}}';
const EOT = 0x04;

describe("readCommand / stopCommand", () => {
  it("since が 0 なら省く（持っているぶん全部）", () => {
    expect(readCommand(0)).toBe('{"cmd":"read"}');
    expect(readCommand(12)).toBe('{"cmd":"read","since":12}');
    expect(stopCommand()).toBe('{"cmd":"stop"}');
  });
});

describe("LogStreamReader", () => {
  it("1行1レコードで切り出す", () => {
    const reader = new LogStreamReader();

    const result = reader.push(chunk(`${RECORD}\n`));

    expect(result.records).toEqual([
      { seq: 1, t: 1756123456789, tEst: false, kind: "rear_object", lv: 2 },
    ]);
    expect(result.done).toBe(false);
  });

  it("レコードが数パケットに分かれても組み立てる", () => {
    // Notify 1パケットとレコードの境界は一致しない（docs/interfaces/ble-log-transfer.md）。
    const reader = new LogStreamReader();
    const line = `${RECORD}\n`;

    const first = reader.push(chunk(line.slice(0, 20)));
    const second = reader.push(chunk(line.slice(20)));

    expect(first.records).toEqual([]);
    expect(second.records).toHaveLength(1);
  });

  it("EOT が最後のレコードと同じ塊で届いても完了を拾う", () => {
    // パケットの区切りで判断しない（EOT は相乗りして届く）。
    const reader = new LogStreamReader();
    const bytes = [...new TextEncoder().encode(`${RECORD}\n`), EOT];

    const result = reader.push(rawChunk([...bytes]));

    expect(result.records).toHaveLength(1);
    expect(result.done).toBe(true);
  });

  it("0件でも EOT だけで完了になる", () => {
    // 送るものが無いことと、途中で止まったことを区別する。
    const reader = new LogStreamReader();

    expect(reader.push(rawChunk([EOT]))).toEqual({ records: [], done: true, skipped: 0 });
  });

  it("t_est が立っていれば推定として受け取る", () => {
    const reader = new LogStreamReader();
    const line =
      '{"seq":9,"type":"detect","t":5,"t_est":true,"body":{"kind":"rear_object","lv":3}}';

    const [record] = reader.push(chunk(`${line}\n`)).records;

    expect(record?.tEst).toBe(true);
  });

  it("読めない行はその行だけ捨てる", () => {
    // 1行の壊れで転送ごと捨てると、取れるはずの検知まで失う。
    const reader = new LogStreamReader();

    const result = reader.push(chunk(`{壊れている\n${RECORD}\n`));

    expect(result.records).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it("知らない kind は捨てる（取り込みが丸ごと 400 になるため）", () => {
    const reader = new LogStreamReader();
    const line = '{"seq":2,"type":"detect","t":5,"body":{"kind":"approach","lv":1}}';

    const result = reader.push(chunk(`${line}\n`));

    expect(result.records).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("多バイト文字が塊の切れ目に来ても化けない", () => {
    // 塊ごとに文字へ直すと、UTF-8 の途中で切れて壊れる（./base64.ts）。
    const reader = new LogStreamReader();
    const line = '{"seq":3,"type":"detect","t":5,"body":{"kind":"rear_object","lv":1,"memo":"あ"}}';
    const bytes = new TextEncoder().encode(`${line}\n`);
    const cut = bytes.length - 4; // 「あ」の3バイトの途中で切る

    reader.push(rawChunk([...bytes.slice(0, cut)]));
    const result = reader.push(rawChunk([...bytes.slice(cut)]));

    expect(result.records).toHaveLength(1);
  });

  it("reset で前の転送の断片を捨てる", () => {
    // `\n` で終わっていない断片が残ると、次の先頭が壊れた JSON になる。
    const reader = new LogStreamReader();
    reader.push(chunk('{"seq":1,"type":"det'));

    reader.reset();
    const result = reader.push(chunk(`${RECORD}\n`));

    expect(result.records).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });

  it("EOT のあとに来たものは次の転送として扱う", () => {
    // 他人の転送の EOT を読んでも、こちらの受信が壊れないこと。
    const reader = new LogStreamReader();
    const bytes = [EOT, ...new TextEncoder().encode(`${RECORD}\n`)];

    const result = reader.push(rawChunk(bytes));

    expect(result.done).toBe(true);
    expect(result.records).toHaveLength(1);
  });
});
