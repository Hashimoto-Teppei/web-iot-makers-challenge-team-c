import { describe, expect, it } from "vitest";
import { register, registeredDetectors } from "../ride/detectors";
import { destination } from "../sim/node";
import { runRide } from "../sim/ride";
import { runDetectorInputs } from "../sim/run";
import { approachFromBehind, blindCorner, postFailureMidRide } from "../sim/scenarios";
import { type BlindCornerConfig, blindCornerDefaults, detectBlindCorner } from "./blind-corner";
import type { DetectorInput, Fix, Track } from "./types";

/** 岡山市付近の基準点（合成）。**実走行の GPS ログは使わない**（`CLAUDE.md`）。 */
const BASE = { lat: 34.6617, lon: 133.9344 };

/** 自分の時計の「いま」。固定値にしておかないと、失敗したテストを再現できない。 */
const NOW = Date.UTC(2026, 8, 1, 0, 0, 10);

const NORTH = 0;
const EAST = 90;
const SOUTH = 180;
const WEST = 270;

/** 自車から交差点までの距離（メートル）。**モックの土台。** */
const TO_CROSSING_M = 40;

/**
 * 相手の端末の時計が進んでいるぶん（ミリ秒）。
 *
 * **わざとずらしてある。**古さは `rxAt`（自分の時計）から測るもので、`t` と混ぜては
 * ならない（`docs/interfaces/detectors.md`）。ずらしておけば、混ぜた実装が落ちる。
 */
const PEER_CLOCK_SKEW_MS = 7_000;

/** 1台ぶんのモック。**この検知は最新の1点しか見ない**ので、履歴は1点でよい。 */
type Rider = {
  id: string;
  /** 居る場所 */
  lat: number;
  lon: number;
  /** 進行方角（度）。`null` は低速で向きが出ていない */
  crs: number | null;
  spd?: number;
  hacc?: number;
  /** `NOW` の何ミリ秒前に手にしたか */
  arrivedAgoMs?: number;
  /** 端末の時計のずれ（ミリ秒） */
  clockSkewMs?: number;
};

const track = (rider: Rider): Track => {
  const agoMs = rider.arrivedAgoMs ?? 0;
  const fix: Fix = {
    t: NOW - agoMs + (rider.clockSkewMs ?? 0),
    rxAt: NOW - agoMs,
    lat: rider.lat,
    lon: rider.lon,
    spd: rider.spd ?? 5,
    crs: rider.crs,
    hacc: rider.hacc ?? 4,
  };
  return { id: rider.id, fixes: [fix] };
};

/** 交差点。自車の真北 {@link TO_CROSSING_M} メートル。 */
const CROSSING = destination(BASE.lat, BASE.lon, NORTH, TO_CROSSING_M);

/**
 * 自車。北へ 5 m/s で走っている。
 *
 * @param toCrossingM 交差点までの距離（メートル）。既定は {@link TO_CROSSING_M}
 */
const self = (toCrossingM = TO_CROSSING_M, overrides: Partial<Rider> = {}): Track =>
  track({
    id: "a1000001",
    ...destination(CROSSING.lat, CROSSING.lon, SOUTH, toCrossingM),
    crs: NORTH,
    ...overrides,
  });

/**
 * 東の道から交差点へ向かってくる相手。西へ 5 m/s。
 *
 * **自車と同じ距離・同じ速度なら、交差点にほぼ同時に着く。**
 *
 * @param toCrossingM 交差点までの距離（メートル）。**負なら通り過ぎている**
 */
const fromEast = (toCrossingM = TO_CROSSING_M, overrides: Partial<Rider> = {}): Track =>
  track({
    id: "b2000002",
    ...destination(CROSSING.lat, CROSSING.lon, EAST, toCrossingM),
    crs: WEST,
    clockSkewMs: PEER_CLOCK_SKEW_MS,
    ...overrides,
  });

/** 相手ぶんの入力。標識は使わないので空。 */
const inputWith = (self_: Track, ...peers: readonly Track[]): DetectorInput => ({
  now: NOW,
  self: self_,
  peers,
  signs: [],
});

const run = (input: DetectorInput, config: Partial<BlindCornerConfig> = {}) =>
  detectBlindCorner(input, { ...blindCornerDefaults, ...config });

