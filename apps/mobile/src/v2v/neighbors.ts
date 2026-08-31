/**
 * 近傍の状態を保つ。
 *
 * **`docs/interfaces/v2v.md`「受信側（モバイル）の約束」の実装。**守らないと検知が壊れる
 * ことだけがあちらに書いてあり、ここはそれを機械にしたもの。**秒数の理由をここに写さない。**
 *
 * **測位と HTTP を触る層から分けてある**（`docs/interfaces/v2v.md`「層を分ける」）。
 * ここは受け取った JSON を検証して溜めるだけなので、React Native を知らず、開発機で
 * そのままテストできる。シミュレータ（`../sim/`）が渡すのも実機の HTTP が渡すのも同じ形。
 *
 * **検知はここに置かない。**ここが作るのは `DetectorInput` までで、何を危険と見なすかは
 * `../detect/` が決める（`docs/interfaces/detectors.md`）。
 */

import type { DetectorInput, Fix, StopSign, Track } from "../detect/types";
import { type MessageLimits, messageLimitDefaults, parsePeer, parseSelf } from "./messages";

/**
 * 近傍の保ち方。**しきい値をコードに直書きしない**（`CLAUDE.md`）。
 *
 * **既定値はすべて仮の値**で、実走行で測って決め直す（`docs/unverified.md` 29 / 36）。
 */
export type NeighborsConfig = {
  /**
   * 最後に受信してからこの時間が過ぎた相手を、近傍から消す（ミリ秒）。
   *
   * **サーバー側の失効に足し算で乗る**（`docs/interfaces/mobile-api.md`）ので、
   * **2つの値は合計で決めること。**片方だけを縮めても幻は半分しか消えない。
   */
  peerExpireMs: number;
  /**
   * 自車の測位がこの時間より古くなったら「測位が無い」とみなす（ミリ秒）。
   *
   * このとき検知を1つも呼ばず、`peers` も持たない（約束 7）。人に見えるのは
   * `beat` の `st: "nofix"` である。
   */
  selfStaleMs: number;
  /**
   * 履歴を保つ長さ（ミリ秒）。
   *
   * 減速度（#10）を出すには数点要るが、長く持つほど古い点を含んだ平均が鈍る。
   */
  historyMs: number;
  /** メッセージを通す範囲 */
  limits: MessageLimits;
};

export const neighborsDefaults: NeighborsConfig = {
  peerExpireMs: 3_000,
  selfStaleMs: 3_000,
  historyMs: 5_000,
  limits: messageLimitDefaults,
};

/** 1台ぶんの履歴。`lastT` と `lastRxAt` は `fixes` とは別に覚える。 */
type Held = {
  fixes: Fix[];
  /**
   * 採用した最新の `t`（約束 4）。
   *
   * `fixes` の末尾から読めそうに見えるが、**履歴のトリムで `fixes` が短くなっても
   * この値は残す**必要がある。設定次第で `historyMs` が `peerExpireMs` より短くなると、
   * 末尾から読む実装では古い `t` を採用し直してしまう。
   */
  lastT: number;
  /**
   * **最後にこの相手の通を受け取った時刻**（自分の時計）。失効はこれで測る（約束 6）。
   *
   * **採用した点の `rxAt` ではない。**古い `t` を捨てたときも、届いたこと自体は
   * ここに記録する。捨てた通で伸ばさないと、**測位が固まっている相手が毎秒届いて
   * いるのに失効し、次の1通で履歴ゼロの新規として入り直す**（点滅する）。
   * その相手は #9 が一番見たい「止まっている自転車」なので、そこで静かに効かなくなる。
   */
  lastRxAt: number;
};

/** 古い順に並んだ `Fix` の配列から `Track` を作る。空なら `null`（空の `Track` を作らない）。 */
function toTrack(id: string, fixes: readonly Fix[]): Track | null {
  const [head, ...rest] = fixes;
  return head === undefined ? null : { id, fixes: [head, ...rest] };
}

