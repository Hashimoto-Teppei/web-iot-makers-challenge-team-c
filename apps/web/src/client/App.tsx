import { useRoute } from "./route";
import { CellPage } from "./stats/CellPage";
import { StatsPage } from "./stats/StatsPage";

/**
 * 画面は2つ。**マップ + ランキング**と**場所の詳細**（`docs/interfaces/web-ui.md`「画面」）。
 *
 * **ルーターはライブラリを入れずに済ませてある**（理由は `./route.tsx`）。
 *
 * **ヘッダー帯は両方の画面で共通**なので、ここで巻く。
 */
export function App() {
  const route = useRoute();

  return (
    <>
      <SiteHeader />
      {route.name === "cell" ? (
        <CellPage lat={route.lat} lon={route.lon} sample={route.sample} />
      ) : (
        <StatsPage sample={route.sample} />
      )}
    </>
  );
}

/**
 * 画面の一番上の帯。
 *
 * **チーム名ではなくサービス名を置く**（`docs/interfaces/web-ui.md`「画面に出す言葉」）。
 * 初めて開いた人が帯に求めるのは「これは何のサイトか」であって、**作った人の名前ではない。**
 *
 * **下の名前は仮称である**（正式名称は未確定。決めるのはこの画面の外）。
 * **決まったら差し替えるのは3箇所**——下の2行と、`apps/web/index.html` の `<title>`。
 *
 * **リンクにしない。**帯からどこかへ飛ぶ先が無い——画面は2つで、
 * **一覧へ戻る導線は詳細画面の「← 一覧にもどる」が持っている。**
 */
function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <p className="site-header__title">自転車ヒヤリマップ 岡山</p>
        <p className="site-header__tagline">走行データから、危ない場所を見つける</p>
      </div>
    </header>
  );
}
