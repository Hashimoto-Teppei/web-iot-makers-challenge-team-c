import { describe, expect, it } from "vitest";
import { NeighborStore, type NeighborsConfig, neighborsDefaults } from "./neighbors";

const ME = "a1000001";
const OTHER = "b2000002";
const THIRD = "c3000003";

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);

/** 通る `self`。時刻と位置だけを差し替えて使う。 */
const self = (t: number, lat = 34.6617, lon = 133.9344) => ({
  k: "self" as const,
  t,
  lat,
  lon,
  spd: 4.0,
  crs: 0,
  hacc: 4.0,
});

const peer = (id: string, t: number, lat = 34.6618, lon = 133.9344) => ({
  ...self(t, lat, lon),
  k: "peer" as const,
  id,
});

/** 自車の測位が入っているだけの店。多くのテストがここから始まる。 */
const storeWithSelf = (config?: Partial<NeighborsConfig>) => {
  const store = new NeighborStore(ME, { ...neighborsDefaults, ...config });
  store.acceptSelf(self(T0), T0);
  return store;
};

describe("acceptSelf", () => {
  it("自車の測位が無い間は入力を作らない（検知を1つも呼ばない）", () => {
    const store = new NeighborStore(ME);
    expect(store.detectorInput(T0)).toBeNull();
  });

  it("測位が古くなったら入力を作らなくなる", () => {
    const store = storeWithSelf({ selfStaleMs: 3_000 });
    expect(store.detectorInput(T0 + 3_000)).not.toBeNull();
    expect(store.detectorInput(T0 + 3_001)).toBeNull();
  });

  it("自車の測位が無い間は peer を持たない", () => {
    const store = storeWithSelf({ selfStaleMs: 3_000 });
    store.acceptPeers([peer(OTHER, T0)], T0);
    expect(store.detectorInput(T0)?.peers).toHaveLength(1);

    // 測位が止まったまま時間が進む。相手はまだ送ってきているが、自車が無ければ
    // どの検知も成立しないので持たない（受信側の約束 7）。
    store.acceptPeers([peer(OTHER, T0 + 4_000)], T0 + 4_000);
    expect(store.detectorInput(T0 + 4_000)).toBeNull();

    // 測位が戻れば、そこからやり直せる（旗にしない）。
    store.acceptSelf(self(T0 + 5_000), T0 + 5_000);
    expect(store.detectorInput(T0 + 5_000)?.peers).toHaveLength(0);
  });

  it("同じか古い t の測位は捨てる", () => {
    const store = storeWithSelf();
    expect(store.acceptSelf(self(T0), T0 + 1_000)).toBe(false);
    expect(store.acceptSelf(self(T0 - 1), T0 + 1_000)).toBe(false);
    expect(store.acceptSelf(self(T0 + 1), T0 + 1_000)).toBe(true);
  });

  it("時計が未来へ跳んだ測位を採用しても、やがて元に戻る", () => {
    // 跳んだ 1 通を採用したあと、後続の測位は「同じか古い」として全部捨てられる。
    // 自車の履歴を捨てる道が無いと、**測位が戻っても二度と入力を作れない。**
    // このとき `beat` は `st: "ok"` のままなので、人からは正常に見えたまま黙る。
    const store = new NeighborStore(ME, { ...neighborsDefaults, selfStaleMs: 3_000 });
    store.acceptSelf(self(T0 + 60_000), T0);

    // 正常な測位が毎秒入り続けても、跳んだ `t` を追い越すまでは採用されない
    // （履歴が跳んだ 1 点のまま伸びない）。
    for (let i = 1; i <= 3; i += 1) store.acceptSelf(self(T0 + i * 1_000), T0 + i * 1_000);
    expect(store.detectorInput(T0 + 3_000)?.self.fixes).toHaveLength(1);

    // 採用できないまま古くなるので、いったん黙る。
    expect(store.detectorInput(T0 + 3_001)).toBeNull();

    // **そこで履歴ごと捨てる。**捨てないと、このあと何通来ても採用されない。
    store.acceptSelf(self(T0 + 5_000), T0 + 5_000);
    expect(store.detectorInput(T0 + 5_000)?.self.fixes).toHaveLength(1);
  });

  it("壊れた測位は取り込まない", () => {
    const store = new NeighborStore(ME);
    expect(store.acceptSelf({ k: "self", t: T0, lat: 999 }, T0)).toBe(false);
    expect(store.detectorInput(T0)).toBeNull();
  });
});

