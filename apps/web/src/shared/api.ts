/**
 * 画面（src/client）と API（src/worker）で共有する型。
 * どちらか一方でしか使わない型はここに置かない。
 */

export type HealthResponse = {
  status: "ok";
  /** ISO 8601 形式の応答時刻 */
  timestamp: string;
};
