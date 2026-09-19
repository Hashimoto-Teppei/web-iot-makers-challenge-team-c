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

import { and, asc, eq, isNotNull, isNull, lte, notExists, sql } from "drizzle-orm";
// **リクエストの形を手で書き写さない**（`docs/interfaces/mobile-api.md`）。
// 型だけを借りるので、Worker のコードはモバイルのバンドルに入らない。
import type { DetectionRecord, PointRecord, RideRecord } from "web/src/worker/logs/request";
import type { DeviceDetection } from "../ble/log-transfer";
import type { Warning } from "../detect/types";
import type { SyncSqliteDatabase } from "../signs/store";
import type { SelfMessage } from "../v2v/messages";
import {
  appMeta,
  detections,
  deviceDetections,
  deviceLogSeqKey,
  LAST_SENT_AT_KEY,
  points,
  rides,
} from "./schema";

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
   * デバイスから回収した検知を取り込む（#40）。**同じものが再び届いても増やさない。**
   *
   * **既読位置（`since` に使う `seq`）もここで進める。**取り込みと同じ呼び出しで進めるのは、
   * **進めてよいのは取り込みを終えたところまで**だからである
   * （`docs/interfaces/ble-log-transfer.md`「転送済みログの扱い」）。
   *
   * @param logId **デバイスの `log_id`**（走行の `log_id` ではない）
   * @returns 新しく積まれた件数（**既にあったぶんは数えない**）
   */
  addDeviceDetections(deviceId: string, logId: string, records: readonly DeviceDetection[]): number;
  /**
   * デバイスのログをどこまで取り込んだか。**`control` の `since` に渡す。**
   *
   * **`log_id` が前回と違えば 0 を返す**（鍵に世代が入っているため）——
   * そのまま全件を取り直すのが正しい（同ファイル）。
   */
  deviceLogSince(deviceId: string, logId: string): number;
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
  /**
   * **送り終えて、置いておく期間を過ぎた行を消す。**
   *
   * **送っていない行は絶対に消さない**——消すと**二度と上がらない**
   * （`pending()` は `sent_at` が `null` の行だけを見ている）。
   *
   * @param before この時刻**以前**に送れた行を消す
   *   （**いつまで置くかはここが決めない**。`./config.ts` の `rideLogRetentionDefaults`）
   */
  purgeSent(before: number): PurgeResult;
  summary(): RideLogSummary;
};

/**
 * 消した件数。**人に見せるためではなく、消えたことを確かめられるようにするため**にある。
 *
 * **消し損ねは、どの件数にも現れない。**{@link RideLogStore.summary} が数えるのは
 * **送っていない行だけ**なので、**送り終えたのに消えていない行を数えるものは無い。**
 * 見えるようにする唯一の口は `./sync.ts` の `purgeError` である。
 */
