import { useEffect, useState } from "react";
import type { StatsCellDetailResponse, StatsSample } from "../../shared/api";

/**
 * 場所の詳細を取ってくるところ（`use-stats.ts` と同じ作り）。
 *
 * **数える側には何も持ち込まない。**時間帯への丸めも、種別ごとの件数も Worker が決めたものを
 * そのまま出す（`src/worker/stats/detail.ts`）——**画面側で数え直すと、定義が2箇所に割れる。**
 */

export type CellDetailQuery = {
  lat: number;
  lon: number;
  sample: StatsSample;
};

export type CellDetailState = {
  data: StatsCellDetailResponse | null;
  error: string | null;
  loading: boolean;
};

export function useCellDetail(query: CellDetailQuery): CellDetailState {
  const [state, setState] = useState<CellDetailState>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    // 応答の順が入れ替わっても、古い方で上書きしない（`use-stats.ts` と同じ）。
    let live = true;
    const params = new URLSearchParams({
      lat: String(query.lat),
      lon: String(query.lon),
      sample: query.sample,
    });

    fetch(`/api/stats/cell?${params}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `API が ${res.status} を返しました`);
        }
        return (await res.json()) as StatsCellDetailResponse;
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
  }, [query.lat, query.lon, query.sample]);

  return state;
}
