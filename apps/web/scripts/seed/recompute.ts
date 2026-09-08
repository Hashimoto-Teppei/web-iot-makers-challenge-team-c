/**
 * 不停止を全走行ぶん計算し直す。**`POST /api/admin/recompute` を、残りが無くなるまで叩くだけ。**
 *
 *   pnpm --filter web recompute --token <ADMIN_TOKEN>                       # 手元
 *   pnpm --filter web recompute --token <ADMIN_TOKEN> --api https://<デプロイ先>
 *
 * **サンプルを投入しただけでは不停止のタブに何も出ない。**`stop_violations` を作るのは
 * この経路だけで、**取り込みのリクエストの中では計算しない**
 * （`docs/interfaces/web-stats.md`「いつ計算するか」）。
 *
 * **1回で計算できるのは 20 走行まで**（`src/worker/recompute/config.ts`。Worker の CPU 時間から
 * 決まっている数字で、上げるには測り直しが要る）。**サンプルは 240 走行ある**ので、
 * **応答の `more` が `false` になるまで `skip` を足して叩き直す**——
 * **手で 12 回叩くと、どこまで進んだか分からなくなる。**
 *
 * **しきい値は毎回渡す。**サーバーは既定値を持たない——**省略して叩いた結果と、
 * その数字を選んだ結果を区別できなくするため**である（`src/worker/recompute/request.ts`）。
 * ここに書いてあるのは `docs/interfaces/web-stats.md`「しきい値の既定値」から写した暫定値で、
 * **変えて試すときは `--stop-speed` などで上書きする。**
 */

import { parseArgs } from "node:util";
import type { RecomputeResponse } from "../../src/worker/recompute/request.ts";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    api: { type: "string", default: "http://localhost:5173" },
    /** `ADMIN_TOKEN`。**環境変数でも渡せる**——Windows では `FOO=bar cmd` が書けない（`CLAUDE.md`）。 */
    token: { type: "string" },
    "stop-speed": { type: "string", default: "1.5" },
    radius: { type: "string", default: "20" },
    bearing: { type: "string", default: "60" },
    "max-hacc": { type: "string", default: "30" },
  },
});

const token = values.token ?? process.env.ADMIN_TOKEN;
if (!token) {
  console.error(
    [
      "ADMIN_TOKEN がありません。--token <値> で渡すか、環境変数 ADMIN_TOKEN に入れてください。",
      "手元の値は apps/web/.dev.vars にあります（このファイルはコミットされません）。",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * しきい値を数にする。**数でない値をそのまま送らない**——`Number("はやい")` は `NaN` で、
 * `JSON.stringify` が `null` にし、**サーバーは「形式が正しくありません」としか言えない。**
 * **数字を詰めるための道具**なので、どの指定が悪いのかはここで言う。
 */
const numberOf = (flag: string, value: string | undefined): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.error(`--${flag} には数を渡してください（受け取った値: ${String(value)}）`);
    process.exit(1);
  }
  return parsed;
};

const thresholds = {
  stopSpeedMps: numberOf("stop-speed", values["stop-speed"]),
  radiusM: numberOf("radius", values.radius),
  bearingToleranceDeg: numberOf("bearing", values.bearing),
  maxHaccM: numberOf("max-hacc", values["max-hacc"]),
};

const url = `${(values.api ?? "").replace(/\/$/, "")}/api/admin/recompute`;
let skip = 0;
let rides = 0;
let violations = 0;

// **`more` が `false` になるまで。**ちょうど上限ぶんで終わったのか続きがあるのかは、
// 走行の数からは決められない（`src/worker/recompute/request.ts` の `more`）。
for (;;) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ skip, thresholds }),
  }).catch((e: unknown) => {
    throw new Error(`${url} に繋がりません（pnpm dev は動いていますか）: ${String(e)}`);
  });

  if (!res.ok) {
    // **本文をそのまま出す。**401（トークン違い）と 503（設定漏れ）を言い分けているのは
    // サーバー側なので、こちらで言い換えると区別が消える（`src/worker/recompute/auth.ts`）。
    console.error(`${url} が ${res.status} を返しました: ${await res.text()}`);
    process.exit(1);
  }

  const body = (await res.json()) as RecomputeResponse;
  rides += body.computed.rides;
  violations += body.computed.violations;
  console.log(
    `${skip} 走行目から ${body.computed.rides} 走行: 不停止 ${body.computed.violations} 件`,
  );
  if (!body.computed.more) break;
  skip += body.computed.rides;
  // **1走行も進まなかったら止める。**`more` が立ったまま 0 走行が返ると、無限に叩き続ける。
  if (body.computed.rides === 0) {
    console.error("走行が1つも進みませんでした。中断します。");
    process.exit(1);
  }
}

console.log(`\n${rides} 走行を計算し直しました（不停止 ${violations} 件）。`);
