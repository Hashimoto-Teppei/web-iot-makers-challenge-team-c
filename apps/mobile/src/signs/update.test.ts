/**
 * 起動時の更新。**HTTP を通さずに回す**（`./update.ts` は取りに行く関数を受け取るだけ）。
 *
 * **確かめたいことの中心は「入れ替えないとき」である。**入れ替えられることより、
 * **壊れたもので手元を上書きしないこと**の方が、外れたときの被害が大きい——
 * 手元の標識が欠ければ、**一時停止の事前通知だけが黙り、デバイスの表示では気づけない。**
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StopSign } from "../detect/types";
import { createMemorySigns, type SignsMeta } from "./store";
import { type FetchStopSignsFn, updateStopSigns } from "./update";

const OLD_META: SignsMeta = {
  pref: 33,
  version: '"33.old"',
  count: 1,
  builtAt: "2026-08-01T00:00:00Z",
};

/** 岡山市内あたり。 */
const OLD_SIGN: StopSign = { id: "s-old", lat: 34.6612, lon: 133.9345, approach: null };
const NEW_SIGN: StopSign = {
  id: "s-new",
  lat: 34.6615,
  lon: 133.9348,
  approach: { lat: 34.6613, lon: 133.9348 },
};

const NOW = new Date("2026-09-02T00:00:00Z");

/** サーバーが返す JSON。**`count` と `signs` の件数はそろっている**（既定の正常な応答）。 */
function body(signs: readonly StopSign[], pref = 33): unknown {
  return { pref, version: "new", count: signs.length, signs };
}

function fresh() {
  return createMemorySigns([OLD_SIGN], OLD_META);
}

function run(
  fetchStopSigns: FetchStopSignsFn,
  signs = fresh(),
  options: { canReplace?: () => boolean; pref?: number } = {},
) {
  return updateStopSigns(signs.store, signs.writer, fetchStopSigns, { now: () => NOW, ...options });
}

