import { describe, expect, it } from "vitest";
import { destination } from "../sim/node";
import { runDetectorInputs } from "../sim/run";
import { approachFromBehind, peerGoesSilent, postFailureMidRide } from "../sim/scenarios";
import { type ApproachConfig, approachDefaults, detectApproach } from "./approach";
import type { DetectorInput, Fix, Track } from "./types";

/** 岡山市付近の基準点（合成）。**実走行の GPS ログは使わない**（`CLAUDE.md`）。 */
const BASE = { lat: 34.6617, lon: 133.9344 };

/** 自分の時計の「いま」。固定値にしておかないと、失敗したテストを再現できない。 */
const NOW = Date.UTC(2026, 8, 1, 0, 0, 10);

/** 自車から真北へ `m` メートル離れた地点。**距離だけを変えたモックを作るための道具。** */
const northOf = (m: number): { lat: number; lon: number } => destination(BASE.lat, BASE.lon, 0, m);

/** モックの1点。 */
type Point = {
  /** `NOW` の何ミリ秒前に**測位した**か（相手の端末の時計で打たれる `t`） */
  agoMs: number;
  /**
   * `NOW` の何ミリ秒前に**手にした**か（自分の時計で打つ `rxAt`）。省略すると `agoMs` と同じ。
   *
   * **測位した時刻とずらせるようにしてある。**実際には相手の位置は POST の応答で
   * 遅れて届き、自車の測位とは揃わない。揃った入力しか作らないと、
   * **ずれたときにだけ壊れる実装をテストが素通しする。**
   */
  arrivedAgoMs?: number;
  /** 自車から真北へ何メートルの位置に居るか */
  northM: number;
  spd?: number;
  crs?: number | null;
  hacc?: number;
};

/**
 * モックの `Track` を組み立てる。
 *
 * **`t` を `rxAt` からわざとずらせるようにしてある。**`t` は相手の端末の時計で打たれた値で、
 * この検知は使ってはならない（`docs/interfaces/detectors.md`）。ずらしておけば、
 * うっかり `t` を見た実装がテストで落ちる。
 */
const track = (id: string, points: readonly Point[], clockSkewMs = 0): Track => {
  const fixes: Fix[] = points.map((p) => {
    const { lat, lon } = northOf(p.northM);
    return {
      t: NOW - p.agoMs + clockSkewMs,
      rxAt: NOW - (p.arrivedAgoMs ?? p.agoMs),
      lat,
      lon,
      spd: p.spd ?? 5,
      crs: p.crs === undefined ? 0 : p.crs,
      hacc: p.hacc ?? 4,
    };
  });
  const [first, ...rest] = fixes;
  if (first === undefined) throw new Error("fixes を空にしない");
  return { id, fixes: [first, ...rest] };
};

/**
 * 自車。原点に居て、北へ 4 m/s で走っている。
 *
 * **その場から動かさない。**この検知が見るのは2台の距離だけなので、距離を変える役は
 * 相手に持たせた方がテストの意図が読みやすい（自分が突っ込む形も、相手が近づく形と
 * 同じ入力になる）。**自車が動く形は下の {@link northbound} で別に確かめる。**
 */
const self = (): Track =>
  track(
    "a1000001",
    [4_000, 3_000, 2_000, 1_000, 0].map((agoMs) => ({ agoMs, northM: 0, spd: 4 })),
  );

/** 相手ぶんの入力。標識は使わないので空。 */
const inputWith = (...peers: readonly Track[]): DetectorInput => ({
  now: NOW,
  self: self(),
  peers,
  signs: [],
});

/**
 * 北へ一定速度で走り続ける1台。**位置は測位した時刻から決まり、届いた時刻では決まらない。**
 *
 * @param northAtNowM `NOW` の時点で自車から真北へ何メートルに居るか
 * @param samples 測位した時刻と、それを手にした時刻（`NOW` の何ミリ秒前か）
 */
const northbound = (
  id: string,
  speedMps: number,
  northAtNowM: number,
  samples: readonly { agoMs: number; arrivedAgoMs?: number }[],
): Track =>
  track(
    id,
    samples.map((s) => ({
      agoMs: s.agoMs,
      arrivedAgoMs: s.arrivedAgoMs,
      // 過去にさかのぼるほど手前に居る。
      northM: northAtNowM - (speedMps * s.agoMs) / 1_000,
      spd: speedMps,
    })),
  );

