import { describe, expect, it } from "vitest";
import { distanceM, normalizeAngleDeg } from "../detect/geo";
import type { DetectorInput, Track } from "../detect/types";
import { type DetectorFrame, runDetectorInputs, runScenario, type SimTick } from "./run";
import {
  appCrashMidRide,
  approachFromBehind,
  blindCorner,
  hardBrakeAhead,
  peerGoesSilent,
  positionLostMidRide,
  postFailureMidRide,
  scenarios,
  stopSignAhead,
} from "./scenarios";

/** その入力の中で、自車と相手が何メートル離れているか。 */
const gapM = (input: DetectorInput, peer: Track): number => {
  const me = input.self.fixes.at(-1);
  const you = peer.fixes.at(-1);
  if (me === undefined || you === undefined) throw new Error("fixes が空");
  return distanceM(me.lat, me.lon, you.lat, you.lon);
};

/** 経過ミリ秒でティックを引く。 */
const at = (frames: readonly DetectorFrame[], elapsedMs: number): DetectorFrame => {
  const frame = frames.find((f) => f.tick.elapsedMs === elapsedMs);
  if (frame === undefined) throw new Error(`${elapsedMs}ms のティックが無い`);
  return frame;
};

describe("すべてのシナリオ", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", (_name, scenario) => {
    const frames = runDetectorInputs(scenario);
    expect(frames.length).toBeGreaterThan(0);

    let previous = Number.NEGATIVE_INFINITY;
    for (const { tick, input } of frames) {
      // 時刻は必ず進む。止まると「最後の測位から何秒経ったか」が検知の中で出せない。
      expect(tick.now).toBeGreaterThan(previous);
      previous = tick.now;

      if (input === null) continue;
      expect(input.now).toBe(tick.now);
      expect(input.self.id).toBe(scenario.observerId);
      // 自分自身を「距離 0 で並走する自転車」として渡さない。
      expect(input.peers.map((p) => p.id)).not.toContain(scenario.observerId);
      // 空の Track を作らない（型で止めてあるが、実際に空でないことも見る）。
      expect(input.self.fixes.length).toBeGreaterThan(0);
      for (const peer of input.peers) expect(peer.fixes.length).toBeGreaterThan(0);
    }
  });

  it.each(scenarios.map((s) => [s.name, s] as const))(
    "%s — 同じシナリオを2度回すと同じ結果になる",
    (_name, scenario) => {
      // 既定の開始時刻を Date.now() にすると、失敗したテストを再現できなくなる。
      expect(runScenario(scenario)).toEqual(runScenario(scenario));
    },
  );
});

describe("急接近（#9）のシナリオ", () => {
  const frames = runDetectorInputs(approachFromBehind);

  it("後ろから来る相手との距離が縮み続ける", () => {
    const gaps = frames
      .map(({ input }) => {
        const peer = input?.peers[0];
        return input !== null && peer !== undefined ? gapM(input, peer) : null;
      })
      .filter((g): g is number => g !== null);

    expect(gaps[0]).toBeCloseTo(60, 0);
    // 相対 5 m/s なので 12 秒あたりで並ぶ。
    expect(gaps.at(-1)).toBeGreaterThan(gaps[Math.floor(gaps.length / 2)] ?? 0);
    expect(Math.min(...gaps)).toBeLessThan(5);
  });

  it("相手は自分より速い（接近速度が出る）", () => {
    const peer = at(frames, 5_000).input?.peers[0]?.fixes.at(-1);
    const me = at(frames, 5_000).input?.self.fixes.at(-1);
    expect(peer?.spd).toBe(9);
    expect(me?.spd).toBe(4);
  });

  it("履歴が溜まる（1点だけを渡さない）", () => {
    // 減速度も接近速度も、点が1つでは出せない。
    expect(at(frames, 5_000).input?.self.fixes.length).toBeGreaterThan(1);
    expect(at(frames, 5_000).input?.peers[0]?.fixes.length).toBeGreaterThan(1);
  });
});

