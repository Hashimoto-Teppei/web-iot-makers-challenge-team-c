import { describe, expect, it } from "vitest";
import { inPermissionQueue } from "./permission-queue";

/** `resolve` を外から呼べる Promise。**重なりを作るために要る。** */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("inPermissionQueue", () => {
  it("前の要求が終わるまで次を始めない", async () => {
    const first = deferred<string>();
    const order: string[] = [];

    const a = inPermissionQueue(() => {
      order.push("a:start");
      return first.promise;
    });
    const b = inPermissionQueue(async () => {
      order.push("b:start");
      return "b";
    });

    // **a が終わるまで b は始まっていないこと。**ここが崩れると、
    // ダイアログが重なって片方が固まる。
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(order).toEqual(["a:start", "b:start"]);
  });

  it("前の要求が失敗しても、次は実行される", async () => {
    const failing = inPermissionQueue(() => Promise.reject(new Error("だめ")));
    await expect(failing).rejects.toThrow("だめ");
    // **止まらないこと。**止まると、1回の失敗で以後すべての権限が確かめられなくなる。
    await expect(inPermissionQueue(async () => "次")).resolves.toBe("次");
  });

  it("失敗はそのまま呼び出し側へ返る", async () => {
    // **握りつぶさない。**握りつぶすと、権限が下りなかったことが画面に出ない。
    await expect(inPermissionQueue(() => Promise.reject(new Error("×")))).rejects.toThrow("×");
  });
});
