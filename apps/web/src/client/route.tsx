import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { StatsSample } from "../shared/api";

/**
 * 画面の切り替え。**画面が2つになったので足した**（#87。それまでは1つしか無かった）。
 *
 * **ライブラリを入れずに済ませてある。**画面は2つで、**入れ子も、遷移の途中で止める話も無い**
 * ——`CLAUDE.md`「早すぎる抽象化を避ける」。**3つ目・4つ目が出てきたら React Router に置き換える**
 * （そのときここが消えるだけで、画面側は `Link` と `useRoute` しか見ていない）。
 *
 * **`history.pushState` を使う（ハッシュではない）。**`wrangler.jsonc` の
 * `not_found_handling: "single-page-application"` が未知のパスに `index.html` を返すので、
 * **詳細画面の URL を直接開いてもリロードしても 404 にならない。**
 */

export type Route =
  | { name: "stats"; sample: StatsSample }
  /** 場所の詳細。**セルは代表座標（南西の角）で指す**（`docs/interfaces/web-ui.md`） */
  | { name: "cell"; lat: number; lon: number; sample: StatsSample };

/** 詳細画面のパス。`/cell/<緯度>/<経度>` */
const CELL_PATH = /^\/cell\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/;

/**
 * URL を画面に変える。**知らないパスは一覧に落とす**（404 の画面を作らない）。
 *
 * **`sample` を URL に載せる**のは、**飛んだ先で件数が変わって見えないため**である
 * ——一覧でサンプルを除いて見ていた人が、詳細でだけ混ざった数を見ることになる。
 * **既定（`include`）のときは付けない**（URL を短く保つ）。
 */
export function parseRoute(pathname: string, search = ""): Route {
  // **既定は「混ぜる」。**デモで見せるのが既定の姿で、除いた方を見たい人が明示する
  // （`src/worker/stats/request.ts` と同じ既定にそろえる）。
  const sample: StatsSample =
    new URLSearchParams(search).get("sample") === "exclude" ? "exclude" : "include";

  const matched = CELL_PATH.exec(pathname);
  if (!matched?.[1] || !matched[2]) return { name: "stats", sample };

  const lat = Number(matched[1]);
  const lon = Number(matched[2]);
  // **数にならない値で詳細を開かない。**そのまま API へ渡すと 400 になり、
  // 画面には「クエリの形式が正しくありません」だけが出る。
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { name: "stats", sample };

  return { name: "cell", lat, lon, sample };
}

/** 一覧の URL。**サンプルの扱いを URL が持つ**ので、戻ったときに見ていた形のまま出る。 */
export const statsPath = (sample: StatsSample): string =>
  sample === "exclude" ? "/?sample=exclude" : "/";

/** 詳細画面の URL を作る。**表示と同じ小数第3位まで**（それ以上出すと丸めた意味が無くなる）。 */
export function cellPath(cell: { lat: number; lon: number }, sample: StatsSample): string {
  const path = `/cell/${cell.lat.toFixed(3)}/${cell.lon.toFixed(3)}`;
  return sample === "exclude" ? `${path}?sample=exclude` : path;
}

/** いま開いている画面。**戻る・進むにも追従する**（`popstate`）。 */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, window.location.search),
  );

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.pathname, window.location.search));
    // **`pushState` はイベントを発火しない**ので、`navigate` の側から起こす（下）。
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATE_EVENT, sync);
    };
  }, []);

  return route;
}

const NAVIGATE_EVENT = "app:navigate";

/**
 * 画面を移る。**履歴に積む**ので、ブラウザの「戻る」で一覧へ帰れる。
 *
 * @param replace 履歴に積まずに置き換える。**同じ画面のままの切り替え**
 *   （サンプルを混ぜるかどうか）に使う——積むと、**戻るを何度も押さないと
 *   前の画面に帰れない。**
 */
export function navigate(path: string, { replace = false } = {}): void {
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export type LinkProps = {
  to: string;
  className?: string;
  children: ReactNode;
};

/**
 * 画面を移るリンク。
 *
 * **`<a href>` のまま置く。**`<button>` にすると、**新しいタブで開けず、
 * リンクをコピーできない**——**場所の詳細は人に見せて話す画面**なので、URL が渡せることに意味がある。
 *
 * **修飾キーを押した click と、左ボタン以外は素通しする**（ブラウザの仕事を奪わない）。
 */
export function Link({ to, className, children }: LinkProps) {
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
    },
    [to],
  );

  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
