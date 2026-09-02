import { useRoute } from "./route";
import { CellPage } from "./stats/CellPage";
import { StatsPage } from "./stats/StatsPage";

/**
 * 画面は2つ。**マップ + ランキング**と**場所の詳細**（`docs/interfaces/web-ui.md`「画面」）。
 *
 * **ルーターはライブラリを入れずに済ませてある**（理由は `./route.tsx`）。
 */
export function App() {
  const route = useRoute();

  if (route.name === "cell") {
    return <CellPage lat={route.lat} lon={route.lon} sample={route.sample} />;
  }
  return <StatsPage sample={route.sample} />;
}