/**
 * 2 秒で `fromM` から `toM` まで距離が変わる相手。
 *
 * 既定の `sampleWindowMs` が 2 秒なので、この2点がそのまま判定に使われる。
 */
const movingPeer = (fromM: number, toM: number, overrides: Partial<Point> = {}): Track =>
  track("b2000002", [
    { agoMs: 2_000, northM: fromM, ...overrides },
    { agoMs: 0, northM: toM, ...overrides },
  ]);

describe("detectApproach（モックデータ）", () => {
  it("警告する距離まで詰まり、5 m/s で近づいてくる相手に警告を出す", () => {
    const warn = detectApproach(inputWith(movingPeer(58, 48)), approachDefaults);

    expect(warn).not.toBeNull();
    expect(warn?.kind).toBe("approach");
    // 48m を 5 m/s で詰めるので届くまで 9.6 秒。まだ余裕がある。
    expect(warn?.lv).toBe(1);
    expect(warn?.causeId).toBe("b2000002");
  });

  it("同じ接近速度でも、距離が近いほど段階が上がる", () => {
    const lv2 = detectApproach(inputWith(movingPeer(40, 30)), approachDefaults);
    const lv3 = detectApproach(inputWith(movingPeer(22, 12)), approachDefaults);

    expect(lv2?.lv).toBe(2);
    expect(lv3?.lv).toBe(3);
  });

  it("止まっている自転車へ自分が突っ込む形も拾う（相手の crs が null）", () => {
    // 低速の相手は `crs` が `null` になる。**捨てると検知が静かに効かなくなる**
    // （`docs/interfaces/detectors.md`）。距離が縮むのは自分が走っているから。
    const stopped = track("b2000002", [
      { agoMs: 2_000, northM: 30, spd: 0, crs: null },
      { agoMs: 0, northM: 20, spd: 0, crs: null },
    ]);

    expect(detectApproach(inputWith(stopped), approachDefaults)?.lv).toBe(2);
  });

  it("相手の時計がずれていても結果が変わらない（t を見ていない）", () => {
    const skewed = track(
      "b2000002",
      [
        { agoMs: 2_000, northM: 22 },
        { agoMs: 0, northM: 12 },
      ],
      // 相手の時計が 30 秒進んでいる。`t` を「いま」と引き算する実装ならここで壊れる。
      30_000,
    );

    expect(detectApproach(inputWith(skewed), approachDefaults)).toEqual(
      detectApproach(inputWith(movingPeer(22, 12)), approachDefaults),
    );
  });

  describe("警告を出さない場合", () => {
    it("近傍が空のとき（POST が失敗している）", () => {
      // **これは「周りは安全」ではない。**分からないことを人に伝えるのは
      // 心拍と `link` の仕組みであって、検知ではない。
      expect(detectApproach(inputWith(), approachDefaults)).toBeNull();
    });

    it("離れていく相手", () => {
      expect(detectApproach(inputWith(movingPeer(20, 30)), approachDefaults)).toBeNull();
    });

    it("すぐ近くを並走している相手", () => {
      expect(detectApproach(inputWith(movingPeer(15, 15)), approachDefaults)).toBeNull();
    });

    it("速く近づいているが、まだ遠い相手", () => {
      // 2 秒で 10m 詰めているが、まだ 60m 先。
      expect(detectApproach(inputWith(movingPeer(70, 60)), approachDefaults)).toBeNull();
    });

    it("測位が粗くて距離を信じられない相手", () => {
      const noisy = movingPeer(22, 12, { hacc: 40 });
      expect(detectApproach(inputWith(noisy), approachDefaults)).toBeNull();
    });

    it("しばらく届いていない相手", () => {
      // 失効の手前で近傍に残っていても、古い位置で警告を出さない。
      const stale = track("b2000002", [
        { agoMs: 6_000, northM: 22 },
        { agoMs: 4_000, northM: 12 },
      ]);
      expect(detectApproach(inputWith(stale), approachDefaults)).toBeNull();
    });

    it("履歴が1点しか無い相手（走り出した直後）", () => {
      const fresh = track("b2000002", [{ agoMs: 0, northM: 12 }]);
      expect(detectApproach(inputWith(fresh), approachDefaults)).toBeNull();
    });

    it("2点の間隔が短すぎる相手", () => {
      const bunched = track("b2000002", [
        { agoMs: 300, northM: 13 },
        { agoMs: 0, northM: 12 },
      ]);
      expect(detectApproach(inputWith(bunched), approachDefaults)).toBeNull();
    });
  });

  describe("複数の相手が該当したとき", () => {
    /** 12m 先に居て、5 m/s で詰まっている相手。 */
    const near = track("c3000003", [
      { agoMs: 2_000, northM: 22 },
      { agoMs: 0, northM: 12 },
    ]);
    /** 50m 先に居て、同じ 5 m/s で詰まっている相手。 */
    const far = track("d4000004", [
      { agoMs: 2_000, northM: 60 },
      { agoMs: 0, northM: 50 },
    ]);

    it("lv が高い方を1つだけ返す", () => {
      const warn = detectApproach(inputWith(far, near), approachDefaults);
      expect(warn?.lv).toBe(3);
      expect(warn?.causeId).toBe("c3000003");
    });

    it("lv が同じなら近い方を返す", () => {
      const nearer = track("e5000005", [
        { agoMs: 2_000, northM: 18 },
        { agoMs: 0, northM: 8 },
      ]);
      const warn = detectApproach(inputWith(near, nearer), approachDefaults);
      expect(warn?.lv).toBe(3);
      expect(warn?.causeId).toBe("e5000005");
    });
  });

  describe("しきい値は設定から注入される", () => {
    it("接近速度のしきい値を上げると、同じ入力で黙る", () => {
      const strict: ApproachConfig = { ...approachDefaults, closingSpeedMps: 6 };
      // 5 m/s で詰まっている相手。既定（2 m/s）なら鳴る。
      expect(detectApproach(inputWith(movingPeer(22, 12)), approachDefaults)).not.toBeNull();
      expect(detectApproach(inputWith(movingPeer(22, 12)), strict)).toBeNull();
    });

    it("距離のしきい値を広げると、遠い相手でも鳴る", () => {
      const wide: ApproachConfig = { ...approachDefaults, warnDistanceM: 100 };
      expect(detectApproach(inputWith(movingPeer(70, 60)), wide)?.lv).toBe(1);
    });
  });
});

