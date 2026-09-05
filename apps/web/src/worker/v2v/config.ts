/**
 * 走行中の中継の設定。
 *
 * **しきい値をコードに直書きしない**（`CLAUDE.md`「実機なしで開発する」）。
 * 既定値の根拠は `docs/interfaces/mobile-api.md`「Worker と Durable Object の約束」。
 * **どれも仮の値**で、実測して決め直す（`docs/unverified.md`）。
 */

/** 近傍を保つ側（Durable Object）の設定。 */
export type NeighborConfig = {
  /**
   * この距離より遠い相手は返さない（メートル）。
   *
   * 検知に必要なのは 50m 程度だが、接近の履歴を作る余裕を足して広めに取る。
   * 受け取った `peer` はスマホの中に留まり BLE へは流れないので、広げても増えるのは
   * JSON のバイト数とスマホの計算量だけ（`docs/adr/0006-decision-layer-on-mobile.md`）。
   */
  radiusM: number;
  /**
   * 最後に**届いてから**この時間が過ぎた相手を捨てる（ミリ秒）。
   *
   * **測るのは到着時刻であって、メッセージの `t` ではない。**`t` は送ってきた端末の
   * 時計なので、ずれている端末が入れた瞬間に失効して「全員から永久に見えない」状態になる
   * （`docs/interfaces/mobile-api.md`）。
   *
   * **モバイル側の失効と足し算になる。**片方だけを動かさないこと
   * （既定 3 + 3 秒で、近傍に残る時間は最悪およそ6秒）。
   */
  expiryMs: number;
};

/** 通してよい値の範囲。壊れた1通を検知に届かせないために上限を置く。 */
export type MessageLimits = {
  /** これを超える `spd` は捨てる（m/s。既定 30 = 108km/h） */
  maxSpdMps: number;
  /** これを超える `hacc` は捨てる（メートル） */
  maxHaccM: number;
};

export const neighborDefaults: NeighborConfig = {
  radiusM: 300,
  expiryMs: 3_000,
};

/**
 * `apps/mobile/src/v2v/messages.ts` の `messageLimitDefaults` と**同じ値**にしてある。
 * 片方だけを変えると、サーバーが通した1通をスマホが捨てる（またはその逆）状態になる。
 */
export const messageLimitDefaults: MessageLimits = {
  maxSpdMps: 30,
  maxHaccM: 50,
};

/**
 * Durable Object の名前。
 *
 * **セルに割らず、この1個だけを使う。**geohash などで割ると、境界をまたいだ自転車が
 * 互いに見えなくなる（`docs/interfaces/mobile-api.md`）。
 *
 * **実測（2026-09-05、#136）: 50台ぶんの 1Hz を 30 秒（1,500 リクエスト）投げて失敗 0、
 * 往復は中央値 285ms・p95 328ms。**10 / 20 / 30 / 50 台で往復はほとんど動かない
 * （257 → 262 → 267 → 285ms）。**発表会場の規模では、1個のままで足りる。**
 *
 * **末尾の世代（`-v1`）を消さない。**`locationHint` は作成時の1回しか効かないので、
 * 置き場所を間違えたときに直す手段が「名前を変えて作り直す」しかない。
 */
export const NEIGHBORS_DO_NAME = "neighbors-v1";

/**
 * Durable Object を最初に作る場所。
 *
 * **渡さないと最初にリクエストした場所に置かれる。**US の CI からスモークテストを
 * 1回叩くと北米に固定され、以降の全員の往復がそこを経由する。
 *
 * **実測（2026-09-05、#136）: 日本から `exchange` の往復が中央値 243ms。**
 * **同じ経路の `GET /api/health`（DO を通らない）が 125ms** なので、DO のぶんは +118ms。
 * このときの入口のコロは **SEA**（`/cdn-cgi/trace` で確認。回線の都合で日本から北米へ出ていた）
 * ——**入口が北米でも往復が 243ms に収まったということは、DO 自体は太平洋の向こう側、
 * つまりアジアに居る**（同じコロに居れば +118ms は出ない）。
 * **会場のスマホは入口も日本になるので、これより短くなる側**である。
 */
export const NEIGHBORS_LOCATION_HINT = "apac-ne" as const;
