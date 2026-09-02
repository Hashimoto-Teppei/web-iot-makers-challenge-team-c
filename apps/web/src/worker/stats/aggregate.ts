/**
 * 集計そのもの。**D1 を触らない純粋な関数だけを置く。**
 *
 * **画面からも、読み取りからも分けてある**（`CLAUDE.md`「検知ロジックを入出力から分離する」）。
 * 率と順位の決め方は**実データを見て動かす**ところなので、
 * **モックデータだけで回せる形**にしておかないと、そのたびに D1 が要る。
 *
 * 数え方の正本は `docs/interfaces/web-stats.md`「率で見る」。
 */

import type { StatsCell } from "../../shared/api";
import { type Cell, cellCorner, cellKey, cellOf } from "../../shared/cell";
import type { StatsLimits } from "./config";

/** 測位点1つ。**通過（率の分母）はこれを数える。** */
export type RidePoint = {
  deviceId: string;
  logId: string;
  /** 測位した時刻（UTC ミリ秒）。**検知を突き合わせるのに使う** */
  t: number;
  lat: number;
  lon: number;
};

/** 検知1つ。**位置を持たない**（`docs/interfaces/web-service.md`「テーブル（D1）」）。 */
export type DetectionRow = {
  deviceId: string;
  /** 検知した時刻（UTC ミリ秒） */
  t: number;
  /** 何を検知したか。**地図とランキングは見ないが、場所の詳細画面（#87）が種別ごとに数える** */
  kind: string;
  /**
   * `t` が実測ではなく推定か。**地図とランキングは読む側で外している**（`query.ts`）が、
   * **詳細画面は出す**ので、ここまで運ぶ。
   */
  tEst: boolean;
};

/**
 * 場所が決まった出来事1つ。**検知と不停止の両方がこの形になる。**
 *
 * 場所の決め方は2つで違う——**検知は測位点に突き合わせて決め**（{@link matchDetections}）、
 * **不停止は標識の位置から決める**（`stop_violations` は場所を持たない）。
 * **決まったあとの数え方は同じ**なので、ここから先は1つの関数で扱う。
 */
export type LocatedEvent = {
  deviceId: string;
  logId: string;
  lat: number;
  lon: number;
  /**
   * **出来事そのものの時刻**（UTC ミリ秒）。突き合わせた測位点の時刻ではない。
   *
   * **使うのは場所の詳細画面（#87）だけ**である——地図とランキングは
   * **時刻の次元を持たない**（`docs/interfaces/web-stats.md`「集計を配る経路」）。
   */
  t: number;
};

/**
 * 走行を1つに指す鍵。`rides` の主キー `(device_id, log_id)` をそのまま文字列にしたもの。
 *
 * **通過を数えるのはこの単位**（`docs/interfaces/web-stats.md`「率で見る」）。
 * **`detail.ts` も同じものを使う**——別に書くと、**一覧と詳細で通過の数え方が割れる。**
 */
export function rideKey(ref: { deviceId: string; logId: string }): string {
  return `${ref.deviceId}/${ref.logId}`;
}

/** 場所が決まった検知。**種別を落とさずに運ぶ**（詳細画面が種別ごとに数えるため）。 */
export type LocatedDetection = LocatedEvent & Pick<DetectionRow, "kind" | "tEst">;

export type MatchResult = {
  located: LocatedDetection[];
  /**
   * 場所に結びつかなかった検知。**数ではなく行そのものを返す。**
   *
   * **黙って捨てない**（`docs/interfaces/web-stats.md`「検知を場所に結びつける」）。
   * 測位が出ていない（`nofix`）間の検知がこれに当たり、**捨てると
   * 「集計に出ていない」が「起きていない」に見える。**
   *
   * **行のまま返すのは、詳細画面が種別ごとの内訳を出すから**である
   * （`docs/interfaces/web-ui.md`）。**数だけにすると、何が落ちたのかを
   * もう一度読み直さないと出せない。**数が欲しい側は `.length` を見る。
   */
  unlocated: DetectionRow[];
};

/**
 * 検知を測位点に突き合わせて場所を決める。
 *
 * **突き合わせるのは `device_id` と `t` だけ**（`docs/interfaces/web-stats.md`）。
 * デバイス発の `log_id` は電源を入れ直すと変わり、走行と1対1で対応しないので、
 * **検知が持つ `log_id` を信じない。走行は、当たった測位点の側から決まる。**
 *
 * **`t_est` が立った検知をここへ渡さないこと**（読む側で外してある。`query.ts`）。
 * 推定した時刻は切断が長いほどずれ、**ずれた時刻に一番近い点＝別のセル**に積まれる。
 *
 * @param maxGapMs これより離れた点しか無ければ「場所不明」にする（`config.ts`）
 */