describe("acceptPeers", () => {
  it("自分の id を持つ peer は捨てる（自分自身を並走する自転車にしない）", () => {
    const store = storeWithSelf();
    store.acceptPeers([peer(ME, T0)], T0);
    expect(store.detectorInput(T0)?.peers).toHaveLength(0);
  });

  it("id ごとに覚えるので、複数台が残る", () => {
    // 1つの変数で持つと一番新しい1台ぶんしか残らず、近傍が常に1台になる。
    const store = storeWithSelf();
    store.acceptPeers([peer(OTHER, T0), peer(THIRD, T0 + 10)], T0);
    expect(
      store
        .detectorInput(T0)
        ?.peers.map((p) => p.id)
        .sort(),
    ).toEqual([OTHER, THIRD]);
  });

  it("同じか古い t の peer は捨てる（相手ごとに t を覚える）", () => {
    const store = storeWithSelf();
    store.acceptPeers([peer(OTHER, T0 + 1_000)], T0 + 1_000);
    store.acceptPeers([peer(OTHER, T0 + 500)], T0 + 1_100);
    store.acceptPeers([peer(OTHER, T0 + 1_000)], T0 + 1_200);
    expect(store.detectorInput(T0 + 1_200)?.peers[0]?.fixes).toHaveLength(1);
  });

  it("壊れた1通を捨てても、同じレスポンスの残りは取り込む", () => {
    const store = storeWithSelf();
    store.acceptPeers([{ k: "peer", id: OTHER, lat: "34.6" }, null, peer(THIRD, T0)], T0);
    expect(store.detectorInput(T0)?.peers.map((p) => p.id)).toEqual([THIRD]);
  });

  it("crs が null の相手を捨てない（止まっている自転車が消える）", () => {
    const store = storeWithSelf();
    store.acceptPeers([{ ...peer(OTHER, T0), spd: 0, crs: null }], T0);
    expect(store.detectorInput(T0)?.peers[0]?.fixes[0]?.crs).toBeNull();
  });
});

