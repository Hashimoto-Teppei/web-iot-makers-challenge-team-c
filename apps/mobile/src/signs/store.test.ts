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
import { createMemorySignStore, type SignStore, type SignsMeta } from "./store";

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
