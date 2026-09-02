/**
 * **メモリ実装と `better-sqlite3` 実装に同じテストを回す。**
 *
 * 片方だけを試すと、「メモリでは通るが実機の SQL が間違っている」が素通りする
 * （`docs/adr/0009-on-device-storage.md`「5」）。実機の `expo-sqlite` は
 * ここでは動かせないが、**引く SQL は `createDrizzleSignStore` の1つだけ**なので、
 * `better-sqlite3` で通れば SQL 自体は確かめられている（残るのは
 * 「同梱した `.db` が実機で開けるか」で、それは `docs/unverified.md` 60）。
 */

import { afterAll, describe, expect, it } from "vitest";
import type { StopSign } from "../detect/types";
import { buildSignsDatabase } from "./node";
import {
  createMemorySignStore,
  createMemorySigns,
  type SignStore,
  type SignsMeta,
  type SignWriter,
} from "./store";

/** 岡山市内あたり。セルは (34661, 133934)。 */
const HERE = { lat: 34.6612, lon: 133.9345 };

const META: SignsMeta = {
  pref: 33,
  version: '"33.2026-09-01"',
  count: 4,
  builtAt: "2026-09-01T00:00:00Z",
};

/** 自セルの中。進入方向つき。 */
const SAME_CELL: StopSign = {
  id: "s-same",
  lat: 34.6615,
  lon: 133.9348,
  approach: { lat: 34.6613, lon: 133.9348 },
};

/** 隣のセル（北東）。**3×3 に入るので引けなければならない。** */
const NEXT_CELL: StopSign = {
  id: "s-next",
  lat: 34.6625,
  lon: 133.9355,
  approach: { lat: 34.6623, lon: 133.9355 },
};

/** 進入方向が元データに無い標識。**`null` のまま端末まで来る。** */
const NO_APPROACH: StopSign = { id: "s-null", lat: 34.6608, lon: 133.9341, approach: null };

/** 2セル離れている。**引けてはいけない**（近傍を絞れていないことになる）。 */
const FAR: StopSign = {
  id: "s-far",
  lat: 34.6645,
  lon: 133.9375,
  approach: { lat: 34.6643, lon: 133.9375 },
};

const ALL = [SAME_CELL, NEXT_CELL, NO_APPROACH, FAR];

function suite(name: string, create: () => SignStore): void {
  describe(name, () => {
    it("自セルと周囲8セルの標識を返す", () => {
      const ids = create()
        .near(HERE.lat, HERE.lon)
        .map((sign) => sign.id)
        .sort();
      expect(ids).toEqual(["s-next", "s-null", "s-same"]);
    });

    it("2セル離れた標識は返さない", () => {
      const ids = create()
        .near(HERE.lat, HERE.lon)
        .map((sign) => sign.id);
      expect(ids).not.toContain("s-far");
    });

    it("進入方向をそのまま返す", () => {
      const found = create()
        .near(HERE.lat, HERE.lon)
        .find((sign) => sign.id === "s-same");
      expect(found?.approach).toEqual(SAME_CELL.approach);
    });

    it("進入方向が無い標識は null のまま返す（0 や自分の位置で埋めない）", () => {
      const found = create()
        .near(HERE.lat, HERE.lon)
        .find((sign) => sign.id === "s-null");
      expect(found?.approach).toBeNull();
    });

    it("どこにも標識が無い場所では空を返す", () => {
      // **空を「標識が無い」と読み替えるのは呼び出し側の仕事ではない**——
      // 持っているかどうかは meta() が答える。
      expect(create().near(35.0, 135.0)).toEqual([]);
    });

    it("meta を返す（版はサーバーの ETag のまま）", () => {
      expect(create().meta()).toEqual(META);
    });
  });
}

suite("createMemorySignStore", () => createMemorySignStore(ALL, META));

// ファイルを作らずに済ませる。生成スクリプトが書くファイルとの違いは置き場所だけ。
// **テストごとに作り直さない**（作った DB を開いたままにしない）。
const sqlite = buildSignsDatabase(":memory:", META, ALL);
afterAll(() => sqlite.close());

