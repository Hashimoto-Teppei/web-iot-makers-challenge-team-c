/**
 * デモとスライドのためのサンプルデータを作る。
 *
 *   pnpm --filter web dev                        # 先に開発サーバーを上げておく
 *   pnpm --filter web sample:generate            # 手元の標識から作る
 *   pnpm --filter web sample:generate --api https://<デプロイ先>   # デプロイ先の標識から作る
 *
 * **サンプルを立てられるのはこのスクリプトだけ**（`docs/interfaces/web-service.md`
 * 「サンプルデータは列で見分ける」）。`POST /api/logs` は `sample` の列を受け取らない
 * ——受け取る形にすると**誰でもサンプルを名乗れ、除いたつもりで除けていない集計**ができる。
 *
 * **実走行の GPS ログは使わない**（`CLAUDE.md`）。実在する一時停止の標識の位置を軸に、
 * **合成した走行**を並べている。
 *
 * **対象は岡山駅から岡山大学津島キャンパスまでの区間**（下の `ROUTE_FROM` / `ROUTE_TO`）。
 *
 * **`stop_signs` に行を足さない。**あの表は端末へ配る元でもあるので
 * （`GET /api/stop-signs`）、**架空の標識を足すと、それがそのまま全員の手元へ配られる。**
 * サンプルの走行は**実在する標識の進入方向から**作る。
 *
 * **`stop_violations` も書かない。**あの表を作るのは `POST /api/admin/recompute` だけで、
 * **再計算のたびに走行ぶんを消して入れ直す**（`docs/interfaces/web-stats.md`）。
 * ここで書いても、次の再計算で消える。**不停止のタブを見るには、投入のあとで再計算を叩く。**
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { StopSign } from "../../src/shared/api.ts";
import { PREF_OKAYAMA } from "../../src/worker/stop-signs/config.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** 1度あたりの南北の距離（メートル）。経度は緯度によって縮むので、その都度 cos を掛ける。 */
const M_PER_DEG_LAT = 111_320;

/** 走る速さ（m/s）。1Hz の測位なので、1点あたりこの距離だけ進む。 */
const CRUISE_MPS = 4;
/** 停止と見なされる速さ（m/s）。既定のしきい値 1.5 m/s を下回る値にしてある。 */
const STOPPED_MPS = 0.4;
/** 標識の手前どれだけから走り始めるか／通り過ぎてどこまで走るか（メートル）。 */
const APPROACH_M = 80;
const DEPART_M = 40;
/** 停止する走行が減速する範囲（メートル）。既定の判定半径 20m の中に入る。 */
const STOP_ZONE_M = 8;

/** 軸にする標識の数。 */
const SIGNS = 12;

/**
 * 標識ごとの走行の数。**場所によって変える**（変更・2026-09-08。#157）。
 *
 * **以前は全部 20 の固定だった。**その結果、**地図の円がどれも半径 62.6m の同じ大きさ**になり、
 * **「半径＝通行の多さ」という情報がデモの画面に1つも出ていなかった**
 * （`docs/interfaces/web-ui.md`「地図の描き方」）。
 *
 * **下の危険率とは独立に並べてある。****相関させると「通行が多い＝危ない」に見え、
 * 色と半径を別々の情報に割り当てた意味が消える**——**通行が多くて率が低い場所**
 * （交通量が多いだけ）と**通行が少なくて率が高い場所**（本当に危ない）を見分けられることが、
 * 2つを別々に割り当てた理由そのものである。
 *
 * **どれも通行の下限（既定5走行）を超えている。**下回ると、その区画は既定の画面から消える。
 * **区間の南（岡山駅側）から北（大学側）の順に対応する**（以下の配列すべて同じ）。
 */
const RIDES_PER_SIGN = [48, 12, 34, 8, 26, 40, 20, 16, 30, 11, 44, 6];

/**
 * サンプルを作る区間。**岡山駅から岡山大学津島キャンパスまで**（決定済み・2026-09-08。#154）。
 *
 * **県内から適当に6か所選ぶのをやめた**——**発表を聞く人が場所を思い浮かべられない。**
 * 岡山駅と大学を結ぶ通学路は、**この題材（自転車の事故と違反）でいちばん通行の多い区間**であり、
 * **地図を初めて見る人でも、円がどこに並んでいるのかが一目で分かる。**
 *
 * **実走行の GPS ログではない**（`CLAUDE.md`）。実在する標識の位置と進入方向だけを軸にして、
 * **走行そのものは合成している。**
 */