describe("detectBlindCorner", () => {
  it("横の道から交差点へ同時に着く相手で発火する", () => {
    const warn = run(inputWith(self(), fromEast()));

    expect(warn).not.toBeNull();
    expect(warn?.kind).toBe("corner");
    expect(warn?.causeId).toBe("b2000002");
  });

  it("交差点が遠ければ黙る", () => {
    // 両者とも 100m 手前（20 秒先）。**そこで鳴らしても「いつも鳴っているもの」になる。**
    expect(run(inputWith(self(100), fromEast(100)))).toBeNull();
  });

  it("着く時刻がずれていれば黙る（同じ交差点でも出会わない）", () => {
    // 自車は 8 秒で着くが、相手は 24 秒かかる。
    expect(run(inputWith(self(), fromEast(120)))).toBeNull();
  });

  it("並走・追走では黙る（#9 の領分）", () => {
    const sameWay = track({
      id: "b2000002",
      ...destination(BASE.lat, BASE.lon, NORTH, 30),
      crs: NORTH,
      clockSkewMs: PEER_CLOCK_SKEW_MS,
    });

    expect(run(inputWith(self(), sameWay))).toBeNull();
  });

  it("同じ道の対向車では黙る（互いに見えている）", () => {
    const headOn = track({
      id: "b2000002",
      ...destination(BASE.lat, BASE.lon, NORTH, 30),
      crs: SOUTH,
      clockSkewMs: PEER_CLOCK_SKEW_MS,
    });

    expect(run(inputWith(self(), headOn))).toBeNull();
  });

  it("正面に居る相手では黙る（見えているので曲がり角ではない）", () => {
    // 進路は交わるが、相手は自分のほぼ真正面（5 度）に居る。
    const inSight = track({
      id: "b2000002",
      ...destination(BASE.lat, BASE.lon, 5, 40),
      crs: 250,
      clockSkewMs: PEER_CLOCK_SKEW_MS,
    });

    expect(run(inputWith(self(), inSight))).toBeNull();
  });

  it("交差点を通り過ぎたあとは黙る", () => {
    // 相手は交差点の**西側**に居て、さらに西へ走っている。
    expect(run(inputWith(self(), fromEast(-40)))).toBeNull();
  });

  it("相手の向きが分からなければ黙る（進路を引けない）", () => {
    expect(run(inputWith(self(), fromEast(TO_CROSSING_M, { crs: null, spd: 0.5 })))).toBeNull();
  });

  it("自分が止まりかけているときは黙る", () => {
    expect(run(inputWith(self(TO_CROSSING_M, { spd: 0.5, crs: null }), fromEast()))).toBeNull();
  });

  it("交差点が近いほど段階が上がる", () => {
    // 自車 5 m/s。40m なら 8 秒、22m なら 4.4 秒、10m なら 2 秒。
    expect(run(inputWith(self(40), fromEast(40)))?.lv).toBe(1);
    expect(run(inputWith(self(22), fromEast(22)))?.lv).toBe(2);
    expect(run(inputWith(self(10), fromEast(10)))?.lv).toBe(3);
  });

  it("すぐそばの相手では黙る（もう角の向こうに居ない）", () => {
    // 距離が数メートルまで詰まると方角がゆらぎで振れ、正面かどうかを決められない。
    // そして**そこまで来た相手は見えている**——この検知の対象ではない。
    expect(run(inputWith(self(4), fromEast(4)))).toBeNull();
  });

  it("測位が古ければ黙る", () => {
    expect(run(inputWith(self(), fromEast(TO_CROSSING_M, { arrivedAgoMs: 8_000 })))).toBeNull();
  });

  it("測位が粗ければ黙る", () => {
    expect(run(inputWith(self(), fromEast()), { maxHaccM: 2 })).toBeNull();
  });

  it("近傍が空なら黙る（「相手が居ない」ではなく「分からない」）", () => {
    expect(run(inputWith(self()))).toBeNull();
  });

  it("複数台が該当したら、交差点が近い方を返す", () => {
    // 西の道から来る相手も同じ交差点へ向かうが、自車の交差点は1つなので
    // **段階が同じなら交点が近い方**を選ぶ。ここでは片方だけ段階が上がる形にする。
    const later = { ...fromEast(TO_CROSSING_M), id: "c3000003" };

    expect(run(inputWith(self(10), fromEast(10), later))?.causeId).toBe("b2000002");
  });
});

describe("detectBlindCorner（シミュレータ）", () => {
  /** シナリオを回し、ティックごとの警告を並べる。**測位が無い間は検知を呼ばない。** */
  const warningsOf = (frames: ReturnType<typeof runDetectorInputs>) =>
    frames.map(({ tick, input }) => ({
      elapsedMs: tick.elapsedMs,
      warn: input === null ? null : detectBlindCorner(input, blindCornerDefaults),
    }));

  it("直交する道から近づく対向車で発火する", () => {
    const fired = warningsOf(runDetectorInputs(blindCorner)).filter((w) => w.warn !== null);

    expect(fired.length).toBeGreaterThan(0);
    for (const { warn } of fired) {
      expect(warn?.kind).toBe("corner");
      expect(warn?.causeId).toBe("b2000002");
    }
  });

  it("交差点を通り過ぎたら止まる", () => {
    // 両者は 10 秒目に交差点へ届く。**そのあとは互いに離れていく。**
    const fired = warningsOf(runDetectorInputs(blindCorner)).filter((w) => w.warn !== null);
    const lastFiredMs = fired[fired.length - 1]?.elapsedMs ?? 0;

    expect(lastFiredMs).toBeLessThanOrEqual(10_000);
    expect(lastFiredMs).toBeLessThan(blindCorner.durationMs);
  });

  it("近づくほど段階が上がる（最後の警告が最初より強い）", () => {
    const fired = warningsOf(runDetectorInputs(blindCorner)).filter((w) => w.warn !== null);
    const first = fired[0]?.warn?.lv ?? 0;
    const last = fired[fired.length - 1]?.warn?.lv ?? 0;

    expect(last).toBeGreaterThan(first);
  });

  it("同じ向きに走るだけの相手では鳴らない（#9 の領分）", () => {
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
    for (const input of blind) expect(detectBlindCorner(input, blindCornerDefaults)).toBeNull();
  });
});

describe("detectBlindCorner（走行ループ）", () => {
  it("登録口に並んでいる", () => {
    // **並べ忘れると、実装があってもアプリの中では1行も実行されない**
    // （`apps/mobile/src/ride/detectors.ts`）。**動くのに黙る**形の故障なので、
    // 気づけるのはここだけである。
    expect(registeredDetectors.map((d) => d.name)).toContain("corner");
  });

  it("デバイスの出口に warn が届く", async () => {
    // **実機・BLE・サーバーなしで、測位から `alert` への書き込みまでを通す**（#64）。
    const frames = await runRide(blindCorner, {
      detectors: [register("corner", detectBlindCorner, blindCornerDefaults)],
    });
    const warns = frames.flatMap((frame) => frame.warns);

    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]).toMatchObject({ k: "warn", kind: "corner" });
  });
});
