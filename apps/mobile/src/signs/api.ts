/**
 * 起動時の標識の更新（`GET /api/stop-signs`）の実装。
 *
 * **更新の組み立て（`./update.ts`）はこのファイルを知らない。**分けてあるので、
 * テストは HTTP を通さずに同じ形を渡せる（`docs/adr/0002-development-lifecycle.md`）。
 *
 * **`scripts/build-signs-db.ts` と1つにまとめない。**あちらは `--base` を取り、
 * 404 のときに取り込みの手順へ案内する**生成の道具**である。こちらは端末の中で走り、
 * **失敗しても走行を止めない**（`docs/interfaces/mobile-api.md`）。
 * **応答を読む部分（`./response.ts`）だけを共有している。**
 */

import type { StopSignPref } from "web/src/shared/api";
import { api } from "../lib/api";
import type { FetchStopSignsFn } from "./update";

/**
 * 実際に Worker へ取りに行く {@link FetchStopSignsFn} を作る。
 *
 * **中断の合図を外から受ける。**走行が始まったら**落としている途中でもやめる**必要がある
 * ——`docs/interfaces/mobile-api.md`「走行を始めたら標識の取得をしない」は、
 * **始めないことだけでなく、続けないこと**も含む。数 MB の転送が 1Hz の中継と
 * 同じ回線に残れば、**中継が詰まって車車間の3検知が全部止まる。**
 *
 * **合図の寿命を持つのは呼び出し元**（`./expo.ts`）。ここは渡されたものを載せるだけ。
 */
export function fetchStopSignsViaApi(signal?: AbortSignal): FetchStopSignsFn {
  return async ({ pref, version }) => {
    let res: Awaited<ReturnType<(typeof api.api)["stop-signs"]["$get"]>>;
    try {
      res = await api.api["stop-signs"].$get(
        { query: { pref: String(pref) } },
        {
          // **手元の版をそのまま送り返す。**端末で作らない
          // （`docs/interfaces/mobile-api.md`「版はサーバーが決める」）。
          // **同梱直後の最初の起動はここで 304 になり、無駄な数 MB を落とさない。**
          //
          // **`null` のときは載せない。**頼む県が手元と違うとき（県を選び直した、
          // まだ何も持っていない）に載せると、**別の県の版を送り返す**ことになる。
          headers: version === null ? {} : { "If-None-Match": version },
          init: { signal },
        },
      );
    } catch (reason: unknown) {
      // **回線が無いのは異常ではない。**走行を止めず、次の起動で取り直す
      // （`docs/interfaces/mobile-api.md`「取得に失敗しても走行を止めない」）。
      return { kind: "failed", message: `標識の更新を取りに行けませんでした: ${String(reason)}` };
    }

    // **`304` を成功として扱う。**`res.ok` は false になるので、先に見分ける
    // ——ここを取り違えると、**変わっていない版を毎回「失敗」として画面に出す。**
    if (res.status === 304) return { kind: "not-modified" };

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail =
        body !== null && typeof body === "object" && "error" in body
          ? String(body.error)
          : `サーバーが ${res.status} を返しました`;
      return { kind: "failed", message: detail };
    }

    // **ここで検証しない。**中身の確かめ方は `./response.ts` が正本で、
    // **同梱物を作る経路と同じものを通す**（`./update.ts` が呼ぶ）。
    const body: unknown = await res.json().catch(() => null);
    return { kind: "body", body, etag: res.headers.get("etag") };
  };
}

/**
 * 選べる県を取りに行った結果。**「無い」と「取れなかった」を混ぜない**——
 * 前者は選ばせない理由が取り込みで、後者は電波である
 * （`docs/interfaces/mobile-api.md`「どの県を選べるかはサーバーが決める」）。
 */
export type StopSignPrefsResult =
  /** 取れた。**空の配列もありうる**（1件も取り込んでいない） */
  | { kind: "prefs"; prefs: readonly StopSignPref[] }
  /** 取りに行けなかった。**選ばせない**（手元の県のまま走る） */
  | { kind: "failed"; message: string };

/**
 * 取り込んである県の一覧（`GET /api/stop-signs/prefs`）。
 *
 * **端末に 47 県を焼き込まないための口。**焼き込むと、**取り込んでいない県が
 * 一覧に並び、選んだ瞬間に 404 になる**（`docs/interfaces/mobile-api.md`）。
 *
 * **名前はサーバーから来ない。**都道府県の名前は変わらないので端末が持つ（`./pref.ts`）。
 */
export async function fetchStopSignPrefs(signal?: AbortSignal): Promise<StopSignPrefsResult> {
  try {
    const res = await api.api["stop-signs"].prefs.$get({}, { init: { signal } });
    if (!res.ok) return { kind: "failed", message: `サーバーが ${res.status} を返しました` };

    const body = await res.json();
    return { kind: "prefs", prefs: body.prefs };
  } catch (reason: unknown) {
    // **回線が無いのは異常ではない。**選ばせないだけで、手元の県のまま走れる。
    return { kind: "failed", message: `選べる県を取りに行けませんでした: ${String(reason)}` };
  }
}
