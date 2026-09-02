import { describe, expect, it } from "vitest";
import { registeredDetectors } from "../ride/detectors";
import { destination } from "../sim/node";
import { runRide } from "../sim/ride";
import { runDetectorInputs } from "../sim/run";
import { stopSignAhead } from "../sim/scenarios";
import { detectStopSign, type StopSignConfig, stopSignDefaults } from "./stop-sign";
import type { DetectorInput, Fix, StopSign, Track } from "./types";

/** 岡山市付近の基準点（合成）。**実走行の GPS ログは使わない**（`CLAUDE.md`）。 */
const BASE = { lat: 34.6617, lon: 133.9344 };

/** 自分の時計の「いま」。固定値にしておかないと、失敗したテストを再現できない。 */
const NOW = Date.UTC(2026, 8, 1, 0, 0, 10);

/** 方角の読みやすい名前（度、真北 0、時計回り）。 */
const NORTH = 0;
const EAST = 90;
const SOUTH = 180;

/** 自車の作り方。**既定は「北へ 5 m/s で走っている」。** */
type SelfOptions = { spd?: number; crs?: number | null; hacc?: number; ageMs?: number };

/**
 * 自車の `Track`。**1点しか持たない。**
 *
 * この検知が見るのは最新の1点だけ（標識は動かないので、距離の変化を測る必要がない）。
 * 履歴を積んでも判定に効かないので、**テストの意図が読みやすい方**を取る。
 */
const self = (options: SelfOptions = {}): Track => {
  const ageMs = options.ageMs ?? 0;
  const fix: Fix = {
    t: NOW - ageMs,
    rxAt: NOW - ageMs,
    ...BASE,
    spd: options.spd ?? 5,
    crs: options.crs === undefined ? NORTH : options.crs,
    hacc: options.hacc ?? 4,
  };
  return { id: "a1000001", fixes: [fix] };
};

/**
 * モックの標識を1つ作る。
 *
 * @param bearing 自車から見てどの方角に立っているか（度）
 * @param m 自車からの距離（メートル）
 * @param comesFrom **対象の車両がどちら側から来るか**（標識から見た方角）。
 *   北へ走る車を対象とする標識なら、対象は標識の**南**から来るので `SOUTH`。
 *   `null` は元データに進入方向の登録が無い標識（`StopSign.approach` が `null`）。
 */
const sign = (id: string, bearing: number, m: number, comesFrom: number | null): StopSign => {
  const at = destination(BASE.lat, BASE.lon, bearing, m);
  return {
    id,
    ...at,
    approach: comesFrom === null ? null : destination(at.lat, at.lon, comesFrom, 20),
  };
};

/** 標識ぶんの入力。この検知は `peers` を見ないので空でよい。 */
const inputWith = (signs: readonly StopSign[], options: SelfOptions = {}): DetectorInput => ({
  now: NOW,
  self: self(options),
  peers: [],
  signs,
});

/** しきい値を1つだけ差し替える。 */
const configWith = (patch: Partial<StopSignConfig>): StopSignConfig => ({
  ...stopSignDefaults,
  ...patch,
});

