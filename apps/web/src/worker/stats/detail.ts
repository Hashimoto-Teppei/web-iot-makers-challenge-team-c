/**
 * 場所の詳細（`GET /api/stats/cell`）の数え方。**D1 を触らない純粋な関数だけを置く**
 * （`aggregate.ts` と同じ理由。`CLAUDE.md`「検知ロジックを入出力から分離する」）。
 *
 * **一覧（`aggregate.ts`）と数え方が違うのは、順位を付けないから**である。
 * 一覧は**走行の数**で数える——連続して発火する検知が率を 100% 超えにするため
 * （`docs/interfaces/web-service.md`「率で見る」）。**こちらは順位を付けないので、
 * 何が何件出たかをそのまま出す。**通過だけは一覧と同じく**走行の数**で数える。
 *
 * **セルの丸めをここに書かない。**`src/shared/cell.ts` を通す——
 * **切り方が割れると、一覧と詳細が別のセルを指す。**
 */

import type { StatsCellDetailResponse, StatsHour, StatsKindCount } from "../../shared/api";
import { type Cell, cellCorner, cellKey, cellOf } from "../../shared/cell";
import type { DetectionRow, LocatedDetection, LocatedEvent, RidePoint } from "./aggregate";
import { rideKey } from "./aggregate";

/**
 * 日本時間の時差（ミリ秒）。**時間帯は日本時間で切る。**
 *
 * **UTC のまま切ると、朝の通勤時間帯が前日の 23 時台に出る**——
 * 画面に出るのは「8時台」という日本語なので、**見る人の時計と合っていないと
 * 数字そのものが誤読される。**
 *
 * **夏時間を考えない**（日本には無い）。**他の国のデータを扱うことになったら、
 * そのときに時間帯の切り方ごと決め直す**（`CLAUDE.md`「早すぎる抽象化を避ける」）。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;

const MS_PER_HOUR = 60 * 60 * 1_000;
const HOURS_PER_DAY = 24;

/**
 * UTC ミリ秒を**日本時間の何時台か**（0〜23）にする。
 *
 * **日付を落とすのはここ**である（`docs/interfaces/web-ui.md`「詳細画面で時刻を丸める」）。
 * **110m のセルと秒単位の時刻を時系列に並べると、1人の走行経路が復元できる**ので、
 * **この画面に日付は出さない。**
 */
export function hourOfDay(t: number): number {
  return Math.floor((t + JST_OFFSET_MS) / MS_PER_HOUR) % HOURS_PER_DAY;
}

/** 1時間ぶんの入れ物。**走行は集合で持つ**（同じ走行が何点あっても通過は1つ）。 */
type HourBucket = {
  rides: Set<string>;
  detections: Map<string, number>;
  violations: number;
};

const emptyBucket = (): HourBucket => ({ rides: new Set(), detections: new Map(), violations: 0 });

const bump = (counts: Map<string, number>, kind: string): void => {
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
};

/**
 * 種別ごとの件数を**多い順**に並べる。
 *
 * **同数のときは `kind` の順で決め切る。**決めないと `Map` の挿入順に従い、
 * **叩くたびに並びが変わる**（読む側は「増えた」と読む）。
 */
export function kindCounts(counts: Map<string, number>): StatsKindCount[] {
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
}

export type CellDetailInput = {
  /** どのセルの内訳か */
  cell: Cell;
  /** 測位点。**セルの外のものが混ざっていてよい**（ここで絞る） */
  points: readonly RidePoint[];
  /** 場所が決まった検知。**`t_est` のものも含めて渡す**（この画面は出す側） */
  detections: readonly LocatedDetection[];
  /** 場所が決まった不停止。**場所は標識から決まっている**ので突き合わせは済んでいる */
  violations: readonly LocatedEvent[];
  /** 場所が分からなかった検知。**セルに属さないので、全体の数として返す** */
  unlocatedDetections: readonly DetectionRow[];
  /** 場所が分からなかった不停止の数（標識を辿れなくなったもの） */
  unlocatedViolations: number;
};

/**
 * 1つのセルの内訳を、時間帯ごとに出す。
 *
 * **何も無かった時間帯は返さない。**24 行を常に返すと、**0 が並ぶ表の中から
 * 数字のある行を探すことになる。**
 */
export function aggregateCellDetail(
  input: CellDetailInput,
): Omit<StatsCellDetailResponse, "sample"> {
  const target = cellKey(input.cell);
  const inCell = (lat: number, lon: number): boolean => cellKey(cellOf(lat, lon)) === target;

  const buckets = new Map<number, HourBucket>();
  const bucketAt = (hour: number): HourBucket => {
    const found = buckets.get(hour);
    if (found) return found;
    const created = emptyBucket();
    buckets.set(hour, created);
    return created;
  };

  /** セル全体の通過。**時間帯の足し算にしない**——またいだ走行を二重に数えることになる。 */
  const allRides = new Set<string>();
  const allDetections = new Map<string, number>();
  let allViolations = 0;
  let tEstimated = 0;

  for (const point of input.points) {
    if (!inCell(point.lat, point.lon)) continue;
    const ride = rideKey(point);
    bucketAt(hourOfDay(point.t)).rides.add(ride);
    allRides.add(ride);
  }

  for (const detection of input.detections) {
    if (!inCell(detection.lat, detection.lon)) continue;
    bump(bucketAt(hourOfDay(detection.t)).detections, detection.kind);
    bump(allDetections, detection.kind);
    if (detection.tEst) tEstimated += 1;
  }

  for (const violation of input.violations) {
    if (!inCell(violation.lat, violation.lon)) continue;
    const bucket = bucketAt(hourOfDay(violation.t));
    bucket.violations += 1;
    allViolations += 1;
    // **不停止のあった走行は、そのセルを通ったものとして通過にも入れる**（`aggregate.ts`
    // と同じ扱い）。**不停止の場所は標識の位置で決まる**ので、**手前 20m を通った走行の
    // 測位点が隣のセルに落ちていることがある。**足さないと**通過 0 のセルに不停止だけが立つ。**
    const ride = rideKey(violation);
    bucket.rides.add(ride);
    allRides.add(ride);
  }

  const hours: StatsHour[] = [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([hour, bucket]) => ({
      hour,
      rides: bucket.rides.size,
      detections: kindCounts(bucket.detections),
      violations: bucket.violations,
    }));

  const corner = cellCorner(input.cell);
  return {
    lat: corner.lat,
    lon: corner.lon,
    hours,
    totals: {
      rides: allRides.size,
      detections: kindCounts(allDetections),
      violations: allViolations,
    },
    tEstimated,
    unlocated: {
      detections: kindCounts(
        input.unlocatedDetections.reduce((counts, row) => {
          bump(counts, row.kind);
          return counts;
        }, new Map<string, number>()),
      ),
      violations: input.unlocatedViolations,
    },
  };
}
