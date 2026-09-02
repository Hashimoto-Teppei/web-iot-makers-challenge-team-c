import { describe, expect, it } from "vitest";
import type { SignsMeta } from "../signs/store";
import type { RideStatus } from "./loop";
import {
  canStartRide,
  POST_FAILURE_ALERT,
  type PreRideCheckKey,
  type PreRideInput,
  preRideChecks,
} from "./pre-ride";

const meta: SignsMeta = { pref: 33, version: "v1", count: 28_651, builtAt: "2026-09-01T00:00:00Z" };

/** そろっている状態（走行前）。**各テストは1つだけ壊す。** */
const ready: PreRideInput = {
  deviceId: "a1000001",
  deviceIsMock: false,
  deviceReason: null,
  deviceChecking: false,
  deviceLink: "up",
  locationReason: null,
  locationChecking: false,
  signsMeta: meta,
  serverReason: null,
  serverChecking: false,
  relayBlockedReason: null,
  status: null,
};

const riding: RideStatus = {
  deviceId: "a1000001",
  fix: "ok",
  lastFixAt: 1,
  peers: 0,
  postFailures: 0,
  lastPostOkAt: 1,
  detectorErrors: 0,
};

function check(input: PreRideInput, key: PreRideCheckKey) {
  const found = preRideChecks(input).find((c) => c.key === key);
  if (found === undefined) throw new Error(`${key} が無い`);
  return found;
}