describe("測位が届く時刻がずれていても壊れない", () => {
  /**
   * **自車と相手の測位は揃わない。**自車は自分で測った瞬間に手に入るが、相手の位置は
   * POST の応答で 150〜350ms 遅れて届き、1通落ちればさらに1秒ずれる
   * （`docs/interfaces/v2v.md`）。**ここが揃った入力しか作らないと、実装のずれが
   * テストをすり抜ける。**
   */
  it("相手の位置が 1.2 秒遅れて届いていても、詰まっていれば警告する", () => {
    // 後ろから 5 m/s で詰めてくる相手。判定に使えるのは 1.2 秒前の時点で、
    // そこでの距離は 20m ——**そこで黙ってはいけない。**
    const late = northbound("b2000002", 5, -20, [
      { agoMs: 3_200 },
      { agoMs: 2_200 },
      { agoMs: 1_200 },
    ]);

    const warn = detectApproach(inputWith(late), approachDefaults);
    expect(warn?.kind).toBe("approach");
    // 20m を 5 m/s なので、届くまで 4 秒。
    expect(warn?.lv).toBe(2);
  });

  it("一定の距離で追走している相手を、到着のずれで急接近と読み違えない", () => {
    // 自分も相手も 6 m/s で北へ。**距離はずっと 20m のまま**なので、接近速度は 0。
    const me = northbound(
      "a1000001",
      6,
      0,
      [3_000, 2_000, 1_000, 0].map((agoMs) => ({ agoMs })),
    );
    // 相手の応答だけが不規則に届く（1通落ちた形）。**測位した時刻は 1 秒刻みのまま。**
    const behind = northbound("b2000002", 6, -20, [
      { agoMs: 3_250 },
      { agoMs: 1_250 },
      { agoMs: 250 },
    ]);

    const input: DetectorInput = { now: NOW, self: me, peers: [behind], signs: [] };
    expect(detectApproach(input, approachDefaults)).toBeNull();
  });

  it("届くのが遅れた位置を、その遅れのぶんだけ速く近づいたと読み違えない", () => {
    const samples = [{ agoMs: 3_000 }, { agoMs: 1_500 }, { agoMs: 0 }];
    // 1.5 m/s でゆっくり詰めてくる相手。既定（2.0 m/s）には届かないので鳴らない。
    const steady = northbound("b2000002", 1.5, -20, samples);
    // 同じ動きだが、**3 秒前の測位が 0.8 秒遅れて届いた。**届いた時刻の差で割る実装は、
    // 3 秒ぶんの距離の変化を 2.2 秒で割ることになり、**接近速度が 1.4 倍に膨れて発火する。**
    const delayed = northbound("b2000002", 1.5, -20, [
      { agoMs: 3_000, arrivedAgoMs: 2_200 },
      { agoMs: 1_500, arrivedAgoMs: 1_100 },
      { agoMs: 0 },
    ]);

    expect(detectApproach(inputWith(steady), approachDefaults)).toBeNull();
    expect(detectApproach(inputWith(delayed), approachDefaults)).toBeNull();
  });
});

