/**
 * 測位の更新が来ない間、直近の測位を「いまの測位」として流し続ける（#167 /
 * `docs/adr/0011-stationary-fix-hold.md`）。
 *
 * **中継の 1Hz を測位の到着に依存させないためのもの。**中継の POST は測位の更新だけが
 * 駆動しており（`./loop.ts` の `onFix()`）、**iOS は動いていない端末に測位を出さない**
 * ——実測で平均 5.3 秒・最長 30.0 秒に1通まで落ちた（#166）。近傍の失効は 3 秒なので、
 * **信号待ちで止まっている自転車は、周りのアプリから消えている時間の方が長い。**
 *
 * **なぜ更新が来ないのかを当てにいかない。**「止まっているから」なのか「測位が死んだから」
 * なのかはスマホ側から見分けられない。**アプリが生きて POST が通っていること自体が、
 * 直近の位置を使ってよい根拠**であり、嘘の長さは上限（{@link FixHoldConfig.maxHoldMs}）
 * だけで抑える。
 *
 * **測位の層に置いてある**ので、走行ループ・近傍・検知・サーバーは1行も変わらない。
 * **Android には分岐を書いていない**——画面を消すと React Native のタイマーが事実上止まる
 * ため（`./loop.ts` の `beat()`）**Android では保持そのものが動かない**が、
 * Android には 1Hz の測位が届いている（`docs/unverified.md` 22）。
 *
 * **`./location.ts` から使う。**このファイルは expo-location を知らないので Vitest で回る。
 */

import type { SelfMessage } from "../v2v/messages";

/** 保持の仕方。**しきい値をコードに直書きしない**（`CLAUDE.md`）。 */
export type FixHoldConfig = {
  /**
   * 直近の測位を使い続けてよい長さ（ミリ秒）。**これを過ぎたら黙る。**
   *
   * **赤信号より長く、鞄の中で測位が死んだまま1回の走行を送り切るより短く。**
   * 過ぎたあとは近傍の失効に任せ、**「分からない」を表明させる。**
   */
  maxHoldMs: number;
};

/** 既定値は仮の値（`docs/unverified.md`）。 */
export const fixHoldDefaults: FixHoldConfig = {
  maxHoldMs: 120_000,
};

/** 埋める周期（ミリ秒）。**中継の 1Hz そのもの**（`docs/interfaces/v2v.md`「送る間隔」）。 */
const INTERVAL_MS = 1_000;

/**
 * 本物の測位が**届かなくなって**からこれだけ経ったら埋め始める（ミリ秒）。
 *
 * **数えるのは「届いてからの時間」で、測位の `t` からの時間ではない。**`t` は測った時刻で、
 * 届くのはそれより遅い。**その遅れのぶんだけ「古い」と見えてしまう**ので、`t` を基準にすると
 * **本物が 1Hz で届いていても毎周期で埋めが割り込みうる。**割り込むと、埋めた点より
 * 古い `t` を持つ本物が `acceptSelf` に捨てられ（`../v2v/neighbors.ts`）、
 * **遅れが一定なら、それが走行の最後まで続く**（レビューで実際に再現した）。
 *
 * 1秒より少し長くしてあるのは、**本物を先に通し、遅れたぶんだけを埋める**ため。
 */
const STALE_MS = 1_200;

/**
 * 直近の測位を「いまの測位」にする。**上限を過ぎていれば `null`。**
 *
 * **`t` を進めるのが肝心。**測位した時刻のまま送り直すと、受信側も送り主自身も
 * 「同じか古い `t`」として捨て（`docs/interfaces/v2v.md`「受信側（モバイル）の約束」）、
 * **近傍からは消えないのに検知が1つも動かない**状態になる。
 *
 * **進めるのは「届かなくなってからの時間」ぶんで、時計の「いま」ではない。**
 * `t` は測った時刻なので、時計の「いま」を入れると**届くまでの遅れのぶんだけ未来に出る**
 * ——飛んでいる最中の本物を追い越し、その本物が捨てられる（`STALE_MS`）。
 *
 * **`spd` は 0、`crs` は `null`。**前の値を持ち越すと、止まっている自転車が
 * 「その向きに走っている」ことになる。
 *
 * @param sinceMs 直近の測位が**届いてから**の時間（ミリ秒）
 */
export function heldFrom(
  last: SelfMessage,
  sinceMs: number,
  config: FixHoldConfig = fixHoldDefaults,
): SelfMessage | null {
  if (sinceMs > config.maxHoldMs) return null;
  return { ...last, t: last.t + sinceMs, spd: 0, crs: null };
}

/** 保持を動かしている間の口。 */
export type FixHold = {
  /**
   * **本物の測位が届いたら渡す。**これが埋める元になる。
   *
   * **古い `t` のものは受け取らない。**`TaskManager` は測位を**まとめて**届けるので
   * （`./location.ts`）、**並びが前後すると `t` が巻き戻る**——巻き戻ると、
   * そのぶん「古い」ことになって埋めが割り込み、次の本物を捨てさせる。
   */
  keep: (fix: SelfMessage) => void;
  /** 止める。**走行を閉じるときに必ず呼ぶ** */
  stop: () => void;
};

/**
 * 埋め始める。**本物が来ていない周期だけ `deliver` を呼ぶ。**
 *
 * **React を知らない。**`setInterval` を直に使うので Vitest の擬似タイマーで回せる
 * （`./idle-heartbeat.ts` と同じ形）。
 *
 * @param deliver 埋めた測位1点ぶん。**本物と同じ扱いで下流へ流してよい形**にしてある
 */
export function startFixHold(
  deliver: (fix: SelfMessage) => void,
  config: FixHoldConfig = fixHoldDefaults,
): FixHold {
  let last: SelfMessage | null = null;
  /** `last` が**届いた**時刻（測った時刻ではない。`STALE_MS`） */
  let keptAt = 0;

  const timer = setInterval(() => {
    // **一度も測位が取れていなければ埋めない。**埋める元が無い。
    if (last === null) return;
    const since = Date.now() - keptAt;
    // 本物が届いたばかりなら、そちらに任せる（`STALE_MS`）。
    if (since < STALE_MS) return;
    // **上限を過ぎたら黙る。**周期ごとにここで止まり続ける（次の本物まで戻らない）。
    const held = heldFrom(last, since, config);
    if (held !== null) deliver(held);
  }, INTERVAL_MS);

  return {
    keep: (fix) => {
      // **巻き戻る `t` を受け取らない**（上の注記。まとめて届いた並びが前後する）。
      if (last !== null && fix.t <= last.t) return;
      last = fix;
      keptAt = Date.now();
    },
    stop: () => clearInterval(timer),
  };
}