describe("updateStopSigns", () => {
  it("手元の版を If-None-Match として渡す（端末で版を作らない）", async () => {
    const fetchStopSigns = vi.fn<FetchStopSignsFn>().mockResolvedValue({ kind: "not-modified" });
    await run(fetchStopSigns);

    expect(fetchStopSigns).toHaveBeenCalledWith({ pref: 33, version: '"33.old"' });
  });

  it("304 なら何もしない（同梱直後の最初の起動）", async () => {
    const signs = fresh();
    const outcome = await run(async () => ({ kind: "not-modified" }), signs);

    expect(outcome.status).toBe("not-modified");
    expect(outcome.error).toBeNull();
    expect(signs.store.meta()).toEqual(OLD_META);
  });

  it("新しい版なら丸ごと入れ替える", async () => {
    const signs = fresh();
    const outcome = await run(
      async () => ({ kind: "body", body: body([NEW_SIGN]), etag: '"33.new"' }),
      signs,
    );

    expect(outcome.status).toBe("replaced");
    expect(outcome.error).toBeNull();
    // **版はサーバーの ETag そのまま。**端末で作らない。
    expect(signs.store.meta()).toEqual({
      pref: 33,
      version: '"33.new"',
      count: 1,
      builtAt: NOW.toISOString(),
    });
    // **差分ではなく入れ替え。**古い標識は残らない。
    const ids = signs.store.near(34.6612, 133.9345).map((sign) => sign.id);
    expect(ids).toEqual(["s-new"]);
  });

  it("W/ 付きの ETag は剥がして持つ（毎回落とし直さないため）", async () => {
    const signs = fresh();
    await run(async () => ({ kind: "body", body: body([NEW_SIGN]), etag: 'W/"33.new"' }), signs);

    expect(signs.store.meta()?.version).toBe('"33.new"');
  });

  it("取りに行けなければ手元をそのまま使う", async () => {
    const signs = fresh();
    const outcome = await run(async () => ({ kind: "failed", message: "圏外です" }), signs);

    expect(outcome.status).toBe("failed");
    // **理由をそのまま出さない。****「手元のものを使う」ことを必ず添える**——
    // サーバーの「まだありません」をそのまま出すと、**この端末に標識が無い**と読まれる。
    expect(outcome.error).toContain("圏外です");
    expect(outcome.error).toContain("手元のものを使います");
    // **走行を止めない。**1か月古い標識でも道路の一時停止はほとんど変わらない。
    expect(signs.store.meta()).toEqual(OLD_META);
    expect(outcome.meta).toEqual(OLD_META);
  });

  it("件数が食い違う応答で入れ替えない（欠けたもので上書きしない）", async () => {
    const signs = fresh();
    const outcome = await run(
      async () => ({
        kind: "body",
        body: { pref: 33, version: "new", count: 99, signs: [NEW_SIGN] },
        etag: '"33.new"',
      }),
      signs,
    );

    expect(outcome.status).toBe("failed");
    expect(signs.store.meta()).toEqual(OLD_META);
  });

  it("0 件で入れ替えない（走れる端末を走れない端末に変えない）", async () => {
    const signs = fresh();
    const outcome = await run(
      async () => ({ kind: "body", body: body([]), etag: '"33.new"' }),
      signs,
    );

    expect(outcome.status).toBe("failed");
    expect(signs.store.meta()).toEqual(OLD_META);
  });

  it("別の県が返ったら入れ替えない（画面から見分けが付かなくなる）", async () => {
    const signs = fresh();
    const outcome = await run(
      async () => ({ kind: "body", body: body([NEW_SIGN], 34), etag: '"34.new"' }),
      signs,
    );

    expect(outcome.status).toBe("failed");
    expect(signs.store.meta()).toEqual(OLD_META);
  });

  it("ETag が無い応答で入れ替えない（次回の 304 が成立しなくなる）", async () => {
    const signs = fresh();
    const outcome = await run(
      async () => ({ kind: "body", body: body([NEW_SIGN]), etag: null }),
      signs,
    );

    expect(outcome.status).toBe("failed");
    expect(signs.store.meta()).toEqual(OLD_META);
  });

  it("標識を持っていなければ取りに行かない（API は更新だけを担う）", async () => {
    const fetchStopSigns = vi.fn<FetchStopSignsFn>();
    const outcome = await run(fetchStopSigns, createMemorySigns([], null));

    expect(fetchStopSigns).not.toHaveBeenCalled();
    expect(outcome.status).toBe("skipped");
    // **黙らない。**何をすればよいかを画面に出す。
    expect(outcome.error).not.toBeNull();
  });

  it("走行中は取りに行かない（1Hz の中継と同じ回線を奪わない）", async () => {
    const fetchStopSigns = vi.fn<FetchStopSignsFn>();
    const outcome = await run(fetchStopSigns, fresh(), { canReplace: () => false });

    expect(fetchStopSigns).not.toHaveBeenCalled();
    expect(outcome.status).toBe("skipped");
  });

  it("落としている間に走り出したら入れ替えない", async () => {
    const signs = fresh();
    let riding = false;
    const outcome = await run(
      async () => {
        // 取得に数秒かかる間に走り出した、という筋。
        riding = true;
        return { kind: "body", body: body([NEW_SIGN]), etag: '"33.new"' };
      },
      signs,
      { canReplace: () => !riding },
    );

    expect(outcome.status).toBe("skipped");
    expect(signs.store.meta()).toEqual(OLD_META);
  });

  it("入れ替えが落ちても投げない（ホーム画面ごと落とさない）", async () => {
    const signs = fresh();
    const outcome = await updateStopSigns(
      signs.store,
      {
        replace() {
          throw new Error("書き込みに失敗");
        },
      },
      async () => ({ kind: "body", body: body([NEW_SIGN]), etag: '"33.new"' }),
      { now: () => NOW },
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.meta).toEqual(OLD_META);
  });
});

