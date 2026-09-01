/**
 * 走行ループを画面のライフサイクルに載せる React のフック。
 *
 * **ここに判断を書かない。**測位の購読（`./location.ts`）・中継（`./api.ts`）・
 * デバイスの口（`./device.ts`）を組み合わせて `RideLoop` を1つ作り、止め方を返すだけである。
 * **配線をここに集めてあるので、画面（`../app/`）は状態を表示するだけで済む。**
 *
 * **画面が前面にある間だけ動く作りは、これで終わりではない。**走行中は画面を消して
 * ハンドルに固定するので、**常駐（`connectedDevice` 型のフォアグラウンドサービス）が要る**
 * ——それは BLE の接続と一緒に #38 で入れる。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createNearbySigns } from "../signs/nearby";
import type { SignStore } from "../signs/store";
import { exchangeViaApi } from "./api";
import { createMockDeviceLink } from "./device";
import { watchFixes } from "./location";
import { RideLoop, type RideStatus } from "./loop";

/** 開始と停止の一回ぶん。**止め忘れを防ぐために、止める関数をここに集める。** */
type Session = { stops: (() => void)[]; cancelled: boolean };

export type RideControl = {
  running: boolean;
  /** 走行ループの状態。始めるまでは `null` */
  status: RideStatus | null;
  /** 測位の権限が下りないなど、人に伝えるべきこと */
  error: string | null;
  start: () => void;
  stop: () => void;
};

/**
 * 走行ループを1つ持ち、開始・停止できるようにする。
 *
 * **デバイスの口はいまモック**（`createMockDeviceLink`）。#38 が入ったら、接続中の
 * デバイスを返すものに差し替える。**そのとき差し替わるのはこの1行だけ**で、
 * `RideLoop` も検知も変わらない。
 *
 * @param signs 手元の標識（`../signs/`）。**絞るのは呼び出し側の責務**なので、
 *   ここでセルごとに引き直して `RideLoop` へ渡す（`docs/adr/0009-on-device-storage.md`）。
 */
export function useRideLoop(signs: SignStore): RideControl {
  const [status, setStatus] = useState<RideStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const sessionRef = useRef<Session | null>(null);

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (session === null) return;
    session.cancelled = true;
    for (const halt of session.stops) halt();
    sessionRef.current = null;
    setRunning(false);
    // **古い状態を残さない。**残すと、走行を終えたあとも「測位: 取れている」や
    // 中継の失敗の赤字が出たままになり、**動いていないのに動いているように見える。**
    setStatus(null);
  }, []);

  const start = useCallback(() => {
    if (sessionRef.current !== null) return;
    const session: Session = { stops: [], cancelled: false };
    sessionRef.current = session;
    setError(null);

    // TODO(#38): 接続中のデバイスに差し替える。それまでは名乗る ID もモックのもの。
    const device = createMockDeviceLink();
    const loop = new RideLoop({ device, exchange: exchangeViaApi, onStatus: setStatus });
    // **走行を始めた時点の口を使い続ける。**走行中に標識を取りに行かない
    // （`docs/interfaces/mobile-api.md`「走行中は取りに行かない」）。
    const nearby = createNearbySigns(signs);

    // **心拍を先に始める。**測位の権限を待っている間も、スマホが生きていることは
    // 伝わっていなければならない（`docs/interfaces/v2v.md`「心拍を必ず見せる」）。
    session.stops.push(loop.startHeartbeat());
    setStatus(loop.status());
    setRunning(true);

    watchFixes((fix) => {
      // **近傍の標識を先に差し替える。**同じセルにいる間は引き直さないので、
      // ここに SQL の往復は入らない（`../signs/nearby.ts`）。
      try {
        loop.setSigns(nearby.at(fix.lat, fix.lon));
      } catch (reason: unknown) {
        // **ここで投げさせない。**測位のコールバックへ例外が抜けると、この下の
        // `onFix` が二度と呼ばれず、**中継も検知も全部止まったまま心拍だけ出続ける**
        // ——デバイスの `link` は `up` のままなので、誰も気づけない
        // （`docs/interfaces/mobile-api.md`「失敗したときの約束」）。
        // **手元の標識は前回のまま**にして走り続け、**止まったことは人に見せる。**
        setError(`一時停止の標識を読み出せません: ${String(reason)}`);
      }
      // **待たない。**測位のコールバックの中で往復を待つと、次の測位が詰まる。
      void loop.onFix(fix);
    })
      .then((unwatch) => {
        // 権限のダイアログを出している間に止められることがある。**そのときは即座に外す**
        // ——溜めた配列に足しても、もう誰も呼ばない。
        if (session.cancelled) unwatch();
        else session.stops.push(unwatch);
      })
      .catch((reason: unknown) => setError(String(reason)));
  }, [signs]);

  // 画面から離れたら止める。**心拍を出したまま忘れない**（デバイスは動いていると
  // 判断し続ける）。
  useEffect(() => stop, [stop]);

  return { running, status, error, start, stop };
}
