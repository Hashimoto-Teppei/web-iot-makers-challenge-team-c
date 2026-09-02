/**
 * 起動時の標識の更新。**手元の版をサーバーに見せ、変わっていれば丸ごと入れ替える。**
 *
 * **HTTP も SQL も知らない**（`./api.ts` と `./store.ts` の口だけを使う）ので、
 * 実機なしで Vitest から回せる（`docs/adr/0002-development-lifecycle.md`）。
 *
 * **API は「更新」だけを担う。初回の取得を担わない**
 * （`docs/interfaces/mobile-api.md`「同梱を初期値にして、API では更新だけをする」）。
 * 標識は同梱物として最初から入っているので、**ここが失敗しても走行は止まらない。**
 *
 * ```
 * 手元の meta.version --If-None-Match--> GET /api/stop-signs
 *   304        → 何もしない（同梱直後の最初の起動はここに来る）
 *   200        → 中身を確かめてから丸ごと入れ替える
 *   それ以外    → 手元のものをそのまま使う
 * ```
 */

import { parseStopSignsResponse } from "./response";
import type { SignStore, SignsMeta, SignWriter } from "./store";

/**
 * 取りに行った結果。**「変わっていない」と「取れなかった」を混ぜない**——
 * 前者は正常な終わり方で、後者は人に見せるものである。
 */
export type StopSignsFetchResult =
  /** 版が変わっていない（`304`）。**同梱直後の最初の起動はここに来る** */
  | { kind: "not-modified" }
  /** 新しいものが返った。**中身の検証は呼ばれた側（このファイル）でする** */
  | { kind: "body"; body: unknown; etag: string | null }
  /** 取りに行けなかった・サーバーが失敗を返した。**手元のものを使い続ける** */
  | { kind: "failed"; message: string };

/**
 * 取りに行く関数。**実装は `./api.ts`。**テストはここに偽物を渡す。
 *
 * @param version 手元の `meta.version`。**そのまま `If-None-Match` に載せる**
 *   （端末が版を作らない。`docs/interfaces/mobile-api.md`「版はサーバーが決める」）。
 *   **`null` なら載せない**——**頼む県が手元と違うとき**（県を選び直した、
 *   まだ何も持っていない）は、**別の県の版を送り返すことになる**
 *   （`docs/interfaces/mobile-api.md`「県を選び直したときも、丸ごと取り直す」）
 */
export type FetchStopSignsFn = (args: {
  pref: number;
  version: string | null;
}) => Promise<StopSignsFetchResult>;

export type SignsUpdateStatus =
  /** 入れ替えた */
  | "replaced"
  /** 版が変わっていなかった */
  | "not-modified"
  /** 取りに行かなかった（持っていない／走行中） */
  | "skipped"
  /** 取りに行ったが使えなかった。**手元はそのまま** */
  | "failed";

export type SignsUpdateOutcome = {
  status: SignsUpdateStatus;
  /** **いま手元にある**素性。入れ替えたなら新しい方。持っていなければ `null` */
  meta: SignsMeta | null;
  /**
   * 使えなかった理由。**更新できていれば `null`。**
   *
   * **画面に出す。**更新は起動時に1回しか走らず、**失敗しても走行は普通に始められる**
   * ので、黙ると**古い標識のまま走り続けていることに誰も気づけない**
   * （`docs/interfaces/mobile-api.md`「『持っていない』と『0件』を混ぜない」と同じ理由）。
   */
  error: string | null;
};

/**
 * 手元の標識を最新にする。**走行中に呼ばない**（`options.canReplace` で塞ぐ）。
 *
 * **投げない。**呼び出し元は起動直後の画面で、**投げるとホーム画面ごと落ちて
 * 走行を始められなくなる**——更新できないことより、検知が動かないことの方が危険である。
 *
 * @param options.canReplace 入れ替えてよいか。**走行中は `false` を返すこと**——
 *   数万行の入れ替えは 1Hz の走行ループと同じ接続を握る
 *   （`docs/interfaces/mobile-api.md`「走行中は取りに行かない」）
 * @param options.pref 頼む県。**省くと手元の県**（起動時の更新はこちら）。
 *   **人が選び直したときだけ渡す**（#71）——渡すと、**まだ何も持っていない端末でも
 *   取りに行く**。選べる県を決めるのはサーバーで、端末は一覧から選ばせる
 *   （`docs/interfaces/mobile-api.md`「どの県を選べるかはサーバーが決める」）
 */