/**
 * 近傍と自車の履歴を保つ入れ物。
 *
 * **状態を持つのはここだけ。**検知は純粋な関数で、前回の呼び出しを覚えない
 * （`docs/interfaces/detectors.md`「状態を持たない」）。4つの検知が同じ履歴を必要とする
 * ので、各自が持つと同じものが4組でき、どれが最新かが場所によって違う状態が生まれる。
 */
export class NeighborStore {
  private readonly selfFixes: Fix[] = [];
  private readonly peers = new Map<string, Held>();

  /**
   * @param selfId 自分の端末ID。**接続中のデバイスから読んだ `device_id`**であって、
   *   スマホ側で作った別の ID ではない（`docs/interfaces/v2v.md`）
   * @param config しきい値。既定は {@link neighborsDefaults}
   */
  constructor(
    private readonly selfId: string,
    private readonly config: NeighborsConfig = neighborsDefaults,
  ) {}

  /**
   * 自車の測位を取り込む。
   *
   * @param message `self` メッセージ（検証はここで行うので、生の値を渡してよい）
   * @param rxAt この測位を手にした時刻（**自分の時計**の UTC ミリ秒）
   * @returns 取り込めたか。捨てたときは `false`
   */
  acceptSelf(message: unknown, rxAt: number): boolean {
    const msg = parseSelf(message, this.config.limits);
    if (msg === null) return false;

    const last = this.selfFixes.at(-1);
    // 自車も新旧を `t` で見る。測位が固まって同じ値を返し続けても履歴が伸びないので、
    // 「点は増えているのに動いていない」という履歴を検知に渡さずに済む。
    if (last !== undefined && msg.t <= last.t) return false;

    this.selfFixes.push({ ...toFix(msg), rxAt });
    return true;
  }

  /**
   * レスポンスの `peer` を取り込む。**壊れた1通で落ちないこと。**
   *
   * @param messages `peer` の配列（検証はここで行う）
   * @param rxAt レスポンスを受け取った時刻（**自分の時計**の UTC ミリ秒）
   */
  acceptPeers(messages: readonly unknown[], rxAt: number): void {
    for (const message of messages) {
      const msg = parsePeer(message, this.config.limits);
      if (msg === null) continue;
      // 自分の id を持つ `peer` は捨てる（約束 1）。捨てないと自分自身を
      // 「距離 0 で並走する自転車」として検知する。
      if (msg.id === this.selfId) continue;

      const held = this.peers.get(msg.id);
      if (held === undefined) {
        this.peers.set(msg.id, { fixes: [{ ...toFix(msg), rxAt }], lastT: msg.t, lastRxAt: rxAt });
        continue;
      }
      // **届いたこと自体を先に記録する。**失効は「最後に受信してから」測るので、
      // このあと `t` で捨てる通でも受信時刻は伸ばす（`Held.lastRxAt`）。
      held.lastRxAt = rxAt;
      // 同じか古い `t` は捨てる（約束 4）。`id` ごとに覚えているので、1つの変数で
      // 持ったときのように「一番新しい1台ぶんしか残らない」ことにはならない。
      if (msg.t <= held.lastT) continue;
      held.fixes.push({ ...toFix(msg), rxAt });
      held.lastT = msg.t;
    }
  }

  /**
   * 失効した相手と、古すぎる履歴を落とす。
   *
   * {@link detectorInput} が先に呼ぶので、通常は呼び出し側が明示的に呼ばなくてよい。
   * 単体で確かめたいときのために公開してある。
   *
   * @param now 自分の時計の「いま」（UTC ミリ秒）
   */
  prune(now: number): void {
    const { peerExpireMs, historyMs } = this.config;

    for (const [id, held] of this.peers) {
      // **最後に受信してから**失効した相手を消す。消さないと、届かなくなった自転車が
      // 「その場に止まっている自転車」として残り続け、通り過ぎたあとも警告が鳴る。
      // **覚えていた `t` も一緒に捨てる**ため、Map のエントリごと消す（残すと
      // 戻ってきた相手を捨て続ける）。
      if (now - held.lastRxAt > peerExpireMs) {
        this.peers.delete(id);
        continue;
      }
      trimOlderThan(held.fixes, now - historyMs);
    }

    trimOlderThan(this.selfFixes, now - historyMs);

    if (this.isSelfStale(now)) {
      // 自車の測位が無い間は `peer` を近傍として持たない（約束 7）。自車の位置が
      // 無ければどの検知も成立しないので、持っても意味がない。
      this.peers.clear();
      // **自車の履歴も捨てる。**残すと、時計が跳んだ1通（未来の `t`）を採用したあと
      // 後続の測位が「同じか古い」として全部捨てられ、**測位が戻っても二度と入力を
      // 作れなくなる。**`peer` は失効で Map ごと消えて覚えた `t` も落ちるのに、
      // 自車にだけ戻る道が無いという形を避ける。**このとき `beat` は `st: "ok"` を
      // 書き続けるので、人からは正常に見えたまま4つの検知すべてが黙る。**
      this.selfFixes.length = 0;
    }
  }

