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
 * **プロダクト名を置いていない。**まだ決まっておらず、`README.md` にも `docs/` にも
 * 定義が無い（未確定）。**名前が決まったら、下の文字列を差し替えるだけで済む。**
 *
 * **リンクにしない。**帯からどこかへ飛ぶ先が無い——画面は2つで、
 * **一覧へ戻る導線は詳細画面の「← どこが危ないか（一覧）」が持っている。**
 */
function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <p className="site-header__title">チームC — Web×IoT メイカーズチャレンジ</p>
        <p className="site-header__tagline">自転車の事故と違反を未然に防ぐ</p>
      </div>
    </header>
  );
}
