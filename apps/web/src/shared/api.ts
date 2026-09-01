/**
 * 画面（src/client）と API（src/worker）で共有する型。
 * どちらか一方でしか使わない型はここに置かない。
 */

export type HealthResponse = {
  status: "ok";
  /** ISO 8601 形式の応答時刻 */
  timestamp: string;
};

/** D1 の疎通確認用。テーブル設計が決まったら差し替える（Issue #7）。 */
export type Ping = {
  id: number;
  message: string;
  createdAt: string;
};

/**
 * 一時停止の標識1件。
 *
 * **型の正本は `apps/mobile/src/detect/types.ts` の `StopSign`。**
 * 同じ形をここにも置いているのは、`packages/` を作らないと決めているため
 * （`docs/adr/0009-on-device-storage.md`）。**項目を増やすときは両方を直す。**
 *
 * **配るのは位置と進入方向だけ。**交差点名称のような、走行中に出せないものは配らない
 * （走行中のディスプレイに文章を出さない。`CLAUDE.md`）——D1 には残してあり、
 * 走行後の画面はそちらを読む。セル（集計の升目）も配らない。端末が同梱物を作るときに
 * 計算する——切り方を2通り持たないため（`docs/interfaces/web-service.md`）。
 */
export type StopSign = {
  /** 標識の識別子。端末では警告の抑制キー（`causeId`）になる */
  id: string;
  /** 規制地点の緯度（度、WGS84）。**停止線の位置とは限らず、交差点中央部のこともある** */
  lat: number;
  /** 規制地点の経度（度、WGS84） */
  lon: number;
  /**
   * **この標識が対象とする車両の進入方向**を表す点。
   * **この点から `(lat, lon)` へ向かって走る車両**が規制の対象になる。
   *
   * **`null` は「全方向が対象」ではなく「元データに登録が無い」。**
   */
  approach: { lat: number; lon: number } | null;
};

/**
 * `GET /api/stop-signs` の応答。**都道府県ぶんを丸ごと返す**
 * （`docs/interfaces/mobile-api.md`「都道府県ぶんを一度に配る。地域で分割しない」）。
 */
export type StopSignsResponse = {
  /** 都道府県コード（岡山県 = 33） */
  pref: number;
  /**
   * 版。**この値が ETag の元**で、端末はそのまま持ち帰って次回 `If-None-Match` に載せる。
   * 端末側で作らない（`docs/interfaces/mobile-api.md`「版はサーバーが決める」）。
   */
  version: string;
  /** `signs` の件数。**0 件なら端末は走行を始めさせない**（`docs/adr/0009-on-device-storage.md`） */
  count: number;
  signs: StopSign[];
};
