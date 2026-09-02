/**
 * 実機で `signs.db` を開く（`expo-sqlite`）。
 *
 * **このファイルだけが React Native に触れる。**`./store.ts` も `./nearby.ts` も
 * `expo-sqlite` を知らないので、走行ループと検知は実機なしで回せる
 * （`docs/adr/0002-development-lifecycle.md`）。
 *
 * **同梱物（`assets/signs.db`）は生成物で、リポジトリに無い。**
 * 作っていないと **Metro がここで解決に失敗してビルドが止まる**——
 * それが狙いである（`docs/adr/0009-on-device-storage.md`「7」）。
 * 作り方は `docs/setup.md`。
 */

import { drizzle } from "drizzle-orm/expo-sqlite";
import { type SQLiteDatabase, type SQLiteProviderAssetSource, useSQLiteContext } from "expo-sqlite";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
// Metro の資産として読み込む。返るのは中身ではなく資産の ID である
// （`src/types/assets.d.ts`）。`metro.config.js` の `assetExts` に `db` を足してある。
import signsAssetId from "../../assets/signs.db";
import { isRiding } from "../ride/riding";
import { fetchStopSignsViaApi } from "./api";
import {
  createDrizzleSignStore,
  createDrizzleSignWriter,
  type SignStore,
  type SignsMeta,
  type SignWriter,
} from "./store";
import { type SignsUpdateOutcome, safeMeta, updateStopSigns } from "./update";

/**
 * 端末の中でのファイル名。**`app.db`（アプリが書く方）と必ず別のファイルにする**
 * ——1つにまとめると、標識の更新で走行ログが消える（`docs/adr/0009-on-device-storage.md`）。
 */
export const SIGNS_DATABASE_NAME = "signs.db";

/**
 * 同梱した `signs.db` の在り処。`<SQLiteProvider assetSource={...}>` に渡す。
 *
 * **`forceOverwrite` を付けない。**このファイルはアプリが書かないので上書きの必要が無く、
 * 付ける癖がそのまま `app.db` へ移ると**走行ログが毎回消える。**
 *
 * **その代わり、同梱物は端末に `signs.db` が無いときしかコピーされない。**
 * 作り直して入れ直しても、**アプリを消さない限り端末の中身は古いまま**である。
 * **手元の同梱物を入れ直したいときは、アプリを消す**しかない（手順は `docs/setup.md`）。
 *
 * **サーバー側が新しくなったぶんは、起動時の更新が入れ替える**（{@link useSignsUpdate}）。
 * こちらは資産のコピーとは別の経路で、**端末の `signs.db` の中身を書き換える。**
 */
export const signsAssetSource: SQLiteProviderAssetSource = { assetId: signsAssetId };

/** 開いてある `signs.db` から口を作る。**引く SQL は Node のテストと同じもの。** */
export function createExpoSignStore(db: SQLiteDatabase): SignStore {
  return createDrizzleSignStore(drizzle(db));
}

/**
 * 入れ替え口。**書く SQL も Node のテストと同じもの**（`./store.ts`）。
 *
 * **画面に渡さない。**渡すのは起動時の更新（{@link useSignsUpdate}）だけで、
 * 走行ループと検知が受け取るのは読む口（{@link SignStore}）である。
 */
export function createExpoSignWriter(db: SQLiteDatabase): SignWriter {
  return createDrizzleSignWriter(drizzle(db));
}

/**
 * 画面から使う。**`<SQLiteProvider>` の内側でだけ呼べる**（`src/app/_layout.tsx`）。
 *
 * これをそのまま `useRideLoop()` に渡す。**セルをまたいだときだけ引き直すのは
 * 走行ループ側**（`./nearby.ts` を `../ride/use-ride-loop.ts` が使う）。
 */
export function useSignStore(): SignStore {
  const db = useSQLiteContext();
  // 画面が再描画されるたびに口を作り直さない（作り直しても壊れないが、意味が無い）。
  return useMemo(() => createExpoSignStore(db), [db]);
}

