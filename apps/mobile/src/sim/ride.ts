/**
 * シナリオを**走行ループごと**回す。**実機・BLE・サーバーなしで、測位から
 * `alert` への書き込みまで一気通貫で確かめられる。**
 *
 * `./run.ts` の `runDetectorInputs()` が「検知に渡る入力」までを見るのに対して、こちらは
 * **登録された検知（`../ride/detectors.ts`）が実際に呼ばれ、抑制を通り、BLE の出口に
 * 何が書かれたか**までを見る。**検知を1つ書いた人が、それがアプリの中で動くことを
 * 確かめる場所**である。
 *
 * ```ts
 * const frames = await runRide(approachFromBehind);
 * const warned = frames.some((f) => f.warns.length > 0);
 * ```
 */

import type { RegisteredDetector } from "../ride/detectors";
import { createMockDeviceLink } from "../ride/device";
import { type RideConfig, RideLoop, type RideStatus } from "../ride/loop";
import type { AlertMessage, BeatMessage, WarnMessage } from "../v2v/alert";
import { type RunConfig, runDefaults, runScenario, type Scenario, type SimTick } from "./run";

/** 1ティックぶん、走行ループが何をしたか。 */
export type RideFrame = {
  /** そのティックで観測者から見えていたもの */
  tick: SimTick;
  /** そのティックで `alert` に書かれたもの（古い順） */
  written: readonly AlertMessage[];
  /** 書かれた警告だけ */
  warns: readonly WarnMessage[];
  /** 書かれた心拍。**`null` はアプリが止まっている**（`Faults.appDown`） */
  beat: BeatMessage | null;
  /** そのティックを終えた時点の状態（走行前後の画面が見るもの） */
  status: RideStatus;
};

/** 回し方。`./run.ts` の `RunConfig` に、走行ループぶんを足しただけ。 */
export type RideRunOptions = {
  run?: Partial<RunConfig>;
  ride?: Partial<RideConfig>;
  /**
   * 回す検知。**既定は `../ride/detectors.ts` に登録されているもの全部。**
   *
   * 自分の検知だけを見たいときは、それ1つを入れた配列を渡す。
   */
  detectors?: readonly RegisteredDetector[];
};

/**
 * シナリオを走行ループに流し、1ティックずつ結果を返す。
 *
 * **時刻はシナリオが決める。**`Date.now()` を使わないので、同じシナリオは何度回しても
 * 同じ結果になる（失敗したテストを再現できる）。
 *
 * **POST の成否はシナリオの `Faults` が決める**（`./run.ts`）。`peers` が `null` の
 * ティックでは中継が失敗したものとして例外を投げるので、**近傍が空になったときに
 * 検知が黙るか**を同じ道で確かめられる。
 */
export async function runRide(
  scenario: Scenario,
  options: RideRunOptions = {},
): Promise<RideFrame[]> {
  const cfg = { ...runDefaults, ...options.run };
  const device = createMockDeviceLink(scenario.observerId);

  // ティックごとに差し替える。実機では HTTP の往復がここに入る。
  let currentTick: SimTick | null = null;
  let now = cfg.startAt;

  const loop = new RideLoop({
    device,
    exchange: async () => {
      const peers = currentTick?.peers ?? null;
      // **`null` は「送らなかった」か「失敗した」。**ここへ来るのは送った場合だけなので
      // 失敗である。空の配列（誰も居なかった）と区別するために投げる。
      if (peers === null) throw new Error("POST が失敗しました（シナリオの faults）");
      return peers;
    },
    now: () => now,
    ...(options.detectors === undefined ? {} : { detectors: options.detectors }),
    ...(scenario.signs === undefined ? {} : { signs: scenario.signs }),
    // **`RunConfig` と共通のものは橋渡しする。**渡さないと、シミュレータが
    // 「走行中」と見なす速度とループが使う速度が食い違い、**どちらもそれらしく見える**。
    config: { neighbors: cfg.neighbors, movingSpdMps: cfg.movingSpdMps, ...options.ride },
  });

  const frames: RideFrame[] = [];
  for (const tick of runScenario(scenario, cfg)) {
    currentTick = tick;
    now = tick.now;
    device.clear();

    // アプリが止まっている間は、スマホの中で何も動いていない。**心拍も書かれない**
    // ——これがデバイス側のウォッチドッグ（#36）が `down` を出す根拠である。
    if (tick.beat !== null) {
      // **心拍が先。**実機では別のタイマーで動いており、測位や POST を待たない。
      loop.beat();
      if (tick.fix !== null) await loop.onFix(tick.fix);
    }

    const written = [...device.written];
    frames.push({
      tick,
      written,
      warns: written.filter((m): m is WarnMessage => m.k === "warn"),
      beat: written.find((m): m is BeatMessage => m.k === "beat") ?? null,
      status: loop.status(),
    });
  }
  return frames;
}
