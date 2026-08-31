import { describe, expect, it } from "vitest";
import type { NeighborConfig } from "./config";
import type { SelfMessage } from "./messages";
import { NeighborTable } from "./neighbors";

// テストは実測値に左右されない値で書く（既定値を変えてもここは壊れない）。
const config: NeighborConfig = { radiusM: 300, expiryMs: 3_000 };

// 岡山駅のあたり。緯度 0.001 度 ≒ 111m なので、0.005 度離せば半径の外に出る。
const BASE_LAT = 34.6617512;
const BASE_LON = 133.9344061;

/** 測位1点。指定しなかった項目は「まっとうな走行中の自転車」で埋める。 */
function fix(over: Partial<SelfMessage> = {}): SelfMessage {
  return {
    k: "self",
    t: 1_756_123_456_789,
    lat: BASE_LAT,
    lon: BASE_LON,
    spd: 5.24,
    crs: 118.4,
    hacc: 4,
    ...over,
  };
}

describe("NeighborTable", () => {
  it("自分は返さない（返すと相手が自分自身を並走する自転車として検知する）", () => {
    const table = new NeighborTable(config);

    const peers = table.exchange("aaaaaaaa", fix(), 1_000);

    expect(peers).toEqual([]);
    expect(table.size).toBe(1);
  });

  it("半径内の他車を返す", () => {
    const table = new NeighborTable(config);
    table.exchange("aaaaaaaa", fix({ lat: BASE_LAT + 0.001 }), 1_000);

    const peers = table.exchange("bbbbbbbb", fix(), 1_100);

    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ k: "peer", id: "aaaaaaaa", lat: BASE_LAT + 0.001 });
  });

  it("半径の外の相手は返さない", () => {
    const table = new NeighborTable(config);
    table.exchange("aaaaaaaa", fix({ lat: BASE_LAT + 0.005 }), 1_000);

    const peers = table.exchange("bbbbbbbb", fix(), 1_100);

    expect(peers).toEqual([]);
    // 半径の外にいるだけで、控え自体は残る（近づいてきたら返せるように）。
    expect(table.size).toBe(2);
  });

  it("最後に届いてから失効ぶんが過ぎた相手は返さず、控えからも消す", () => {
    const table = new NeighborTable(config);
    table.exchange("aaaaaaaa", fix(), 1_000);

    const peers = table.exchange("bbbbbbbb", fix(), 1_000 + config.expiryMs + 1);

    expect(peers).toEqual([]);
    expect(table.size).toBe(1);
  });

  it("失効の直前ならまだ返す", () => {
    const table = new NeighborTable(config);
    table.exchange("aaaaaaaa", fix(), 1_000);

    const peers = table.exchange("bbbbbbbb", fix(), 1_000 + config.expiryMs);

    expect(peers).toHaveLength(1);
  });

  it("送り続けている限り失効しない（届くたびに到着時刻を打ち直す）", () => {
    const table = new NeighborTable(config);
    table.exchange("aaaaaaaa", fix(), 1_000);
    table.exchange("aaaaaaaa", fix(), 3_000);

    const peers = table.exchange("bbbbbbbb", fix(), 3_500);

    expect(peers).toHaveLength(1);
  });

  it("失効を `t` で測らない（時計が大きくずれた端末も見える）", () => {
    const table = new NeighborTable(config);
    // 端末の時計が1日ぶんずれている。`t` で測ると入れた瞬間に失効し、
    // **本人の POST は成功し続けるのに全員から永久に見えなくなる。**
    table.exchange("aaaaaaaa", fix({ t: 1_756_123_456_789 - 86_400_000 }), 1_000);

    const peers = table.exchange("bbbbbbbb", fix(), 1_100);

    expect(peers).toHaveLength(1);
    // `t` は中身としてそのまま通す（打ち直さない）。相手の履歴の間隔はこれで測る。
    expect(peers[0]?.t).toBe(1_756_123_456_789 - 86_400_000);
  });

  it("複数台を id ごとに保つ（1台ぶんで上書きしない）", () => {
    const table = new NeighborTable(config);
    table.exchange("aaaaaaaa", fix({ lat: BASE_LAT + 0.0001 }), 1_000);
    table.exchange("bbbbbbbb", fix({ lat: BASE_LAT + 0.0002 }), 1_010);

    const peers = table.exchange("cccccccc", fix(), 1_020);

    expect(peers.map((p) => p.id).sort()).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("同じ id の再送は位置を更新する（履歴として溜めない）", () => {
    const table = new NeighborTable(config);
    table.exchange("aaaaaaaa", fix({ lat: BASE_LAT + 0.0001 }), 1_000);
    table.exchange("aaaaaaaa", fix({ lat: BASE_LAT + 0.0002 }), 1_100);

    const peers = table.exchange("bbbbbbbb", fix(), 1_200);

    expect(peers).toHaveLength(1);
    expect(peers[0]?.lat).toBe(BASE_LAT + 0.0002);
  });

  it("`crs` が null の相手も返す（止まっている自転車を消さない）", () => {
    const table = new NeighborTable(config);
    table.exchange("aaaaaaaa", fix({ spd: 0, crs: null }), 1_000);

    const peers = table.exchange("bbbbbbbb", fix(), 1_100);

    expect(peers[0]?.crs).toBeNull();
  });
});
