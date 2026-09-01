/**
 * **実機と同じ SQL を `better-sqlite3` で回す**（`docs/adr/0009-on-device-storage.md`「5」）。
 *
 * 標識と違いメモリ実装を持たないので、ここが**唯一の関門**である。
 * 確かめるのは「引けるか」ではなく、**採番・送信済みの印・分割**——
 * どれも間違えると、**走行ログが静かに消えるか、二重に積まれる。**
 */

import { afterEach, describe, expect, it } from "vitest";
import type { Warning } from "../detect/types";
import type { SelfMessage } from "../v2v/messages";
import { type AppDatabase, openAppDatabase } from "./node";
import { createDiscardingRideLogStore, type PendingLimits, type RideLogStore } from "./store";

const DEVICE = "a1000001";
const LIMITS: PendingLimits = { maxPoints: 5_000, maxDetections: 2_000 };

/** 合成した測位（**実走行のログは使わない**。`CLAUDE.md`）。 */
function fix(t: number, overrides: Partial<SelfMessage> = {}): SelfMessage {
  return { k: "self", t, lat: 34.6612, lon: 133.9345, spd: 4.2, crs: 90, hacc: 8, ...overrides };
}

const WARNING: Warning = { kind: "stop", lv: 2, causeId: "s-1" };

let open: AppDatabase[] = [];