describe("updateStopSigns（手元が読めない）", () => {
  let broken: Parameters<typeof updateStopSigns>[0];

  beforeEach(() => {
    broken = {
      near: () => [],
      meta() {
        throw new Error("開けません");
      },
    };
  });

  it("「読めない」を「持っていない」に潰さない", async () => {
    const fetchStopSigns = vi.fn<FetchStopSignsFn>();
    const outcome = await updateStopSigns(broken, { replace: () => {} }, fetchStopSigns);

    expect(fetchStopSigns).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("開けません");
  });
});

/**
 * 人が県を選び直したとき（#71）。**起動時の更新と同じ処理を通す**ので、
 * ここで確かめるのは**違いのぶんだけ**である——頼む県と、載せる版と、
 * **失敗したときに前の県が残ること。**
 */
describe("updateStopSigns（都道府県を選び直す）", () => {
  it("選んだ県を頼む。手元と違う県なら版を載せない", async () => {
    // **載せると別の県の版を送り返すことになる**
    // （`docs/interfaces/stop-signs-delivery.md`「県を選び直したときも、丸ごと取り直す」）。
    const fetchStopSigns = vi.fn<FetchStopSignsFn>().mockResolvedValue({
      kind: "failed",
      message: "とれない",
    });
    await run(fetchStopSigns, fresh(), { pref: 34 });

    expect(fetchStopSigns).toHaveBeenCalledWith({ pref: 34, version: null });
  });

  it("選んだ県が手元と同じなら、いつもどおり版を載せる", async () => {
    // **同じ県を選び直しただけで数 MB を落とし直さない。**
    const fetchStopSigns = vi.fn<FetchStopSignsFn>().mockResolvedValue({ kind: "not-modified" });
    await run(fetchStopSigns, fresh(), { pref: 33 });

    expect(fetchStopSigns).toHaveBeenCalledWith({ pref: 33, version: '"33.old"' });
  });

  it("何も持っていなくても、県を選べば取りに行く", async () => {
    // **選ぶということは、まだ何も持っていないところから始められるということ**（#71）。
    const signs = createMemorySigns([], null);
    const outcome = await run(
      async () => ({ kind: "body", body: body([NEW_SIGN], 34), etag: '"34.new"' }),
      signs,
      { pref: 34 },
    );

    expect(outcome.status).toBe("replaced");
    expect(signs.store.meta()?.pref).toBe(34);
  });

  it("選んだ県と違う県が返ったら入れ替えない", async () => {
    const signs = fresh();
    const outcome = await run(
      async () => ({ kind: "body", body: body([NEW_SIGN], 33), etag: '"33.new"' }),
      signs,
      { pref: 34 },
    );

    expect(outcome.status).toBe("failed");
    // **前の県がそのまま残る。**消すと、何も持っていない端末ができる。
    expect(signs.store.meta()).toEqual(OLD_META);
  });

  it("取りに行けなくても、前の県の標識を消さない", async () => {
    const signs = fresh();
    const outcome = await run(async () => ({ kind: "failed", message: "圏外" }), signs, {
      pref: 34,
    });

    expect(outcome.status).toBe("failed");
    expect(signs.store.meta()).toEqual(OLD_META);
    expect(signs.store.near(34.6612, 133.9345)).toEqual([OLD_SIGN]);
  });

  it("手元に何も無いときは「手元のものを使います」と言わない", async () => {
    // **走れないことを走れるように見せない。**県を選んだのに取れなかった端末は、
    // 一時停止の事前通知が動かないままである。
    const outcome = await run(
      async () => ({ kind: "failed", message: "圏外" }),
      createMemorySigns([], null),
      { pref: 34 },
    );

    expect(outcome.error).not.toContain("手元のものを使います");
    expect(outcome.error).toContain("手元にも標識がありません");
  });

  it("走行中は選び直しても取りに行かない", async () => {
    const fetchStopSigns = vi.fn<FetchStopSignsFn>();
    const outcome = await run(fetchStopSigns, fresh(), { pref: 34, canReplace: () => false });

    expect(fetchStopSigns).not.toHaveBeenCalled();
    expect(outcome.status).toBe("skipped");
  });
});
