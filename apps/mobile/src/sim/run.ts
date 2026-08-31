/**
 * シナリオを時間で回し、スマホ1台（観測者）から見えるものを並べる。
 *
 * **実機も BLE も要らない。**Vitest から直接叩けるので、検知の担当（#9 / #10 / #11 / #27）は
 * ここが返す `DetectorInput` の列を自分の検知に流すだけでよい。
 *
 * **正常系だけ流せても足りない**ので、`Faults` で3つの故障を再現できるようにしてある
 * （下の表）。**2つ目と3つ目を混同しないこと**——POST が落ちてもスマホは生きている。
 */

import type { DetectorInput, StopSign } from "../detect/types";
import { type PeerMessage, roundForWire, type SelfMessage } from "../v2v/messages";
import { NeighborStore, type NeighborsConfig, neighborsDefaults } from "../v2v/neighbors";
import type { SimNode, Span } from "./node";
import { World, type WorldConfig, worldDefaults } from "./world";

/**
 * 観測者に起こす故障（シナリオ開始からの相対ミリ秒）。
 *
 * | 故障 | 何が起きるか | 何が確かめられるか |
 * | --- | --- | --- |
 * | `nofix` | 測位できない。POST せず、`beat` は `st: "nofix"` | 検知が黙り、デバイスの `link` が `nofix` になる（#36） |
 * | `postFails` | POST が失敗する。**`beat` は `st: "ok"` のまま** | 近傍が空になる。「相手が居ない」ではなく「分からない」として扱えているか |
 * | `appDown` | アプリが止まる。`beat` が途切れる | デバイスの `link` が `down` になる（#36） |
 *
 * **`postFails` と `appDown` を取り違えると、ウォッチドッグのテストが嘘になる。**
 * POST が落ちてもスマホは生きているので、`link` は `up` のままでなければならない。
 */
export type Faults = {
  nofix?: readonly Span[];
  postFails?: readonly Span[];
  appDown?: readonly Span[];
};

/**
 * BLE の `alert` に書く心拍（`docs/interfaces/v2v.md`「デバイスへ渡すもの」）。
 *
 * **警告（`warn`）はここに含めない。**何を危険と見なすかは検知が決めるもので、
 * シミュレータは入力を作る側である。
 */
export type Beat = {
  k: "beat";
  /** UTC ミリ秒 */
  t: number;
  /** 測位が取れているか */
  st: "ok" | "nofix";
  /** 走行中か。速度を持っているのはスマホだけなので、判定もスマホが行う */
  mv: boolean;
};

/** 1ティックぶん、観測者のスマホから見えるもの。 */
export type SimTick = {
  /** 自分の時計の「いま」（UTC ミリ秒） */
  now: number;
  /** シナリオ開始からの経過（ミリ秒）。故障の期間を読むときの物差し */
  elapsedMs: number;
  /**
   * 自車の測位。**`null` は測位できていない。**
   *
   * **POST の成否とは別に持つ。**サーバーに届かなくても自車の測位は生きており、
   * 一時停止の事前通知（#27）は標識さえ手元にあれば動き続ける
   * （`docs/interfaces/mobile-api.md`「失敗したときの約束」）。
   * ここを `peers` と一緒に落とすと、**POST が失敗した瞬間に検知が全部止まる**という、
   * 仕様が明確に否定している形になる。
   */
  fix: SelfMessage | null;
  /**
   * POST のレスポンスで受け取った周辺車両。
   *
   * **`null` は「送らなかった」か「失敗した」。**どちらかは `fix` で分かる
   * （`fix` が `null` なら測位が無くて送らなかった、あれば POST が失敗した）。
   * **空配列とは意味が違う**——空配列は「届いたが半径内に誰も居なかった」。
   */
  peers: readonly PeerMessage[] | null;
  /** BLE に書く心拍。**`null` はアプリが止まっている**（何も書けない） */
  beat: Beat | null;
};

/** 何台かの動きと、観測者に起こす故障をまとめたもの。 */
export type Scenario = {
  /** 何を再現しているか。テストの名前に使う */
  name: string;
  /** どの台の視点で見るか。`nodes` に含まれていること */
  observerId: string;
  nodes: readonly SimNode[];
  /** 回す長さ（ミリ秒） */
  durationMs: number;
  faults?: Faults;
  /** 近傍の一時停止の標識（#27）。実機では呼び出し側が絞って渡す */
  signs?: readonly StopSign[];
};

/** 回し方。**しきい値をコードに直書きしない**（`CLAUDE.md`）。 */
export type RunConfig = {
  /**
   * ティックの間隔（ミリ秒）。
   *
   * 実機では時間で回さず測位に合わせるので、実質 1Hz になる
   * （`docs/interfaces/v2v.md`「送る間隔」）。
   */
  tickMs: number;
  /**
   * シナリオを開始する時刻（UTC ミリ秒）。
   *
   * **`Date.now()` を既定にしない。**同じシナリオを回すたびに時刻が変わると、
   * 失敗したテストの再現ができなくなる。
   */
  startAt: number;
  /** これ以上の速度なら「走行中」とする（m/s）。`beat` の `mv` に入る */
  movingSpdMps: number;
  world: WorldConfig;
  neighbors: NeighborsConfig;
};

export const runDefaults: RunConfig = {
  tickMs: 1_000,
  // 固定の時刻。値そのものに意味は無いが、変えるとテストの期待値がずれる。
  startAt: Date.UTC(2026, 8, 1, 0, 0, 0),
  // 歩くより速ければ走行中とみなす仮の値（`docs/unverified.md`）。
  movingSpdMps: 1.5,
  world: worldDefaults,
  neighbors: neighborsDefaults,
};