/**
 * 手元の標識の素性（件数・版）。**走行前の画面が読む。**
 *
 * **描画のたびに引き直さない。**変わるのは起動時の更新が入れ替えたときだけなので、
 * **その結果が出たときにだけ引き直す**（{@link useSignsUpdate}）。
 *
 * **引き直しを忘れないこと。**忘れると、入れ替えたのに**画面には古い版と件数が
 * 出続ける**——「更新できたのかどうか人に見せる」という、この仕組みの目的そのものが
 * 果たせなくなる（`docs/interfaces/stop-signs-delivery.md`「『持っていない』と『0件』を混ぜない」）。
 */
export function useSignsMeta(store: SignStore): SignsMeta | null {
  const { outcome } = useSignsUpdateSnapshot();
  // **`outcome` は計算に使わない。引き直す合図として置いてある**
  // ——外すと、入れ替えたのに画面が古い版と件数のままになる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 上記のとおり意図的な依存。
  return useMemo(() => store.meta(), [store, outcome]);
}

/**
 * 起動時の更新の状態。**アプリの中で1つだけ持つ。**
 *
 * **React の state に持たない。**更新は**アプリの起動につき1回**で、画面より寿命が長い
 * ——ホーム画面と設定画面のどちらから見ても同じ結果が見え、**画面を行き来しても
 * 取り直さない**必要がある（数 MB の取得である）。`../log/expo.ts` が保存層を
 * モジュールに持っているのと同じ理由。
 */
export type SignsUpdateState = {
  /** 取りに行っている最中か */
  running: boolean;
  /** 終わった結果。**まだ走っていなければ `null`** */
  outcome: SignsUpdateOutcome | null;
};

let updateState: SignsUpdateState = { running: false, outcome: null };
const listeners = new Set<() => void>();
/** **起動につき1回**を守るための印。画面の再マウントでは戻さない。 */
let updateStarted = false;

function publish(next: SignsUpdateState): void {
  updateState = next;
  for (const listen of listeners) listen();
}

function subscribe(listen: () => void): () => void {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}

function useSignsUpdateSnapshot(): SignsUpdateState {
  // 第3引数（サーバー側の値）は web ビルドの初期描画で要る。同じものでよい。
  return useSyncExternalStore(
    subscribe,
    () => updateState,
    () => updateState,
  );
}

/**
 * 更新の状態を**見るだけ**。取りに行くのは {@link useSignsUpdate} の側。
 *
 * **走行中かを知らない画面（設定など）はこちらを使う。**あちらを呼ぶと、
 * **走行中に開いただけで数 MB の取得が始まりうる。**
 */
export function useSignsUpdateState(): SignsUpdateState {
  return useSignsUpdateSnapshot();
}

/**
 * 起動時に1回だけ、標識の更新を取りに行く。
 *
 * **呼ぶのは走行中かどうかを知っている画面だけ**（いまはホーム画面）。
 * **そのため、ホーム画面を通らずに起動すると更新は走らない。**いまはコードから画面を
 * 移動させる入口が無い（`src/app/_layout.tsx`）ので問題にならないが、**ディープリンクや
 * 通知で別の画面へ直接入る道を足すときは、ここの置き場所を `_layout.tsx` へ移すこと**
 * ——設定画面が「まだ確かめていません」のまま固まる。
 * **走行中は取りに行かない**——数 MB の取得が 1Hz の中継と同じ回線を奪い、
 * **中継が詰まれば車車間の3検知が全部止まる**（`docs/interfaces/stop-signs-delivery.md`
 * 「取るのはアプリの起動時。走行中は取りに行かない」）。
 *
 * @param store 画面が読んでいるものと同じ口を渡す。**ここで開き直さない**
 *   （用意した文が二重になる。`./store.ts`）
 * @param riding いま走行中か。**取得の最中に走り出した場合も、入れ替えの直前で止める**
 */
