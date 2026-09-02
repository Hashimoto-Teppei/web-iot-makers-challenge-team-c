import { useMemo } from "react";
import type { StatsSample } from "../../shared/api";
import { Link, statsPath } from "../route";
import { kindLabel } from "./kinds";
import { useCellDetail } from "./use-cell-detail";

/**
 * 場所の詳細。**1つのセルの内訳を、時間帯ごとに出す**（`docs/interfaces/web-ui.md`「画面」）。
 *
 * **この画面だけが時刻という次元を持つ。**だから、ここが一番プライバシーに近い。
 *
 * - **秒単位の時刻を並べない。**出るのは「何時台」だけ（丸めるのは Worker。`stats/detail.ts`）
 * - **`device_id` を出さない。**丸めた時間帯でも、**同じ端末の行を拾い集めれば経路が並ぶ**
 * - **生の測位点を出さない**
 *
 * **セルに読める名前は付かない**（`docs/interfaces/web-ui.md`「場所は地図が示す」）。
 * 出すのは代表座標（南西の角）だけで、**土地勘と結びつけるのは一覧の地図の仕事**である。
 */

export type CellPageProps = {
  lat: number;
  lon: number;
  sample: StatsSample;
};

export function CellPage({ lat, lon, sample }: CellPageProps) {
  const query = useMemo(() => ({ lat, lon, sample }), [lat, lon, sample]);
  const { data, error, loading } = useCellDetail(query);

  // **列は「このセルに出た種別」だけ。**5種類を常に並べると、
  // 出ていない検知の 0 が表の大半を占める。合計の並び（多い順）をそのまま使う。
  const kinds = data?.totals.detections.map((count) => count.kind) ?? [];

  return (
    <main className="stats">
      <header>
        <p className="back">
          <Link to={statsPath(sample)}>← どこが危ないか（一覧）</Link>
        </p>
        {/* **応答が返した代表座標を出す**（渡した値ではない）。**セルの中のどの点を渡しても
            同じ内訳が返る**ので、渡した値をそのまま出すと、**下に並ぶ数字とは別のセルの名前**が
            見出しになる。読み込み中だけは、渡した値を丸めずに出す。 */}
        <h1>
          {(data?.lat ?? lat).toFixed(3)}, {(data?.lon ?? lon).toFixed(3)} の内訳
        </h1>
        <p>
          セル（緯度経度を小数第3位で切り捨てた升目、岡山でおよそ 111m × 92m）1つぶん。
          <strong>数字は日本時間の時間帯ごと</strong>で、
          <strong>検知と不停止は件数、通過は走行の数</strong>で数えている。
          {sample === "exclude" && <strong>サンプルデータは除いている。</strong>}
        </p>
      </header>

      {error && <p className="error">エラー: {error}</p>}
      {loading && <p className="loading">読み込み中…</p>}

      {data && (
        <>
          <p className="totals">
            合計: 通過 {data.totals.rides} 走行 / 検知 {countOf(data.totals.detections)} 件 / 不停止{" "}
            {data.totals.violations} 件
          </p>

          {data.hours.length === 0 ? (
            <p className="note">
              このセルには、まだ何も入っていません。通過も検知も不停止も 0 件です。
            </p>
          ) : (
            <table className="hours">
              <thead>
                <tr>
                  <th scope="col">時間帯</th>
                  <th scope="col">通過</th>
                  {kinds.map((kind) => (
                    <th key={kind} scope="col">
                      {kindLabel(kind)}
                    </th>
                  ))}
                  <th scope="col">不停止</th>
                </tr>
              </thead>
              <tbody>
                {data.hours.map((hour) => (
                  <tr key={hour.hour}>
                    <th scope="row">{hour.hour}時台</th>
                    <td>{hour.rides}</td>
                    {kinds.map((kind) => (
                      <td key={kind}>
                        {hour.detections.find((count) => count.kind === kind)?.count ?? 0}
                      </td>
                    ))}
                    <td>{hour.violations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data.tEstimated > 0 && (
            <p className="note">
              このうち {data.tEstimated} 件は、
              <strong>デバイスが推定した時刻で打たれた検知</strong>
              です（BLE が切れている間のもの）。時刻がずれているぶん場所も確かではないため、
              <strong>地図とランキングには入っていません。</strong>
            </p>
          )}

          {(data.unlocated.detections.length > 0 || data.unlocated.violations > 0) && (
            <p className="note">
              <strong>場所が分からなかったもの（このセルに限らない全体の数）</strong>:{" "}
              {data.unlocated.detections
                .map((count) => `${kindLabel(count.kind)} ${count.count} 件`)
                .join(" / ")}
              {data.unlocated.detections.length > 0 && data.unlocated.violations > 0 && " / "}
              {data.unlocated.violations > 0 && `不停止 ${data.unlocated.violations} 件`}
              。検知は<strong>測位が出ていない間に発火したもの</strong>、 不停止は
              <strong>標識を取り込み直して位置を辿れなくなったもの</strong>で、
              どのセルにも入っていない。
              <strong>
                一覧の「場所が分からなかった数」より多くなることがある——あちらは時刻が推定の検知を
                最初から除いているため。
              </strong>
            </p>
          )}
        </>
      )}
    </main>
  );
}

const countOf = (counts: { count: number }[]): number =>
  counts.reduce((total, item) => total + item.count, 0);
