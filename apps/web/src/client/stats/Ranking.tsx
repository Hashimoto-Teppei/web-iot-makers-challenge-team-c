import type { StatsCell } from "../../shared/api";
import { cellId } from "./StatsMap";

/**
 * 率の高い順に並べた順位表。
 *
 * **行に出す文字はセルの代表座標**（切り捨てた緯度経度、小数第3位）で、
 * **これは名前ではなく識別子として出す**（`docs/interfaces/web-ui.md`「場所は地図が示す」）。
 * **読める名前を付けない。逆ジオコーディングもしない**——**地名は地図がすでに描いている。**
 *
 * **行をクリックすると地図がその場所へ飛ぶ。**2つを別ページにすると往復ができない。
 */

export type RankingProps = {
  cells: StatsCell[];
  selected: StatsCell | null;
  onSelect: (cell: StatsCell) => void;
};

const percent = (rate: number): string => `${(rate * 100).toFixed(0)}%`;
/** 代表座標。**小数第3位まで**（それ以上出すと、丸めた意味が無くなる） */
const coords = (cell: StatsCell): string => `${cell.lat.toFixed(3)}, ${cell.lon.toFixed(3)}`;

export function Ranking({ cells, selected, onSelect }: RankingProps) {
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
            <td>{percent(cell.rate)}</td>
            <td>{cell.hits}</td>
            <td>{cell.rides}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