export async function updateStopSigns(
  store: SignStore,
  writer: SignWriter,
  fetchStopSigns: FetchStopSignsFn,
  options: { now?: () => Date; canReplace?: () => boolean; pref?: number } = {},
): Promise<SignsUpdateOutcome> {
  const now = options.now ?? (() => new Date());
  const canReplace = options.canReplace ?? (() => true);

  let current: SignsMeta | null;
  try {
    current = store.meta();
  } catch (reason: unknown) {
    // **読めないことを「持っていない」に潰さない。**直し方が違う（片方は同梱物の作り直し、
    // こちらは端末のデータベースが壊れている）。
    return { status: "failed", meta: null, error: `手元の標識を読めません: ${String(reason)}` };
  }

  // **頼む県。人が選んだものが優先で、無ければ手元の県。**
  // どちらも無ければ頼みようがない（下）。
  const requested = options.pref ?? current?.pref ?? null;

  if (requested === null) {
    // **ここで取りに行かない。**API は更新だけを担い、初回の取得を担わない
    // （`docs/interfaces/mobile-api.md`）。**そもそも頼む県コードが無い**——
    // 県は手元の `meta` が持っている。**人が選べば `options.pref` で入ってくる**ので、
    // そのときはここを通らずに取りに行く（#71）。
    return {
      status: "skipped",
      meta: null,
      error:
        "標識を持っていないため、更新も取りに行けません" +
        "（docs/setup.md の手順で同梱物を作り直すか、設定から都道府県を選んでください）",
    };
  }

  if (!canReplace()) {
    // **走行中。**取りに行くこと自体をやめる——数 MB の取得が 1Hz の中継と同じ回線を奪う。
    return { status: "skipped", meta: current, error: null };
  }

  // **頼む県が手元と違うなら、版を載せない。**載せると**別の県の版を送り返す**ことになる
  // （`docs/interfaces/mobile-api.md`「県を選び直したときも、丸ごと取り直す」）。
  // いまのサーバーの ETag は県を含むので 304 にはならないが、
  // **こちら側の正しさをサーバーの実装に預けない。**
  const version = current !== null && current.pref === requested ? current.version : null;

  const result = await fetchStopSigns({ pref: requested, version });
  if (result.kind === "not-modified") return { status: "not-modified", meta: current, error: null };
  // **`keeping()` を通す。**取りに行けなかっただけなので、**手元のもので走れる**ことを
  // 必ず添える——サーバーが返す「都道府県コード 33 の標識がまだありません」を
  // そのまま出すと、**この端末に標識が無いと読まれる**（実際にはある）。
  if (result.kind === "failed")
    return { status: "failed", meta: current, error: keeping(result.message, current) };

  let parsed: ReturnType<typeof parseStopSignsResponse>;
  try {
    // **同梱物を作るときと同じ検証を通す**（`./response.ts`）。ここを緩めると、
    // **正しく揃っている手元を、欠けたもので置き換える。**
    parsed = parseStopSignsResponse(result.body, result.etag, now());
  } catch (reason: unknown) {
    return { status: "failed", meta: current, error: keeping(String(reason), current) };
  }

  // **頼んだ県が返ってきたことを確かめる。**別の県で入れ替えると、
  // **画面は入れ替わった `meta` を信じる**ので、どの画面からも見分けが付かない。
  if (parsed.meta.pref !== requested) {
    return {
      status: "failed",
      meta: current,
      error: keeping(
        `頼んだ県と違うものが返りました（頼んだ ${requested} / 返った ${parsed.meta.pref}）`,
        current,
      ),
    };
  }

  // **0 件で入れ替えない。**サーバー側は取り込み前の県を 404 にしているが
  // （`apps/web/src/worker/index.ts`）、**受け取った側で確かめるのをやめない**——
  // 通すと、**走れる端末を走れない端末に変える**のがこの更新になる。
  if (parsed.meta.count === 0) {
    return { status: "failed", meta: current, error: keeping("0 件が返りました", current) };
  }

  // **落としきってから、もう一度確かめる。**取得に数秒かかるので、
  // **その間に走り出していることがある。**
  if (!canReplace()) return { status: "skipped", meta: current, error: null };

  try {
    writer.replace(parsed.meta, parsed.signs);
  } catch (reason: unknown) {
    // **入れ替えはトランザクションで囲んである**（`./store.ts`）ので、
    // 落ちたなら手元は消える前のままである。**それでも手元を読み直して返す**——
    // 「そのはず」で画面に古い件数を出すより、実際にあるものを出す。
    return {
      status: "failed",
      meta: safeMeta(store) ?? current,
      error: `標識を入れ替えられませんでした: ${String(reason)}`,
    };
  }

  return { status: "replaced", meta: parsed.meta, error: null };
}

/**
 * 更新を諦めたときの文言。**「手元のものを使う」ことを必ず添える。**
 *
 * 添えないと、初めての人は**走ってはいけない状態だと受け取る**——
 * 実際には1か月古い標識でも道路の一時停止はほとんど変わらない
 * （`docs/interfaces/mobile-api.md`「取得に失敗しても走行を止めない」）。
 */
function keeping(reason: string, current: SignsMeta | null): string {
  // **手元に何も無いときに「手元のものを使います」と言わない。**嘘になるうえ、
  // **走れないことを走れるように見せる**——県を選んだのに取れなかった端末は、
  // **一時停止の事前通知が動かないまま**である（#71）。
  if (current === null) return `標識を受け取れませんでした（手元にも標識がありません）: ${reason}`;
  return `新しい標識を受け取れませんでした（手元のものを使います）: ${reason}`;
}

/**
 * 画面を落とさずに素性を読む。**読めなければ `null`。**
 *
 * `./expo.ts` も使う。**2つ書かない**（`CLAUDE.md`「同じことを2箇所に書かない」）。
 */
export function safeMeta(store: SignStore): SignsMeta | null {
  try {
    return store.meta();
  } catch {
    return null;
  }
}
