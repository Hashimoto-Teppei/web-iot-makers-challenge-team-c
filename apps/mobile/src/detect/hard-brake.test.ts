import { describe, expect, it } from "vitest";
import { register, registeredDetectors } from "../ride/detectors";
import { destination } from "../sim/node";
import { runRide } from "../sim/ride";
import { runDetectorInputs } from "../sim/run";
import { approachFromBehind, hardBrakeAhead, postFailureMidRide } from "../sim/scenarios";
import { detectHardBrake, type HardBrakeConfig, hardBrakeDefaults } from "./hard-brake";
import type { DetectorInput, Fix, Track } from "./types";

/** 岡山市付近の基準点（合成）。**実走行の GPS ログは使わない**（`CLAUDE.md`）。 */
const BASE = { lat: 34.6617, lon: 133.9344 };

/** 自分の時計の「いま」。固定値にしておかないと、失敗したテストを再現できない。 */
const NOW = Date.UTC(2026, 8, 1, 0, 0, 10);

/** 自車から指定の方角へ `m` メートル離れた地点。 */
const away = (bearingDeg: number, m: number): { lat: number; lon: number } =>
  destination(BASE.lat, BASE.lon, bearingDeg, m);

/**
 * 相手の端末の時計が進んでいるぶん（ミリ秒）。
 *
 * **わざとずらしてある。**減速度は `t` の差から出すもので（`docs/interfaces/detectors.md`）、
 * `rxAt` から出してはならない。ずらしておけば、うっかり `rxAt` を見た実装が落ちる。
 */
const PEER_CLOCK_SKEW_MS = 7_000;

/** モックの1点。 */
type Point = {
  /** `NOW` の何ミリ秒前に**測位した**か */
  agoMs: number;
  /** `NOW` の何ミリ秒前に**手にした**か。省略すると `agoMs` と同じ */
  arrivedAgoMs?: number;
  spd: number;
  crs?: number | null;
  hacc?: number;
};

/**
 * モックの `Track` を組み立てる。位置は全点で同じ（この検知は距離の変化を見ない）。
 *
 * @param bearingDeg 自車から見てどの方角に居るか
 * @param awayM 自車から何メートル離れているか
 */
const track = (
  id: string,
  bearingDeg: number,
  awayM: number,
  points: readonly Point[],
  clockSkewMs = 0,
): Track => {
  const { lat, lon } = away(bearingDeg, awayM);
  const fixes: Fix[] = points.map((p) => ({
    t: NOW - p.agoMs + clockSkewMs,
    rxAt: NOW - (p.arrivedAgoMs ?? p.agoMs),
    lat,
    lon,
    spd: p.spd,
    crs: p.crs === undefined ? 0 : p.crs,
    hacc: p.hacc ?? 4,
  }));
  const [first, ...rest] = fixes;
  if (first === undefined) throw new Error("fixes を空にしない");
  return { id, fixes: [first, ...rest] };
};

/** 自車。原点に居て、北へ 5 m/s で走り続けている。 */
const self = (overrides: Partial<Point> = {}): Track =>
  track(
    "a1000001",
    0,
    0,
    [3_000, 2_000, 1_000, 0].map((agoMs) => ({ agoMs, spd: 5, ...overrides })),
  );

/**
 * 前方 25m を走っていた相手が、直前の1秒で 5 m/s から 1 m/s へ落ちる（4 m/s²）。
 *
 * **止まりきったところで `crs` が `null` になる形**も別のテストで確かめる。
 */
const brakingAhead = (
  bearingDeg = 0,
  awayM = 25,
  points: readonly Point[] = [
    { agoMs: 3_000, spd: 5 },
    { agoMs: 2_000, spd: 5 },
    { agoMs: 1_000, spd: 5 },
    { agoMs: 0, spd: 1 },
  ],
): Track => track("b2000002", bearingDeg, awayM, points, PEER_CLOCK_SKEW_MS);

/** 相手ぶんの入力。標識は使わないので空。 */
const inputWith = (self_: Track, ...peers: readonly Track[]): DetectorInput => ({
  now: NOW,
  self: self_,
  peers,
  signs: [],
});

const run = (input: DetectorInput, config: Partial<HardBrakeConfig> = {}) =>
  detectHardBrake(input, { ...hardBrakeDefaults, ...config });

