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
  { value: "detection", label: "検知", note: "走行中にその場で発火した警告" },
  { value: "violation", label: "不停止", note: "走行ログと標識から、あとから計算した判定" },
];

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
        <p>
          走行ログから、<strong>セル</strong>（緯度経度を小数第3位で切り捨てた升目、 岡山でおよそ
          111m × 92m）ごとに率を出したもの。
          <strong>率 = そのセルで1件以上あった走行の数 ÷ そのセルを通った走行の数</strong>
          で、件数では数えていない。
        </p>
      </header>

      <div className="controls">
        <div className="tabs" role="tablist" aria-label="レイヤー">
          {LAYERS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={layer === item.value}
              title={item.note}
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
          サンプルデータを混ぜる
        </label>

        <label>
          順位に出す通過の下限
          <input
            type="number"
            min={0}
            value={minRides}
            // **整数に丸めてから渡す。**`type="number"` は "1.5" も空文字もそのまま返し、
            // **小数はサーバーの検証に弾かれて画面全体が「クエリの形式が正しくありません」になる。**
            onChange={(e) => setMinRides(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          />
          走行
        </label>
      </div>

      {error && <p className="error">エラー: {error}</p>}
      {loading && <p className="loading">読み込み中…</p>}

      {data?.truncated && (
        <p className="note">セルが多いため、率の高い方から {cells.length} 件だけ出しています。</p>
      )}
      {data && data.unlocated > 0 && (
        <p className="note">
          場所が分からなかった{layer === "detection" ? "検知" : "不停止"}が {data.unlocated}{" "}
          件あります
          {layer === "detection"
            ? "（測位が出ていない間の検知）"
            : "（標識を取り込み直して、位置を辿れなくなったもの）"}
          。これは地図にも順位にも入っていません。
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