describe("失効", () => {
  it("最後に受信してから peerExpireMs を過ぎた相手を近傍から消す", () => {
    const store = storeWithSelf({ peerExpireMs: 3_000, selfStaleMs: 60_000 });
    store.acceptPeers([peer(OTHER, T0)], T0);
    expect(store.detectorInput(T0 + 3_000)?.peers).toHaveLength(1);
    expect(store.detectorInput(T0 + 3_001)?.peers).toHaveLength(0);
  });

  it("消すときに覚えていた t も捨てる（戻ってきた相手を捨て続けない）", () => {
    const store = storeWithSelf({ peerExpireMs: 3_000, selfStaleMs: 60_000 });
    store.acceptPeers([peer(OTHER, T0 + 5_000)], T0);
    store.detectorInput(T0 + 4_000); // ここで失効する

    // 相手の時計が戻った（あるいは再起動して t を打ち直した）状況。t を覚えたままだと、
    // この相手は二度と近傍に入れない。
    store.acceptPeers([peer(OTHER, T0 + 100)], T0 + 4_100);
    expect(store.detectorInput(T0 + 4_100)?.peers).toHaveLength(1);
  });

  it("毎秒届いているが測位が固まっている相手を失効させない", () => {
    // 失効は「最後に受信してから」。採用した点の rxAt で測ると、同じ `t` が届き続ける
    // 相手が3秒で消えて次の1通で入り直す（点滅する）。履歴が常に1点になり、
    // **接近速度も減速度も原理的に出せなくなる。**止まっている自転車は #9 が
    // 一番見たい相手なので、そこで静かに効かなくなる。
    const store = storeWithSelf({ peerExpireMs: 3_000, selfStaleMs: 60_000 });
    store.acceptPeers([{ ...peer(OTHER, T0), spd: 0, crs: null }], T0);
    for (let i = 1; i <= 8; i += 1) {
      store.acceptSelf(self(T0 + i * 1_000), T0 + i * 1_000);
      store.acceptPeers([{ ...peer(OTHER, T0), spd: 0, crs: null }], T0 + i * 1_000);
      expect(store.detectorInput(T0 + i * 1_000)?.peers).toHaveLength(1);
    }
  });

  it("届かなくなれば失効する（受信を止めたときだけ消える）", () => {
    const store = storeWithSelf({ peerExpireMs: 3_000, selfStaleMs: 60_000 });
    store.acceptPeers([peer(OTHER, T0)], T0);
    expect(store.detectorInput(T0 + 3_000)?.peers).toHaveLength(1);
    expect(store.detectorInput(T0 + 3_001)?.peers).toHaveLength(0);
  });

  it("失効は受信した時刻で測る（相手の t ではない）", () => {
    // 時計が大きくずれている端末。t で測ると入れた瞬間に失効し、
    // 「全員から永久に見えない」状態になる。
    const store = storeWithSelf({ peerExpireMs: 3_000, selfStaleMs: 60_000 });
    store.acceptPeers([peer(OTHER, T0 - 3_600_000)], T0);
    expect(store.detectorInput(T0 + 1_000)?.peers).toHaveLength(1);
  });
});

describe("履歴", () => {
  it("historyMs より古い点を落とす", () => {
    const store = new NeighborStore(ME, { ...neighborsDefaults, historyMs: 5_000 });
    for (let i = 0; i <= 8; i += 1) store.acceptSelf(self(T0 + i * 1_000), T0 + i * 1_000);

    const fixes = store.detectorInput(T0 + 8_000)?.self.fixes;
    // 8秒目から見て 5 秒ぶん（3〜8秒）が残る。
    expect(fixes?.map((f) => f.t)).toEqual([3, 4, 5, 6, 7, 8].map((s) => T0 + s * 1_000));
  });

  it("古い順に並び、末尾が最新になる", () => {
    const store = storeWithSelf();
    store.acceptSelf(self(T0 + 1_000), T0 + 1_000);
    const fixes = store.detectorInput(T0 + 1_000)?.self.fixes ?? [];
    expect(fixes.at(-1)?.t).toBe(T0 + 1_000);
    expect(fixes[0]?.t).toBe(T0);
  });

  it("rxAt は受け取った側が打つ（相手の t とは別）", () => {
    const store = storeWithSelf();
    store.acceptPeers([peer(OTHER, T0 - 500)], T0);
    const fix = store.detectorInput(T0)?.peers[0]?.fixes[0];
    expect(fix?.t).toBe(T0 - 500);
    expect(fix?.rxAt).toBe(T0);
  });
});

describe("detectorInput", () => {
  it("now は自分の時計をそのまま渡す", () => {
    expect(storeWithSelf().detectorInput(T0 + 1_234)?.now).toBe(T0 + 1_234);
  });

  it("標識をそのまま渡す（絞るのは呼び出し側）", () => {
    const signs = [{ id: "s1", lat: 34.66, lon: 133.93 }];
    expect(storeWithSelf().detectorInput(T0, signs)?.signs).toEqual(signs);
  });

  it("peers が空でも入力は作る（空は「分からない」であって「安全」ではない）", () => {
    expect(storeWithSelf().detectorInput(T0)?.peers).toEqual([]);
  });
});
