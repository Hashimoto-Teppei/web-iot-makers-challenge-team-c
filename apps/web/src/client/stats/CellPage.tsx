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
    <main className="stats stats--cell">
      <header>
        <p className="back">
          <Link to={statsPath(sample)}>← 一覧にもどる</Link>
        </p>
        {/* **応答が返した代表座標を出す**（渡した値ではない）。**セルの中のどの点を渡しても
            同じ内訳が返る**ので、渡した値をそのまま出すと、**下に並ぶ数字とは別のセルの名前**が
            見出しになる。読み込み中だけは、渡した値を丸めずに出す。 */}
        {/* **座標だけを見出しにしない。**数字が単独で置かれると、
         **何の数字なのかが見出しから読めない。**「区画」を頭に付けるだけで足りる。 */}
        <h1>
          区画 {(data?.lat ?? lat).toFixed(3)}, {(data?.lon ?? lon).toFixed(3)}
        </h1>
        {/* **「セル」の定義を書き直さない。**一覧で一度説明した語なので、
            ここでは寸法だけを添える（`docs/interfaces/web-ui.md`「画面に出す言葉」）。 */}
        <p>
          この区画（約110m四方）の<strong>時間帯ごとの内訳</strong>です。時刻は日本時間。
          <strong>警告と一時不停止は件数、通行は走行数</strong>で数えています。
          {sample === "exclude" && <strong>デモ用のサンプルは除いています。</strong>}
        </p>
      </header>

      {error && <p className="error">エラー: {error}</p>}
      {loading && <p className="loading">読み込み中…</p>}

      {data && (
        <>
          {/* **1つずつ要素に分ける。**地続きの文字列のままだと、
           **狭い画面で「0」と「件」の間で行が折れる。** */}
          <p className="totals">
            <span>通行 {data.totals.rides} 走行</span>
            <span>警告 {countOf(data.totals.detections)} 件</span>
            <span>一時不停止 {data.totals.violations} 件</span>
          </p>

          {data.hours.length === 0 ? (
            <p className="note">
              この区画には、まだ何も入っていません。通行も警告も一時不停止も 0 件です。
            </p>
          ) : (
            <div className="card table-card">
              <table className="hours">
                <thead>
                  <tr>
                    <th scope="col">時間帯</th>
                    <th scope="col">通行</th>
                    {kinds.map((kind) => (
                      <th key={kind} scope="col">
                        {kindLabel(kind)}
                      </th>
                    ))}
                    <th scope="col">一時不停止</th>
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
            </div>
          )}

          {/* **BLE という語を画面に出さない。**利用者から見えているのは
              「スマホと切れている」ことだけで、**その下の通信方式は読む人の判断を変えない。** */}
          {data.tEstimated > 0 && (
            <p className="note">
              このうち {data.tEstimated} 件は
              <strong>スマホと切れている間にデバイスが記録した警告</strong>
              です。時刻が推定のため場所も確かではなく、
              <strong>地図と順位には入っていません。</strong>
            </p>
          )}

          {/* **落ちた理由を2つとも並べない。**読む人が知る必要があるのは
              「どの区画にも入っていない」ことだけで、**取り込み直しの経緯は運用側の事情。** */}
          {(data.unlocated.detections.length > 0 || data.unlocated.violations > 0) && (
            <p className="note">
              <strong>位置が記録されていないもの（この区画に限らない全体の数）</strong>:{" "}
              {data.unlocated.detections
                .map((count) => `${kindLabel(count.kind)} ${count.count} 件`)
                .join(" ／ ")}
              {data.unlocated.detections.length > 0 && data.unlocated.violations > 0 && " ／ "}
              {data.unlocated.violations > 0 && `一時不停止 ${data.unlocated.violations} 件`}
              。どの区画にも入っていません。
              <strong>一覧に出る数より多いことがあります</strong>
              （一覧は時刻が推定の警告を最初から除いているため）。
            </p>
          )}
        </>
      )}
    </main>
  );
}

const countOf = (counts: { count: number }[]): number =>
  counts.reduce((total, item) => total + item.count, 0);