function store(options: { random?: () => number } = {}): RideLogStore {
  const db = openAppDatabase(":memory:", options);
  open.push(db);
  return db.store;
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

describe("走行の記録", () => {
  it("終えるまで送信の対象にならない", () => {
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    ride.addPoint(fix(1_000));

    // **走行中に送らない**（開始と終了は確定値で、あとから延ばせない）。
    expect(logs.pending(LIMITS)).toBeNull();

    ride.end(2_000);
    expect(logs.pending(LIMITS)?.points).toHaveLength(1);
  });

  it("そのまま POST /api/logs に渡せる形で返す", () => {
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    ride.addPoint(fix(1_000, { crs: null }));
    ride.addWarning(WARNING, 1_500);
    ride.end(2_000);

    const batch = logs.pending(LIMITS);
    expect(batch).toEqual({
      deviceId: DEVICE,
      rides: [{ logId: ride.logId, startedAt: 1_000, endedAt: 2_000 }],
      points: [
        {
          logId: ride.logId,
          seq: 1,
          t: 1_000,
          lat: 34.6612,
          lon: 133.9345,
          spd: 4.2,
          crs: null,
          hacc: 8,
        },
      ],
      detections: [{ source: "phone", logId: ride.logId, seq: 1, t: 1_500, kind: "stop", lv: 2 }],
    });
  });

  it("seq は 1 から単調増加する（冪等キーの前提）", () => {
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    for (let i = 0; i < 3; i += 1) ride.addPoint(fix(1_000 + i));
    ride.end(2_000);

    expect(logs.pending(LIMITS)?.points.map((p) => p.seq)).toEqual([1, 2, 3]);
  });

  it("デバイス発の種別（rear_object）をスマホ発として記録しない", () => {
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    ride.addPoint(fix(1_000));
    // **1件混ざるだけでリクエストが丸ごと 400 になる**（`web/src/worker/logs/request.ts`）。
    ride.addWarning({ kind: "rear_object", lv: 3 }, 1_500);
    ride.end(2_000);

    expect(logs.pending(LIMITS)?.detections).toHaveLength(0);
  });

  it("走行ごとに違う識別子を作る（同じ値が出たら引き直す）", () => {
    // **同じ `log_id` を使い回すと `seq` が振り直され、前の走行の点と衝突する**
    // ——取り込みは既にあるキーを無視するので、**あとから来た方が黙って消える。**
    const values = [0.5, 0.5, 0.25];
    const logs = store({ random: () => values.shift() ?? 0.75 });

    const first = logs.startRide(DEVICE, 1_000);
    first.end(2_000);
    const second = logs.startRide(DEVICE, 3_000);

    expect(second.logId).not.toBe(first.logId);
  });

  it("閉じ忘れた走行を、次の走行を始めるときに最後の測位で閉じる（デバイスが変わっても）", () => {
    // アプリが落ちた走行は `ended_at` が `null` のまま残り、**送信の対象から外れたまま
    // 誰にも見えない。**
    const logs = store();
    const abandoned = logs.startRide(DEVICE, 1_000);
    abandoned.addPoint(fix(1_400));
    abandoned.addPoint(fix(1_800));

    // 別のデバイスにつなぎ替えても閉じる（絞ると二度と閉じられない走行が残る）。
    logs.startRide("b2000002", 9_000);

    const batch = logs.pending(LIMITS);
    expect(batch?.rides).toEqual([{ logId: abandoned.logId, startedAt: 1_000, endedAt: 1_800 }]);
  });

  it("閉じるときに、開始より前の時刻にしない", () => {
    // `started_at` は端末の時計、`t` は測位の時刻で**出どころが違う**ので、
    // 走り出した直後に古い測位が届くと逆転しうる。**逆転した走行は取り込みが
    // 400（`invalid`）を返し、送信は古い走行から進むので、その1件が以後の全部を止める。**
    const logs = store();
    const abandoned = logs.startRide(DEVICE, 5_000);
    abandoned.addPoint(fix(1_000));

    logs.startRide(DEVICE, 9_000);

    const [ride] = logs.pending(LIMITS)?.rides ?? [];
    expect(ride).toEqual({ logId: abandoned.logId, startedAt: 5_000, endedAt: 5_000 });
  });

  it("測位が1点も無い走行を閉じるときは、開始の時刻を使う", () => {
    const logs = store();
    const abandoned = logs.startRide(DEVICE, 1_000);
    logs.startRide(DEVICE, 9_000);

    // **`ended_at < started_at` の走行を作らない**（取り込みが 400 を返す）。
    // 送るものが無いので `pending()` には出ないが、閉じられてはいる。
    expect(logs.pending(LIMITS)).toBeNull();
    expect(abandoned.logId).toHaveLength(8);
  });
});

describe("送信済みの印", () => {
  it("印を付けたぶんは二度と出ない", () => {
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    ride.addPoint(fix(1_000));
    ride.addWarning(WARNING, 1_200);
    ride.end(2_000);

    const batch = logs.pending(LIMITS);
    if (batch === null) throw new Error("送るものがある");
    logs.markSent(batch, 5_000);

    expect(logs.pending(LIMITS)).toBeNull();
    expect(logs.summary()).toEqual({
      pendingRides: 0,
      pendingPoints: 0,
      pendingDetections: 0,
      lastSentAt: 5_000,
    });
  });

  it("上限で分けても、続きから出て、重ならない", () => {
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    for (let i = 0; i < 5; i += 1) ride.addPoint(fix(1_000 + i));
    ride.end(2_000);

    const small: PendingLimits = { maxPoints: 2, maxDetections: 2 };
    const first = logs.pending(small);
    if (first === null) throw new Error("送るものがある");
    expect(first.points.map((p) => p.seq)).toEqual([1, 2]);
    // **分けて送るときも、走行の行を毎回入れる**（`docs/interfaces/web-service.md`）。
    expect(first.rides).toHaveLength(1);

    logs.markSent(first, 5_000);
    expect(logs.pending(small)?.points.map((p) => p.seq)).toEqual([3, 4]);
  });

  it("送れていない件数を数える（走行後の画面に出す）", () => {
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    ride.addPoint(fix(1_000));
    ride.addPoint(fix(1_001));
    ride.addWarning(WARNING, 1_200);
    ride.end(2_000);

    expect(logs.summary()).toEqual({
      pendingRides: 1,
      pendingPoints: 2,
      pendingDetections: 1,
      lastSentAt: null,
    });
  });

  it("何も記録していなくても数えられる（0 件で落ちない）", () => {
    // `sum()` は行が1つも無いと `null` を返す。**そのまま画面へ流さない。**
    expect(store().summary()).toEqual({
      pendingRides: 0,
      pendingPoints: 0,
      pendingDetections: 0,
      lastSentAt: null,
    });
  });
});

describe("開けなかったときの保存層", () => {
  it("何も残さず、送るものも持たない（走行そのものは止めない）", () => {
    const logs = createDiscardingRideLogStore();
    const ride = logs.startRide(DEVICE, 1_000);
    ride.addPoint(fix(1_000));
    ride.addWarning(WARNING, 1_200);
    ride.end(2_000);

    expect(logs.pending(LIMITS)).toBeNull();
    expect(logs.purgeSent(9_999_999)).toEqual({ rides: 0, points: 0, detections: 0 });
    expect(logs.summary()).toEqual({
      pendingRides: 0,
      pendingPoints: 0,
      pendingDetections: 0,
      lastSentAt: null,
    });
  });
});

describe("送り終えたぶんを消す", () => {
  /** 点と検知を1件ずつ持つ走行を作って、`at` に送ったことにする。 */
  function sentRide(logs: RideLogStore, startedAt: number, at: number) {
    const ride = logs.startRide(DEVICE, startedAt);
    ride.addPoint(fix(startedAt));
    ride.addWarning(WARNING, startedAt + 100);
    ride.end(startedAt + 1_000);
    const batch = logs.pending(LIMITS);
    if (batch === null) throw new Error("送るものがある");
    logs.markSent(batch, at);
    return ride;
  }

  it("送り終えた行と、空になった走行の行を消す", () => {
    const logs = store();
    sentRide(logs, 1_000, 5_000);

    // **消すのは「その時刻までに送れた行」**（いつまで置くかは `./config.ts`）。
    expect(logs.purgeSent(5_000)).toEqual({ rides: 1, points: 1, detections: 1 });
    // 二度目は何も残っていない。**行数が増え続けないのはここ。**
    expect(logs.purgeSent(5_000)).toEqual({ rides: 0, points: 0, detections: 0 });
  });

  it("送っていない行は消さない（消すと二度と上がらない）", () => {
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    ride.addPoint(fix(1_000));
    ride.addWarning(WARNING, 1_200);
    ride.end(2_000);

    // **未来の時刻で掃除しても触らない。**印が付いていない行は保持期間の話ではない。
    expect(logs.purgeSent(9_999_999)).toEqual({ rides: 0, points: 0, detections: 0 });
    expect(logs.pending(LIMITS)?.points).toHaveLength(1);
    expect(logs.summary().pendingPoints).toBe(1);
  });

  it("置いておく期間の内に送ったぶんは残す", () => {
    const logs = store();
    sentRide(logs, 1_000, 5_000);

    // 5,000 に送ったものは、4,999 までの掃除では消えない。
    expect(logs.purgeSent(4_999)).toEqual({ rides: 0, points: 0, detections: 0 });
  });

  it("送っていない行が残っている走行の行を消さない", () => {
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    ride.addPoint(fix(1_000));
    ride.addPoint(fix(1_100));
    ride.end(2_000);

    // 1点だけ送る（残り1点は手元に残る）。
    const batch = logs.pending({ maxPoints: 1, maxDetections: 1 });
    if (batch === null) throw new Error("送るものがある");
    logs.markSent(batch, 5_000);

    expect(logs.purgeSent(5_000)).toEqual({ rides: 0, points: 1, detections: 0 });
    // **走行の行が消えていない**——消すと、残った点を送るときに一緒に送る行が無くなる。
    expect(logs.pending(LIMITS)?.rides).toEqual([
      { logId: ride.logId, startedAt: 1_000, endedAt: 2_000 },
    ]);
  });

  it("いま記録している走行を消さない（まだ1点も入っていない）", () => {
    const logs = store();
    const running = logs.startRide(DEVICE, 1_000);

    // **走り出した直後は点が0件。**「行が残っていない走行」として消してはいけない。
    expect(logs.purgeSent(9_999_999)).toEqual({ rides: 0, points: 0, detections: 0 });

    running.addPoint(fix(1_500));
    running.end(2_000);
    expect(logs.pending(LIMITS)?.points).toHaveLength(1);
  });

  it("終えたばかりの走行を消さない（置いておく期間を過ぎるまで）", () => {
    // **測位の購読が始まるのは走り出したあと**なので、**点が1つも無いまま終わる走行**が
    // ありうる（`../ride/use-ride-loop.ts`）。ここで消すと、
    // **そのあとに届いた1点目が、走行の行の無いまま残る**——`pending()` は `rides` から
    // 辿るので**永久に送られず、画面には「送っていない測位」として出続ける。**
    const logs = store();
    const ride = logs.startRide(DEVICE, 1_000);
    ride.end(2_000);

    expect(logs.purgeSent(1_999)).toEqual({ rides: 0, points: 0, detections: 0 });

    // 遅れて届いた1点目。**走行の行が残っているので、ちゃんと送られる。**
    ride.addPoint(fix(2_100));
    expect(logs.pending(LIMITS)?.points).toHaveLength(1);
  });

  it("期間を過ぎた空の走行は消す（「送るものが無い走行」を溜めない）", () => {
    const logs = store();
    logs.startRide(DEVICE, 1_000).end(2_000);

    // 終わりの時刻が期限に達したら消える。**残すと `pending()` の探索が伸びる。**
    expect(logs.purgeSent(2_000)).toEqual({ rides: 1, points: 0, detections: 0 });
  });

  it("消しても「最後に送れた時刻」が残る", () => {
    const logs = store();
    sentRide(logs, 1_000, 5_000);
    logs.purgeSent(5_000);

    // **行から `max(sent_at)` を出していたら、ここで `null` に戻り、
    // 走行後の画面が「一度も送っていない」と出す。**
    expect(logs.summary()).toEqual({
      pendingRides: 0,
      pendingPoints: 0,
      pendingDetections: 0,
      lastSentAt: 5_000,
    });
  });

  it("時計が巻き戻っても、最後に送れた時刻を古い方へ書き換えない", () => {
    const logs = store();
    sentRide(logs, 1_000, 5_000);
    sentRide(logs, 6_000, 3_000);

    expect(logs.summary().lastSentAt).toBe(5_000);
  });
});

describe("走行が複数あるとき", () => {
  it("古い走行から順に送る", () => {
    const logs = store();
    const older = logs.startRide(DEVICE, 1_000);
    older.addPoint(fix(1_000));
    older.end(2_000);
    const newer = logs.startRide(DEVICE, 3_000);
    newer.addPoint(fix(3_000));
    newer.end(4_000);

    const first = logs.pending(LIMITS);
    if (first === null) throw new Error("送るものがある");
    expect(first.rides[0]?.logId).toBe(older.logId);

    // **1回に1走行しか載せない**（点はその走行の行と一緒に送る、という約束を読んで分かる形にする）。
    logs.markSent(first, 5_000);
    expect(logs.pending(LIMITS)?.rides[0]?.logId).toBe(newer.logId);
  });
});