export function useSignsUpdate(
  store: SignStore,
  { riding }: { riding: boolean },
): SignsUpdateState {
  const db = useSQLiteContext();
  const state = useSignsUpdateSnapshot();

  // **走行が始まったことを、走っている取得の中から見えるようにする。**
  // 依存配列に入れて回し直すと、**走り出すたびに取得がやり直される。**
  const ridingRef = useRef(riding);
  ridingRef.current = riding;

  // 走っている取得を外から打ち切る手。**取得していなければ `null`。**
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (updateStarted || riding) return;
    updateStarted = true;

    const abort = new AbortController();
    // **なぜ打ち切ったかを覚える。**走行のせいなら走り終えてから取り直し、
    // 時間切れなら人に見せる——**同じ「中断」でも次にすることが違う。**
    let cause: "riding" | "timeout" | null = null;

    // **返らないまま終わらせない。**電波の弱い場所では応答が返らないことがあり、
    // **黙って待ち続けると設定画面が「確かめています…」のまま固まる。**
    const timeout = setTimeout(() => {
      cause = "timeout";
      abort.abort();
    }, UPDATE_TIMEOUT_MS);

    abortRef.current = () => {
      cause = "riding";
      abort.abort();
    };

    publish({ running: true, outcome: null });

    // **入れ替えるのは同じ接続（`useSQLiteContext()`）を通す。**別に開くと、
    // **走行ループが読んでいる接続との間で書き込みが待たされる。**
    updateStopSigns(store, createExpoSignWriter(db), fetchStopSignsViaApi(abort.signal), {
      canReplace: () => !ridingRef.current,
    })
      .then((outcome) => {
        if (cause !== null) return;
        // **`canReplace` に弾かれたぶんも、走り終えたら取り直す**
        // （`meta` が無い端末は取りに行きようがないので、そちらは戻さない）。
        if (outcome.status === "skipped" && outcome.meta !== null) updateStarted = false;
        publish({ running: false, outcome });
      })
      // **`updateStopSigns` は投げない約束**なので、ここに来るのは組み立て側の不具合だけ。
      // それでも握りつぶさない——**古い標識のまま走っていることが画面に出ないのが一番悪い。**
      .catch((reason: unknown) => {
        if (cause !== null) return;
        publish({
          running: false,
          outcome: {
            status: "failed",
            meta: safeMeta(store),
            error: `標識の更新に失敗しました（手元のものを使います）: ${String(reason)}`,
          },
        });
      })
      .finally(() => {
        clearTimeout(timeout);
        abortRef.current = null;
        if (cause === null) return;

        if (cause === "riding") {
          // **走り終えたらもう一度取りに行く。**戻さないと、走行中に一度打ち切られただけで
          // **そのアプリは二度と標識を更新しない。**
          updateStarted = false;
          publish({
            running: false,
            outcome: { status: "skipped", meta: safeMeta(store), error: null },
          });
          return;
        }
        publish({
          running: false,
          outcome: {
            status: "failed",
            meta: safeMeta(store),
            error: "標識の更新が時間内に返りませんでした（手元のものを使います）",
          },
        });
      });
  }, [store, db, riding]);

  // **走り出したら、落としている途中でもやめる。**始めないことだけでは足りない
  // ——数 MB の転送が残れば、1Hz の中継と回線を取り合う
  // （`docs/interfaces/stop-signs-delivery.md`「走行を始めたら標識の取得をしない」）。
  useEffect(() => {
    if (!riding) return;
    abortRef.current?.();
  }, [riding]);

  return state;
}

/**
 * これだけ待って返らなければ諦める。**手元の標識で走れる**ので、長く粘る意味がない。
 *
 * **走行の開始を待たせる値ではない**——走り出すのは自由で、そのときは上の効果が打ち切る。
 */
const UPDATE_TIMEOUT_MS = 30_000;