const ROUTE_FROM = { lat: 34.6648, lon: 133.9185 }; // 岡山駅
const ROUTE_TO = { lat: 34.6935, lon: 133.9203 }; // 岡山大学津島キャンパス
/** 区間の中心線からどれだけ離れた標識まで使うか（メートル）。 */
const CORRIDOR_M = 300;

/**
 * 標識ごとの「危なさ」（率）。**場所によって変える**——全部同じにすると、
 * **順位表が意味を持っているのかどうかを画面から確かめられない。**
 *
 * **件数ではなく率で持つ**（変更・2026-09-08。#157）。走行の数が場所ごとに違うので
 * （上の `RIDES_PER_SIGN`）、**件数で書くと、率が走行の数に引きずられて決まる。**
 * 実際に起こす走行の数は `Math.round(率 × 走行の数)` で出す。
 *
 * **画面の色の段（0 / 1〜9 / 10〜19 / 20〜39 / 40% 以上。`src/client/stats/config.ts`）が
 * すべて出るように選んである。**1つでも欠けると、**その段の色が正しいかを画面で確かめられない。**
 */
const DETECTION_RATES = [0.55, 0.05, 0.32, 0, 0.12, 0.45, 0.08, 0.22, 0.02, 0.15, 0.28, 0.65];
const STOP_RATES = [0.3, 0.62, 0.05, 0.48, 0.18, 0, 0.25, 0.08, 0.55, 0.14, 0.35, 0.02];

type Sign = { id: string; lat: number; lon: number; approachLat: number; approachLon: number };

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    /** 標識を取りに行く先。**既定は手元の開発サーバー。** */
    api: { type: "string", default: "http://localhost:5173" },
    pref: { type: "string", default: String(PREF_OKAYAMA) },
    out: { type: "string" },
  },
});

/**
 * 区間の中心線に対する位置。**`along` は岡山駅からの距離、`offset` は中心線からの離れ**
 * （どちらもメートル）。**平面と見なして計算する**——区間は 3km ほどしかなく、
 * **地球の丸みは、300m の帯に入るかどうかの判定を変えない。**
 */
function onRoute(lat: number, lon: number): { along: number; offset: number } {
  const cos = Math.cos((ROUTE_FROM.lat * Math.PI) / 180);
  const toM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => ({
    x: (b.lon - a.lon) * M_PER_DEG_LAT * cos,
    y: (b.lat - a.lat) * M_PER_DEG_LAT,
  });
  const route = toM(ROUTE_FROM, ROUTE_TO);
  const point = toM(ROUTE_FROM, { lat, lon });
  const len = Math.hypot(route.x, route.y);
  // 中心線の向きの成分が `along`、直交する成分の大きさが `offset`。
  const along = (point.x * route.x + point.y * route.y) / len;
  const offset = Math.abs((point.x * route.y - point.y * route.x) / len);
  return { along, offset };
}

/**
 * 標識を `GET /api/stop-signs` から読む。**`approach` がある行だけ**を使う——
 * **進入方向が登録されていない標識は不停止の判定の対象にならない**ので
 * （`docs/interfaces/web-stats.md`）、軸にしても不停止のタブが空のままになる。
 *
 * **`wrangler` を子プロセスで起動しない。****Windows では `pnpm` が `pnpm.cmd` に解決され、
 * Node は `.cmd` を直接起動できない**——**チームの半分でこのスクリプトが動かなくなる**
 * （`CLAUDE.md`「Windows / macOS の混在」）。**自分たちの API を使えば `fetch` だけで済む。**
 */
