import { angleDiffDeg, bearingDeg, distanceM } from "../geo";
import { MIN_BEARING_SPAN_M } from "./config";

/**
 * 不停止の判定。**D1 にも Hono にも触らない純粋な関数**にしてある
 * （`CLAUDE.md`「検知ロジックを入出力から分離する」）。合成した点列だけで Vitest を回せる。
 *
 * **仕様の正本は `docs/interfaces/web-service.md`「不停止の判定」。**
 * ここはその実装であって、決め直す場所ではない。
 */

/** 判定に使うしきい値。**すべてリクエストで受け取る**（`request.ts`）。 */
export type Thresholds = {
  /** これを下回った点があれば「止まった」と見なす（m/s） */
  stopSpeedMps: number;
  /** 標識からこの距離の中を通ったら、その標識の手前を通ったと見なす（メートル） */
  radiusM: number;
  /** 標識の進入方向と走行の方角のずれが、これを超えたら対象外にする（度） */
  bearingToleranceDeg: number;
  /** 水平位置精度がこれより悪い測位点を、判定から外す（メートル） */
  maxHaccM: number;
};

/** 判定に使う測位点。`ride_points` のうち、判定が見る列だけ。 */
export type JudgePoint = {
  t: number;
  lat: number;
  lon: number;
  spd: number;
  hacc: number;
};

/**
 * 判定に使う標識。
 *
 * **`crs`（端末が打った方角）を受け取らない。**走行の側の方角は点の並びから出す
 * （`docs/unverified.md` 57）。
 */
export type JudgeSign = {
  id: string;
  lat: number;
  lon: number;
  /** **この点から `(lat, lon)` へ向かって走る車両**が規制の対象。`null` は「登録が無い」 */
  approachLat: number | null;
  approachLon: number | null;
};

/** 1件の不停止。**位置を持たない**——場所は `signId` を辿って出す（`db/schema.ts`）。 */
export type Violation = {
  signId: string;
  /** 標識に一番近づいた測位点の時刻（UTC ミリ秒） */
  t: number;
};

/** 標識の半径の中を連続して通った区間。**1回の走行が同じ標識を2度通れば2つできる。** */
type Visit = {
  /** 半径に入る直前までさかのぼれるように、点列全体での添字で持つ */
  startIndex: number;
  endIndex: number;
  closestIndex: number;
};

/**
 * 走行の方角を、点の並びから出す。
 *
 * **`ride_points.crs` を使わない。**方角の無い測位が `0`（真北）として入っていることがあり
 * （`docs/unverified.md` 57）、**信じると東西に走った不停止が北向きの標識に付く。**
 *
 * **標識に一番近づいた点へ「どこから来たか」を見る。**半径に入る前の点までさかのぼるのは、
 * **止まっている間の点だけで方角を出すと、数十 cm のゆらぎが方角になる**ため。
 * さかのぼる範囲は距離で切ってあるので、**周回して同じ標識を2度通っても前の周まで戻らない。**
 *
 * **決められなければ `null`。**呼ぶ側はその訪問を対象外にする——
 * **見逃す側に倒す**（`docs/interfaces/web-service.md`「しきい値の既定値」）。
 */
function travelBearingOf(points: readonly JudgePoint[], visit: Visit): number | null {
  const target = points[visit.closestIndex];
  if (!target) return null;

  // 半径に入る手前へさかのぼり、方角を出せるだけ離れた最初の点を探す。
  for (let i = visit.startIndex; i >= 0; i--) {
    const p = points[i];
    if (!p) continue;
    if (distanceM(p.lat, p.lon, target.lat, target.lon) >= MIN_BEARING_SPAN_M) {
      return bearingDeg(p.lat, p.lon, target.lat, target.lon);
    }
  }

  // さかのぼれない（走行が半径の中から始まっている）ときだけ、区間全体の向きで代える。
  const first = points[visit.startIndex];
  const last = points[visit.endIndex];
  if (!first || !last) return null;
  if (distanceM(first.lat, first.lon, last.lat, last.lon) < MIN_BEARING_SPAN_M) return null;
  return bearingDeg(first.lat, first.lon, last.lat, last.lon);
}

/** 1つの標識について、半径の中を通った区間を切り出す。 */
function visitsOf(points: readonly JudgePoint[], sign: JudgeSign, radiusM: number): Visit[] {
  const visits: Visit[] = [];
  let current: Visit | null = null;
  let closestM = Number.POSITIVE_INFINITY;

  for (const [i, p] of points.entries()) {
    const d = distanceM(p.lat, p.lon, sign.lat, sign.lon);
    if (d <= radiusM) {
      if (!current) {
        current = { startIndex: i, endIndex: i, closestIndex: i };
        closestM = d;
      } else {
        current.endIndex = i;
        if (d < closestM) {
          current.closestIndex = i;
          closestM = d;
        }
      }
    } else if (current) {
      visits.push(current);
      current = null;
      closestM = Number.POSITIVE_INFINITY;
    }
  }
  if (current) visits.push(current);

  return visits;
}

/**
 * 1回の走行ぶんの不停止を出す。
 *
 * **点は時刻の順に並べ直してから見る。**`seq` と `t` の順が一致する想定だが、
 * **区間の切り出しも方角も並びに依存する**ので、並びをここで確定させる。
 *
 * **精度の悪い点はここで落とす。**取り込み（`POST /api/logs`）は足切りをしない
 * （`logs/config.ts`）——**捨てたら二度と戻らない生ログ**だからで、
 * **どこで切るかは、そのときのしきい値で計算する側が決める。**
 *
 * **進入方向が登録されていない標識は対象にしない。**「全方向が対象」ではなく
 * 「元データに登録が無い」（`db/schema.ts`）ので、**向きを確かめずに不停止と判定すると、
 * 対向車線や交差する道路を走っただけで濡れ衣になる。**
 */
export function judgeRide(
  points: readonly JudgePoint[],
  signs: readonly JudgeSign[],
  thr: Thresholds,
): Violation[] {
  const usable = points.filter((p) => p.hacc <= thr.maxHaccM).sort((a, b) => a.t - b.t);
  if (usable.length === 0) return [];

  const violations: Violation[] = [];

  for (const sign of signs) {
    if (sign.approachLat === null || sign.approachLon === null) continue;
    // **標識が対象とする進入方向**＝進入方向の点から規制地点へ向かう向き。
    const wanted = bearingDeg(sign.approachLat, sign.approachLon, sign.lat, sign.lon);
    if (wanted === null) continue;

    for (const visit of visitsOf(usable, sign, thr.radiusM)) {
      const travel = travelBearingOf(usable, visit);
      if (travel === null) continue;
      if (angleDiffDeg(travel, wanted) > thr.bearingToleranceDeg) continue;

      // **1点でも下回っていれば止まったと見なす。**GPS の速度が跳ねた点があっても、
      // 止まった点が残っていれば不停止にならない（跳ねは濡れ衣を作らない側に効く）。
      let stopped = false;
      for (let i = visit.startIndex; i <= visit.endIndex; i++) {
        const p = usable[i];
        if (p && p.spd < thr.stopSpeedMps) {
          stopped = true;
          break;
        }
      }
      if (stopped) continue;

      const closest = usable[visit.closestIndex];
      if (closest) violations.push({ signId: sign.id, t: closest.t });
    }
  }

  // 並びを決めておく。**同じ入力から毎回同じ順で行ができる**方が、作り直した結果を比べられる。
  return violations.sort((a, b) => a.t - b.t || a.signId.localeCompare(b.signId));
}