describe("前方の急ブレーキ（#10）のシナリオ", () => {
  const frames = runDetectorInputs(hardBrakeAhead);

  it("前の相手の速度が 5 から 0 へ落ちる", () => {
    const speedAt = (ms: number) => at(frames, ms).input?.peers[0]?.fixes.at(-1)?.spd;
    expect(speedAt(4_000)).toBe(5);
    expect(speedAt(7_000)).toBe(0);
  });

  it("減速が履歴の中で見える（1 ティックで落ちない）", () => {
    // 階段状に落とすと、しきい値がティックの間隔次第で変わってしまう。
    const fixes = at(frames, 7_000).input?.peers[0]?.fixes ?? [];
    const speeds = fixes.map((f) => f.spd);
    expect(new Set(speeds).size).toBeGreaterThan(2);
    expect(Math.max(...speeds)).toBe(5);
    expect(Math.min(...speeds)).toBe(0);
  });

  it("相手は自分の前にいる", () => {
    const input = at(frames, 0).input;
    const peer = input?.peers[0];
    if (input === undefined || input === null || peer === undefined)
      throw new Error("相手が居ない");
    expect(gapM(input, peer)).toBeCloseTo(30, 0);
  });
});

describe("見えない曲がり角（#11）のシナリオ", () => {
  const frames = runDetectorInputs(blindCorner);

  it("進行方角がほぼ直交している", () => {
    const input = at(frames, 5_000).input;
    const me = input?.self.fixes.at(-1)?.crs;
    const you = input?.peers[0]?.fixes.at(-1)?.crs;
    if (me == null || you == null) throw new Error("向きが分からない");
    expect(Math.abs(normalizeAngleDeg(me - you))).toBeCloseTo(90, 0);
  });

  it("交差点で最も近づく", () => {
    const gapAt = (ms: number) => {
      const input = at(frames, ms).input;
      const peer = input?.peers[0];
      if (input === undefined || input === null || peer === undefined)
        throw new Error("相手が居ない");
      return gapM(input, peer);
    };
    // どちらも交差点まで 50m から 5 m/s なので、10 秒目に出会う。
    expect(gapAt(0)).toBeCloseTo(Math.hypot(50, 50), 0);
    expect(gapAt(10_000)).toBeLessThan(1);
    expect(gapAt(14_000)).toBeGreaterThan(gapAt(10_000));
  });
});

describe("一時停止の事前通知（#27）のシナリオ", () => {
  const frames = runDetectorInputs(stopSignAhead);

  it("進路上の標識と、外れた道の標識の両方を渡す", () => {
    // 単に近いだけで拾うと、自分が向かっていない標識で警告が鳴る。
    expect(at(frames, 0).input?.signs.map((s) => s.id)).toEqual(["sim-stop-1", "sim-stop-2"]);
  });

  it("相手が居なくても入力は作る（通信が死んでいても動く検知）", () => {
    expect(at(frames, 5_000).input?.peers).toEqual([]);
    expect(at(frames, 5_000).input).not.toBeNull();
  });

  it("進路上の標識に近づいていく", () => {
    const distanceToSign = (ms: number) => {
      const input = at(frames, ms).input;
      const me = input?.self.fixes.at(-1);
      const sign = input?.signs[0];
      if (me === undefined || sign === undefined) throw new Error("標識が無い");
      return distanceM(me.lat, me.lon, sign.lat, sign.lon);
    };
    expect(distanceToSign(0)).toBeCloseTo(80, 0);
    expect(distanceToSign(10_000)).toBeCloseTo(30, 0);
  });
});

describe("故障 1: 測位できない", () => {
  const frames = runDetectorInputs(positionLostMidRide);
  const beatAt = (ms: number): SimTick["beat"] => at(frames, ms).tick.beat;

  it("その間は測位も POST も無く、心拍に nofix を載せ続ける", () => {
    for (const ms of [5_000, 6_000, 7_000, 8_000]) {
      expect(at(frames, ms).tick.fix).toBeNull();
      expect(at(frames, ms).tick.peers).toBeNull();
      expect(beatAt(ms)).toEqual({ k: "beat", t: at(frames, ms).tick.now, st: "nofix", mv: true });
    }
  });

  it("心拍は止まらない（止めるとアプリが落ちたことになる）", () => {
    expect(frames.every(({ tick }) => tick.beat !== null)).toBe(true);
  });

  it("測位が古くなると検知を1つも呼ばなくなる", () => {
    // 既定の selfStaleMs は 3 秒。測位が止まってからそのぶん経つと入力が作れない。
    expect(at(frames, 5_000).input).not.toBeNull();
    expect(at(frames, 8_000).input).toBeNull();
  });

  it("測位が戻れば元に戻る", () => {
    expect(at(frames, 9_000).tick.beat?.st).toBe("ok");
    expect(at(frames, 9_000).input).not.toBeNull();
  });
});

