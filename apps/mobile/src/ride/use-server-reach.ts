/**
 * 走行前のサーバー疎通を画面のライフサイクルに載せるフック。
 *
 * **判定を持たない**（`./server-reach.ts` と `./pre-ride.ts`）。
 */

import { useCallback, useEffect, useState } from "react";
import { checkServerReach } from "./server-reach";

export type ServerReach = {
  /** 確かめている最中か */
  checking: boolean;
  /** 届かない理由。**届いていれば `null`** */
  reason: string | null;
  /** もう一度確かめる。**電波を直した人が、押して確かめ直せるようにする** */
  recheck: () => void;
};

/**
 * 画面が現れたときに1回確かめ、**走行中は確かめ直さない。**
 *
 * 走り出せば実測（`RideStatus.postFailures`）の方が確かで、**1Hz の中継と同じ回線に
 * 余計な往復を足さない**（`docs/interfaces/mobile-api.md`）。
 *
 * @param riding いま走行中か
 */
export function useServerReach(riding: boolean): ServerReach {
  const [state, setState] = useState<{ checking: boolean; reason: string | null }>({
    checking: true,
    reason: null,
  });
  // 確かめ直しの合図。**値そのものに意味は無い。**
  const [attempt, setAttempt] = useState(0);

  // **`attempt` は計算に使わない。確かめ直す合図として置いてある**
  // ——外すと、電波を直して押しても何も起きない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 上記のとおり意図的な依存。
  useEffect(() => {
    if (riding) return;
    let alive = true;
    setState({ checking: true, reason: null });
    checkServerReach().then((reason) => {
      if (alive) setState({ checking: false, reason });
    });
    return () => {
      alive = false;
    };
  }, [riding, attempt]);

  const recheck = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, recheck };
}
