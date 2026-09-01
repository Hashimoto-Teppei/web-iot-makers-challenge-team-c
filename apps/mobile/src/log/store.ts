/**
 * 走行ログの保存層の口（`RideLogStore`）と、その Drizzle 実装。
 *
 * ```
 * Vitest → better-sqlite3（./node.ts）   実機 → expo-sqlite（./expo.ts）
 * ```
 *
 * **標識（`../signs/store.ts`）と違い、メモリ実装を置かない。**あちらは走行ループと
 * シミュレータが毎周期読むので軽い実装が要ったが、**こちらを使うのは走行ループの
 * 書き込みと走行後の送信だけ**で、どちらも SQL のまま Vitest から回せる
 * （`docs/adr/0009-on-device-storage.md`「5」の狙いは満たしている）。
 *
 * **送る側（`./sync.ts`）は SQL を知らない。**ここが返す {@link PendingBatch} は
 * そのまま `POST /api/logs` の本文になる形にしてある。
 */

import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
// **リクエストの形を手で書き写さない**（`docs/interfaces/mobile-api.md`）。
// 型だけを借りるので、Worker のコードはモバイルのバンドルに入らない。
import type { DetectionRecord, PointRecord, RideRecord } from "web/src/worker/logs/request";
import type { Warning } from "../detect/types";
import type { SyncSqliteDatabase } from "../signs/store";
import type { SelfMessage } from "../v2v/messages";
import { detections, points, rides } from "./schema";

/** スマホ発の検知の種別。**`rear_object` はデバイスの中でしか発生しない**（#40） */
export type PhoneWarnKind = Extract<DetectionRecord, { source: "phone" }>["kind"];

/**
 * 1回ぶんの送信。**そのまま `POST /api/logs` の本文になる。**
 *
 * **1回に1走行しか載せない。**取り込みは20走行まで受け付けるが（`web/src/worker/logs/config.ts`）、
 * **混ぜても速くならず、「点はその走行の行と一緒に送る」という約束**
 * （`docs/interfaces/web-service.md`）**を守れているかが読んで分からなくなる。**
 */
export type PendingBatch = {
  /** **1リクエストに1つ。**レコードごとには持たない（`web/src/worker/logs/request.ts`） */
  deviceId: string;
  rides: RideRecord[];
  points: PointRecord[];
  detections: DetectionRecord[];
};

/** 送信の状況。**走行後の画面に出す**（`docs/interfaces/mobile-api.md`「失敗したときの約束」と同じ理由） */
export type RideLogSummary = {
  /** まだ送れていない走行の数（**終わったものだけ**） */
  pendingRides: number;
  pendingPoints: number;
  pendingDetections: number;
  /** 最後に送れた時刻（UTC ミリ秒）。一度も無ければ `null` */
  lastSentAt: number | null;
};

/**
 * 走行1回ぶんの書き込み口。**走行ループがこれを持つ。**
 *
 * **`seq` を呼び出し側に決めさせない。**1から単調増加することが冪等キーの前提であり
 * （`docs/interfaces/ble-log-transfer.md`）、**採番が2箇所にあると必ずずれる。**
 */
export type RideRecording = {
  deviceId: string;
  logId: string;
  /** 測位を1点足す。**走行中に1Hz で呼ばれる** */
  addPoint(fix: SelfMessage): void;
  /** 発火した警告を1件足す。**`rear_object` は受け取らない**（デバイス発。#40） */
  addWarning(warning: Warning, t: number): void;
  /** 走行を終える。**これを呼ぶまで送信の対象にならない** */
  end(endedAt: number): void;
};

export type RideLogStore = {
  /**
   * 走行を始める。**`device_id` はつながっているデバイスのもの**
   * （`docs/interfaces/mobile-api.md`。つながっていない走行は始めない）。
   */
  startRide(deviceId: string, startedAt: number): RideRecording;
  /**
   * 次に送るぶんを1回ぶん取り出す。**送るものが無ければ `null`。**
   *
   * **同じものを返し続ける**（取り出しても印は付かない）。印を付けるのは
   * {@link RideLogStore.markSent} で、**送れたことを確かめてからにする**
   * ——先に付けると、落ちた1回ぶんが誰にも見えないまま消える。
   */
  pending(limits: PendingLimits): PendingBatch | null;
  /** 送れたぶんに印を付ける。 */
  markSent(batch: PendingBatch, at: number): void;
  summary(): RideLogSummary;
};

/**
 * 1回に送る件数の上限。**取り込み側の上限がそのまま入る**
 * （`web/src/worker/logs/config.ts` が正本。**超えると 400 で1行も入らない**）。
 */
