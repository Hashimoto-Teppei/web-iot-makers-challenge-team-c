import { hc } from "hono/client";
// apps/web の型だけを参照する。実体（Worker のコード）はモバイルには入らない。
import type { AppType } from "web/src/worker/index";
import { DEFAULT_API_BASE_URL } from "./api-base";

/**
 * API のベース URL。**既定はデプロイ先の Worker**（`api-base.ts`）。
 *
 * EXPO_PUBLIC_ で始まる環境変数はアプリのバンドルに埋め込まれ、利用者が読める。
 * したがってここに秘密の値を置かない（URL は秘密ではない）。
 *
 * **手元の `apps/web` に向けたいときだけ** `.env.local` に書く。
 * Android エミュレータからは 10.0.2.2 がホスト PC を指す（`EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:5173`）。
 * 実機で試すときは PC の LAN 内 IP（例: `http://192.168.1.5:5173`）にする。
 * 手順は `docs/setup.md`。
 */
export const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;

export const api = hc<AppType>(apiBaseUrl);
