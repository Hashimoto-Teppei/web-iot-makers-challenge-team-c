/**
 * Worker 役。**Durable Object の振る舞いをメモリの中で模す。**
 *
 * 実機ではスマホが 1Hz で `POST /v2v/exchange` を叩き、DO が近傍の `peer` を返す
 * （`docs/interfaces/mobile-api.md`）。開発機ではこれがその代わりになる。
 * **検知は、データがどこから来たかを知らない**ので、差し替わるのは配線だけである。
 *
 * **本番の実装ではない。**`apps/web` の DO と同じ約束をなぞってあるが、正本はあちら。
 * 食い違いに気づいたら、あちらを直すのか、ここを直すのかを PR で分けること。
 */

import { distanceM } from "../detect/geo";
import type { PeerMessage, SelfMessage } from "../v2v/messages";

/** DO 側の設定。**既定値は仮の値**（`docs/interfaces/mobile-api.md`）。 */
export type WorldConfig = {
  /**
   * この半径の中にいる相手を返す（メートル）。
   *
   * 検知に必要なのは 50m 程度だが、接近の履歴を作る余裕を足して広めにしてある。
   * 受け取った `peer` はスマホの中に留まり BLE へは流れないので、広げても増えるのは
   * JSON のバイト数とスマホの計算量だけ。
   */
  radiusM: number;
  /**
   * 最後に届いてからこの時間が過ぎた相手を配るのをやめる（ミリ秒）。
   *
   * **モバイル側の失効（`../v2v/neighbors.ts` の `peerExpireMs`）とは足し算になる。**
   * 2つの値を別々に決めないこと。
   */
  expireMs: number;
};

export const worldDefaults: WorldConfig = {
  radiusM: 300,
  expireMs: 3_000,
};

/** DO のメモリに置く1台ぶん。`arrivedAt` は**受け取った側**が打つ。 */
type Entry = {
  msg: SelfMessage;
  /**
   * DO が受け取った時刻（UTC ミリ秒）。
   *
   * **失効の判定に `t` を使わない。**`t` は送ってきた端末の時計で打たれた値であり、
   * 時計が失効ぶん以上ずれている端末は、入れた瞬間に失効して「全員から永久に見えない」
   * 状態になる。しかも本人の画面では POST が成功し続けるので気づけない
   * （`docs/interfaces/mobile-api.md`）。
   */
  arrivedAt: number;
};

/**
 * 生きている端末を保つ入れ物。
 *
 * **状態はメモリ上の Map だけ。**永続化しない（飛んでも1秒で全員が再 POST する）。
 */
export class World {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly config: WorldConfig = worldDefaults) {}

  /**
   * 1回の交換。**この順で行う**（`docs/interfaces/mobile-api.md`）。
   *
   * 1. 失効した相手を捨てる
   * 2. 自分を更新し、受け取った時刻を DO 側で打つ
   * 3. 半径内かつ自分以外を返す
   *
   * @param id 送ってきた端末の ID
   * @param msg 送られてきた `self`
   * @param arrivedAt DO が受け取った時刻（UTC ミリ秒）
   * @returns その端末に返す `peer` の配列。**自分は入らない**
   */
  exchange(id: string, msg: SelfMessage, arrivedAt: number): PeerMessage[] {
    for (const [entryId, entry] of this.entries) {
      if (arrivedAt - entry.arrivedAt > this.config.expireMs) this.entries.delete(entryId);
    }

    this.entries.set(id, { msg, arrivedAt });

    const peers: PeerMessage[] = [];
    for (const [entryId, entry] of this.entries) {
      // 自分を返さない。スマホ側にも同じ防御があるが、送らない側で止めるのが先。
      if (entryId === id) continue;
      const away = distanceM(msg.lat, msg.lon, entry.msg.lat, entry.msg.lon);
      if (away > this.config.radiusM) continue;
      // `t` は中身として通すだけ。DO が打ち直さない。
      const { k: _k, ...rest } = entry.msg;
      peers.push({ k: "peer", id: entryId, ...rest });
    }
    return peers;
  }
}
