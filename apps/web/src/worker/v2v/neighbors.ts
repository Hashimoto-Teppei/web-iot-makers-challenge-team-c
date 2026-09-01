import { DurableObject } from "cloudflare:workers";
import { distanceM } from "../geo";
import { type NeighborConfig, neighborDefaults } from "./config";
import type { PeerMessage, SelfMessage } from "./messages";

/**
 * 走行中の近傍を保つ。
 *
 * **状態はメモリ上の `Map` だけ。永続化しない**（`docs/interfaces/mobile-api.md`）。
 * 飛んでも1秒で直る（全員が再 POST する）ので永続化する理由がなく、位置情報は
 * **消える方が既定であること自体が安全**である（`CLAUDE.md`）。
 */

/** 1台ぶんの控え。 */
type Entry = {
  /**
   * **この Durable Object に届いた時刻**（UTC ミリ秒）。失効を測るのはこちら。
   *
   * **`fix.t` で測らない。**あれは送ってきた端末の時計で打たれた値なので、時計が
   * 失効ぶん以上ずれている端末は入れた瞬間に失効し、「全員から永久に見えない」状態になる。
   * しかも本人の POST は成功し続けるので気づけない（`docs/interfaces/mobile-api.md`）。
   */
  rxAt: number;
  /** 受け取った測位。中身はそのまま通す（`t` を打ち直さない） */
  fix: SelfMessage;
};

/**
 * 近傍の表。**Workers の API を何も知らない**ので、開発機でそのままテストできる
 * （`docs/adr/0002-development-lifecycle.md`）。
 *
 * 「いま」を引数で受け取り、中で `Date.now()` を呼ばない。時刻を進めたテストが書ける。
 */
export class NeighborTable {
  readonly #entries = new Map<string, Entry>();
  readonly #config: NeighborConfig;

  constructor(config: NeighborConfig) {
    this.#config = config;
  }

  /**
   * 1回の交換。**この順で行う**（`docs/interfaces/mobile-api.md`）。
   *
   * 1. 失効した相手を捨てる
   * 2. 自分を更新し、受け取った時刻をこちら側で打つ
   * 3. 半径内かつ自分以外を返す
   *
   * **`await` を1つも入れない。**Durable Object は単一スレッドだが `await` のたびに
   * 他のリクエストが割り込めるため、`await` が無ければ競合が構造的に起きない。
   * ストレージや D1 を触ると必ず `await` が入るので、ここでは触らない。
   *
   * @param id 名乗った端末ID
   * @param fix 受け取った自車の測位
   * @param now この Durable Object の時計の「いま」（UTC ミリ秒）
   */
  exchange(id: string, fix: SelfMessage, now: number): PeerMessage[] {
    for (const [key, entry] of this.#entries) {
      // 反復の途中で削除してよい（Map の反復は削除に対して安全）。
      if (now - entry.rxAt > this.#config.expiryMs) this.#entries.delete(key);
    }

    this.#entries.set(id, { rxAt: now, fix });

    const peers: PeerMessage[] = [];
    for (const [peerId, entry] of this.#entries) {
      // **自分を返さない。**返すと受け取った側が自分自身を「距離 0 で並走する自転車」
      // として検知する。スマホ側にも同じ防御があるが、送らない側で止めるのが先。
      if (peerId === id) continue;
      if (distanceM(fix.lat, fix.lon, entry.fix.lat, entry.fix.lon) > this.#config.radiusM) {
        continue;
      }
      const { k: _k, ...rest } = entry.fix;
      peers.push({ k: "peer", id: peerId, ...rest });
    }
    return peers;
  }

  /** いま控えている台数。テストと、後で様子を見るためだけに使う。 */
  get size(): number {
    return this.#entries.size;
  }
}

/**
 * 近傍を保つ Durable Object。**インスタンスは1個だけ**
 * （`config.ts` の `NEIGHBORS_DO_NAME`）。
 *
 * **`fetch()` ハンドラにしない。**`fetch()` にすると引数を取り出すのに
 * `await request.json()` が要り、上の「`await` を入れない」が成立しなくなる。
 * RPC なら引数が復元済みで渡る（`docs/interfaces/mobile-api.md`）。
 */
export class NeighborsDO extends DurableObject<Env> {
  readonly #table = new NeighborTable(neighborDefaults);

  /**
   * 到着時刻を**この Durable Object の時計で打つ**。呼び出し側から時刻を渡させない
   * （渡させると、送ってきた端末の時計を使うのと同じことになる）。
   */
  exchange(id: string, fix: SelfMessage): PeerMessage[] {
    return this.#table.exchange(id, fix, Date.now());
  }
}
