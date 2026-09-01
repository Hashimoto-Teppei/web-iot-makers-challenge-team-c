/**
 * アプリに同梱する `signs.db` を作る。
 *
 *   pnpm --filter mobile signs:build [--base http://localhost:5173] [--pref 33]
 *
 * ```
 * JARTIC の原本 --(抽出。原本を持つ人が1回)--> D1
 * D1 --(GET /api/stop-signs)--> 各自の signs.db  ← ここ。誰でも、原本なしで
 * ```
 *
 * **原本を持たない人でも1コマンドで揃う**ようにするための経路である
 * （`docs/adr/0009-on-device-storage.md`「7」）。**JARTIC の原本からは作らない。**
 *
 * **できたファイルはコミットしない**（`.gitignore` に入れてある）。
 * **無いときに自動で作らない**——Metro が解決に失敗してビルドが止まるのが正しい姿で、
 * 「API が落ちている日になぜかビルドが止まる」より、**理由の分かる止まり方**である。
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildSignsDatabase, openSignsDatabase } from "../src/signs/node.ts";
import { parseStopSignsResponse } from "../src/signs/response.ts";

/** 岡山県。当面はこの県だけを配る（`docs/interfaces/mobile-api.md`）。 */
const DEFAULT_PREF = 33;

/**
 * 既定の取得先。**`pnpm dev` で立つ Vite の開発サーバー**（Worker も同じ口で動く）。
 *
 * **環境変数に依存しない**（Windows では mise の `[env]` が効かない。`CLAUDE.md`）ので、
 * 別の場所から取るときは `--base` で渡す。
 */
const DEFAULT_BASE = "http://localhost:5173";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(here, "..", "assets", "signs.db");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: DEFAULT_BASE },
      pref: { type: "string", default: String(DEFAULT_PREF) },
      out: { type: "string", default: DEFAULT_OUT },
    },
  });

  const pref = Number(values.pref);
  if (!Number.isInteger(pref))
    throw new Error(`--pref が都道府県コードではありません: ${values.pref}`);

  const url = new URL("/api/stop-signs", values.base);
  url.searchParams.set("pref", String(pref));

  console.log(`取得します: ${url}`);
  const response = await fetch(url).catch((cause: unknown) => {
    // **繋がらない理由をここで補う。**初めての人が一番詰まるのはこの1歩である。
    throw new Error(
      `${url} に繋がりません。別のターミナルで pnpm dev を動かしてください（cause: ${String(cause)}）`,
    );
  });

  if (response.status === 404) {
    // **D1 に標識が入っていない。**取り込みは Web/API 側の仕事なので、そちらへ案内する。
    throw new Error(
      `都道府県コード ${pref} の標識がサーバーにありません。` +
        "D1 への取り込み（apps/web の stop-signs:extract）が先に要ります。",
    );
  }
  if (!response.ok) throw new Error(`取得に失敗しました: ${response.status}`);

  const parsed = parseStopSignsResponse(
    await response.json(),
    response.headers.get("etag"),
    new Date(),
  );

  // **頼んだ県が返ってきたことを確かめる。**別の県の中身で `signs.db` を作ると、
  // **どの画面からも見分けが付かない**（画面は同梱物の `meta` を信じる）。
  if (parsed.meta.pref !== pref) {
    throw new Error(
      `頼んだ県と違うものが返りました（頼んだ ${pref} / 返った ${parsed.meta.pref}）`,
    );
  }

  // **0 件で作らない。**作れてしまうと、**標識ゼロのアプリが黙って出来上がる**
  // （起動時に止まるが、止まった理由が分かるのは実機で見たときだけ。
  // `docs/unverified.md` 60）。
  if (parsed.meta.count === 0) {
    throw new Error(`都道府県コード ${pref} の標識が 0 件でした。取り込みを確かめてください`);
  }

  const out = resolve(values.out);
  buildSignsDatabase(out, parsed.meta, parsed.signs).close();

  // **書いたものを開き直して確かめる。**ここまで通っても、開けないファイルが
  // 出来ていれば意味が無い（実機で気づくのが一番遅い。`docs/unverified.md` 60）。
  const { store, close } = openSignsDatabase(out);
  const meta = store.meta();
  close();
  if (meta === null || meta.count !== parsed.meta.count) {
    throw new Error(`${out} を作りましたが、開き直したら中身が違いました`);
  }

  console.log(`できました: ${out}`);
  console.log(`  都道府県 ${meta.pref} / ${meta.count} 件 / 版 ${meta.version}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  // **静かに終わらない。**失敗を 0 で返すと、同梱物が古いまま気づかずにビルドが通る。
  process.exit(1);
});
