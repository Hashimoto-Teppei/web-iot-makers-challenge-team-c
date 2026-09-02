/**
 * 測位の権限を走行前に1回確かめるフック。
 *
 * **判定を持たない。**測れない理由を作るのは `./location.ts`、それを緑・赤にするのは
 * `./pre-ride.ts` で、ここは**画面のライフサイクルに載せるだけ**である。
 */

import { useCallback, useEffect, useState } from "react";
import { checkLocationPermission } from "./location";

export type LocationReady = {
  /** 確かめている最中か */
  checking: boolean;
  /** 測れない理由。**測れそうなら `null`** */
  reason: string | null;
  /**
   * もう一度確かめる。
   *
   * **これが無いと、一度断った人は詰む。**権限のダイアログで「許可しない」を押し、
   * Android の設定で許し直して戻ってきても、**この画面は再マウントされない**
   * （expo-router は保持する）ので赤のままで、**アプリを終了させるまで走り出せない。**
   * **一番間違えやすいのが初回の権限**である。
   */
  recheck: () => void;
};

/**
 * 画面が現れたときに1回だけ確かめる。
 *
 * **走行中に確かめ直さない。**権限は走行中に変わらないうえ、変わったとしても
 * **そのとき見るべきは実測（`RideStatus.fix`）の方**である（`./pre-ride.ts`）。
 */
export function useLocationReady(): LocationReady {
  const [state, setState] = useState<{ checking: boolean; reason: string | null }>({
    checking: true,
    reason: null,
  });
  // 確かめ直しの合図。**値そのものに意味は無い。**
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` は確かめ直す合図。外すと押しても何も起きない。
  useEffect(() => {
    let cancelled = false;
    setState({ checking: true, reason: null });
    checkLocationPermission()
      .then((reason) => {
        if (!cancelled) setState({ checking: false, reason });
      })
      // **握りつぶさない。**確かめられなかったことを緑にすると、**権限が無いまま
      // 走り出せてしまう**——そのとき出るのは `beat` の `st: "nofix"` だけで、
      // 人は原因を知りようがない。
      .catch((reason: unknown) => {
        if (!cancelled)
          setState({
            checking: false,
            reason: `位置情報の権限を確かめられません: ${String(reason)}`,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const recheck = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, recheck };
}
