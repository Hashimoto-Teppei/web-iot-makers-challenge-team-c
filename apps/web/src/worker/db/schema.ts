import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * D1 が動いていることを確かめるための仮のテーブル。
 *
 * 本来のテーブル設計は Issue #7（モバイル ⇄ API の仕様と D1 のテーブル設計）で決める。
 * 決まったらこのテーブルは削除する。ここに本番のカラムを足していかないこと。
 */
export const pings = sqliteTable("pings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  message: text("message").notNull(),
  // D1（SQLite）に日時型はない。文字列で ISO 8601（UTC）を持たせる。
  // datetime('now') だと "2026-08-23 07:11:33" 形式になり、JavaScript の Date が確実には解釈できない。
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

/**
 * 一時停止の標識。JARTIC の交通規制情報オープンデータ（共通規制種別コード 63）から
 * 抽出したもの。取り込みは `scripts/stop-signs/`、配るのは `GET /api/stop-signs`。
 *
 * **端末側（`apps/mobile` の `signs.db`）とスキーマを共有しない。**列も目的も別物で、
 * 揃えにいくと片方の都合がもう片方に漏れる（`docs/adr/0009-on-device-storage.md`）。
 * 端末はセルの列を持つが、こちらは持たない——D1 側でセルが要るのは集計（走行ログとの
 * 突き合わせ）で、そちらは `ride_points` を切る話であって標識の列ではない。
 */
export const stopSigns = sqliteTable(
  "stop_signs",
  {
    /**
     * 標識の識別子。**取り込み直しても同じ標識には同じ値が付くこと。**
     *
     * この値は端末まで運ばれ、警告の抑制キー（`causeId`）になる
     * （`apps/mobile/src/ride/warn-gate.ts`）。取り込みのたびに変わると、
     * **同じ標識が毎回「別の標識」として鳴り直す。**
     */
    id: text("id").primaryKey(),
    /** 都道府県コード（岡山県 = 33） */
    pref: integer("pref").notNull(),
    /** 規制地点の緯度（度、WGS84）。**停止線の位置とは限らず、交差点中央部のこともある** */
    lat: real("lat").notNull(),
    /** 規制地点の経度（度、WGS84） */
    lon: real("lon").notNull(),
    /**
     * **この標識が対象とする車両の進入方向**を表す点。
     * **この点から規制地点へ向かって走る車両**が規制の対象になる。
     *
     * **単に近いだけで拾うと、対向車線や交差する道路の標識で警告が鳴る**ので、
     * 一時停止の事前通知（#27）はこの点を見る。元データ（JARTIC の「進入方向（座標）」）が
     * 方向ごとに座標を持っているので、**1つの交差点に複数の進入方向があれば、
     * 行も方向のぶんだけ分かれる。**
     *
     * **`null` は「全方向が対象」ではなく「元データに登録が無い」。**
     */
    approachLat: real("approach_lat"),
    approachLon: real("approach_lon"),
    // **交差点名称の列は置かない。**元データ（JARTIC）の該当列は岡山県では全行が空で、
    // 走行後の画面で場所を人に読ませる用途には使えなかった
    // （`docs/interfaces/stop-signs-source.md`）。
  },
  // 配るときは常に都道府県ぶんを丸ごと引く（`docs/interfaces/mobile-api.md`）。
  (t) => [index("stop_signs_pref_idx").on(t.pref)],
);

/**
 * 標識の版。**都道府県ごとに1行**で、取り込みのたびに置き換える。
 *
 * **版をサーバーが持つことが、この表がある理由のすべて**である
 * （`docs/interfaces/mobile-api.md`「版はサーバーが決める」）。ここで作らないと
 * 端末が独自の版番号を作り始め、`If-None-Match` で突き合わせられなくなる。
 *
 * `count` は**取り込んだ時点の件数の記録**。`GET /api/stop-signs` は配る前にこの値と
 * 実際の行数を突き合わせ、**食い違っていたら配らずに落とす**（`src/worker/index.ts`）。
 * 取り込みの SQL はトランザクションで囲めない（D1 が `BEGIN` を受け付けない）ので、
 * 途中で落ちると**版だけが新しくなって中身が欠ける**——そのまま配ると、端末が
 * 正しく揃っている手元の `signs.db` を欠けたもので置き換える。
 */
export const stopSignVersions = sqliteTable("stop_sign_versions", {
  /** 都道府県コード。**この表は都道府県ごとに1行しか持たない** */
  pref: integer("pref").primaryKey(),
  /** ETag の元になる値。**取り込んだ中身から決まる**（同じ CSV を入れ直しても変わらない） */
  version: text("version").notNull(),
  /** その版に入っている標識の件数 */
  count: integer("count").notNull(),
  /** 取り込んだ時刻（ISO 8601、UTC） */
  importedAt: text("imported_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
});

/**
 * 1回の走行。**スマホが走行後にまとめて送る**（`POST /api/logs`）。
 *
 * **主キーは `(device_id, log_id)`。サーバー側で別の ID を振らない**
 * （`docs/interfaces/web-service.md`「テーブル（D1）」）。振ると、同じ走行が
 * 2回送られたときに**同じ走行だと分からないまま2行できる。**
 *
 * **`devices` テーブルは作らない。**`device_id` は BLE のアドバタイズに出ている
 * 16進8文字で、誰でも名乗れる——登録してあることが何も保証しない以上、
 * 登録の手続きは手間だけが残る（同上「端末の表を作らない」）。
 */
export const rides = sqliteTable(
  "rides",
  {
    /** 端末ID（16進の小文字8文字）。**スマホ発の行でも、接続していたデバイスの ID** */
    deviceId: text("device_id").notNull(),
    /** 走行の識別子（16進の小文字8文字）。**スマホが走行ごとに作る** */
    logId: text("log_id").notNull(),
    /**
     * 開始と終了（UTC ミリ秒）。
     *
     * **文字列の ISO 8601 にしない**（`pings` とは違う）。この列は `ride_points.t` や
     * `detections.t` と引き算・比較をする——**デバイス発の検知を走行に結びつけるのは
     * `(device_id, t)` だけ**なので（`docs/interfaces/web-stats.md`）、
     * **突き合わせる相手と同じ単位で持つ。**
     */
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at").notNull(),
    /**
     * デモとスライドのために入れたデータか。
     *
     * **`POST /api/logs` はこの列を受け取らない。**常に「サンプルではない」として入れる
     * （`docs/interfaces/web-service.md`「サンプルデータは列で見分ける」）。
     * **受け取る形にすると誰でもサンプルを名乗れ、除いたつもりで除けていない集計ができる。**
     * 立てられるのは投入スクリプトだけ。
     */
    sample: integer("sample", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.logId] }),
    // 集計は期間で切って走行を数える（`docs/interfaces/web-stats.md`「率で見る」）。
    index("rides_started_at_idx").on(t.startedAt),
  ],
);

