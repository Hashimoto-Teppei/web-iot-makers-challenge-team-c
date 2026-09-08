import { useEffect, useRef } from "react";
import type { StatsCell, StatsSample } from "../../shared/api";
import { cellPath, Link } from "../route";
import { bandForPercent, ratePercent } from "./config";
import { cellId } from "./StatsMap";

/**
 * 率の高い順に並べた順位表。
 *
 * **行に出す文字はセルの代表座標**（切り捨てた緯度経度、小数第3位）で、
 * **これは名前ではなく識別子として出す**（`docs/interfaces/web-ui.md`「場所は地図が示す」）。
 * **読める名前を付けない。逆ジオコーディングもしない**——**地名は地図がすでに描いている。**
 *
 * **行をクリックすると地図がその場所へ飛ぶ。**2つを別ページにすると往復ができない。
 *
 * **場所の詳細（#87）へは別の列から飛ぶ。****座標のボタンを取り合わない**——
 * **地図への往復こそが、この2つを1ページに並べた理由そのもの**である。
 */

export type RankingProps = {
  cells: StatsCell[];
  selected: StatsCell | null;
  onSelect: (cell: StatsCell) => void;
  /** 詳細へ飛ぶときに引き継ぐ。**飛んだ先で件数が変わって見えないため** */
  sample: StatsSample;
  /** いま指されているセル。**地図の円を指している間も入る**（#157） */
  hovered: StatsCell | null;
  /** 行を指したことを親へ返す。**外れたら `null`** */
  onHover: (cell: StatsCell | null) => void;
};

/** 代表座標。**小数第3位まで**（それ以上出すと、丸めた意味が無くなる） */
const coords = (cell: StatsCell): string => `${cell.lat.toFixed(3)}, ${cell.lon.toFixed(3)}`;

/**
 * 率のセル。**表示と色を同じ値から出す**ための小さな入れ物
 * （`./config.ts` の `ratePercent` — 率そのものから色を決めると、
 * **「0%」の行が赤くなる**）。
 *
 * **地図の円と同じ段の色を、数字の隣に小さく置く**（#157）。
 * **順位表と地図で色の意味が同じであること**が、この2つを1ページに並べた前提であり、
 * **置かないと、地図の色が何段目なのかを目で数えることになる。**
 */
function Rate({ value }: { value: number }) {
  const band = bandForPercent(value);
  return (
    <td className={value > 0 ? "rate" : "rate rate--zero"}>
      <span
        className="rate__chip"
        style={{ background: band.fill, borderColor: band.stroke }}
        // 意味は隣の数字が持っている。**読み上げで色見本を読ませない。**
        aria-hidden="true"
      />
      {value}%
    </td>
  );
}

export function Ranking({ cells, selected, onSelect, sample, hovered, onHover }: RankingProps) {
  const body = useRef<HTMLTableSectionElement>(null);

  // **地図から指された行を、順位表の中に送り込む。**順位表は中でスクロールするので
  // （`../index.css` の `.ranking-panel`）、**強調しただけでは器の外にいて見えない。**
  //
  // **`scrollIntoView` を使わない。****あれは画面まで含めて祖先を全部スクロールする**ので、
  // **ページごと下へ動く**——**地図がカーソルの下から逃げ、`mouseout` で印が消える。**
  // **動かすのは順位表の器だけ**にして、**行が器の中に見えているときは何もしない。**
  useEffect(() => {
    const panel = body.current?.closest<HTMLElement>(".ranking-panel");
    const row = hovered
      ? body.current?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(cellId(hovered))}"]`)
      : null;
    if (!panel || !row) return;

    const box = row.getBoundingClientRect();
    const inside = panel.getBoundingClientRect();
    // 見出しは貼り付いているので（`../index.css`）、**その下に送り込むと隠れる。**
    const head = body.current?.previousElementSibling?.getBoundingClientRect().height ?? 0;

    if (box.top < inside.top + head) panel.scrollTop += box.top - inside.top - head;
    else if (box.bottom > inside.bottom) panel.scrollTop += box.bottom - inside.bottom;
  }, [hovered]);

  if (cells.length === 0) {
    return (
      <p className="ranking__empty">
        表示できる区画がありません。通行の下限に満たないか、まだ走行データが入っていません。
      </p>
    );
  }

  return (
    <table className="ranking">
      <thead>
        <tr>
          <th scope="col">#</th>
          {/* **「セルの南西の角」と書かない。**南西の角は**円を置くときの実装の都合**
              （`./StatsMap.tsx`）で、**読む人の判断を何も変えない。** */}
          <th scope="col">場所（緯度, 経度）</th>
          <th scope="col">危険率</th>
          <th scope="col">発生</th>
          <th scope="col">通行</th>
          {/* **見出しは置くが、目には見せない。**中のリンクの文字（「時間帯別」）が
              そのまま列の意味になっているので、**同じ言葉を2度並べたくない**——
              ただし**空の `<th>` にすると、読み上げでリンクの列が何の列か分からなくなる。** */}
          <th scope="col">
            <span className="visually-hidden">場所の詳細</span>
          </th>
        </tr>
      </thead>
      <tbody ref={body}>
        {cells.map((cell, index) => (
          <tr
            key={cellId(cell)}
            data-cell={cellId(cell)}
            className={
              [
                selected && cellId(selected) === cellId(cell) ? "is-selected" : "",
                hovered && cellId(hovered) === cellId(cell) ? "is-hovered" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onMouseEnter={() => onHover(cell)}
            onMouseLeave={() => onHover(null)}
            // **キーボードでも印が出るようにする。**行の中のボタンとリンクに
            // 焦点が移ったときに上がってくる（React の `onFocus` は上に伝わる）。
            // **これが無いと、マウスを使わない人には地図との対応が見えない。**
            onFocus={() => onHover(cell)}
            onBlur={() => onHover(null)}
          >
            <td>{index + 1}</td>
            <td>
              {/* クリックできるのは行だが、キーボードでも辿れるようにボタンにする。 */}
              <button type="button" onClick={() => onSelect(cell)}>
                {coords(cell)}
              </button>
            </td>
            {/* **率 0 を赤で強めない。**赤はこの画面で「危ない」を指す色に予約してある
                （`../index.css` の `--danger`）ので、**危険が1件も出ていない行が赤い**と、
                色の意味がその場で壊れる。**表示と同じ値で判定する**（`./config.ts`）。 */}
            <Rate value={ratePercent(cell.rate)} />
            <td>{cell.hits}</td>
            <td>{cell.rides}</td>
            <td>
              {/* **`<a href>` のまま置く。**場所の詳細は人に見せて話す画面なので、
                  新しいタブで開けることと URL を渡せることに意味がある（`../route.tsx`）。 */}
              <Link to={cellPath(cell, sample)}>時間帯別</Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