/**
 * 人が選んだ県に入れ替える（#71）。**起動時の更新と同じ処理を通す**
 * （`./update.ts`）——2つ作らない（`docs/interfaces/stop-signs-delivery.md`
 * 「県を選び直したときも、丸ごと取り直す」）。
 *
 * **結果は起動時の更新と同じ場所に出す。**設定画面の「更新」の行がそのまま入れ替わる
 * ——**取り直せたかどうかを見る場所を2つに増やさない。**
 *
 * **走行中は取りに行かない。**走行はこの画面より寿命が長く、
 * **設定画面へ移っても走り続けている**（`../ride/riding.ts`）。
 */
export function useSelectPref(store: SignStore): {
  /**
   * 選んだ県で入れ替える。**投げない。**
   *
   * **結果を返すのは、呼んだ画面が入れ替わったかどうかで振る舞いを変えるため**
   * （入れ替わったら戻り、失敗したら理由を出したままそこに留まる）。
   * **中身は {@link useSignsUpdateState} にも出る**ので、画面が消えても残る。
   */
  select: (pref: number) => Promise<SignsUpdateOutcome | null>;
  /** 取りに行っている最中か */
  running: boolean;
} {
  const db = useSQLiteContext();
  const { running } = useSignsUpdateSnapshot();

  const select = useCallback(
    async (pref: number): Promise<SignsUpdateOutcome | null> => {
      // **二重に走らせない。**起動時の更新が走っている最中に選ばれると、
      // **同じファイルを2つの入れ替えが奪い合う。**
      //
      // **フックの値ではなくモジュールの値を見る**（`isRiding()` と同じ理由）——
      // フックの値は再描画まで古く、**同じ描画の中で2回押されると2回とも素通りする。**
      // **`null` を返す**——何もしていないので、呼んだ画面は留まる。
      if (updateState.running) return null;

      const abort = new AbortController();
      let timedOut = false;
      // **返らないまま終わらせない**（{@link useSignsUpdate} と同じ理由）。
      const timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, UPDATE_TIMEOUT_MS);

      publish({ running: true, outcome: null });
      try {
        const outcome = await updateStopSigns(
          store,
          createExpoSignWriter(db),
          fetchStopSignsViaApi(abort.signal),
          // **走行中かはフックの値ではなくモジュールから読む**——
          // 取得の最中に走り出しても、フックの値は再描画まで古いままである。
          { pref, canReplace: () => !isRiding() },
        );
        // **打ち切ったときは、返ってきた理由を出さない。**打ち切ったのはこちらなので、
        // 中身は「取りに行けませんでした」になる——**なぜ止まったのかが人に伝わらない。**
        const published = timedOut ? timedOutOutcome(store) : outcome;
        publish({ running: false, outcome: published });
        return published;
      } catch (reason: unknown) {
        // **`updateStopSigns` は投げない約束**なので、ここに来るのは組み立て側の不具合だけ。
        // それでも握りつぶさない——**入れ替わっていないことが画面に出ないのが一番悪い。**
        const published: SignsUpdateOutcome = timedOut
          ? timedOutOutcome(store)
          : {
              status: "failed",
              meta: safeMeta(store),
              error: `都道府県を変えられませんでした: ${String(reason)}`,
            };
        publish({ running: false, outcome: published });
        return published;
      } finally {
        clearTimeout(timeout);
      }
    },
    // **`running` を依存に入れない。**上で見ているのはモジュールの値なので、
    // 入れると**押すたびに関数が作り直されるだけ**である。
    [store, db],
  );

  return { select, running };
}

/** 時間切れで打ち切ったときの結果。**手元は何も変わっていない。** */
function timedOutOutcome(store: SignStore): SignsUpdateOutcome {
  return {
    status: "failed",
    meta: safeMeta(store),
    error: "標識を取りに行きましたが、時間内に返りませんでした（手元の県のままです）",
  };
}
