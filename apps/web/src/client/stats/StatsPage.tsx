import { useCallback, useMemo, useState } from "react";
import type { StatsCell, StatsCoverage, StatsLayer, StatsSample } from "../../shared/api";
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

/**
 * 日付（日本時間）。**時刻は出さない**——**規模を伝えるのに時刻は要らず、
 * 出すと詳細画面で時刻を丸めた意味が薄れる**（`docs/interfaces/web-ui.md`）。
 */
const day = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "long",
  day: "numeric",
});
/** 同じ年の終わりの日。**年を2度出さない**（「2026年8月24日〜2026年8月30日」は読ませすぎ）。 */
const dayInYear = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "long",
  day: "numeric",
});
const year = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric" });
const period = (from: number, to: number): string =>
  `${day.format(from)}〜${year.format(from) === year.format(to) ? dayInYear.format(to) : day.format(to)}`;

/**
 * データの出どころと規模の一行（#154）。
 *
 * **率だけを出さない。****分母が分からないと、率の重みが判断できない**——
 * 8走行のうち6回の 75% と、800走行のうち600回の 75% は、読む人にとって別のものである。
 * **順位表の行にある「通行」はその区画の分母**で、ここに出すのは**画面全体の分母**である。
 *
 * **サンプルを混ぜているかどうかも同じ行に出す。**混ざった数と実走行の数は
 * **見た目で区別が付かない**ので、**何を見ているのかを数字の隣に置く。**
 */
function Coverage({ coverage, sample }: { coverage: StatsCoverage; sample: StatsSample }) {
  const span =
    coverage.from === null || coverage.to === null ? null : period(coverage.from, coverage.to);

  return (
    <p className="coverage">
      {coverage.rides === 0 ? (
        "まだ走行データがありません。"
      ) : (
        <>
          いまの集計は <strong>{coverage.rides} 走行</strong>
          （端末 {coverage.devices} 台{span ? `、${span}` : ""}）ぶんです。
        </>
      )}{" "}
      {sample === "include"
        ? "デモ用のサンプル（岡山駅から岡山大学津島キャンパスまでの区間で合成した走行）を含みます。"
        : "デモ用のサンプルは除いています。"}
    </p>
  );
}

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
  // **指しているだけのセル**（#157）。**選択とは別に持つ**——
  // 混ぜると、**順位表を上から下へなぞるだけで地図が飛び回る。**
  const [hovered, setHovered] = useState<StatsCell | null>(null);

  const query = useMemo(() => ({ layer, sample, minRides }), [layer, sample, minRides]);
  const { data, error, loading } = useStats(query);

  // 参照が変わるたびに地図の円を置き直すので、関数は固定しておく。
  const onSelect = useCallback((cell: StatsCell) => setSelected(cell), []);
  const onHover = useCallback((cell: StatsCell | null) => setHovered(cell), []);

  const cells = data?.cells ?? [];
  // 取り直しでセルが入れ替わったら、選択も外す（消えたセルを指したままにしない）。
  const stillThere = selected && cells.some((cell) => cellId(cell) === cellId(selected));
  // 指していたセルが消えたときも同じ（印だけが古い場所に残らないように）。
  const hoverThere = hovered && cells.some((cell) => cellId(cell) === cellId(hovered));

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
        {/* **データの出どころと規模**（#154）。**読み込み中は前の値を出したままにする**
            ——消すと、下の地図と順位表がずれて跳ねる（`.loading` と同じ理由）。
            **`sample` は応答が返したものを使う**（画面の状態ではない）——**取り直している間、
            前の数字に新しい札が付く**。「240走行」と「サンプルは除いています」が同時に出ると、
            この行が防ぎたかった取り違えがそのまま起きる。 */}
        {data && <Coverage coverage={data.coverage} sample={data.sample} />}
      </header>

      <div className="controls">
        <div className="tabs" role="tablist" aria-label="表示する内容">
          {LAYERS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={layer === item.value}
              // **説明と結び付ける。**離れた場所に置いた `<p>` は、
              // **これが無いと読み上げでタブと繋がらない**（タブ名しか読まれない）。
              aria-describedby="layer-note"
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
      <p className="layer-note" id="layer-note">
        {layerNote(layer)}
      </p>

      {error && <p className="error">エラー: {error}</p>}
      {/* **読み込み中でなくても場所を空けておく。****出たり消えたりすると、
          下の地図の高さが1行ぶん変わる**（高さは残りを配る形になっている。`../index.css`）——
          **下限の入力を1文字打つたびに地図が跳ねる。** */}
      <p className="loading" aria-live="polite">
        {loading ? "読み込み中…" : ""}
      </p>

      {data?.truncated && (
        <p className="note">区画が多いため、危険率の高い {cells.length} 件だけ表示しています。</p>
      )}
      {data && data.unlocated > 0 && (
        <p className="note">
          {/* **応答の `layer` を使う**（上の `Coverage` と同じ理由。取り直している間、
              前のレイヤーの件数に新しいレイヤーの名前が付く）。 */}
          位置が記録されていない{data.layer === "detection" ? "警告" : "一時不停止"}が{" "}
          {data.unlocated} 件
          {data.layer === "detection"
            ? "（GPS が取れていない間のもの）"
            : "（標識を取り込み直して、位置を辿れなくなったもの）"}
          。地図と順位には入っていません。
        </p>
      )}

      <div className="panels">
        <StatsMap
          cells={cells}
          selected={stillThere ? selected : null}
          onSelect={onSelect}
          hovered={hoverThere ? hovered : null}
          onHover={onHover}
        />
        {/* **順位表は面に載せる。**地図は自分で面を持っている（`.map` に枠と影がある）ので、
            並べたときに片方だけ地の上に浮いていると、2つが同じものの2つの見せ方に見えない。 */}
        <div className="card ranking-panel">
          <Ranking
            cells={cells}
            selected={stillThere ? selected : null}
            onSelect={onSelect}
            sample={sample}
            hovered={hoverThere ? hovered : null}
            onHover={onHover}
          />
        </div>
      </div>
    </main>
  );
}
