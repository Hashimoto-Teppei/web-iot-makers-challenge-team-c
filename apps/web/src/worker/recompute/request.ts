import { z } from "zod";
import { type RecomputeLimits, recomputeLimitDefaults } from "./config";
import type { Thresholds } from "./judge";

/**
 * `POST /api/admin/recompute` のリクエストの検証。
 *
 * **仕様の正本は `docs/interfaces/web-stats.md`「不停止の判定」と「いつ計算するか」。**
 * ここはその実装であって、決め直す場所ではない。
 *
 * **しきい値をサーバーの既定値で埋めない。**4つとも必須にしてある——
 * **その場で数字を変えて叩き直せることがこの経路を持つ理由**であり
 * （`docs/adr/0007-keep-raw-ride-logs.md`）、既定値を置くと
 * **「省略して叩いた結果」と「その数字を選んだ結果」が区別できなくなる。**
 * 暫定の既定値は `docs/interfaces/web-stats.md`「しきい値の既定値」にある。
 */

/** 端末ID・走行の識別子の形（16進の小文字8文字）。`docs/interfaces/ble-gatt.md` */
const hexId = z.string().regex(/^[0-9a-f]{8}$/);

/** どの走行を計算し直すか。**`rides` の主キーと同じ組。** */
const rideRef = z.object({
  deviceId: hexId,
  logId: hexId,
});

function thresholdsSchema(limits: RecomputeLimits) {
  return z.object({
    /**
     * **0 を許さない。**1Hz の測位は止まっていても数十 cm/s のゆらぎを出すので、
     * **0 にすると誰も停止したことにならない**（`docs/interfaces/web-stats.md`）。
     */
    stopSpeedMps: z.number().gt(0).lte(10),
    radiusM: z.number().gt(0).lte(limits.maxRadiusM),
    /**
     * **180 まで許す**（＝進入方向を見ない）。**外すなら見逃す側へ倒す**という判断と逆向きなので
     * 既定にはしないが、**方向を見ないとどう変わるかを試せないと、60° が妥当かを確かめられない。**
     */
    bearingToleranceDeg: z.number().min(0).max(180),
    /**
     * これより悪い精度の測位点を判定から外す。**取り込みは足切りをしない**ので
     * （`logs/config.ts`）、**切るのはここだけ**である。
     */
    maxHaccM: z.number().gt(0),
  });
}

export function recomputeRequestSchema(limits: RecomputeLimits) {
  return (
    z
      .object({
        thresholds: thresholdsSchema(limits),
        /**
         * 計算し直す走行。**省略すると古い順に上限ぶん**を対象にする。
         *
         * **件数の上限をここ（Zod）で見ない。**見ると **`too_big` として「形が違う」に
         * まとめられ、「分けて送り直せば入る」と区別できない**——`POST /api/logs` が
         * その2つを分けているのと同じ理由である（`logs/request.ts` の `logsErrorOf`）。
         * **数えるのは `index.ts`** で、あちらは「多すぎます」と言える。
         */
        rides: z.array(rideRef).min(1).optional(),
        /**
         * 何走行ぶん飛ばすか（`rides` を省略したときだけ意味を持つ）。
         *
         * **上限を超えた走行を 400 で突き返さないため**にある。走行は増え続けるので、
         * **突き返すだけだと、21 本目が入った時点で「全走行を計算し直す」経路が永久に使えなくなる**
         * ——しかも**どの走行があるかを知る API が無い**ので、`rides` に書く材料も手に入らない。
         * 応答の `more` が `false` になるまで、上限ずつ足して叩く。
         */
        skip: z.number().int().min(0).optional(),
      })
      // **`rides` と `skip` を混ぜない。**`rides` を渡した時点で対象は決まっており、
      // **黙って無視すると、飛ばしたつもりの走行が計算されている。**
      .refine((body) => !(body.rides && body.skip !== undefined), {
        message: "rides を指定するときは skip を渡さないでください",
      })
  );
}

/** 既定の上限での検証。ルートはこれを使う（テストだけが上限を差し替える）。 */
export const recomputeRequest = recomputeRequestSchema(recomputeLimitDefaults);

export type RecomputeRequest = z.infer<typeof recomputeRequest>;
export type RideRef = z.infer<typeof rideRef>;

/**
 * 再計算の応答。
 *
 * **`violations` は「入れ直した件数」。**取り込み（`POST /api/logs`）が受け取った件数を返すのとは
 * 逆で、**こちらは既存の行を置き換えるので、入った件数がそのまま結果**である。
 *
 * **しきい値を返す。**呼んだ側が渡した値そのものだが、**どの設定の結果を見ているかが
 * 応答だけで分かる方が、叩き直しながら数字を詰めるときに間違えない。**
 */
export type RecomputeResponse = {
  computed: {
    /** 対象にした走行の数（不停止が0件だった走行も数える） */
    rides: number;
    /** 判定に使った測位点の数（精度で落とす前の数） */
    points: number;
    /** 入れ直した不停止の数 */
    violations: number;
    /**
     * **まだ計算していない走行が残っているか**（`rides` を省略したときだけ `true` になりうる）。
     *
     * **これが無いと、ちょうど上限ぶんで終わったのか、続きがあるのかが区別できない。**
     * `true` の間は `skip` を上限ずつ足して叩き直す。
     */
    more: boolean;
  };
  thresholds: Thresholds;
};

/** 400 / 401 / 503 の中身。**zod の issue をそのまま載せない**（`logs/request.ts` と同じ理由）。 */
export type RecomputeError = {
  error: string;
};