/** `elapsed` がどれかの期間に入っているか（`fromMs` 以上 `toMs` 未満）。 */
function inSpans(spans: readonly Span[] | undefined, elapsedMs: number): boolean {
  return spans?.some((s) => elapsedMs >= s.fromMs && elapsedMs < s.toMs) ?? false;
}

/** ノードの状態を `self` メッセージにする。**送る前に丸める。** */
function toSelfMessage(node: SimNode, elapsedMs: number, now: number): SelfMessage {
  const state = node.at(elapsedMs);
  // `t` は測位した時刻。シミュレータでは測位した瞬間に送るものとして `now` を入れる。
  return roundForWire({ k: "self", t: now, ...state });
}

/**
 * シナリオを回し、観測者から見えるものを1ティックずつ返す。
 *
 * **観測者以外の台を先に送る。**実機では各台がばらばらに POST するが、順番で結果が
 * 変わると再現できるテストにならないので、**同じティックの中では順番を固定する。**
 */
export function runScenario(scenario: Scenario, config: Partial<RunConfig> = {}): SimTick[] {
  const cfg = { ...runDefaults, ...config };
  const observer = scenario.nodes.find((n) => n.id === scenario.observerId);
  if (observer === undefined) {
    throw new Error(`${scenario.name}: observerId(${scenario.observerId}) が nodes に無い`);
  }

  const world = new World(cfg.world);
  const ticks: SimTick[] = [];

  for (let elapsedMs = 0; elapsedMs <= scenario.durationMs; elapsedMs += cfg.tickMs) {
    const now = cfg.startAt + elapsedMs;

    for (const node of scenario.nodes) {
      if (node.id === scenario.observerId) continue;
      // 送信をやめた相手は World に届かない。失効するまでは古い位置が配られ続ける
      // ——これが「その場に止まっている自転車」の幻である。
      if (inSpans(node.silentMs, elapsedMs)) continue;
      world.exchange(node.id, toSelfMessage(node, elapsedMs, now), now);
    }

    ticks.push(observedTick(scenario, observer, world, elapsedMs, now, cfg));
  }
  return ticks;
}

/** 観測者の1ティック。故障はここで効かせる。 */
function observedTick(
  scenario: Scenario,
  observer: SimNode,
  world: World,
  elapsedMs: number,
  now: number,
  cfg: RunConfig,
): SimTick {
  const faults = scenario.faults;

  // アプリが止まっている間は何も書けない。測位も POST も `beat` も無い。
  if (inSpans(faults?.appDown, elapsedMs)) {
    return { now, elapsedMs, fix: null, peers: null, beat: null };
  }

  // 測位できていない間は `self` を送らない（位置が無ければ半径で問い合わせようがない）。
  // **それでも `beat` は毎秒書く。**黙るとデバイスは「アプリが落ちた」と表示する。
  if (inSpans(faults?.nofix, elapsedMs)) {
    // 走行中かは測位が無いと分からないので、走行中に倒す（`docs/notifications.md`）。
    return {
      now,
      elapsedMs,
      fix: null,
      peers: null,
      beat: { k: "beat", t: now, st: "nofix", mv: true },
    };
  }

  const fix = toSelfMessage(observer, elapsedMs, now);
  const beat: Beat = { k: "beat", t: now, st: "ok", mv: fix.spd >= cfg.movingSpdMps };

  // POST が失敗しても自分の測位は生きているので、`beat` は `st: "ok"` のまま、
  // `fix` も残る。止めると `link` が `down` になり、
  // 「スマホは動いているのに落ちたことになる」。
  if (inSpans(faults?.postFails, elapsedMs)) {
    return { now, elapsedMs, fix, peers: null, beat };
  }

  return { now, elapsedMs, fix, peers: world.exchange(scenario.observerId, fix, now), beat };
}

/** 1ティックぶんの、ティックと検知の入力の組。 */
export type DetectorFrame = {
  tick: SimTick;
  /**
   * そのティックで検知に渡す入力。
   *
   * **`null` のときは検知を1つも呼ばない**（`docs/interfaces/detectors.md`）。
   * 自車の測位が無いか、アプリが止まっている。
   */
  input: DetectorInput | null;
};

/**
 * シナリオを回し、**検知にそのまま渡せる入力**の列を返す。
 *
 * 検知の担当が使う入口はここ。受け取った `peer` を検証して近傍の状態を保つところまでは
 * `../v2v/neighbors.ts` が行うので、**実機と同じ道を通った入力**が返る。
 *
 * ```ts
 * for (const { input } of runDetectorInputs(approachFromBehind)) {
 *   if (input === null) continue; // 測位が無い間は呼ばない
 *   const warn = detectApproach(input, approachDefaults);
 * }
 * ```
 */
export function runDetectorInputs(
  scenario: Scenario,
  config: Partial<RunConfig> = {},
): DetectorFrame[] {
  const cfg = { ...runDefaults, ...config };
  const store = new NeighborStore(scenario.observerId, cfg.neighbors);
  const signs = scenario.signs ?? [];

  return runScenario(scenario, cfg).map((tick) => {
    // アプリが止まっている間は、そもそもスマホの中で何も動いていない。
    if (tick.beat === null) return { tick, input: null };

    // `rxAt` は受け取った側が打つ（`docs/interfaces/detectors.md`）。
    // **測位と近傍を別々に取り込む。**POST が失敗しても自車の測位は生きているので、
    // 近傍だけが空になり、標識を見る検知は動き続ける。
    if (tick.fix !== null) store.acceptSelf(tick.fix, tick.now);
    if (tick.peers !== null) store.acceptPeers(tick.peers, tick.now);
    return { tick, input: store.detectorInput(tick.now, signs) };
  });
}
