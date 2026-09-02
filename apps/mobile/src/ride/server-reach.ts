/**
 * 走行前に、サーバーへ届くかを1回確かめる。
 *
 * **標識の更新の成否を代わりに使わない。**あちらは**失敗しても走行を止めない**と
 * 決めてある（`docs/interfaces/mobile-api.md`「取得に失敗しても走行を止めない」——
 * 1か月古い標識でも道路の一時停止はほとんど変わらない）。**代用すると、
 * 標識が古いだけの端末を走れない端末に変えてしまう。**
 *
 * **確かめたいのは中継の経路**である。届かなければ近傍が空になり、
 * **車車間の3検知が全部黙る**——しかもそれは「周りに誰もいない」と区別がつかない
 * （`docs/adr/0004-v2v-transport.md`）。
 *
 * **走行中は使わない。**走り出せば実測（`RideStatus.postFailures`）の方が確かで、
 * 1Hz の中継と同じ回線に余計な往復を足さない。
 */

import { api } from "../lib/api";

/**
 * これだけ待って返らなければ届かなかったことにする。
 *
 * **長く粘らない。**人は走り出す前にこの画面を見ており、**返らないこと自体が
 * 「電波が弱い」という答え**である。
 */
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * サーバーへ届くかを確かめる。**届かない理由、届けば `null` を返す。**
 *
 * **投げない。**呼ぶのは走行前の画面で、投げると点検ごと落ちる。
 */
export async function checkServerReach(): Promise<string | null> {
  try {
    const response = await api.api.health.$get(undefined, {
      init: { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) },
    });
    if (!response.ok) return `サーバーが ${response.status} を返しました。`;
    return null;
  } catch (reason: unknown) {
    // **中身で分けない。**圏外も時間切れも、人がすることは同じ（電波を確かめる）。
    return `サーバーに届きません: ${String(reason)}`;
  }
}