describe("故障 2: POST が失敗する", () => {
  const frames = runDetectorInputs(postFailureMidRide);

  it("心拍は ok のまま、測位も生きている（スマホは生きている）", () => {
    // ここを nofix や無音にすると、ウォッチドッグのテストが嘘になる。
    for (const ms of [5_000, 7_000, 9_000]) {
      expect(at(frames, ms).tick.beat?.st).toBe("ok");
      expect(at(frames, ms).tick.fix).not.toBeNull();
      // レスポンスが返らないので近傍だけが分からなくなる。空配列（届いたが誰も居ない）
      // とは区別する。
      expect(at(frames, ms).tick.peers).toBeNull();
    }
  });

  it("近傍が空になるが、入力そのものは作られる", () => {
    // 空は「相手が居ない」ではなく「分からない」。検知が黙るのは正しいが、
    // 「周りは安全」と読み替えてはいけない。
    const input = at(frames, 9_000).input;
    expect(input).not.toBeNull();
    expect(input?.peers).toEqual([]);
  });

  it("自車の測位は生き続ける（標識を見る検知は動き続ける）", () => {
    // POST が落ちても自分の測位は自分で取れている。ここが途切れると、
    // 「通信が死んでも一時停止の事前通知は動く」という約束が嘘になる。
    expect(at(frames, 9_000).input?.self.fixes.length).toBeGreaterThan(0);
  });

  it("復旧すれば相手が戻る", () => {
    expect(at(frames, 12_000).input?.peers).toHaveLength(1);
  });
});

describe("故障 3: アプリが止まる", () => {
  const frames = runDetectorInputs(appCrashMidRide);

  it("心拍が途切れる（デバイスはこれで link を down にする）", () => {
    expect(at(frames, 7_000).tick.beat).not.toBeNull();
    for (const ms of [8_000, 10_000, 20_000]) {
      expect(at(frames, ms).tick.beat).toBeNull();
      expect(at(frames, ms).tick.fix).toBeNull();
      expect(at(frames, ms).tick.peers).toBeNull();
    }
  });

  it("検知も動かない", () => {
    expect(at(frames, 10_000).input).toBeNull();
  });
});

describe("相手が送信をやめる", () => {
  const frames = runDetectorInputs(peerGoesSilent);
  const peerCount = (ms: number) => at(frames, ms).input?.peers.length;

  it("黙った直後はまだ近傍に残る（サーバー側とモバイル側の失効が足し算になる）", () => {
    expect(peerCount(10_000)).toBe(1);
    expect(peerCount(12_000)).toBe(1);
  });

  it("やがて近傍から消える（通り過ぎた相手で警告を鳴らし続けない）", () => {
    expect(peerCount(20_000)).toBe(0);
  });

  it("消えるまでにかかるのは、サーバー側とモバイル側の失効を足した時間", () => {
    // 既定は 3 + 3 秒。黙った 10 秒目から数えて 6 秒後に消える。
    // **片方だけを縮めても幻は半分しか消えない**ので、2つの値は合計で決めること
    // （`docs/interfaces/mobile-api.md`）。ここが動いたら、どちらかを独りで変えている。
    const gone = frames.find((f) => f.tick.elapsedMs >= 10_000 && f.input?.peers.length === 0);
    expect(gone?.tick.elapsedMs).toBe(16_000);
  });

  it("残っている間、相手の位置は止まったままになる（幻）", () => {
    const last = (ms: number) => at(frames, ms).input?.peers[0]?.fixes.at(-1);
    const a = last(11_000);
    const b = last(12_000);
    if (a === undefined || b === undefined) throw new Error("相手が居ない");
    expect(distanceM(a.lat, a.lon, b.lat, b.lon)).toBe(0);
  });
});