/**
 * 測位の連続点。**間引かずにそのまま残す**（`docs/adr/0007-keep-raw-ride-logs.md`）。
 *
 * **残しているのは、走り直さずにしきい値を変えて不停止を計算し直すため**であって、
 * 画面に出すためではない。**生の点を画面に出さない**——出すのはセルに丸めたものだけで、
 * それがこの表を持ってよい条件そのものである。
 *
 * **一意キーは `(device_id, log_id, seq)`。`source` の列を持たない**——
 * 測位点はスマホ発しか無い（デバイスは位置を知らない）ので、`'phone'` しか入らない列は
 * **入っていることを確かめる手間だけを増やす**（`docs/interfaces/web-service.md`）。
 */
export const ridePoints = sqliteTable(
  "ride_points",
  {
    deviceId: text("device_id").notNull(),
    logId: text("log_id").notNull(),
    /** 走行の中での点の番号。**スマホが 1 から振る**。取り込みの一意キーを兼ねる */
    seq: integer("seq").notNull(),
    /** 測位した時刻（UTC ミリ秒）。打ったのはスマホの時計 */
    t: integer("t").notNull(),
    /** 緯度・経度（度、WGS84） */
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    /** 対地速度（m/s）。**不停止の判定はこの値を見る** */
    spd: real("spd").notNull(),
    /**
     * 進行方角（度、真北 0）。**低速時は `null`。**
     *
     * **不停止の判定でこの列を使わない**（`docs/interfaces/web-stats.md`「不停止の判定」）。
     * **方角の無い測位が `0`（真北）として入っていることがある**（`docs/unverified.md` 57）。
     * 走行の側の方角は**点の並びから出す。**
     */
    crs: real("crs"),
    /** 水平位置精度（メートル） */
    hacc: real("hacc").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.logId, t.seq] }),
    // 不停止の判定（#85）は走行ぶんを時刻順に読む。主キーの並びは seq なので、
    // 時刻で引くための索引を別に置く（seq と t の順序は一致する想定だが、頼らない）。
    index("ride_points_device_t_idx").on(t.deviceId, t.t),
  ],
);

/**
 * 検知。**端末が走行中に確定させたもので、あとから作り直せない**
 * （`docs/interfaces/web-service.md`「検知と不停止は別物である」）。
 *
 * **走行（`rides`）を指さない。**外部キーも `ride_id` の列も持たない——
 * **デバイス発の `log_id` は電源を入れ直すと変わり、走行と1対1で対応しない**
 * （`docs/interfaces/ble-log-transfer.md`）。**`(device_id, t)` から `rides` の期間で引く。
 * この規則1つで、スマホ発とデバイス発の両方を同じように扱う。**
 *
 * **位置も持たない。**スマホ発は知っているが、それでも入れない——入れると
 * デバイス発だけが `NULL` の列ができ、**「位置が無い」と「突き合わせに失敗した」の
 * 区別がつかなくなる。**
 */