export function matchDetections(
  points: readonly RidePoint[],
  detections: readonly DetectionRow[],
  maxGapMs: number,
): MatchResult {
  // **端末ごとに時刻順の並びを1本作る。**検知1件ごとに全点を走査すると
  // 「検知 × 測位点」になり、1走行 5,000 点 × 2,000 件で 1,000 万回になる。
  const byDevice = new Map<string, RidePoint[]>();
  for (const point of points) {
    const list = byDevice.get(point.deviceId);
    if (list) list.push(point);
    else byDevice.set(point.deviceId, [point]);
  }
  for (const list of byDevice.values()) list.sort((a, b) => a.t - b.t);

  const located: LocatedDetection[] = [];
  const unlocated: DetectionRow[] = [];
  for (const detection of detections) {
    const list = byDevice.get(detection.deviceId);
    const nearest = list ? nearestByTime(list, detection.t) : undefined;
    if (!nearest || Math.abs(nearest.t - detection.t) > maxGapMs) {
      unlocated.push(detection);
      continue;
    }
    located.push({
      deviceId: nearest.deviceId,
      logId: nearest.logId,
      lat: nearest.lat,
      lon: nearest.lon,
      // **時刻は検知のもの**を残す（突き合わせた点のものではない）。ずれは最大でも
      // `maxGapMs` だが、**時間帯の境目でどちらに入るかが変わる。**
      t: detection.t,
      kind: detection.kind,
      tEst: detection.tEst,
    });
  }
  return { located, unlocated };
}

/** 時刻順に並んだ点から、`t` に一番近いものを二分探索で返す。**空なら `undefined`。** */
function nearestByTime(sorted: readonly RidePoint[], t: number): RidePoint | undefined {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    // biome-ignore lint/style/noNonNullAssertion: mid は必ず範囲内（lo < hi のため）
    if (sorted[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  // **境目の両側を見る。**`lo` は「`t` 以上の最初」なので、1つ手前の方が近いことがある。
  const after = sorted[lo];
  const before = sorted[lo - 1];
  if (!after) return before;
  if (!before) return after;
  return t - before.t <= after.t - t ? before : after;
}

export type AggregateResult = {
  cells: StatsCell[];
  /** {@link StatsLimits.maxCells} で打ち切ったか。**黙って切らないために返す** */
  truncated: boolean;
};

/**
 * セルごとの率を出して、高い順に並べる。
 *
 * ```
 * 率 = そのセルで1件以上あった走行の数 ÷ そのセルを通った走行の数
 * ```
 *
 * **分子も分母も「走行の数」で数える。件数で数えない**
 * （`docs/interfaces/web-stats.md`「率で見る」）。**件数にすると 100% を超え、
 * 順位が「危ない確率」ではなく「そこで何秒詰まったか」の順位になる**——
 * 後方物体検知のように連続して発火するものがあるためである。
 */
export function aggregateCells(
  points: readonly RidePoint[],
  events: readonly LocatedEvent[],
  limits: StatsLimits,
): AggregateResult {
  /** セルの鍵 → そのセルを通った走行。**セル自身も一緒に持つ**（鍵から戻す関数を作らないため） */
  const passes = new Map<string, { cell: Cell; rides: Set<string> }>();
  /** セルの鍵 → そのセルで1件以上あった走行 */
  const hits = new Map<string, Set<string>>();

  const addPass = (cell: Cell, ride: string): void => {
    const key = cellKey(cell);
    const found = passes.get(key);
    if (found) found.rides.add(ride);
    else passes.set(key, { cell, rides: new Set([ride]) });
  };

  for (const point of points) addPass(cellOf(point.lat, point.lon), rideKey(point));
  for (const event of events) {
    const cell = cellOf(event.lat, event.lon);
    const ride = rideKey(event);
    const key = cellKey(cell);
    const found = hits.get(key);
    if (found) found.add(ride);
    else hits.set(key, new Set([ride]));
    // **出来事のあった走行は、そのセルを通ったものとして分母にも入れる。**
    // 不停止の場所は**標識の位置**で決まるので（`stop_violations` は場所を持たない）、
    // **標識の手前 20m を通った走行の測位点が、隣のセルに落ちていることがある。**
    // 足さないと **`hits > passes` になり、率が 100% を超える。**
    addPass(cell, ride);
  }

  const cells: StatsCell[] = [];
  for (const [key, { cell, rides }] of passes) {
    if (rides.size < limits.minRides) continue;
    const hitCount = hits.get(key)?.size ?? 0;
    const corner = cellCorner(cell);
    cells.push({
      lat: corner.lat,
      lon: corner.lon,
      rides: rides.size,
      hits: hitCount,
      rate: hitCount / rides.size,
    });
  }

  // **並びを最後まで決め切る。**率と通過が同じセルが同順になると、
  // **叩くたびにランキングの並びが変わる**（読む側は「上位が入れ替わった」と読む）。
  cells.sort((a, b) => b.rate - a.rate || b.rides - a.rides || a.lat - b.lat || a.lon - b.lon);

  return {
    cells: cells.slice(0, limits.maxCells),
    truncated: cells.length > limits.maxCells,
  };
}
