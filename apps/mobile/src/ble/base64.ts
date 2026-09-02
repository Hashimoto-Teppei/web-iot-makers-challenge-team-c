/**
 * UTF-8 文字列と Base64 の相互変換。
 *
 * **react-native-ble-plx は Characteristic の値を Base64 の文字列で受け渡す**ので、
 * `alert` に書く JSON も `device-info` から読む JSON も、必ずここを通る。
 *
 * **自前で持つのは、Hermes に `btoa` / `atob` が無いため。** Node にはあるので
 * 開発機では動いてしまい、**実機だけが `ReferenceError` で落ちる**——落ちる場所が
 * BLE の中なので、**警告の出口ごと黙る**（`docs/interfaces/ble-gatt.md`）。
 * `Buffer` も同じ理由で使わない（React Native には無い）。
 *
 * **React Native も BLE も知らない**ので、開発機の Vitest でそのまま回せる
 * （`docs/adr/0002-development-lifecycle.md`）。
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 の1文字 → 6bit。`=` と未知の文字は -1。 */
const REVERSE = new Map<string, number>(
  [...ALPHABET].map((character, index) => [character, index]),
);

/** UTF-8 のバイト列を Base64 にする。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    // 3バイト（24bit）を 4文字（6bit × 4）にする。端数はパディングで埋める。
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(triple >> 18) & 0x3f];
    out += ALPHABET[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 0x3f] : "=";
    out += i + 2 < bytes.length ? ALPHABET[triple & 0x3f] : "=";
  }
  return out;
}

/** Base64 を UTF-8 のバイト列に戻す。**Base64 として読めない文字は無視する。** */
export function base64ToBytes(text: string): Uint8Array {
  const out: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of text) {
    const value = REVERSE.get(character);
    if (value === undefined) continue; // `=`・改行・空白
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * 文字列を UTF-8 で Base64 にする。
 *
 * **`TextEncoder` を使わない。**Hermes には無い（`TextEncoder` は RN 0.74 以降の
 * 一部構成にしかない）。`encodeURIComponent` は Hermes にもある。
 */
export function utf8ToBase64(text: string): string {
  return bytesToBase64(utf8Bytes(text));
}

/** UTF-8 の Base64 を文字列に戻す。**壊れたバイト列でも投げない**（置換文字になる）。 */
export function base64ToUtf8(text: string): string {
  return utf8String(base64ToBytes(text));
}

function utf8Bytes(text: string): Uint8Array {
  // `encodeURIComponent` は ASCII 以外を `%XX` に変える。**UTF-8 のバイト列そのもの**なので、
  // それを1バイトずつ戻せばエンコーダを自前で書かずに済む。
  const escaped = encodeURIComponent(text);
  const out: number[] = [];
  for (let i = 0; i < escaped.length; i += 1) {
    if (escaped[i] === "%") {
      out.push(Number.parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(escaped.charCodeAt(i));
    }
  }
  return Uint8Array.from(out);
}

function utf8String(bytes: Uint8Array): string {
  let escaped = "";
  for (const byte of bytes) {
    escaped += `%${byte.toString(16).padStart(2, "0")}`;
  }
  try {
    return decodeURIComponent(escaped);
  } catch {
    // **壊れたバイト列で投げさせない。**投げると、1通の化けで BLE の受信が止まる。
    return "";
  }
}
