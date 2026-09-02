import { z } from "zod";
import { statsDefaults } from "./config";

/**
 * `GET /api/stats/cells` のクエリ文字列。
 *
 * **公開の画面が叩く経路なので、既定値をサーバーが持つ**（`config.ts`）。
 * 不停止の再計算（`recompute/request.ts`）が既定値を持たないのと逆だが、理由は同じところにある
 * ——あちらは**数字を変えて叩き直すためだけの経路**で、こちらは**何も指定せず開く画面**である。
 *
 * クエリ文字列は常に文字列で届くので、数値は `coerce` で変換する。
 */
export const statsQuery = z.object({
  /** **どちらか一方だけを返す。**同時に重ねない（`docs/interfaces/web-ui.md`） */
  layer: z.enum(["detection", "violation"]).default("detection"),
  /**
   * サンプルデータを混ぜるか。**既定は混ぜる。**
   *
   * **デモで見せるのが既定の姿**であり、**除いた方を見たい人が明示して切り替える。**
   * 逆にすると、投入したサンプルが画面に出ないまま「集計が壊れている」と読まれる。
   */
  sample: z.enum(["include", "exclude"]).default("include"),
  /**
   * 順位に出す通過の下限。**0 を許す**——**サンプルが数走行しか無いうちは、
   * 既定の5走行では画面が空になる**ので、下げて確かめられる必要がある。
   */
  minRides: z.coerce.number().int().min(0).default(statsDefaults.minRides),
});

/** 集計が失敗したときの本文。**形をモバイル側の型に載せるため、`error` だけに揃える。** */
export type StatsError = { error: string };
