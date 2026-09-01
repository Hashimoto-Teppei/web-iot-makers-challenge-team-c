import { describe, expect, it, vi } from "vitest";
import type { DetectorInput, Warning } from "../detect/types";
import type { PeerMessage, SelfMessage } from "../v2v/messages";
import type { RegisteredDetector } from "./detectors";
import { createMockDeviceLink } from "./device";
import { type RideDeps, RideLoop } from "./loop";

/** 岡山市付近の基準点（合成）。実走行の GPS ログは使わない（`CLAUDE.md`）。 */
const BASE = { lat: 34.6617, lon: 133.9344 };
const START = Date.UTC(2026, 8, 1, 0, 0, 0);

const fix = (t: number, spd = 5): SelfMessage => ({
  k: "self",
  t,
  ...BASE,
  spd,
  crs: 0,
  hacc: 4,
});

const peer = (t: number): PeerMessage => ({
  k: "peer",
  id: "b2000002",
  t,
  ...BASE,
  spd: 5,
  crs: 0,
  hacc: 4,
});

/** 常に同じ警告を返す検知。**登録口を通す**ので、ループ側は本物と区別しない。 */
const always = (warning: Warning, name = "fake"): RegisteredDetector => ({
  name,
  run: () => warning,
});

/** 時計を手で進められるループを作る。 */
function setup(over: Partial<RideDeps> = {}) {
  const device = createMockDeviceLink("a1000001");
  let now = START;
  const deps: RideDeps = {
    device,
    exchange: async () => [],
    detectors: [],
    now: () => now,
    ...over,
  };
  const loop = new RideLoop(deps);
  return {
    device,
    loop,
    at: (t: number) => {
      now = t;
    },
  };
}