describe("detectHardBrake", () => {
  it("前方の相手が急ブレーキをかけたら発火する", () => {
    const warn = run(inputWith(self(), brakingAhead()));

    expect(warn).not.toBeNull();
    expect(warn?.kind).toBe("brake");
    expect(warn?.causeId).toBe("b2000002");
  });

  it("減速がしきい値に届かなければ黙る", () => {
    // 3 秒かけて 5 → 2 m/s（1 m/s²）。信号の手前で普通に止まりに行く形。
    const gentle = brakingAhead(0, 25, [
      { agoMs: 3_000, spd: 5 },
      { agoMs: 2_000, spd: 4 },
      { agoMs: 1_000, spd: 3 },
      { agoMs: 0, spd: 2 },
    ]);

    expect(run(inputWith(self(), gentle))).toBeNull();
  });

  it("速度の落ち幅が小さいゆらぎでは黙る", () => {
    // 1 秒で 5 → 3.5 m/s。**減速度は 1.5 m/s² でしきい値未満**だが、
    // 窓を狭めれば超えてしまう類のもの。落ち幅の足切りが効いていることを見る。
    const jitter = brakingAhead(0, 25, [
      { agoMs: 2_000, spd: 5 },
      { agoMs: 1_000, spd: 5 },
      { agoMs: 0, spd: 3.5 },
    ]);

    expect(run(inputWith(self(), jitter), { decelMps2: 1.0 })).toBeNull();
  });

  it("後方の相手のブレーキでは黙る（追突しようがない）", () => {
    expect(run(inputWith(self(), brakingAhead(180, 25)))).toBeNull();
  });

  it("対向車のブレーキでは黙る", () => {
    // 前方 25m に居るが、南へ走っている（自分は北へ）。
    const oncoming = brakingAhead(0, 25, [
      { agoMs: 3_000, spd: 5, crs: 180 },
      { agoMs: 2_000, spd: 5, crs: 180 },
      { agoMs: 1_000, spd: 5, crs: 180 },
      { agoMs: 0, spd: 1, crs: 180 },
    ]);

    expect(run(inputWith(self(), oncoming))).toBeNull();
  });

  it("止まりきって向きが分からなくなった相手も拾う", () => {
    // **急ブレーキの終着点がこれ。**`crs` が `null` だからと捨てると、
    // 一番危ない相手が静かに落ちる（`docs/interfaces/detectors.md`）。
    const stopped = brakingAhead(0, 25, [
      { agoMs: 3_000, spd: 5, crs: 0 },
      { agoMs: 2_000, spd: 5, crs: 0 },
      { agoMs: 1_000, spd: 5, crs: 0 },
      { agoMs: 0, spd: 0, crs: null },
    ]);

    expect(run(inputWith(self(), stopped))?.kind).toBe("brake");
  });

  it("遠すぎる相手では黙る", () => {
    expect(run(inputWith(self(), brakingAhead(0, 120)))).toBeNull();
  });

  it("詰まっているほど段階が上がる", () => {
    // 自車 5 m/s。50m 先なら 10 秒、15m 先なら 3 秒、9m 先なら 1.8 秒の猶予。
    const far = run(inputWith(self(), brakingAhead(0, 50)))?.lv ?? 0;
    const mid = run(inputWith(self(), brakingAhead(0, 15)))?.lv ?? 0;
    const near = run(inputWith(self(), brakingAhead(0, 9)))?.lv ?? 0;

    expect(far).toBe(1);
    expect(mid).toBe(2);
    expect(near).toBe(3);
  });

  it("交差する道でブレーキした相手では黙る", () => {
    // 前方 30m に居るが、東へ走っている（自分は北へ）。**交差点を曲がりながら
    // 減速する車がこれ**で、追突の危険にはならない。
    const crossing = brakingAhead(0, 30, [
      { agoMs: 3_000, spd: 5, crs: 90 },
      { agoMs: 2_000, spd: 5, crs: 90 },
      { agoMs: 1_000, spd: 5, crs: 90 },
      { agoMs: 0, spd: 1, crs: 90 },
    ]);

    expect(run(inputWith(self(), crossing))).toBeNull();
  });

  it("すぐそばの相手では黙る（方角が信じられない）", () => {
    // **真横に並んで走る相手が信号で止まった形。**測位が数メートル振れると
    // 「前方」に入り込み、猶予が短いぶん一番大きな警告で鳴ってしまう。
    // ここまで詰まった相手は急接近（#9）が距離の変化で見ている。
    expect(run(inputWith(self(), brakingAhead(90, 3)))).toBeNull();
  });

  it("自分が止まりかけているときは黙る", () => {
    expect(run(inputWith(self({ spd: 0.5, crs: null }), brakingAhead()))).toBeNull();
  });

  it("測位が古ければ黙る", () => {
    const stale = brakingAhead(0, 25, [
      { agoMs: 8_000, arrivedAgoMs: 8_000, spd: 5 },
      { agoMs: 5_000, arrivedAgoMs: 5_000, spd: 1 },
    ]);

    expect(run(inputWith(self(), stale))).toBeNull();
  });

  it("測位が粗ければ黙る", () => {
    expect(run(inputWith(self(), brakingAhead(0, 25)), { maxHaccM: 2 })).toBeNull();
  });

  it("近傍が空なら黙る（「相手が居ない」ではなく「分からない」）", () => {
    expect(run(inputWith(self()))).toBeNull();
  });

  it("到着が固まっても減速度が膨らまない", () => {
    // **3 秒ぶんの変化が 1 秒の間にまとめて届いた形。**`rxAt` の差で割る実装だと
    // 減速度が 3 倍に膨れ、**起きていない急ブレーキ**で鳴る。
    const bunched = brakingAhead(0, 25, [
      { agoMs: 3_000, arrivedAgoMs: 1_000, spd: 5 },
      { agoMs: 0, arrivedAgoMs: 0, spd: 2 },
    ]);

    expect(run(inputWith(self(), bunched))).toBeNull();
  });

  it("止まったままの時間が長くても、窓の中のブレーキを見逃さない", () => {
    // 窓の両端だけを見る実装だと、**止まっている区間が平均に混ざって減速度が薄まる。**
    const stoppedAWhile = brakingAhead(0, 25, [
      { agoMs: 3_000, spd: 5 },
      { agoMs: 2_000, spd: 0, crs: null },
      { agoMs: 1_000, spd: 0, crs: null },
      { agoMs: 0, spd: 0, crs: null },
    ]);

    expect(run(inputWith(self(), stoppedAWhile))?.kind).toBe("brake");
  });

  it("複数台が該当したら、段階が高い方を返す", () => {
    const far = brakingAhead(0, 50);
    const near = { ...brakingAhead(10, 10), id: "c3000003" };

    expect(run(inputWith(self(), far, near))?.causeId).toBe("c3000003");
  });
});