export type PurgeResult = {
  rides: number;
  points: number;
  detections: number;
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
 * 「デバイスを使わない」で走るとき、**新しい走行だけを記録しない**（#185）。
 *
 * **中継（Durable Object）は数秒で消えるが、走行ログは D1 に永続する行**で、しかも
 * **取り込みは上書きも削除もできない**（`../lib/mock-guard.ts`）。
 * **実在しないデバイスの行を、誰にも消せない場所に残さない。**
 *
 * **塞ぐのは書く側（`startRide`）だけ。** 丸ごと差し替えると、
 * **すでに溜まっている走行が「送っていないもの: なし」に見え**（`./use-ride-log-sync.ts`
 * が `summary()` を読む）、**保持期限の掃除まで止まる**（同じファイルの `purgeRideLogs`）
 * ——設定を1つ入れただけで、**別の走行のログが黙って消えないまま残り続ける。**
 *
 * **オフなら、渡されたものをそのまま返す**（包まない）。
 */
export function rideLogStoreFor(standalone: boolean, store: RideLogStore): RideLogStore {
  if (!standalone) return store;
  // **`this` を使っていない**ので、展開して1つだけ差し替えてよい（`createRideLogStore`）。
  return { ...store, startRide: createDiscardingRideLogStore().startRide };
}

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
    // **回収したことにしない。**取り込めないので、既読位置も進めない（0 を返す）
    // ——次につないだときに、同じぶんをもう一度取りに行ける。
    addDeviceDetections: () => 0,
    deviceLogSince: () => 0,
    pending: () => null,
    markSent: () => {},
    purgeSent: () => ({ rides: 0, points: 0, detections: 0 }),
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

    addDeviceDetections(deviceId, logId, records) {
      if (records.length === 0) return 0;
      const before = countOf(
        db
          .select({ n: sql<number>`count(*)` })
          .from(deviceDetections)
          .where(and(eq(deviceDetections.deviceId, deviceId), eq(deviceDetections.logId, logId)))
          .all(),
      );

      let last = 0;
      for (const record of records) {
        // **同じキーが再び届くのは正常。**途中で切れて `since` から取り直せば、
        // 同じ区間がもう一度流れてくる（`docs/interfaces/ble-log-transfer.md`）。
        // **上書きしない**——送信済みの印（`sent_at`）を消してしまう。
        db.insert(deviceDetections)
          .values({
            deviceId,
            logId,
            seq: record.seq,
            t: record.t,
            tEst: record.tEst ? 1 : 0,
            kind: record.kind,
            lv: record.lv,
          })
          .onConflictDoNothing()
          .run();
        if (record.seq > last) last = record.seq;
      }

      // **既読位置は前に進めるだけ。**戻すと、**一度でも溢れた端末と二度と同期できなくなる**
      // （飛びの手前で止め続けると、毎回同じ位置で飛ぶ。
      // `docs/interfaces/ble-log-transfer.md`「転送の約束」の 5）。
      db.insert(appMeta)
        .values({ key: deviceLogSeqKey(deviceId, logId), value: last })
        .onConflictDoUpdate({
          target: appMeta.key,
          set: { value: sql`max(${appMeta.value}, excluded.value)` },
        })
        .run();

      // **件数は数え直す。**`run()` が返すものはドライバごとに違い、
      // **Vitest で通ったものが実機で通る保証が無い**（{@link RideLogStore.purgeSent}）。
      return (
        countOf(
          db
            .select({ n: sql<number>`count(*)` })
            .from(deviceDetections)
            .where(and(eq(deviceDetections.deviceId, deviceId), eq(deviceDetections.logId, logId)))
            .all(),
        ) - before
      );
    },

    deviceLogSince(deviceId, logId) {
      const [row] = db
        .select({ value: appMeta.value })
        .from(appMeta)
        .where(eq(appMeta.key, deviceLogSeqKey(deviceId, logId)))
        .all();
      return row?.value ?? 0;
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

      // **走行ぶんを先に送る。**デバイス発は走行に結びついていないので、
      // **どちらを先にしても取り込みの結果は変わらない**が、**古いものから送る**という
      // 順序（`rides` の `order by`）をこちらにも及ぼすため、走行を先に出し切る。
      if (ride === undefined || ride.endedAt === null) return pendingDeviceBatch(db, limits);

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
      // **「最後に送れた時刻」を走行ログとは別に残す。**送信済みの行は保持期間を過ぎたら
      // 消えるので（{@link RideLogStore.purgeSent}）、**行から出していると掃除のあとに
      // 「一度も送っていない」に戻る**（`./schema.ts` の `appMeta`）。
      db.insert(appMeta)
        .values({ key: LAST_SENT_AT_KEY, value: at })
        // **後から来た値で上書きしない。**時計が巻き戻ることがある（端末の時刻合わせ）ので、
        // **大きい方を残す**——画面に出るのは「最後に送れたのはいつか」である。
        .onConflictDoUpdate({
          target: appMeta.key,
          set: { value: sql`max(${appMeta.value}, excluded.value)` },
        })
        .run();

      // **デバイス発は走行の行を持たない**ので、`batch.rides` の輪では塗れない（#40）。
      // **`log_id` ごとに、送った `seq` の上限まで塗る**（走行ぶんと同じ形）。
      for (const logId of new Set(
        batch.detections.filter((row) => row.source === "device").map((row) => row.logId),
      )) {
        const lastSeq = lastSeqOf(
          batch.detections.filter((row) => row.source === "device"),
          logId,
        );
        if (lastSeq === null) continue;
        db.update(deviceDetections)
          .set({ sentAt: at })
          .where(
            and(
              eq(deviceDetections.deviceId, batch.deviceId),
              eq(deviceDetections.logId, logId),
              isNull(deviceDetections.sentAt),
              lte(deviceDetections.seq, lastSeq),
            ),
          )
          .run();
      }

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

    purgeSent(before) {
      // **消した件数は、消す前に数える。**`run()` が返すものはドライバごとに違い
      // （`better-sqlite3` と `expo-sqlite`）、**Vitest で通ったものが実機で通る保証が無い**
      // ——この保存層が SQL を1つにしている意味が消える。
      // **走行後に1回しか通らない**経路なので、1文増えても釣り合う。
      // **出どころ（`source`）で絞らない。**印が付いているかどうかだけを見る
      // （まだ送っていない行は `sent_at` が `null` なので触れない）。
      // **表が増えたら、ここには1行足りる**——デバイス発は別の表なので、下で同じ条件を書く。
      const sentPoints = and(isNotNull(points.sentAt), lte(points.sentAt, before));
      const sentDetections = and(isNotNull(detections.sentAt), lte(detections.sentAt, before));
      // **デバイス発も同じ期限で消す**（#40）。**既読位置は `app_meta` に残る**ので、
      // 消しても取り直しにはならない（`./schema.ts` の `deviceLogSeqKey`）。
      const sentDeviceDetections = and(
        isNotNull(deviceDetections.sentAt),
        lte(deviceDetections.sentAt, before),
      );

      const purgedPoints = countOf(
        db.select({ n: sql<number>`count(*)` }).from(points).where(sentPoints).all(),
      );
      const purgedDetections =
        countOf(
          db.select({ n: sql<number>`count(*)` }).from(detections).where(sentDetections).all(),
        ) +
        countOf(
          db
            .select({ n: sql<number>`count(*)` })
            .from(deviceDetections)
            .where(sentDeviceDetections)
            .all(),
        );

      db.delete(points).where(sentPoints).run();
      db.delete(detections).where(sentDetections).run();
      db.delete(deviceDetections).where(sentDeviceDetections).run();

      // **行が1つも残っていない走行だけを消す。**残すと「送るものが無い走行」が増え続け、
      // `pending()` の探索が伸びる。
      //
      // **走行の行にも同じ期限を効かせる。**「行が残っていない」だけを条件にすると、
      // **測位が1点も入っていない走行が、終えた直後に消える**——そして
      // **測位の購読が始まるのは走り出したあと**（`../ride/use-ride-loop.ts`）なので、
      // **消えたあとに1点目が届く**ことがある。その点は**走行の行が無いまま残り**、
      // `pending()` は `rides` から辿るので**永久に送られず、走行後の画面には
      // 「送っていない測位」として出続ける**（人には消しようがない）。
      //
      // **`ended_at` が `null` の走行も消さない。**走行中の1件がこれに当たる。
      //
      // **消した `log_id` は、以後の走行で引き当てられうる**（採番は `rides` に
      // 残っているものだけを避ける。{@link uniqueLogId}）。**16進8文字なので
      // 42億分の1**であり、**当たった場合はサーバー側で新しい走行が黙って消える**
      // （取り込みは既にあるキーを無視する）。**確率と、行を残し続ける不利益を
      // 秤にかけて、消す方を選んでいる。**
      const emptyRide = and(
        isNotNull(rides.endedAt),
        lte(rides.endedAt, before),
        notExists(
          db
            .select({ one: sql`1` })
            .from(points)
            .where(and(eq(points.deviceId, rides.deviceId), eq(points.logId, rides.logId))),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(detections)
            .where(and(eq(detections.deviceId, rides.deviceId), eq(detections.logId, rides.logId))),
        ),
      );
      const purgedRides = countOf(
        db.select({ n: sql<number>`count(*)` }).from(rides).where(emptyRide).all(),
      );
      db.delete(rides).where(emptyRide).run();

      return { rides: purgedRides, points: purgedPoints, detections: purgedDetections };
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
      const [unsentDetections] = db
        .select({ n: sql<number>`count(*)` })
        .from(detections)
        .where(and(eq(detections.source, "phone"), isNull(detections.sentAt)))
        .all();
      // **デバイス発も数える**（#40）。数えないと、**回収したのに送れていないぶんが
      // 画面のどこにも出ない**——走行後の同期は1日に1回しか走らないので、
      // 気づくのがデモの直前になる（`docs/interfaces/mobile-api.md`）。
      const [unsentDeviceDetections] = db
        .select({ n: sql<number>`count(*)` })
        .from(deviceDetections)
        .where(isNull(deviceDetections.sentAt))
        .all();
      // **行から `max(sent_at)` を出さない。**送信済みの行は保持期間を過ぎたら消えるので、
      // **掃除のあとに「一度も送っていない」に戻る**（`./schema.ts` の `appMeta`）。
      const [lastSentAt] = db
        .select({ value: appMeta.value })
        .from(appMeta)
        .where(eq(appMeta.key, LAST_SENT_AT_KEY))
        .all();

      return {
        pendingRides: rideCounts?.n ?? 0,
        pendingPoints: unsentPoints?.n ?? 0,
        pendingDetections: (unsentDetections?.n ?? 0) + (unsentDeviceDetections?.n ?? 0),
        lastSentAt: lastSentAt?.value ?? null,
      };
    },
  };
}