describe("RideLoop の心拍", () => {
  it("測位も POST も無しに書ける（黙るとデバイスが「アプリが落ちた」と表示する）", () => {
    const { loop, device } = setup();
    loop.beat();
    expect(device.written).toEqual([{ k: "beat", t: START, st: "nofix", mv: true }]);
  });

  it("測位が無い間は `mv` を走行中に倒す（止まっているかは測位が無いと分からない）", () => {
    const { loop, device } = setup();
    loop.beat();
    expect(device.written[0]).toMatchObject({ st: "nofix", mv: true });
  });

  it('測位を取り込むと `st: "ok"` になり、`mv` は速度で決まる', async () => {
    const { loop, device, at } = setup();
    await loop.onFix(fix(START, 5));
    device.clear();
    loop.beat();
    expect(device.written[0]).toMatchObject({ st: "ok", mv: true });

    at(START + 500);
    await loop.onFix(fix(START + 500, 0.2));
    device.clear();
    loop.beat();
    expect(device.written[0]).toMatchObject({ st: "ok", mv: false });
  });

  it("測位が古くなると `nofix` に戻る（一度立ったら戻らない旗にしない）", async () => {
    const { loop, device, at } = setup();
    await loop.onFix(fix(START));

    at(START + 10_000);
    device.clear();
    loop.beat();
    expect(device.written[0]).toMatchObject({ st: "nofix" });
  });

  it('POST が失敗し続けても `st: "ok"` のまま書き続ける', async () => {
    const failing = vi.fn(async () => {
      throw new Error("network");
    });
    const { loop, device, at } = setup({ exchange: failing });

    for (let i = 0; i < 3; i += 1) {
      at(START + i * 1_000);
      await loop.onFix(fix(START + i * 1_000));
      device.clear();
      loop.beat();
      // サーバーに届かなくても自車の測位は生きている。止めると
      // 「スマホは動いているのに落ちたことになる」。
      expect(device.written[0]).toMatchObject({ k: "beat", st: "ok" });
    }
    expect(loop.status().postFailures).toBe(3);
  });

  it("`startHeartbeat()` は起動直後と間隔ごとに書き、止められる", () => {
    vi.useFakeTimers();
    try {
      const { loop, device } = setup();
      const stop = loop.startHeartbeat(1_000);
      expect(device.written).toHaveLength(1);

      vi.advanceTimersByTime(2_000);
      expect(device.written).toHaveLength(3);

      stop();
      vi.advanceTimersByTime(5_000);
      expect(device.written).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RideLoop の中継", () => {
  it("受け取った `peer` を近傍に入れる", async () => {
    const { loop } = setup({ exchange: async () => [peer(START)] });
    await loop.onFix(fix(START));
    expect(loop.status().peers).toBe(1);
    expect(loop.status().postFailures).toBe(0);
  });

  it("名乗る `id` は接続中のデバイスの `device_id`（スマホ側で作らない）", async () => {
    const exchange = vi.fn(async () => []);
    const { loop } = setup({ exchange });
    await loop.onFix(fix(START));
    expect(exchange).toHaveBeenCalledWith("a1000001", fix(START));
  });

  it("失敗しても投げ返さず、検知へ進む", async () => {
    const warning: Warning = { kind: "stop", lv: 1, causeId: "sign-1" };
    const { loop, device } = setup({
      exchange: async () => {
        throw new Error("network");
      },
      detectors: [always(warning)],
    });

    await expect(loop.onFix(fix(START))).resolves.toBeUndefined();
    // 近傍が空でも、標識を見る検知（#27）は動き続ける。
    expect(device.warns()).toEqual([{ k: "warn", kind: "stop", lv: 1 }]);
  });

  it("失敗しても再送しない（次の測位が1秒後に来る）", async () => {
    const exchange = vi.fn(async () => {
      throw new Error("network");
    });
    const { loop } = setup({ exchange });
    await loop.onFix(fix(START));
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("前の POST が返る前に測位が来ても重ねて投げない", async () => {
    let release: () => void = () => undefined;
    const returned = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exchange = vi.fn(async () => {
      await returned;
      return [];
    });
    const { loop, at } = setup({ exchange });

    const first = loop.onFix(fix(START));
    at(START + 1_000);
    // 待っている間の測位でも検知は回る（自車の測位は生きている）ので、
    // 投げないだけで処理は進む。
    await loop.onFix(fix(START + 1_000));
    expect(exchange).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it("取り込めなかった測位は送らない（古い位置を他人の近傍へ配らない）", async () => {
    const exchange = vi.fn(async () => []);
    const { loop, at } = setup({ exchange });
    await loop.onFix(fix(START));

    at(START + 1_000);
    // `t` が進んでいない（測位が固まっている）ので取り込まれない。
    await loop.onFix(fix(START));
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

describe("RideLoop の検知", () => {
  it("登録された検知を全部回し、発火したものを全部書く（スマホ側で絞らない）", async () => {
    const { loop, device } = setup({
      detectors: [
        always({ kind: "stop", lv: 1, causeId: "sign-1" }, "stop"),
        always({ kind: "approach", lv: 3, causeId: "b2000002" }, "approach"),
      ],
    });
    await loop.onFix(fix(START));

    // `lv` の高い順に書く（詰まったときに重要なものが先に届く）。
    expect(device.warns()).toEqual([
      { k: "warn", kind: "approach", lv: 3 },
      { k: "warn", kind: "stop", lv: 1 },
    ]);
  });

  it("走行ログに残すのは、実際にデバイスへ書いた警告だけ（#73）", async () => {
    // **発火したものを全部記録すると、危険が続く間ずっと毎秒1件増える**——
    // 1回の危険が数十件になり、集計の件数が「そこで何秒詰まったか」になる。
    const onWarn = vi.fn();
    const { loop, at } = setup({
      detectors: [always({ kind: "approach", lv: 2, causeId: "b2000002" })],
      onWarn,
    });
    await loop.onFix(fix(START));
    at(START + 1_000);
    await loop.onFix(fix(START + 1_000));

    expect(onWarn.mock.calls).toEqual([[{ kind: "approach", lv: 2, causeId: "b2000002" }, START]]);
  });

  it("同じ警告を毎周期書き直さない", async () => {
    const { loop, device, at } = setup({
      detectors: [always({ kind: "approach", lv: 2, causeId: "b2000002" })],
    });
    await loop.onFix(fix(START));
    at(START + 1_000);
    await loop.onFix(fix(START + 1_000));

    expect(device.warns()).toHaveLength(1);
  });

  it("測位が無い間は検知を1つも呼ばない", async () => {
    const run = vi.fn(() => null);
    const { loop } = setup({ detectors: [{ name: "fake", run }] });
    loop.beat();
    expect(run).not.toHaveBeenCalled();
  });

  it("検知が例外を投げても、他の検知と心拍は動く", async () => {
    const throwing: RegisteredDetector = {
      name: "broken",
      run: () => {
        throw new Error("検知の不具合");
      },
    };
    const { loop, device } = setup({
      detectors: [throwing, always({ kind: "approach", lv: 2, causeId: "b2000002" })],
    });

    await loop.onFix(fix(START));
    expect(device.warns()).toEqual([{ k: "warn", kind: "approach", lv: 2 }]);
    // 握りつぶしたことが表に出ないと、静かに効かなくなる。
    expect(loop.status().detectorErrors).toBe(1);
  });

  it("検知には自車と近傍だけが渡る（HTTP も BLE も渡さない）", async () => {
    let seen: DetectorInput | null = null;
    const { loop } = setup({
      exchange: async () => [peer(START)],
      detectors: [
        {
          name: "spy",
          run: (input) => {
            seen = input;
            return null;
          },
        },
      ],
    });
    await loop.onFix(fix(START));

    expect(seen).not.toBeNull();
    expect(Object.keys(seen as unknown as object).sort()).toEqual([
      "now",
      "peers",
      "self",
      "signs",
    ]);
  });
});

describe("RideLoop の状態", () => {
  it("連続して失敗している回数を出す（画面に出すため）", async () => {
    let fails = true;
    const { loop, at } = setup({
      exchange: async () => {
        if (fails) throw new Error("network");
        return [];
      },
    });

    await loop.onFix(fix(START));
    at(START + 1_000);
    await loop.onFix(fix(START + 1_000));
    expect(loop.status().postFailures).toBe(2);

    fails = false;
    at(START + 2_000);
    await loop.onFix(fix(START + 2_000));
    expect(loop.status().postFailures).toBe(0);
    expect(loop.status().lastPostOkAt).toBe(START + 2_000);
  });

  it("測位が途切れている間も、心拍のたびに状態が流れる", async () => {
    const onStatus = vi.fn();
    const { loop, at } = setup({ onStatus });
    await loop.onFix(fix(START));
    onStatus.mockClear();

    // 測位が完全に止まると `onFix` は二度と呼ばれない。ここで流さないと、画面は
    // 「測位: 取れている」を出したまま固まる（`beat` は `nofix` を書いているのに）。
    at(START + 10_000);
    loop.beat();
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ fix: "nofix" }));
  });

  it("状態が変わったら購読者に渡す", async () => {
    const onStatus = vi.fn();
    const { loop } = setup({ onStatus });
    await loop.onFix(fix(START));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ fix: "ok", peers: 0 }));
  });
});
