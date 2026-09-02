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

/**
 * `GET /api/stats/cell` のクエリ文字列。**1つのセルの内訳を出す**（#87）。
 *
 * **セルは代表座標（南西の角）で指す。**`cellKey` の形（`34665/133918`）を URL に出さない
 * ——**あれは `Map` の鍵にするためだけのもの**で、外に出す識別子は代表座標である
 * （`src/shared/cell.ts`）。**受け取った値はサーバー側でもう一度丸める**ので、
 * セルの中のどの点を渡しても同じセルの内訳が返る。
 *
 * **`layer` を取らない。**この画面は**検知と不停止の両方を出す**——
 * 地図と違って重ならないので、切り替える理由が無い（`docs/interfaces/web-ui.md`）。
 * **`minRides` も取らない。**順位を付けないので、下限で隠す意味が無い。
 */
export const cellDetailQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  /** **一覧と同じ既定にそろえる。**別々にすると、飛んだ先で件数が変わって見える */
  sample: z.enum(["include", "exclude"]).default("include"),
});