  /**
   * 検知に渡す入力を組み立てる。
   *
   * **自車の測位が無い間は `null` を返す。**このとき検知を1つも呼ばないこと
   * （空の `self` を渡さない。`docs/interfaces/detectors.md`）。
   *
   * **返り値が `null` でないことは「周りが安全」を意味しない。**POST が失敗している間は
   * `peers` が空になるが、それは「相手が居ない」ではなく「分からない」である。
   *
   * @param now 自分の時計の「いま」（UTC ミリ秒）
   * @param signs 近傍の一時停止の標識。絞るのは呼び出し側の責務（#27 / #7）
   */
  detectorInput(now: number, signs: readonly StopSign[] = []): DetectorInput | null {
    this.prune(now);
    const self = toTrack(this.selfId, this.selfFixes);
    if (self === null || this.isSelfStale(now)) return null;

    const peers: Track[] = [];
    for (const [id, held] of this.peers) {
      const track = toTrack(id, held.fixes);
      if (track !== null) peers.push(track);
    }
    return { now, self, peers, signs };
  }

  /**
   * 自車の測位が生きているか。**`beat` の `st` はこれで決める。**
   *
   * **`detectorInput()` が `null` を返したことで代用しない。**あちらは自車の測位が
   * 無いときも、履歴が尽きたときも `null` を返す。心拍が伝えるのは「測位が取れているか」
   * だけなので、混ぜると**測位できているのに `nofix` を書く**ことになりうる
   * （`docs/interfaces/v2v.md`「心拍を必ず見せる」）。
   *
   * **状態を変えない。**心拍は毎秒書くので、ここで `prune()` を呼ぶと、走行ループの
   * 周期とは別の頻度で近傍が消えることになる。
   *
   * @param now 自分の時計の「いま」（UTC ミリ秒）
   */
  hasSelfFix(now: number): boolean {
    return !this.isSelfStale(now);
  }

  /** 自車の測位が古すぎるか（一度も無い場合も含む）。 */
  private isSelfStale(now: number): boolean {
    const last = this.selfFixes.at(-1);
    return last === undefined || now - last.rxAt > this.config.selfStaleMs;
  }
}

/** メッセージから `Fix` の位置ぶんを取り出す。`rxAt` は受け取った側が打つので含まない。 */
function toFix(msg: {
  t: number;
  lat: number;
  lon: number;
  spd: number;
  crs: number | null;
  hacc: number;
}): Omit<Fix, "rxAt"> {
  return { t: msg.t, lat: msg.lat, lon: msg.lon, spd: msg.spd, crs: msg.crs, hacc: msg.hacc };
}

/**
 * 先頭から、`rxAt` が `limit` より古い点を落とす（配列を直接縮める）。
 *
 * `fixes` は古い順なので先頭から見れば足りる。**最後の1点は残す**——履歴が尽きた
 * ことと相手が居なくなったことは別で、後者は失効が判定する。
 */
function trimOlderThan(fixes: Fix[], limit: number): void {
  let drop = 0;
  while (drop < fixes.length - 1 && (fixes[drop] as Fix).rxAt < limit) drop += 1;
  if (drop > 0) fixes.splice(0, drop);
}
