/**
 * 走行後の同期を画面のライフサイクルに載せる React のフック。
 *
 * **ここに判断を書かない。**送る組み立ては `./sync.ts`、HTTP は `./api.ts`、
 * SQL は `./store.ts` にある。**このファイルがするのは、いつ呼ぶかと、結果を画面へ渡すこと**だけ。
 *
 * **自分から定期的に送らない。**走行中に送ると 1Hz の中継と同じ回線を奪う
 * （`docs/interfaces/mobile-api.md`「走行後の同期」）ので、**呼ぶのは画面（走行を終えたとき）**である。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { postLogsViaApi } from "./api";
import type { RideLogStore, RideLogSummary } from "./store";
import { syncRideLogs } from "./sync";

export type RideLogSync = {
  /** 溜まっているものの件数。読めなければ `null` */
  summary: RideLogSummary | null;
  syncing: boolean;
  /** 送れなかった理由。**画面に出す**（黙って失敗させない） */
  error: string | null;
  /** いま送る。**走行を終えたときと、人が押したときに呼ぶ** */
  sync: () => void;
  /** 件数を読み直す */
  refresh: () => void;
};

export function useRideLogSync(store: RideLogStore): RideLogSync {
  const [summary, setSummary] = useState<RideLogSummary | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // **重ねて送らない。**同じぶんを2回送っても取り込みは冪等だが、
  // **印が付く前に2本目が走ると、同じ数千点を2回分の通信で送る**ことになる。
  const running = useRef(false);

  const refresh = useCallback(() => {
    try {
      setSummary(store.summary());
    } catch (reason: unknown) {
      setError(`走行ログを読み出せません: ${String(reason)}`);
    }
  }, [store]);

  const sync = useCallback(() => {
    if (running.current) return;
    running.current = true;
    setSyncing(true);
    setError(null);

    syncRideLogs(store, postLogsViaApi)
      .then((outcome) => setError(outcome.error))
      // **ここに来るのは組み立て側の不具合だけ**（送信の失敗は `outcome.error` に入る）。
      // それでも握りつぶさない——**送れていないことが画面に出ないのが一番悪い。**
      .catch((reason: unknown) => setError(`送信に失敗しました: ${String(reason)}`))
      .finally(() => {
        running.current = false;
        setSyncing(false);
        refresh();
      });
  }, [store, refresh]);

  // 画面を開いたときに1回読む。**送りはしない**（走行中に開いていることがある）。
  useEffect(refresh, [refresh]);

  return { summary, syncing, error, sync, refresh };
}
