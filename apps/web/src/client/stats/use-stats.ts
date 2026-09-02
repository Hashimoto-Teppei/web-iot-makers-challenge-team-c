import { useEffect, useState } from "react";
import type { StatsLayer, StatsResponse, StatsSample } from "../../shared/api";

/**
 * 集計を取ってくるところ。**画面と API は同じ Worker（＝同じオリジン）**なので相対パスで呼ぶ。
 *
 * **数える側には何も持ち込まない。**率も順位も Worker が決めたものをそのまま出す
 * （`src/worker/stats/aggregate.ts`）——**画面側でもう一度並べ替えたり足し直したりすると、
 * 指標の定義が2箇所に割れる。**
 */

export type StatsQuery = {
  layer: StatsLayer;
  sample: StatsSample;
  minRides: number;
};

export type StatsState = {
  data: StatsResponse | null;
  error: string | null;
  loading: boolean;
};

export function useStats(query: StatsQuery): StatsState {
  const [state, setState] = useState<StatsState>({ data: null, error: null, loading: true });

  useEffect(() => {
    // **取り直している間、前の結果を消さない。**タブを切り替えるたびに画面が空になると、
    // 「切り替えたら0件になった」と読まれる。
    setState((prev) => ({ ...prev, loading: true, error: null }));

    // **切り替えが速いと応答の順が入れ替わる。**古い応答で上書きしないよう、
    // 効果が捨てられたら結果も捨てる。
    let live = true;
    const params = new URLSearchParams({
      layer: query.layer,
      sample: query.sample,
      minRides: String(query.minRides),
    });

    fetch(`/api/stats/cells?${params}`)
      .then(async (res) => {
        // **ステータスを見る。**見ないと、エラーの JSON をそのまま集計として描いてしまう。
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `API が ${res.status} を返しました`);
        }
        return (await res.json()) as StatsResponse;
      })
      .then((data) => {
        if (live) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (live)
          setState({
            data: null,
            error: e instanceof Error ? e.message : String(e),
            loading: false,
          });
      });

    return () => {
      live = false;
    };
  }, [query.layer, query.sample, query.minRides]);

  return state;
}
