import type { StatsCell, StatsSample } from "../../shared/api";
import { cellPath, Link } from "../route";
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
};

/**
 * 表示する率（整数のパーセント）。**色の判定もこの値から出す**（下）。
 *
 * **率そのもので色を決めてはいけない。**`0.004` は **「0%」と表示されるのに 0 より大きい**ので、
 * **「0%」の行が赤くなる**——**危険が1件も出ていない行が赤い**という、
 * 避けたかったものがそのまま出る（通過が 200 走行を超えれば起こる）。
 */
const percent = (rate: number): number => Math.round(rate * 100);
/** 代表座標。**小数第3位まで**（それ以上出すと、丸めた意味が無くなる） */
const coords = (cell: StatsCell): string => `${cell.lat.toFixed(3)}, ${cell.lon.toFixed(3)}`;

/** 率のセル。**表示と色を同じ値から出す**ための小さな入れ物。 */
function Rate({ value }: { value: number }) {
  return <td className={value > 0 ? "rate" : "rate rate--zero"}>{value}%</td>;
}

export function Ranking({ cells, selected, onSelect, sample }: RankingProps) {
  if (cells.length === 0) {
    return (
      <p className="ranking__empty">
        順位に出せるセルがありません。通過が下限に満たないか、まだ走行ログが入っていません。
      </p>
    );
  }

  return (
    <table className="ranking">
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">場所（セルの南西の角）</th>
          <th scope="col">率</th>
          <th scope="col">出た走行</th>
          <th scope="col">通過</th>
          <th scope="col">内訳</th>
        </tr>
      </thead>
      <tbody>
        {cells.map((cell, index) => (
          <tr
            key={cellId(cell)}
            className={selected && cellId(selected) === cellId(cell) ? "is-selected" : undefined}
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
                色の意味がその場で壊れる。**表示と同じ値で判定する**（上の `percent`）。 */}
            <Rate value={percent(cell.rate)} />
            <td>{cell.hits}</td>
            <td>{cell.rides}</td>
            <td>
              {/* **`<a href>` のまま置く。**場所の詳細は人に見せて話す画面なので、
                  新しいタブで開けることと URL を渡せることに意味がある（`../route.tsx`）。 */}
              <Link to={cellPath(cell, sample)}>時間帯</Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
