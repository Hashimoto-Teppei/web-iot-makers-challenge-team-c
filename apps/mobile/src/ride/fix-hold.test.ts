/**
 * 測位の更新が来ない間の保持（`./fix-hold.ts`）のテスト。
 *
 * **実機も測位も要らない。**時間は擬似タイマーで進める（`./idle-heartbeat.test.ts` と同じ形）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelfMessage } from "../v2v/messages";
import { fixHoldDefaults, heldFrom, startFixHold } from "./fix-hold";

/** 岡山市付近の基準点（合成）。実走行の GPS ログは使わない（`AGENTS.md`）。 */
const START = Date.UTC(2026, 8, 1, 0, 0, 0);

const fix = (t: number): SelfMessage => ({
  k: "self",
  t,
  lat: 34.6617,
  lon: 133.9344,
  spd: 5,
  crs: 90,
  hacc: 4,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("直近の測位を「いまの測位」にする", () => {
  // **`t` を進めないと、受信側も送り主自身も「同じか古い `t`」として捨てる**
  // （`docs/adr/0011-stationary-fix-hold.md` 決定 2）。
  it("`t` を届かなくなってからのぶん進め、`spd` を 0、`crs` を null にする", () => {
    const held = heldFrom(fix(START), 5_000);
    expect(held).toEqual({ ...fix(START), t: START + 5_000, spd: 0, crs: null });
  });

  // **止まっている自転車が「その向きに走っている」ことになるのを避ける。**
  it("位置と精度は動かさない", () => {
    const held = heldFrom(fix(START), 1_000);
    expect(held?.lat).toBe(fix(START).lat);
    expect(held?.hacc).toBe(fix(START).hacc);
  });

  // **上限は「分からない」を表明させるための線**（決定 3）。
  it("上限を過ぎたら null（黙る）", () => {
    const { maxHoldMs } = fixHoldDefaults;
    expect(heldFrom(fix(START), maxHoldMs)).not.toBeNull();
    expect(heldFrom(fix(START), maxHoldMs + 1)).toBeNull();
  });
});

describe("埋め続けるタイマー", () => {
  it("本物が来ない間、毎秒1通を埋める", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const delivered: SelfMessage[] = [];
    const hold = startFixHold((f) => delivered.push(f));

    hold.keep(fix(START));
    vi.advanceTimersByTime(5_000);
    // **1秒ずつ進んでいること。**同じ `t` を2通送ると片方が捨てられる。
    // 最初の1通が 2 秒後なのは、**本物を先に通すための余裕**（`STALE_MS`）。
    expect(delivered.map((f) => f.t)).toEqual([
      START + 2_000,
      START + 3_000,
      START + 4_000,
      START + 5_000,
    ]);

    hold.stop();
    vi.advanceTimersByTime(5_000);
    expect(delivered).toHaveLength(4);
  });

  // **本物が 1Hz で来ているとき（Android や屋外の iOS）は、何も足さない。**
  // 割り込むと、**埋めた点より古い `t` の本物が `acceptSelf` に捨てられる。**
  it("本物が 1Hz で来ている間は埋めない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const delivered: SelfMessage[] = [];
    const hold = startFixHold((f) => delivered.push(f));

    for (let i = 0; i < 10; i += 1) {
      hold.keep(fix(START + i * 1_000));
      vi.advanceTimersByTime(1_000);
    }
    expect(delivered).toHaveLength(0);

    hold.stop();
  });

  // **測位は測った時刻より遅れて届く。**遅れのぶんを「古さ」に数えると、
  // **1Hz で届いていても毎周期で埋めが割り込み、本物が捨てられ続ける**
  // （レビューで再現。数えるのは届いてからの時間である）。
  it("届くのが遅れていても、1Hz で来ている間は埋めない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const delivered: SelfMessage[] = [];
    const hold = startFixHold((f) => delivered.push(f));

    // 400ms 遅れて届く測位が、毎秒1通。
    for (let i = 0; i < 10; i += 1) {
      vi.setSystemTime(START + i * 1_000 + 400);
      hold.keep(fix(START + i * 1_000));
      vi.advanceTimersByTime(1_000);
    }
    expect(delivered).toHaveLength(0);

    hold.stop();
  });

  // **埋めた `t` は測位と同じ時間軸に乗せる**（時計の「いま」ではない）。
  // 時計の「いま」を入れると**届くまでの遅れのぶんだけ未来に出て、
  // 飛んでいる最中の本物を追い越す**——その本物は `t <= last.t` で捨てられる。
  it("埋めた `t` に、届くまでの遅れを混ぜない", () => {
    vi.useFakeTimers();
    // 400ms 遅れて届いた測位。
    vi.setSystemTime(START + 400);
    const delivered: SelfMessage[] = [];
    const hold = startFixHold((f) => delivered.push(f));

    hold.keep(fix(START));
    vi.advanceTimersByTime(2_000);
    expect(delivered).toHaveLength(1);
    // 時計は START + 2_400。**遅れのぶんを足さない。**
    expect(delivered[0]?.t).toBe(START + 2_000);

    hold.stop();
  });

  // **まとめて届いた測位の並びが前後することがある**（`./location.ts` の `data.locations`）。
  // 巻き戻ると、そのぶん「古い」ことになって埋めが割り込む。
  it("`t` が巻き戻る測位を受け取らない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const delivered: SelfMessage[] = [];
    const hold = startFixHold((f) => delivered.push(f));

    hold.keep(fix(START + 5_000));
    hold.keep(fix(START));
    vi.advanceTimersByTime(2_000);
    // 埋める元は新しい方のまま。
    expect(delivered[0]?.t).toBe(START + 5_000 + 2_000);

    hold.stop();
  });

  // **一度も測位が取れていない走行で、埋める元は無い。**
  it("測位を1通も受け取っていなければ何も出さない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const delivered: SelfMessage[] = [];
    const hold = startFixHold((f) => delivered.push(f));

    vi.advanceTimersByTime(10_000);
    expect(delivered).toHaveLength(0);

    hold.stop();
  });

  // **上限を過ぎたら止まったままにする**（決定 3。過ぎたあとは失効に任せる）。
  it("上限を過ぎたら、そのあとは1通も出さない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const delivered: SelfMessage[] = [];
    const hold = startFixHold((f) => delivered.push(f), { maxHoldMs: 3_000 });

    hold.keep(fix(START));
    vi.advanceTimersByTime(20_000);
    expect(delivered.map((f) => f.t)).toEqual([START + 2_000, START + 3_000]);

    hold.stop();
  });

  // **本物が戻れば埋めも戻る**（測位が生き返った走行を、上限で見捨てない）。
  it("上限を過ぎたあとでも、本物が来れば埋め直す", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const delivered: SelfMessage[] = [];
    const hold = startFixHold((f) => delivered.push(f), { maxHoldMs: 3_000 });

    hold.keep(fix(START));
    vi.advanceTimersByTime(20_000);
    const before = delivered.length;

    hold.keep(fix(START + 20_000));
    vi.advanceTimersByTime(2_000);
    expect(delivered).toHaveLength(before + 1);
    expect(delivered.at(-1)?.t).toBe(START + 22_000);

    hold.stop();
  });
});
