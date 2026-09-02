/**
 * **同梱物から引いた近傍が、検知の前提を満たしているか。**
 *
 * 一時停止の事前通知（#27）はシミュレータの `stopSignAhead` を相手に書かれる。
 * そのシナリオは**進路の 80m 先の標識**と、**東 40m の別の道の標識**を渡してくるが、
 * **走行中に検知へ届くのは `SignStore.near()` が返したものだけ**である。
 *
 * **セルが狭すぎれば、検知が正しくても警告は出ない。**しかもその失敗は
 * 「近くに標識が無い」と見分けが付かない（`docs/interfaces/stop-signs-delivery.md`）ので、
 * **ここで確かめておく。**
 */

import { describe, expect, it } from "vitest";
import { runDetectorInputs } from "../sim/run";
import { stopSignAhead } from "../sim/scenarios";
import { buildSignsDatabase } from "./node";
import type { SignsMeta } from "./store";

const META: SignsMeta = {
  pref: 33,
  version: '"33.sim"',
  count: stopSignAhead.signs?.length ?? 0,
  builtAt: "2026-09-01T00:00:00Z",
};

describe("stopSignAhead のシナリオ", () => {
  it("走り出した地点から、シナリオの標識が全部引ける", () => {
    const signs = stopSignAhead.signs ?? [];
    expect(signs.length).toBeGreaterThan(0);

    // 走り出した最初の測位。**実機と同じ道を通った入力**から取る。
    const first = runDetectorInputs(stopSignAhead).find((frame) => frame.input !== null)?.input;
    expect(first).toBeDefined();
    const self = first?.self.fixes[0];
    expect(self).toBeDefined();
    if (self === undefined) return;

    const { store, close } = buildSignsDatabase(":memory:", META, signs);
    try {
      const near = store.near(self.lat, self.lon).map((sign) => sign.id);
      // 80m 先の標識も、東 40m の紛らわしい標識も、どちらも検知に届かなければならない
      // （**届かないと、方角を見ない実装が素通りする**）。
      expect(near.sort()).toEqual(signs.map((sign) => sign.id).sort());
    } finally {
      close();
    }
  });
});