describe("detectHardBrake（シミュレータ）", () => {
  /** シナリオを回し、ティックごとの警告を並べる。**測位が無い間は検知を呼ばない。** */
  const warningsOf = (frames: ReturnType<typeof runDetectorInputs>) =>
    frames.map(({ tick, input }) => ({
      elapsedMs: tick.elapsedMs,
      warn: input === null ? null : detectHardBrake(input, hardBrakeDefaults),
    }));

  it("前の自転車が 1.5 秒で止まると発火する", () => {
    const fired = warningsOf(runDetectorInputs(hardBrakeAhead)).filter((w) => w.warn !== null);

    expect(fired.length).toBeGreaterThan(0);
    for (const { warn } of fired) {
      expect(warn?.kind).toBe("brake");
      expect(warn?.causeId).toBe("b2000002");
    }
  });

  it("ブレーキが窓から出たら止まる", () => {
    // 相手は 6.5 秒目に止まりきり、そのあとは動かない。**止まっていることは
    // 急ブレーキではない**ので、窓（既定 3 秒）を過ぎれば黙る。
    const fired = warningsOf(runDetectorInputs(hardBrakeAhead)).filter((w) => w.warn !== null);
    const lastFiredMs = fired[fired.length - 1]?.elapsedMs ?? 0;

    expect(lastFiredMs).toBeLessThanOrEqual(6_500 + hardBrakeDefaults.sampleWindowMs);
    expect(lastFiredMs).toBeLessThan(hardBrakeAhead.durationMs);
  });

  it("詰まるほど段階が上がる（最後の警告が最初より強い）", () => {
    const fired = warningsOf(runDetectorInputs(hardBrakeAhead)).filter((w) => w.warn !== null);
    const first = fired[0]?.warn?.lv ?? 0;
    const last = fired[fired.length - 1]?.warn?.lv ?? 0;

    expect(last).toBeGreaterThan(first);
  });

  it("後ろから詰めてくるだけの相手では鳴らない（#9 の領分）", () => {
    const fired = warningsOf(runDetectorInputs(approachFromBehind)).filter((w) => w.warn !== null);

    expect(fired).toEqual([]);
  });

  it("POST が失敗して近傍が失効したあとは黙る", () => {
    // 近傍が空なのは「相手が居ない」ではなく**「分からない」**であって、
    // 警告を出す根拠にならない（`docs/interfaces/detectors.md`）。
    const blind = runDetectorInputs(postFailureMidRide).flatMap(({ input }) =>
      input !== null && input.peers.length === 0 ? [input] : [],
    );

    expect(blind.length).toBeGreaterThan(0);
    for (const input of blind) expect(detectHardBrake(input, hardBrakeDefaults)).toBeNull();
  });
});

describe("detectHardBrake（走行ループ）", () => {
  it("登録口に並んでいる", () => {
    // **並べ忘れると、実装があってもアプリの中では1行も実行されない**
    // （`apps/mobile/src/ride/detectors.ts`）。**動くのに黙る**形の故障なので、
    // 気づけるのはここだけである。
    expect(registeredDetectors.map((d) => d.name)).toContain("brake");
  });

  it("デバイスの出口に warn が届く", async () => {
    // **実機・BLE・サーバーなしで、測位から `alert` への書き込みまでを通す**（#64）。
    const frames = await runRide(hardBrakeAhead, {
      detectors: [register("brake", detectHardBrake, hardBrakeDefaults)],
    });
    const warns = frames.flatMap((frame) => frame.warns);

    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toMatchObject({ k: "warn", kind: "brake" });
  });
});