export type PendingLimits = {
  maxPoints: number;
  maxDetections: number;
};

/**
 * 何も残さない保存層。**`app.db` を開けなかったときだけ使う**（`./expo.ts`）。
 *
 * **黙って成功にしない。**使う側は必ず開けなかった旨を画面に出すこと
 * ——**「記録できている」と見えるまま消えるのが一番悪い。**
 *
 * **走行そのものは止めない。**記録できないことより、**検知が動かないことの方が危険**である
 * （警告の出し先はデバイスで、そちらは `app.db` と関係なく動く）。
 */
export function createDiscardingRideLogStore(): RideLogStore {
  return {
    startRide: (deviceId) => ({
      deviceId,
      logId: "00000000",
      addPoint: () => {},
      addWarning: () => {},
      end: () => {},
    }),
    pending: () => null,
    markSent: () => {},
    summary: () => ({
      pendingRides: 0,
      pendingPoints: 0,
      pendingDetections: 0,
      lastSentAt: null,
    }),
  };
}

/**
 * 走行の識別子を作る。**16進の小文字8文字**（`docs/interfaces/ble-gatt.md` の `device_id` と同じ形）。
 *
 * **暗号学的な乱数を使わない。**当てられて困る値ではなく、
 * **同じ端末の中で他の走行と衝突しなければよい**だけである（衝突は下で確かめている）。
 */
