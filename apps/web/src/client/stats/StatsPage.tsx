import { useCallback, useMemo, useState } from "react";
import type { StatsCell, StatsLayer, StatsSample } from "../../shared/api";
import { navigate, statsPath } from "../route";
import { Ranking } from "./Ranking";
import { cellId, StatsMap } from "./StatsMap";
import { useStats } from "./use-stats";

/**
 * マップ + ランキング。**1ページに並べる**（`docs/interfaces/web-ui.md`）。
 *
 * **地図だけだと「どこが一番危ないか」が分からず、順位表だけだと「そこがどこか」が
 * 分からない。**別ページにすると、行から地図へ飛ぶ往復ができない。
 *
 * **検知と不停止を同時に重ねない。**同じ交差点に2つの円が重なると、
 * **どちらの濃さを見ているのか分からなくなる**ので、タブで切り替える。
 */

const LAYERS: { value: StatsLayer; label: string; note: string }[] = [
  {
    value: "detection",
    label: "走行中の警告",
    note: "走行中にデバイスがその場で鳴らした警告です。",
  },
  {
    value: "violation",
    label: "一時不停止",
    note: "走行データと標識の位置から、あとで計算した判定です。",
  },
];

/**
 * **2つのタブの違いを画面に出す。**以前は `title` 属性にしか説明が無く、
 * **マウスを乗せるまで読めなかった**——初めて見る人にはタブの名前だけでは差が分からない。
 */
const layerNote = (layer: StatsLayer): string =>
  LAYERS.find((item) => item.value === layer)?.note ?? "";

export type StatsPageProps = {
  /**
   * サンプルデータを混ぜるか。**URL が持っている**（`../route.tsx`）。
   *
   * **状態にしないのは、詳細画面へ飛んで戻ってきたときに元へ戻ってしまうから**である
   * ——除いて見ていた人が、戻った先で混ざった数を見ることになる。
   *
   * **`layer` と `minRides` は状態のままにしてある。**この2つも戻ると既定へ戻るが、
   * **画面に出ている値が変わるだけで、数字の意味は変わらない**（サンプルは
   * **同じ場所の件数そのものが変わる**）。**気になったら同じやり方で URL に載せる。**
   */
  sample: StatsSample;
};

export function StatsPage({ sample }: StatsPageProps) {
  const [layer, setLayer] = useState<StatsLayer>("detection");
  const [minRides, setMinRides] = useState(5);
  const [selected, setSelected] = useState<StatsCell | null>(null);

  const query = useMemo(() => ({ layer, sample, minRides }), [layer, sample, minRides]);
  const { data, error, loading } = useStats(query);

  // 参照が変わるたびに地図の円を置き直すので、関数は固定しておく。
  const onSelect = useCallback((cell: StatsCell) => setSelected(cell), []);

  const cells = data?.cells ?? [];
  // 取り直しでセルが入れ替わったら、選択も外す（消えたセルを指したままにしない）。
  const stillThere = selected && cells.some((cell) => cellId(cell) === cellId(selected));

  return (
    <main className="stats">
      <header>
        <h1>どこが危ないか</h1>
        {/* **画面に「セル」「率」と書かない**（`docs/interfaces/web-ui.md`「画面に出す言葉」）。
            **切り捨ての方法は読む人の判断を変えない**ので「約110m四方」に畳み、
            **式を1つ出すことで「危険率」「発生」「通行」の3語を同時に定義する**
            ——この3語が順位表の列見出しとそのまま対応している。 */}
        <p>
          自転車の走行データをもとに、<strong>約110m四方の区画</strong>ごとの
          <strong>危険率</strong>を出しています。
          <strong>危険率 = 危険が起きた走行数（発生）÷ その区画を通った走行数（通行）</strong>。
        </p>
      </header>

      <div className="controls">
        <div className="tabs" role="tablist" aria-label="表示する内容">
          {LAYERS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={layer === item.value}
              onClick={() => setLayer(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <label>
          <input
            type="checkbox"
            checked={sample === "include"}
            // **履歴に積まない**（同じ画面のままの切り替え）。積むと、詳細から戻るのに
            // 戻るを何度も押すことになる。
            onChange={(e) =>
              navigate(statsPath(e.target.checked ? "include" : "exclude"), { replace: true })
            }
          />
          デモ用のサンプルを含める
        </label>

        <label>
          <input
            type="number"
            min={0}
            value={minRides}
            // **整数に丸めてから渡す。**`type="number"` は "1.5" も空文字もそのまま返し、
            // **小数はサーバーの検証に弾かれて画面全体が「クエリの形式が正しくありません」になる。**
            onChange={(e) => setMinRides(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          />
          走行以上が通った区画だけ表示
        </label>
      </div>

      {/* **タブの説明は操作列の外に出す。**中に入れると `flex-wrap` で
          チェックボックスの横に回り込み、**どのタブの説明なのか分からなくなる。** */}
      <p className="layer-note">{layerNote(layer)}</p>

      {error && <p className="error">エラー: {error}</p>}
      {loading && <p className="loading">読み込み中…</p>}

      {data?.truncated && (
        <p className="note">区画が多いため、危険率の高い {cells.length} 件だけ表示しています。</p>
      )}
      {data && data.unlocated > 0 && (
        <p className="note">
          位置が記録されていない{layer === "detection" ? "警告" : "一時不停止"}が {data.unlocated}{" "}
          件
          {layer === "detection"
            ? "（GPS が取れていない間のもの）"
            : "（標識を取り込み直して、位置を辿れなくなったもの）"}
          。地図と順位には入っていません。
        </p>
      )}

      <div className="panels">
        <StatsMap cells={cells} selected={stillThere ? selected : null} onSelect={onSelect} />
        {/* **順位表は面に載せる。**地図は自分で面を持っている（`.map` に枠と影がある）ので、
            並べたときに片方だけ地の上に浮いていると、2つが同じものの2つの見せ方に見えない。 */}
        <div className="card ranking-panel">
          <Ranking
            cells={cells}
            selected={stillThere ? selected : null}
            onSelect={onSelect}
            sample={sample}
          />
        </div>
      </div>
    </main>
  );
}
