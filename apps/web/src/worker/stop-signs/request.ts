import { z } from "zod";
import { PREF_CODE_MAX, PREF_CODE_MIN } from "./config";

/**
 * `GET /api/stop-signs` のクエリ文字列。
 *
 * **引数は都道府県コードだけ。位置を取らない**（`docs/interfaces/stop-signs-delivery.md`）。
 * ここに緯度経度を足すと、**走り出す前に現在地をサーバーへ送る**設計になる。
 *
 * クエリ文字列は常に文字列で届くので `coerce` で数値にする。**省略を許さない**——
 * 既定値を置くと、端末が県コードを送っていないことに誰も気づけなくなる。
 */
export const stopSignsQuery = z.object({
  pref: z.coerce.number().int().min(PREF_CODE_MIN).max(PREF_CODE_MAX),
});