describe("detectStopSign（モックデータ）", () => {
  it("進路の先にある、自分が対象の標識で警告を出す", () => {
    // 5 m/s × 5 秒 = 25m 手前から知らせる。20m 先はその内側。
    const warn = detectStopSign(inputWith([sign("s1", NORTH, 20, SOUTH)]), stopSignDefaults);

    expect(warn?.kind).toBe("stop");
    // **`causeId` は `StopSign.id`。**入れないと呼び出し側の抑制が別の標識を畳む。
    expect(warn?.causeId).toBe("s1");
  });

  it("近いほど段階が上がる（既定では警告する距離の手前半分から lv 2）", () => {
    // 5 m/s なら 25m 手前から。境目はその半分の 12.5m。
    const far = detectStopSign(inputWith([sign("s1", NORTH, 24, SOUTH)]), stopSignDefaults);
    const near = detectStopSign(inputWith([sign("s1", NORTH, 10, SOUTH)]), stopSignDefaults);

    expect(far?.lv).toBe(1);
    expect(near?.lv).toBe(2);
  });

  it("遅くても lv 1 から始まる（段階が1つ消えない）", () => {
    // **段階の境目を絶対値で置くと、ここが壊れる。**遅いときは警告する距離が下限
    // （15m）に張り付くので、境目を 20m のように置くと**下限が丸ごとその内側に入り、
    // 最初の警告がいきなり lv 2 になる。**
    const signs = [sign("s1", NORTH, 12, SOUTH)];

    expect(detectStopSign(inputWith(signs, { spd: 2 }), stopSignDefaults)?.lv).toBe(1);
  });

  it("速いほど手前から鳴る（警告する距離を速度から作っている）", () => {
    const signs = [sign("s1", NORTH, 45, SOUTH)];

    // 5 m/s なら 25m 手前からなので、45m 先はまだ黙る。
    expect(detectStopSign(inputWith(signs, { spd: 5 }), stopSignDefaults)).toBeNull();
    // 10 m/s なら 50m 手前から。同じ標識で鳴る。
    expect(detectStopSign(inputWith(signs, { spd: 10 }), stopSignDefaults)).not.toBeNull();
  });

  it("速度から作った距離が上限を超えない", () => {
    // 20 m/s × 5 秒 = 100m だが、上限は既定 60m。**近傍として渡ってくるのは
    // 3×3 セルぶんだけ**なので、それより先を見に行かない。
    const warn = detectStopSign(
      inputWith([sign("s1", NORTH, 80, SOUTH)], { spd: 20 }),
      stopSignDefaults,
    );

    expect(warn).toBeNull();
  });

  describe("自分が対象ではない標識を拾わない", () => {
    it("対向車線の標識（進入方向が逆）", () => {
      // 進路の 20m 先に立っているが、**南へ走る車が対象**の標識。
      const warn = detectStopSign(inputWith([sign("s1", NORTH, 20, NORTH)]), stopSignDefaults);

      expect(warn).toBeNull();
    });

    it("交差する道の標識（進入方向が直交）", () => {
      // 東 15m。**東から西へ走る車が対象**で、北へ走る自車は対象ではない。
      const warn = detectStopSign(inputWith([sign("s1", EAST, 15, EAST)]), stopSignDefaults);

      expect(warn).toBeNull();
    });

    it("停止線まで来て、また漕ぎ出したとき（もう手遅れで、正しく止まった直後でもある）", () => {
      // **検知は前回の呼び出しを覚えない**ので、「さっき止まった」ことを知らない。
      // ここで鳴らす実装にすると、**正しく一時停止した人が漕ぎ出した瞬間にブザーが鳴る。**
      const warn = detectStopSign(
        inputWith([sign("s1", NORTH, 5, SOUTH)], { spd: 2 }),
        stopSignDefaults,
      );

      expect(warn).toBeNull();
    });

    it("もう通り過ぎた標識（進入方向は合っている）", () => {
      // 真後ろ 20m。**進行方角は通り過ぎたあとも変わらない**ので、
      // 進入方向の判定だけでは止まらない。
      const warn = detectStopSign(inputWith([sign("s1", SOUTH, 20, SOUTH)]), stopSignDefaults);

      expect(warn).toBeNull();
    });
  });

  describe("進入方向が分からない標識（approach が null）", () => {
    it("既定では拾う（黙ると「標識が無い」と見分けがつかない）", () => {
      const warn = detectStopSign(inputWith([sign("s1", NORTH, 20, null)]), stopSignDefaults);

      expect(warn?.causeId).toBe("s1");
    });

    it("設定で落とせる", () => {
      const warn = detectStopSign(
        inputWith([sign("s1", NORTH, 20, null)]),
        configWith({ warnOnUnknownApproach: false }),
      );

      expect(warn).toBeNull();
    });

    it("進入方向が規制地点と同じ座標のときも「分からない」として扱う", () => {
      // 2点が重なっていると方位に意味が無い（`geo.ts` の `bearingDeg` が 0 を返す）。
      // **「北向きが対象」と読み違えない**ことを確かめる。
      const at = destination(BASE.lat, BASE.lon, NORTH, 20);
      const degenerate: StopSign = { id: "s1", ...at, approach: { ...at } };

      expect(detectStopSign(inputWith([degenerate]), stopSignDefaults)?.causeId).toBe("s1");
      expect(
        detectStopSign(inputWith([degenerate]), configWith({ warnOnUnknownApproach: false })),
      ).toBeNull();
    });

    it("通り過ぎていれば、進入方向が分からなくても鳴らない", () => {
      const warn = detectStopSign(inputWith([sign("s1", SOUTH, 20, null)]), stopSignDefaults);

      expect(warn).toBeNull();
    });
  });

  describe("警告を出さない場合", () => {
    it("標識を1つも持っていないとき", () => {
      expect(detectStopSign(inputWith([]), stopSignDefaults)).toBeNull();
    });

    it("もう止まりかけているとき", () => {
      const warn = detectStopSign(
        inputWith([sign("s1", NORTH, 20, SOUTH)], { spd: 1.0 }),
        stopSignDefaults,
      );

      expect(warn).toBeNull();
    });

    it("進行方角が出ていないとき（低速で crs が null）", () => {
      const warn = detectStopSign(
        inputWith([sign("s1", NORTH, 20, SOUTH)], { crs: null }),
        stopSignDefaults,
      );

      expect(warn).toBeNull();
    });

    it("測位が粗くて隣の道路と区別できないとき", () => {
      // `docs/unverified.md` 9 / 21。**数 m ずれると狙った標識ではなくなる。**
      const warn = detectStopSign(
        inputWith([sign("s1", NORTH, 20, SOUTH)], { hacc: 20 }),
        stopSignDefaults,
      );

      expect(warn).toBeNull();
    });

    it("最新の測位が古いとき", () => {
      const warn = detectStopSign(
        inputWith([sign("s1", NORTH, 20, SOUTH)], { ageMs: 5_000 }),
        stopSignDefaults,
      );

      expect(warn).toBeNull();
    });
  });

  describe("複数の標識が該当したとき", () => {
    it("lv が高い方を1つだけ返す", () => {
      const warn = detectStopSign(
        inputWith([sign("far", NORTH, 24, SOUTH), sign("near", NORTH, 10, SOUTH)]),
        stopSignDefaults,
      );

      expect(warn?.lv).toBe(2);
      expect(warn?.causeId).toBe("near");
    });

    it("lv が同じなら近い方を返す", () => {
      const warn = detectStopSign(
        inputWith([sign("far", NORTH, 24, SOUTH), sign("nearer", NORTH, 22, SOUTH)]),
        stopSignDefaults,
      );

      expect(warn?.causeId).toBe("nearer");
    });
  });

  describe("しきい値は設定から注入される", () => {
    it("知らせる秒数を伸ばすと、同じ標識で早く鳴る", () => {
      const signs = [sign("s1", NORTH, 45, SOUTH)];

      expect(detectStopSign(inputWith(signs), stopSignDefaults)).toBeNull();
      expect(detectStopSign(inputWith(signs), configWith({ leadTimeS: 10 }))).not.toBeNull();
    });

    it("進入方向の許容を広げると、斜めから入る標識も拾う", () => {
      // 北東（45 度）から入る車が対象の標識。**許容をまたぐ側と、またがない側の
      // 両方で確かめる**（既定の 45 度はちょうど境界にあたるので、ここでは使わない）。
      const signs = [sign("s1", NORTH, 20, 225)];

      expect(detectStopSign(inputWith(signs), configWith({ approachToleranceDeg: 30 }))).toBeNull();
      expect(
        detectStopSign(inputWith(signs), configWith({ approachToleranceDeg: 60 })),
      ).not.toBeNull();
    });

    it("段階を分ける割合を動かすと、同じ標識の lv が変わる", () => {
      // 5 m/s なら警告する距離は 25m。割合 0.2 なら境目は 5m、0.9 なら 22.5m。
      const signs = [sign("s1", NORTH, 20, SOUTH)];

      expect(detectStopSign(inputWith(signs), configWith({ level2Ratio: 0.2 }))?.lv).toBe(1);
      expect(detectStopSign(inputWith(signs), configWith({ level2Ratio: 0.9 }))?.lv).toBe(2);
    });
  });
});

