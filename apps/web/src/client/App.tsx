import { StatsPage } from "./stats/StatsPage";

/**
 * 画面は1つ。**マップ + ランキング**（`docs/interfaces/web-ui.md`「画面」）。
 *
 * **場所の詳細画面は別**（#87）。ルーティングはそれが入るときに足す——
 * **1画面しか無いうちにルーターを入れない**（`CLAUDE.md`「早すぎる抽象化を避ける」）。
 */
export function App() {
  return <StatsPage />;
}