/**
 * デバイスから回収した検知を1回ぶん取り出す（#40）。**走行の行を載せない。**
 *
 * **取り込み側は「検知だけを送る回」を受け付ける**（`web/src/worker/logs/request.ts`
 * ——3つとも省略できる）。デバイス発の検知は走行に結びついておらず、
 * **どこで起きたかは Worker が `t` で突き合わせる**ので、走行の行を作る必要が無い。
 *
 * **1回に1つの `(device_id, log_id)` だけ**を載せる。`device_id` は1リクエストに1つと
 * 決まっており（`docs/interfaces/mobile-api.md`）、混ぜても速くならない。
 */
function pendingDeviceBatch(db: SyncSqliteDatabase, limits: PendingLimits): PendingBatch | null {
  const [head] = db
    .select({ deviceId: deviceDetections.deviceId, logId: deviceDetections.logId })
    .from(deviceDetections)
    .where(isNull(deviceDetections.sentAt))
    // **古いものから送る**（走行ぶんと同じ理由。通信が細い日に古いものだけが残らないように）。
    .orderBy(asc(deviceDetections.t))
    .limit(1)
    .all();
  if (head === undefined) return null;

  const rows = db
    .select({
      logId: deviceDetections.logId,
      seq: deviceDetections.seq,
      t: deviceDetections.t,
      tEst: deviceDetections.tEst,
      kind: deviceDetections.kind,
      lv: deviceDetections.lv,
    })
    .from(deviceDetections)
    .where(
      and(
        eq(deviceDetections.deviceId, head.deviceId),
        eq(deviceDetections.logId, head.logId),
        isNull(deviceDetections.sentAt),
      ),
    )
    // **`seq` の順に送る。**印を付けるときに「ここまで」で切れる形にしておく。
    .orderBy(asc(deviceDetections.seq))
    .limit(limits.maxDetections)
    .all();
  if (rows.length === 0) return null;

  return {
    deviceId: head.deviceId,
    rides: [],
    points: [],
    detections: rows.map((row) => ({
      source: "device",
      logId: row.logId,
      seq: row.seq,
      t: row.t,
      // **`false` を送らない。**無ければ実測、が約束である
      // （`docs/interfaces/ble-log-transfer.md`）。
      ...(row.tEst === 1 ? { tEst: true } : {}),
      kind: "rear_object",
      lv: row.lv as 1 | 2 | 3,
    })),
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
 *
 * **デバイス発（`device_detections`）はここに入らない。**あちらは走行に結びついておらず、
 * `pending()` も走行ぶんを送り切ってから別に取り出す（{@link pendingDeviceBatch}）。
 * **走行ごとに送るものを増やすときだけ、ここと `pending()` と `markSent()` を一緒に広げる。**
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

/** `count(*)` の結果。**行が返らないこと自体は正常**（数え上げる表が空でも1行返るが、備える）。 */
function countOf(rows: readonly { n: number }[]): number {
  return rows[0]?.n ?? 0;
}