describe("detectStopSign（シミュレータ）", () => {
  it("進路の 80m 先の標識に近づくと発火し、横道の標識では鳴らない", () => {
    const fired = runDetectorInputs(stopSignAhead).flatMap(({ tick, input }) => {
      const warn = input === null ? null : detectStopSign(input, stopSignDefaults);
      return warn === null ? [] : [{ elapsedMs: tick.elapsedMs, warn }];
    });

    expect(fired.length).toBeGreaterThan(0);
    for (const { warn } of fired) {
      expect(warn.kind).toBe("stop");
      // **東 40m の標識（`sim-stop-2`）は東から入る車が対象。**
      // 距離だけを見る実装はここで落ちる。
      expect(warn.causeId).toBe("sim-stop-1");
    }

    // 5 m/s で 80m 先。25m 手前まで詰まる 11 秒あたりまでは鳴らない。
    expect(fired[0]?.elapsedMs).toBeGreaterThanOrEqual(10_000);
  });

  it("通り過ぎたあとは黙る", () => {
    // 16 秒目に標識へ届き、そのあとも走り続ける（シナリオは 20 秒）。
    const fired = runDetectorInputs(stopSignAhead).filter(
      ({ input }) => input !== null && detectStopSign(input, stopSignDefaults) !== null,
    );
    const lastMs = fired[fired.length - 1]?.tick.elapsedMs ?? 0;

    expect(lastMs).toBeLessThan(stopSignAhead.durationMs);
  });

  it("走行ループに登録されていて、デバイスの出口に warn が届く", async () => {
    // **実機・BLE・サーバーなし。**`registeredDetectors` をそのまま使うので、
    // `../ride/detectors.ts` への登録を忘れたらここで落ちる（#27 の完了条件）。
    const frames = await runRide(stopSignAhead);
    const stops = frames.flatMap((f) => f.warns.filter((w) => w.kind === "stop"));

    expect(stops.length).toBeGreaterThan(0);
    expect(registeredDetectors.some((d) => d.name === "stop")).toBe(true);
  });
});
