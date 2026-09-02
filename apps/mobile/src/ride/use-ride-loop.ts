/**
 * 走行ループを画面のライフサイクルに載せる React のフック。
 *
 * **ここに判断を書かない。**測位の購読（`./location.ts`）・中継（`./api.ts`）・
 * デバイスの口（`./device.ts`）を組み合わせて `RideLoop` を1つ作り、止め方を返すだけである。
 * **配線をここに集めてあるので、画面（`../app/`）は状態を表示するだけで済む。**
 *
 * **走行中は画面を消してハンドルに固定する**ので、常駐（フォアグラウンドサービス）が要る。
 * **それを立てるのは測位の側**（`./location.ts`）で、BLE の接続もその1本に相乗りする。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "../lib/api";
import { blocksMockDevice } from "../lib/mock-guard";
import { createDiscardingRideLogStore, type RideLogStore, type RideRecording } from "../log/store";
import { createNearbySigns } from "../signs/nearby";
import type { SignStore } from "../signs/store";
import { exchangeViaApi, refuseMockExchange } from "./api";
import type { DeviceLink } from "./device";
import { watchFixes } from "./location";
import { RideLoop, type RideStatus } from "./loop";
import { setRiding, useRiding } from "./riding";

/** 開始と停止の一回ぶん。**止め忘れを防ぐために、止める関数をここに集める。** */
type Session = { stops: (() => void)[]; cancelled: boolean; recording: RideRecording };

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
 * **デバイスは外から受け取る**（`./use-device-link.ts`）。接続は走行より寿命が長く、
 * **走り出す前につながっていることを確かめられなければ、走行前の点検が
 * 「デバイス」を判定できない**（`./pre-ride.ts`）。
 *
 * @param device 接続中のデバイス。**つながっていなければ `null`** ——そのときは
 *   走行ループを始めない（検知が動いても警告の出し先が無い。`./device.ts`）
 *
 * @param signs 手元の標識（`../signs/`）。**絞るのは呼び出し側の責務**なので、
 *   ここでセルごとに引き直して `RideLoop` へ渡す（`docs/adr/0009-on-device-storage.md`）。
 * @param logs 走行ログの保存層（`../log/`）。**測位と警告をここに溜め、走行後に送る**
 *   （#73。送るのは画面から `syncRideLogs()` を呼ぶ——**走行中に送らない**）。
 */
export function useRideLoop(
  signs: SignStore,
  logs: RideLogStore,
  device: DeviceLink | null,
): RideControl {
  const [status, setStatus] = useState<RideStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // **走行中かはアプリで1つだけ持つ**（`./riding.ts`）——設定画面から走行中に
  // 標識を入れ替えられないようにするため、画面の外からも見える必要がある。
  const running = useRiding();
  const sessionRef = useRef<Session | null>(null);

  /**
   * 走行ログへの書き込みを1回。**失敗しても走行を止めず、人には見せる。**
   *
   * **握りつぶすだけにしない。**書けていないことは画面のどこにも出ず、
   * **走り終えてから「送るものが無い」と分かる**ことになる。
   */
  const record = useCallback((write: () => void) => {
    try {
      write();
    } catch (reason: unknown) {
      setError(`走行ログを保存できません: ${String(reason)}`);
    }
  }, []);

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (session === null) return;
    session.cancelled = true;
    for (const halt of session.stops) halt();
    // **走行を閉じる。**閉じるまで送信の対象にならない（`../log/schema.ts` の `ended_at`）
    // ——**終わっていない走行の点は、誰にも見えないまま端末に溜まり続ける。**
    record(() => session.recording.end(Date.now()));
    sessionRef.current = null;
    setRiding(false);
    // **古い状態を残さない。**残すと、走行を終えたあとも「測位: 取れている」や
    // 中継の失敗の赤字が出たままになり、**動いていないのに動いているように見える。**
    setStatus(null);
  }, [record]);

  const start = useCallback(() => {
    if (sessionRef.current !== null) return;
    // **つながっていなければ始めない。**検知が動いても警告の出し先が無く、
    // 名乗る `device_id` も無い（`./device.ts`）。**押せないようにするのは画面側**
    // （`./pre-ride.ts`）だが、ここでも受けておく——判定を通らない経路で呼ばれても
    // 半端に走り出さないため。
    if (device === null) {
      setError("デバイスにつながっていないため、走行を始められません。");
      return;
    }
    setError(null);

    // **モックのまま共有のデプロイ先へ位置を送らない**（理由は `../lib/mock-guard.ts`）。
    // 手元の apps/web に向けているときだけ実際に中継する。
    const exchange = blocksMockDevice(device.deviceId, apiBaseUrl)
      ? refuseMockExchange
      : exchangeViaApi;

    // **走行を1つ開いてから始める。**`device_id` はデバイスのもので、スマホ側で
    // 別の ID を作らない（`docs/interfaces/mobile-api.md`「走行後の同期」）。
    //
    // **開けなくても走行は始める。**記録できないことより、**検知が動かないことの方が
    // 危険**である（警告はデバイスに出る）。**記録が落ちたことは画面に出す。**
    let recording: RideRecording;
    try {
      recording = logs.startRide(device.deviceId, Date.now());
    } catch (reason: unknown) {
      setError(`走行ログを開けません（この走行は記録されません）: ${String(reason)}`);
      recording = createDiscardingRideLogStore().startRide(device.deviceId, Date.now());
    }
    const session: Session = { stops: [], cancelled: false, recording };
    sessionRef.current = session;

    const loop = new RideLoop({
      device,
      exchange,
      onStatus: setStatus,
      // **書いた警告だけを記録する**（`./loop.ts` の `onWarn`）。
      // **保存に失敗しても走行を止めない**——記録は副産物であって、目的ではない。
      onWarn: (warning, t) => record(() => recording.addWarning(warning, t)),
    });
    // **走行を始めた時点の口を使い続ける。**走行中に標識を取りに行かない
    // （`docs/interfaces/mobile-api.md`「走行中は取りに行かない」）。
    const nearby = createNearbySigns(signs);

    // **心拍を先に始める。**測位の権限を待っている間も、スマホが生きていることは
    // 伝わっていなければならない（`docs/interfaces/v2v.md`「心拍を必ず見せる」）。
    session.stops.push(loop.startHeartbeat());
    setStatus(loop.status());
    setRiding(true);

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
      // **走行ログに残すのは、ここへ届いた測位すべて**である（走行ループが
      // 取り込まなかったものも含む）。**足切りは計算する側が、そのときのしきい値で行う**
      // （`docs/adr/0007-keep-raw-ride-logs.md`）。**捨てると二度と戻らない。**
      record(() => recording.addPoint(fix));
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
  }, [signs, logs, record, device]);

  // 画面から離れたら止める。**心拍を出したまま忘れない**（デバイスは動いていると
  // 判断し続ける）。
  useEffect(() => stop, [stop]);

  return { running, status, error, start, stop };
}