export const detections = sqliteTable(
  "detections",
  {
    deviceId: text("device_id").notNull(),
    /**
     * 出どころ（`phone` / `device`）。**主キーに入っている。**
     *
     * スマホは自分で `log_id` と `seq` を作るが、`device_id` はデバイスのものを使う
     * （`docs/interfaces/mobile-api.md`）。**入れないと、デバイスの `log_id=1, seq=1` と
     * スマホの `log_id=1, seq=1` が同じキーになり、片方が黙って消える。**
     */
    source: text("source", { enum: ["phone", "device"] }).notNull(),
    logId: text("log_id").notNull(),
    seq: integer("seq").notNull(),
    /** 何を検知したか。値の正本は `docs/interfaces/ble-log-transfer.md`「検知ログの `body`」 */
    kind: text("kind").notNull(),
    /** 強さ（1〜3）。「確からしさ」ではない（`docs/interfaces/detectors.md`） */
    lv: integer("lv").notNull(),
    /** 検知した時刻（UTC ミリ秒） */
    t: integer("t").notNull(),
    /**
     * `t` が実測ではなく**単調時計からの推定**か（`docs/interfaces/ble-log-transfer.md`）。
     *
     * BLE が切れている間、デバイスは最後に受け取った `beat` の `t` に経過を足して打つ。
     * **切断が長いほどずれ、ずれた時刻に一番近い測位点＝別のセルに積まれる**ので、
     * **地図とランキングの集計から除く**（詳細画面には出す。
     * `docs/interfaces/web-stats.md`「検知を場所に結びつける」）。
     *
     * **スマホ発の行では必ず `false`。**取り込みが受け取るのはデバイス発だけである
     * （`src/worker/logs/request.ts`）。
     */
    tEst: integer("t_est", { mode: "boolean" }).notNull().default(false),
    /** サンプルデータか。**`POST /api/logs` はこの列を受け取らない**（`rides` と同じ理由） */
    sample: integer("sample", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.source, t.logId, t.seq] }),
    // 場所に結びつけるときは `(device_id, t)` で引く（この表の唯一の引き方）。
    index("detections_device_t_idx").on(t.deviceId, t.t),
  ],
);

/**
 * 不停止。**サーバーが走行ログと標識から計算したもので、何度でも作り直せる**
 * （`docs/interfaces/web-stats.md`「不停止の判定」）。
 *
 * **`POST /api/logs` からは絶対に書かない。**この表を作るのは
 * `POST /api/admin/recompute`（#85）だけで、**再計算のたびに走行ぶんを消して入れ直す。**
 * 追記だけの他の表とは性質が違う。
 *
 * **表を先に置いてあるのは、`ride_points` と対で使うものだから**である（#80 で作った）。
 * **列は #85 が必要に応じて足してよい**——判定の中身はそちらが決める。
 */
export const stopViolations = sqliteTable(
  "stop_violations",
  {
    /**
     * 連番。**この表だけは代理キーを持つ。**
     *
     * `(device_id, log_id, sign_id)` を主キーにできないのは、**1回の走行が同じ標識を
     * 2度通りうる**ため（周回すれば起こる）。主キーにすると、2度目が黙って消える。
     */
    id: integer("id").primaryKey({ autoIncrement: true }),
    deviceId: text("device_id").notNull(),
    logId: text("log_id").notNull(),
    /** どの標識か（`stop_signs.id`）。**場所はこの標識を辿って出す**（この表に持たない） */
    signId: text("sign_id").notNull(),
    /** 標識を通過したと判定した時刻（UTC ミリ秒） */
    t: integer("t").notNull(),
    /**
     * 判定に使ったしきい値。**残さないと、どの設定で作られた行なのか分からなくなり、
     * 作り直す判断ができない**（`docs/interfaces/web-service.md`）。
     */
    thrStopSpeedMps: real("thr_stop_speed_mps").notNull(),
    thrRadiusM: real("thr_radius_m").notNull(),
    thrBearingToleranceDeg: real("thr_bearing_tolerance_deg").notNull(),
    /**
     * 判定から外した測位精度の下限（メートル）。**#85 が足した列**（2026-09-02）。
     *
     * **取り込みは精度で足切りをしない**（`src/worker/logs/config.ts`）ので、
     * **切るのは判定のときだけ**であり、**どこで切ったかは他の3つと同じだけ結果を変える。**
     * 残さないと、**同じしきい値で作り直したつもりの行が別のものになる。**
     */
    thrMaxHaccM: real("thr_max_hacc_m").notNull(),
    /** 計算した時刻（ISO 8601、UTC） */
    computedAt: text("computed_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`),
  },
  // 再計算は走行ぶんを消してから入れ直すので、その単位で引ける索引を置く。
  (t) => [index("stop_violations_ride_idx").on(t.deviceId, t.logId)],
);