suite("better-sqlite3（実機と同じ SQL）", () => sqlite.store);

describe("createMemorySignStore", () => {
  it("meta を渡さなければ null（「持っていない」を 0 件に潰さない）", () => {
    expect(createMemorySignStore([]).meta()).toBeNull();
  });
});

/**
 * 入れ替え（`SignWriter`）。**読む側と同じく2つの実装に同じテストを回す。**
 *
 * **ここを間違えると「何も持っていない端末」ができる**——`near()` が間違っているより
 * 被害が大きい（`docs/interfaces/mobile-api.md`「差分を作らない」）。
 */
const NEW_META: SignsMeta = {
  pref: 33,
  version: '"33.2026-10-01"',
  count: 1,
  builtAt: "2026-10-01T00:00:00Z",
};

/** 入れ替え後に残る唯一の標識。**自セルの中**なので `near()` から引ける。 */
const REPLACEMENT: StopSign = { id: "s-new", lat: 34.6614, lon: 133.9346, approach: null };

function writerSuite(name: string, create: () => { store: SignStore; writer: SignWriter }): void {
  describe(name, () => {
    it("丸ごと入れ替える（古い標識が残らない）", () => {
      const { store, writer } = create();
      writer.replace(NEW_META, [REPLACEMENT]);

      expect(store.meta()).toEqual(NEW_META);
      expect(store.near(HERE.lat, HERE.lon).map((sign) => sign.id)).toEqual(["s-new"]);
    });

    it("1文に収まらない件数でも書ける（SQLite のパラメータ上限）", () => {
      const { store, writer } = create();
      // **500 件でまとめている**ので、それを超える件数を渡さないと分割の経路を通らない。
      const many = Array.from({ length: 1200 }, (_, i) => ({
        ...REPLACEMENT,
        id: `s-${i}`,
      }));
      writer.replace({ ...NEW_META, count: many.length }, many);

      expect(store.meta()?.count).toBe(1200);
      expect(store.near(HERE.lat, HERE.lon)).toHaveLength(1200);
    });

    it("進入方向が無い標識を null のまま書く（0 や位置で埋めない）", () => {
      const { store, writer } = create();
      writer.replace(NEW_META, [{ ...REPLACEMENT, approach: null }]);

      expect(store.near(HERE.lat, HERE.lon)[0]?.approach).toBeNull();
    });
  });
}

/** 書き換えるテストが開いた DB。**開いたままにしない。** */
const writable: { close(): void }[] = [];
afterAll(() => {
  for (const db of writable) db.close();
});

writerSuite("createMemorySigns", () => createMemorySigns(ALL, META));

writerSuite("better-sqlite3（実機と同じ SQL）", () => {
  // **読む側の suite が使っている DB とは別に作る。**共有すると、
  // 書き換えた中身を読む側のテストが引くことになる。
  const db = buildSignsDatabase(":memory:", META, ALL);
  writable.push(db);
  return db;
});

describe("createDrizzleSignWriter（トランザクション）", () => {
  it("途中で落ちたら1件も変わらない（消してから落ちた端末を作らない）", () => {
    const db = buildSignsDatabase(":memory:", META, ALL);
    writable.push(db);

    // **2つ目のかたまりで主キーが衝突する。**分割して書いている途中で落ちる筋である。
    const conflicting = [
      ...Array.from({ length: 600 }, (_, i) => ({ ...REPLACEMENT, id: `s-${i}` })),
      { ...REPLACEMENT, id: "s-0" },
    ];
    expect(() =>
      db.writer.replace({ ...NEW_META, count: conflicting.length }, conflicting),
    ).toThrow();

    // **消す前の状態に戻っていること。**戻っていなければ、標識ゼロの端末ができる。
    expect(db.store.meta()).toEqual(META);
    expect(
      db.store
        .near(HERE.lat, HERE.lon)
        .map((sign) => sign.id)
        .sort(),
    ).toEqual(["s-next", "s-null", "s-same"]);
  });
});