describe("detectApproach（シミュレータ）", () => {
  /** シナリオを回し、ティックごとの警告を並べる。**測位が無い間は検知を呼ばない。** */
  const warningsOf = (frames: ReturnType<typeof runDetectorInputs>) =>
    frames.map(({ tick, input }) => ({
      elapsedMs: tick.elapsedMs,
      warn: input === null ? null : detectApproach(input, approachDefaults),
    }));

  it("後ろから詰めてくる自転車で発火し、追い抜かれたあとは止まる", () => {
    // 60m 後ろから相対 5 m/s。12 秒あたりで追いつき、そのあとは離れていく。
    const fired = warningsOf(runDetectorInputs(approachFromBehind)).filter((w) => w.warn !== null);

    expect(fired.length).toBeGreaterThan(0);
    for (const { warn } of fired) {
      expect(warn?.kind).toBe("approach");
      expect(warn?.causeId).toBe("b2000002");
    }

    const lastFiredMs = fired[fired.length - 1]?.elapsedMs ?? 0;
    // 追いついたあとも相手は走り続ける。**通り過ぎたら黙ること**を同じシナリオで見る。
    expect(lastFiredMs).toBeLessThan(approachFromBehind.durationMs);
  });

  it("詰まるほど段階が上がる（最後の警告が最初より強い）", () => {
    const fired = warningsOf(runDetectorInputs(approachFromBehind)).filter((w) => w.warn !== null);
    const first = fired[0]?.warn?.lv ?? 0;
    const last = fired[fired.length - 1]?.warn?.lv ?? 0;

    expect(last).toBeGreaterThan(first);
  });

  it("相手が送信をやめたら、幻の位置で鳴り続けない", () => {
    // 届かなくなった相手は、**失効するまで「その場に止まっている自転車」として残る**
    // （`docs/interfaces/mobile-api.md`）。位置が固まっている間は距離が縮まないので、
    // 距離の変化で判断するこの検知は自然に黙る——**失効を待たずに。**
    const fired = warningsOf(runDetectorInputs(peerGoesSilent)).filter((w) => w.warn !== null);
    const lastFiredMs = fired[fired.length - 1]?.elapsedMs ?? 0;

    // 10 秒目に黙るので、判定の窓（既定 2 秒）を過ぎれば警告も止まる。
    expect(lastFiredMs).toBeLessThanOrEqual(10_000 + approachDefaults.sampleWindowMs);
  });

  it("POST が失敗して近傍が失効したあとは黙る", () => {
    // **失敗した瞬間に空になるのではない。**サーバー側とモバイル側の失効は足し算に
    // なるので（`docs/interfaces/mobile-api.md`）、数秒は直前の位置が残る。
    // ここで見るのは、**空になったあとに何も言わないこと**。近傍が空なのは
    // 「相手が居ない」ではなく**「分からない」**であって、警告を出す根拠にならない。
    const blind = runDetectorInputs(postFailureMidRide).flatMap(({ input }) =>
      input !== null && input.peers.length === 0 ? [input] : [],
    );

    expect(blind.length).toBeGreaterThan(0);
    for (const input of blind) expect(detectApproach(input, approachDefaults)).toBeNull();
  });
});