describe("preRideChecks", () => {
  it("4項目が決まった順で返る", () => {
    expect(preRideChecks(ready).map((c) => c.key)).toEqual(["device", "fix", "signs", "server"]);
  });

  it("そろっていれば走行を始められる", () => {
    expect(canStartRide(preRideChecks(ready))).toBe(true);
  });

  // **1つでも緑でなければ始めない。**押せてしまうと、静かに黙ったまま走ることになる。
  it("1つでも赤なら走行を始められない", () => {
    expect(canStartRide(preRideChecks({ ...ready, deviceId: null }))).toBe(false);
  });

  it("確かめている最中も走行を始められない", () => {
    expect(canStartRide(preRideChecks({ ...ready, locationChecking: true }))).toBe(false);
  });

  it("デバイスが切れていれば赤になり、理由が出る", () => {
    const device = check({ ...ready, deviceId: null }, "device");
    expect(device.state).toBe("ng");
    expect(device.detail).not.toBe("");
  });

  // **探している最中を赤にしない。**スキャンには数秒かかるので、赤で始めると
  // **最初に見る赤が偽物**になり、本物の赤も読み飛ばされるようになる。
  it("デバイスを探している最中は、赤でも緑でもない", () => {
    const device = check({ ...ready, deviceId: null, deviceChecking: true }, "device");
    expect(device.state).toBe("checking");
  });

  // **直し方が違うものを同じ文にしない**（`CLAUDE.md`「開発が初めてのメンバーが多い」）。
  it("つながらない理由が分かっていれば、その理由を出す", () => {
    const device = check(
      { ...ready, deviceId: null, deviceReason: "MTU が 64 しかありません" },
      "device",
    );
    expect(device).toMatchObject({ state: "ng", detail: "MTU が 64 しかありません" });
  });

  // **こちらは接続できているのに、デバイスには届いていない状態。**
  // 緑にすると、**警告が1つも出ないまま走り出せる**（`docs/interfaces/v2v.md`）。
  it("走行中にデバイスが心拍を受け取れていなければ赤になる", () => {
    expect(check({ ...ready, status: riding, deviceLink: "down" }, "device").state).toBe("ng");
  });

  // **走り出す前の `down` は正常。**心拍は走行を始めてから出る（`./loop.ts`）ので、
  // ここで赤くすると**つながっているのに永久に走り始められない。**
  it("走り出す前の down では赤にしない", () => {
    expect(check({ ...ready, deviceLink: "down" }, "device").state).toBe("ok");
  });

  // **測位が無いのは「届いていない」ではない。**`nofix` は心拍が届いている証拠であり、
  // 測位そのものは「測位」の行が見ている。ここで二重に赤くしない。
  it("デバイスが nofix と言っていても、デバイスの行は緑のまま", () => {
    expect(check({ ...ready, deviceLink: "nofix" }, "device").state).toBe("ok");
  });

  // **BLE を通っていないことを画面が「接続しています」と言い切らない。**
  it("モック接続であることを隠さない", () => {
    const device = check({ ...ready, deviceIsMock: true }, "device");
    expect(device.state).toBe("ok");
    expect(device.detail).toContain("モック");
  });

  // **「持っていない」と「0 件」で直し方が違う**ので、同じ文にしない。
  it("標識を持っていないときと 0 件のときで、赤の理由が違う", () => {
    const none = check({ ...ready, signsMeta: null }, "signs");
    const empty = check({ ...ready, signsMeta: { ...meta, count: 0 } }, "signs");
    expect(none.state).toBe("ng");
    expect(empty.state).toBe("ng");
    expect(none.detail).not.toBe(empty.detail);
  });

  it("走行前の測位は、権限が下りていれば緑になる", () => {
    expect(check(ready, "fix").state).toBe("ok");
    expect(
      check({ ...ready, locationReason: "「正確な位置」を許可してください" }, "fix"),
    ).toMatchObject({ state: "ng", detail: "「正確な位置」を許可してください" });
  });

  // **走行中は実測に切り替わる。**権限があっても屋内では測位が出ない。
  it("走行中の測位は status を見る", () => {
    expect(check({ ...ready, status: { ...riding, fix: "nofix" } }, "fix").state).toBe("ng");
    expect(check({ ...ready, status: riding }, "fix").state).toBe("ok");
  });

  // **モックのままだと、`/api/health` には届くのに中継は1通も飛ばない**
  // （`../lib/mock-guard.ts`）。**疎通の緑で塗り潰すと、既定のビルドが4つ緑で走り出す。**
  it("中継が塞がれていれば、疎通が取れていてもサーバーは赤になる", () => {
    const blocked = { ...ready, relayBlockedReason: "モックのデバイスのままです" };
    expect(check(blocked, "server")).toMatchObject({
      state: "ng",
      detail: "モックのデバイスのままです",
    });
    expect(canStartRide(preRideChecks(blocked))).toBe(false);
  });

  // **最初に見る赤が偽物だと、本物の赤も読み飛ばされる。**
  it("走り出した直後の測位待ちは赤にせず、一度取れたあとの nofix は赤にする", () => {
    const warmingUp = { ...riding, fix: "nofix" as const, lastFixAt: null };
    const lost = { ...riding, fix: "nofix" as const, lastFixAt: 1 };
    expect(check({ ...ready, status: warmingUp }, "fix").state).toBe("checking");
    expect(check({ ...ready, status: lost }, "fix").state).toBe("ng");
  });

  // **モックであることを隠さない**（隠すと「動いているつもり」を画面が作る）。
  it("モックのデバイスは、緑でもそうと分かる形で出る", () => {
    const mock = check({ ...ready, deviceIsMock: true }, "device");
    expect(mock.state).toBe("ok");
    expect(mock.detail).not.toBe(check(ready, "device").detail);
  });

  it("走行前のサーバーは、疎通の結果を見る", () => {
    expect(check(ready, "server").state).toBe("ok");
    expect(check({ ...ready, serverChecking: true }, "server").state).toBe("checking");
    expect(check({ ...ready, serverReason: "圏外" }, "server").state).toBe("ng");
  });

  // **1回の失敗では赤にしない。**1Hz で投げているので1通落ちるのは日常的に起きる。
  it("走行中のサーバーは、中継が続けて失敗したときだけ赤になる", () => {
    const once = { ...riding, postFailures: 1 };
    const many = { ...riding, postFailures: POST_FAILURE_ALERT };
    expect(check({ ...ready, status: once }, "server").state).toBe("ok");
    expect(check({ ...ready, status: many }, "server").state).toBe("ng");
  });
});