export function newLogId(random: () => number = Math.random): string {
  return Math.floor(random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
}

/**
 * SQL 実装。**`better-sqlite3` と `expo-sqlite` で同じものを使う。**
 *
 * @param now 既定は `Date.now`。**採番と印の時刻を差し替えられるようにしてある**
 *   （テストが実時間を待たないため）
 */
export function createRideLogStore(
  db: SyncSqliteDatabase,
  options: { random?: () => number } = {},
): RideLogStore {
  const random = options.random ?? Math.random;

  // **文を1回だけ用意して使い回す。**走行中に毎秒呼ばれるのはこの2つで、
  // Drizzle の expo-sqlite ドライバは**呼ぶたびに `prepareSync()` して片付けない**
  // （`../signs/store.ts` に同じ注記がある）。**長い走行で端末に文が溜まり続ける。**
  const insertPoint = db
    .insert(points)
    .values({
      deviceId: sql.placeholder("deviceId"),
      logId: sql.placeholder("logId"),
      seq: sql.placeholder("seq"),
      t: sql.placeholder("t"),
      lat: sql.placeholder("lat"),
      lon: sql.placeholder("lon"),
      spd: sql.placeholder("spd"),
      crs: sql.placeholder("crs"),
      hacc: sql.placeholder("hacc"),
    })
    .prepare();

  const insertDetection = db
    .insert(detections)
    .values({
      deviceId: sql.placeholder("deviceId"),
      source: sql.placeholder("source"),
      logId: sql.placeholder("logId"),
      seq: sql.placeholder("seq"),
      t: sql.placeholder("t"),
      kind: sql.placeholder("kind"),
      lv: sql.placeholder("lv"),
    })
    .prepare();

  return {
    startRide(deviceId, startedAt) {
      // **前回の走行が終わっていなければ、ここで閉じる。**アプリが落ちた・端末が
      // 落ちた走行は `ended_at` が `null` のまま残り、**送信の対象から外れたまま
      // 誰にも見えない**（`pending()` は終わった走行しか見ない）。
      // **終わりは最後の測位の時刻にする**——落ちたあとの時刻を入れると、
      // 期間だけが伸びて**別の走行の検知がその走行に結びつく**
      // （検知は `(device_id, t)` が期間に入るかで走行に結びつく。
      // `docs/interfaces/web-service.md`）。
      db.update(rides)
        .set({
          // **開始より前で閉じない。**`started_at` は端末の時計（`Date.now()`）、
          // `t` は測位の時刻で**出どころが違う**ので、走り出した直後に古い測位が
          // 1通届いた走行では逆転しうる。**逆転した走行は取り込みが 400（`invalid`）を返し、
          // 送信は最古の走行から順に進むので、その1件が以後すべての走行を永久に止める。**
          endedAt: sql`max(
            ${rides.startedAt},
            coalesce(
              (select max(${points.t}) from ${points}
                where ${points.deviceId} = ${rides.deviceId} and ${points.logId} = ${rides.logId}),
              ${rides.startedAt}
            )
          )`,
        })
        // **デバイスで絞らない。**別のデバイスにつなぎ替えた日に落ちた走行は、
        // 絞ると**二度と閉じられず、送られないまま端末に残り続ける。**
        .where(isNull(rides.endedAt))
        .run();

      const logId = uniqueLogId(db, deviceId, random);
      db.insert(rides).values({ deviceId, logId, startedAt }).run();

      let pointSeq = 0;
      let detectionSeq = 0;

      return {
        deviceId,
        logId,
        addPoint(fix) {
          pointSeq += 1;
          insertPoint.run({
            deviceId,
            logId,
            seq: pointSeq,
            t: fix.t,
            lat: fix.lat,
            lon: fix.lon,
            spd: fix.spd,
            crs: fix.crs,
            hacc: fix.hacc,
          });
        },
        addWarning(warning, t) {
          // **デバイス発の種別をスマホ発として書かない。**取り込み側は
          // `source: "phone"` で `rear_object` を受け取らず、**この1件のために
          // リクエストが丸ごと 400 になる**（`web/src/worker/logs/request.ts`）。
          if (warning.kind === "rear_object") return;
          detectionSeq += 1;
          insertDetection.run({
            deviceId,
            source: "phone",
            logId,
            seq: detectionSeq,
            t,
            kind: warning.kind,
            lv: warning.lv,
          });
        },
        end(endedAt) {
          db.update(rides)
            .set({ endedAt })
            .where(and(eq(rides.deviceId, deviceId), eq(rides.logId, logId)))
            .run();
        },
      };
    },

    pending(limits) {
      const [ride] = db
        .select({
          deviceId: rides.deviceId,
          logId: rides.logId,
          startedAt: rides.startedAt,
          endedAt: rides.endedAt,
        })
        .from(rides)
        // **終わった走行だけを送る**（`./schema.ts` の `ended_at`）。
        .where(and(isNotNull(rides.endedAt), sql`${hasUnsent(rides.deviceId, rides.logId)}`))
        // **古い走行から送る。**新しい走行を先に送ると、通信が細い日に
        // **古いものだけが永久に残る。**
        .orderBy(asc(rides.startedAt))
        .limit(1)
        .all();

      if (ride === undefined || ride.endedAt === null) return null;

      const batchPoints = db
        .select({
          logId: points.logId,
          seq: points.seq,
          t: points.t,
          lat: points.lat,
          lon: points.lon,
          spd: points.spd,
          crs: points.crs,
          hacc: points.hacc,
        })
        .from(points)
        .where(
          and(
            eq(points.deviceId, ride.deviceId),
            eq(points.logId, ride.logId),
            isNull(points.sentAt),
          ),
        )
        // **`seq` の順に送る。**印を付けるときに「ここまで」で切れる形にしておく。
        .orderBy(asc(points.seq))
        .limit(limits.maxPoints)
        .all();

      const batchDetections = db
        .select({
          logId: detections.logId,
          seq: detections.seq,
          t: detections.t,
          kind: detections.kind,
          lv: detections.lv,
        })
        .from(detections)
        .where(
          and(
            eq(detections.deviceId, ride.deviceId),
            eq(detections.logId, ride.logId),
            eq(detections.source, "phone"),
            isNull(detections.sentAt),
          ),
        )
        .orderBy(asc(detections.seq))
        .limit(limits.maxDetections)
        .all();

      return {
        deviceId: ride.deviceId,
        // **分けて送っても、走行の行は毎回入れる**（`docs/interfaces/web-service.md`）。
        // 同じ行を何度送っても増えない（取り込みは無視する）。
        rides: [{ logId: ride.logId, startedAt: ride.startedAt, endedAt: ride.endedAt }],
        points: batchPoints,
        detections: batchDetections.map((row) => ({
          source: "phone",
          logId: row.logId,
          seq: row.seq,
          t: row.t,
          kind: row.kind as PhoneWarnKind,
          lv: row.lv as 1 | 2 | 3,
        })),
      };
    },

    markSent(batch, at) {
      // **走行ごとに突き合わせる。**いまは1回に1走行しか載せないが、
      // **`batch.points.at(-1)` を全部の走行に使い回すと、載せ方を変えた瞬間に
      // 送っていない行へ印が付く**（付いた行は二度と送られない）。
      for (const ride of batch.rides) {
        const lastPointSeq = lastSeqOf(batch.points, ride.logId);
        if (lastPointSeq !== null) {
          // **`seq` の範囲で印を付ける。**キーを1件ずつ並べると、5,000 点で
          // **SQLite の束縛変数の上限に触れる。**送ったのは「まだ印の無いもののうち
          // `seq` が小さい方から」なので、**上限まで塗れば過不足なく一致する。**
          db.update(points)
            .set({ sentAt: at })
            .where(
              and(
                eq(points.deviceId, batch.deviceId),
                eq(points.logId, ride.logId),
                isNull(points.sentAt),
                lte(points.seq, lastPointSeq),
              ),
            )
            .run();
        }

        const lastDetectionSeq = lastSeqOf(batch.detections, ride.logId);
        if (lastDetectionSeq !== null) {
          db.update(detections)
            .set({ sentAt: at })
            .where(
              and(
                eq(detections.deviceId, batch.deviceId),
                eq(detections.logId, ride.logId),
                eq(detections.source, "phone"),
                isNull(detections.sentAt),
                lte(detections.seq, lastDetectionSeq),
              ),
            )
            .run();
        }
      }
    },

    summary() {
      const [rideCounts] = db
        .select({ n: sql<number>`count(*)` })
        .from(rides)
        // **送るものが残っている走行だけを数える。**すべて送れた走行は、もう出す用が無い。
        .where(and(isNotNull(rides.endedAt), sql`${hasUnsent(rides.deviceId, rides.logId)}`))
        .all();

      // **`sum(case ...)` で数えない。**送信済みの行を消す経路が無いので表は増え続け、
      // **全表走査が画面を開くたびに JS スレッドの上で同期に走る。**
      // `sent_at` の索引で賄える形（`is null` の数え上げと `max()`）にする。
      const [unsentPoints] = db
        .select({ n: sql<number>`count(*)` })
        .from(points)
        .where(isNull(points.sentAt))
        .all();
      const [lastPointSentAt] = db
        .select({ at: sql<number | null>`max(${points.sentAt})` })
        .from(points)
        .all();
      const [unsentDetections] = db
        .select({ n: sql<number>`count(*)` })
        .from(detections)
        .where(and(eq(detections.source, "phone"), isNull(detections.sentAt)))
        .all();
      const [lastDetectionSentAt] = db
        .select({ at: sql<number | null>`max(${detections.sentAt})` })
        .from(detections)
        .all();

      return {
        pendingRides: rideCounts?.n ?? 0,
        pendingPoints: unsentPoints?.n ?? 0,
        pendingDetections: unsentDetections?.n ?? 0,
        lastSentAt: maxOrNull(lastPointSentAt?.at ?? null, lastDetectionSentAt?.at ?? null),
      };
    },
  };
}

/** その走行ぶんとして送った、最後の `seq`。1件も無ければ `null`。 */
function lastSeqOf(rows: readonly { logId: string; seq: number }[], logId: string): number | null {
  let last: number | null = null;
  for (const row of rows) {
    if (row.logId === logId && (last === null || row.seq > last)) last = row.seq;
  }
  return last;
}

/**
 * その走行に**この保存層が送る行**で、まだ送っていないものがあるか（相関副問い合わせ）。
 *
 * **`pending()` が取り出す条件とそろえる。**片方だけ広いと、**取り出すものが無いのに
 * 「送るものがある」と言い続ける走行**ができ、空のリクエストを上限まで投げて終わる。
 * **#40 がデバイス発（`source = "device"`）を足すときは、ここと `pending()` と
 * `markSent()` の3つを一緒に広げること。**
 */
function hasUnsent(deviceId: unknown, logId: unknown) {
  return sql`(
    exists (select 1 from ${points}
      where ${points.deviceId} = ${deviceId} and ${points.logId} = ${logId}
        and ${points.sentAt} is null)
    or exists (select 1 from ${detections}
      where ${detections.deviceId} = ${deviceId} and ${detections.logId} = ${logId}
        and ${detections.source} = 'phone' and ${detections.sentAt} is null)
  )`;
}

/**
 * まだ使っていない走行の識別子を作る。
 *
 * **衝突を握りつぶさない。**同じ `log_id` を使い回すと `seq` が 1 から振り直され、
 * **前の走行の点と冪等キーがぶつかって、あとから来た方が黙って消える**
 * （取り込みは既にあるキーを無視する。`docs/interfaces/web-service.md`）。
 */
function uniqueLogId(db: SyncSqliteDatabase, deviceId: string, random: () => number): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const logId = newLogId(random);
    const [existing] = db
      .select({ logId: rides.logId })
      .from(rides)
      .where(and(eq(rides.deviceId, deviceId), eq(rides.logId, logId)))
      .all();
    if (existing === undefined) return logId;
  }
  throw new Error("走行の識別子を作れませんでした（同じ値が続けて出ています）");
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