async function readSigns(apiBase: string, pref: number): Promise<Sign[]> {
  const url = `${apiBase.replace(/\/$/, "")}/api/stop-signs?pref=${pref}`;
  const res = await fetch(url).catch((e: unknown) => {
    throw new Error(`${url} に繋がりません（pnpm dev は動いていますか）: ${String(e)}`);
  });
  if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`);

  const body = (await res.json()) as { signs?: StopSign[] };
  const signs = body.signs ?? [];
  const onCorridor = signs
    .filter(
      (sign): sign is StopSign & { approach: { lat: number; lon: number } } =>
        sign.approach !== null,
    )
    .map((sign) => ({ sign, at: onRoute(sign.lat, sign.lon) }))
    // 区間の中の帯に入るものだけ。**`along` が区間の外に出たものも落とす**
    // （手前や向こう側の標識が、駅と大学を結ぶ線から外れた場所に円を作ってしまう）。
    .filter(
      ({ at }) =>
        at.offset <= CORRIDOR_M &&
        at.along >= 0 &&
        at.along <= onRoute(ROUTE_TO.lat, ROUTE_TO.lon).along,
    )
    .sort((a, b) => a.at.along - b.at.along);

  // **区間全体に散らす。**先頭から `SIGNS` 件取ると**駅前に固まり、大学側が空になる**——
  // 地図の上で「駅から大学まで」に見えるかどうかが、この間引きで決まる。
  // **両端を含む等間隔で拾う**（一定間隔で間引くと、割り切れないぶん北の端が余って落ちる）。
  const last = onCorridor.length - 1;
  const picked =
    onCorridor.length <= SIGNS
      ? onCorridor
      : Array.from(
          { length: SIGNS },
          (_, i) => onCorridor[Math.round((i * last) / (SIGNS - 1))] ?? onCorridor[last],
        );
  return picked
    .filter((item) => item !== undefined)
    .map(({ sign }) => ({
      id: sign.id,
      lat: sign.lat,
      lon: sign.lon,
      approachLat: sign.approach.lat,
      approachLon: sign.approach.lon,
    }));
}

/** 端末IDと走行IDは16進8文字（`docs/interfaces/ble-gatt.md`）。**サンプルだと分かる並びにする。** */
const deviceIdOf = (index: number): string => `5a3e${index.toString(16).padStart(4, "0")}`;
const logIdOf = (index: number): string => `5a3e${(0x1000 + index).toString(16).padStart(4, "0")}`;

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * 標識へ向かって走る1本の走行を作る。
 *
 * 進む向きは**進入方向の点から規制地点へ向かうベクトル**（`stop_signs.approach` の意味そのもの）。
 * **この向きで走らないと、不停止の判定が「対象の方向ではない」として落とす。**
 */
function buildRide(
  sign: Sign,
  deviceId: string,
  logId: string,
  startedAt: number,
  stops: boolean,
  detections: number,
): string[] {
  const cos = Math.cos((sign.lat * Math.PI) / 180);
  const dLat = sign.lat - sign.approachLat;
  const dLon = sign.lon - sign.approachLon;
  // 進入方向の点と規制地点が同じなら向きが決まらない。その標識は使わない。
  const lenM = Math.hypot(dLat * M_PER_DEG_LAT, dLon * M_PER_DEG_LAT * cos);
  if (lenM === 0) return [];
  const unitLat = dLat / lenM;
  const unitLon = dLon / lenM;

  const statements: string[] = [];
  const points: { t: number; lat: number; lon: number; spd: number; hacc: number }[] = [];
  let seq = 0;
  for (let offset = -APPROACH_M; offset <= DEPART_M; offset += CRUISE_MPS) {
    const inStopZone = stops && Math.abs(offset) <= STOP_ZONE_M;
    points.push({
      t: startedAt + seq * 1000,
      lat: sign.lat + unitLat * offset,
      lon: sign.lon + unitLon * offset,
      spd: inStopZone ? STOPPED_MPS : CRUISE_MPS,
      // 実測にありがちな幅を持たせる（判定から外す精度の既定は 30m）。
      hacc: 4 + (seq % 5),
    });
    seq += 1;
  }
  const endedAt = startedAt + (points.length - 1) * 1000;

  statements.push(
    "INSERT INTO rides (device_id, log_id, started_at, ended_at, sample) VALUES " +
      `(${quote(deviceId)}, ${quote(logId)}, ${startedAt}, ${endedAt}, 1);`,
  );
  for (const [index, p] of points.entries()) {
    statements.push(
      "INSERT INTO ride_points (device_id, log_id, seq, t, lat, lon, spd, crs, hacc) VALUES " +
        `(${quote(deviceId)}, ${quote(logId)}, ${index + 1}, ${p.t}, ` +
        `${p.lat.toFixed(7)}, ${p.lon.toFixed(7)}, ${p.spd}, NULL, ${p.hacc});`,
    );
  }

  // 検知は標識の位置あたりで起こす（そのセルに積まれる）。
  const middle = Math.floor(points.length / 2);
  for (let i = 0; i < detections; i++) {
    const at = points[middle + i];
    if (!at) break;
    statements.push(
      "INSERT INTO detections (device_id, source, log_id, seq, kind, lv, t, t_est, sample) VALUES " +
        `(${quote(deviceId)}, 'phone', ${quote(logId)}, ${i + 1}, 'approach', 2, ${at.t}, 0, 1);`,
    );
  }
  return statements;
}

const signs = await readSigns(values.api ?? "", Number(values.pref));
if (signs.length === 0) {
  console.error(
    [
      "岡山駅〜岡山大学津島キャンパスの区間に、進入方向つきの一時停止の標識が見つかりません。",
      "先に取り込んでください（README.md「一時停止の標識」）。サンプルの走行は実在する標識の",
      "進入方向から作るので、進入方向が登録されていない標識だけでは作れません。",
    ].join("\n"),
  );
  process.exit(1);
}

const statements: string[] = [
  "-- サンプルデータ（scripts/seed/sample.ts が生成）。**実走行の GPS ログではない。**",
  "-- 入れ直せるように、サンプルの行だけを先に消す（sample = 1 の走行とその測位点・検知）。",
  "DELETE FROM ride_points WHERE (device_id, log_id) IN (SELECT device_id, log_id FROM rides WHERE sample = 1);",
  "DELETE FROM stop_violations WHERE (device_id, log_id) IN (SELECT device_id, log_id FROM rides WHERE sample = 1);",
  "DELETE FROM detections WHERE sample = 1;",
  "DELETE FROM rides WHERE sample = 1;",
];

// 走行の時刻は1本ずつずらす（同じ時刻に固まっていると、詳細画面 #87 で時間帯が1つになる）。
let startedAt = Date.UTC(2026, 7, 24, 0, 0, 0);
let rideIndex = 0;
for (const [signIndex, sign] of signs.entries()) {
  // **標識の数が配列より多いときは末尾の値を使い回す**（取り込み次第で増えうる）。
  // **0 を配ると、その標識だけ走行が1本も出ずに地図から消える。**
  const rides = RIDES_PER_SIGN[signIndex] ?? RIDES_PER_SIGN[RIDES_PER_SIGN.length - 1] ?? 20;
  const detectionHits = Math.round((DETECTION_RATES[signIndex] ?? 0) * rides);
  const stopSkips = Math.round((STOP_RATES[signIndex] ?? 0) * rides);
  for (let i = 0; i < rides; i++) {
    statements.push(
      ...buildRide(
        sign,
        // 端末を分けて持たせる（1台の端末に全部の走行が付くと、実際の姿から遠い）。
        deviceIdOf(rideIndex % 4),
        logIdOf(rideIndex),
        startedAt,
        // **止まらなかった走行が不停止になる。**再計算を叩いたときに行が入る。
        i >= stopSkips,
        i < detectionHits ? 1 : 0,
      ),
    );
    rideIndex += 1;
    // 1本ごとに 37 分ずらす（時間帯がばらける）。
    startedAt += 37 * 60 * 1000;
  }
}

const out = values.out ?? join(here, "out", "sample.sql");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${statements.join("\n")}\n`, "utf-8");

console.log(
  [
    `${signs.length} か所の標識を軸に、${rideIndex} 走行ぶんのサンプルを書きました: ${out}`,
    "",
    "手元の D1 に入れる:",
    `  pnpm exec wrangler d1 execute team-c-db --local --file=${out}`,
    "",
    "不停止のタブを見るには、投入のあとで再計算を回す（この表はそこでしか作られない）。",
    `1回で計算できるのは20走行までなので、${rideIndex} 走行ぶんは残りが無くなるまで叩き直す:`,
    "  pnpm recompute --token <ADMIN_TOKEN>",
  ].join("\n"),
);
