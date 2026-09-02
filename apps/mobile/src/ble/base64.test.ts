import { describe, expect, it } from "vitest";
import { base64ToUtf8, utf8ToBase64 } from "./base64";

describe("utf8ToBase64", () => {
  it("ASCII の JSON を Base64 にする", () => {
    // **`alert` に毎秒書くのはこの形**（`docs/interfaces/v2v.md`）。
    const text = '{"k":"beat","t":1756123456789,"st":"ok","mv":false}';
    expect(utf8ToBase64(text)).toBe(
      // Node の Buffer で作った期待値（実装とは別の経路で出したもの）
      "eyJrIjoiYmVhdCIsInQiOjE3NTYxMjM0NTY3ODksInN0Ijoib2siLCJtdiI6ZmFsc2V9",
    );
  });

  it("長さが 3 の倍数でなくてもパディングする", () => {
    expect(utf8ToBase64("a")).toBe("YQ==");
    expect(utf8ToBase64("ab")).toBe("YWI=");
    expect(utf8ToBase64("abc")).toBe("YWJj");
  });

  it("空文字は空文字になる", () => {
    expect(utf8ToBase64("")).toBe("");
  });

  it("非 ASCII を UTF-8 のバイト列として扱う", () => {
    // **`status` の `last_error` に日本語が入りうる。**ここで壊れると、
    // 断られた理由が読めないまま人が原因を探すことになる。
    expect(base64ToUtf8(utf8ToBase64("エラー"))).toBe("エラー");
  });
});

describe("base64ToUtf8", () => {
  it("往復して元に戻る", () => {
    const text = '{"proto":2,"device_id":"c3f1a20b","log_id":"9a1c0000"}';
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
  });

  it("改行が混ざっていても読める", () => {
    expect(base64ToUtf8("YWJj\n")).toBe("abc");
  });

  it("UTF-8 として壊れていても投げない", () => {
    // **1通の化けで BLE の受信を止めない**（`./base64.ts`）。
    expect(base64ToUtf8("////")).toBe("");
  });
});
