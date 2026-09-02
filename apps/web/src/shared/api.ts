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
 * **配るのは位置と進入方向だけ。****いまは D1 に入っているのもこれだけ**で、
 * 交差点名称は元データが空だったため取り込んでいない（`docs/interfaces/stop-signs-source.md`）。
 * **配らない列を足すときも、走行中のディスプレイに出せないものは端末へ送らない**
 * （走行中のディスプレイに文章を出さない。`CLAUDE.md`）。
 * セル（集計の升目）も配らない。端末が同梱物を作るときに計算する
 * ——切り方を2通り持たないため（`docs/interfaces/web-service.md`）。
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

/**
 * 集計のレイヤー。**検知と不停止を同時に重ねない**（`docs/interfaces/web-ui.md`）。
 *
 * 同じ交差点に2つの円が重なると、**どちらの濃さを見ているのか分からなくなる。**
 * 画面はタブで切り替え、API はこの値で1つだけ返す。
 */
export type StatsLayer = "detection" | "violation";

/**
 * サンプルデータを混ぜるか。
 *
 * **デモとスライドのために入れたデータは同じ表に列で入っている**
 * （`docs/interfaces/web-service.md`「サンプルデータは列で見分ける」）。
 * **別のテーブルにすると画面と集計のクエリが2つに割れる**ので、切り替えはここでする。
 */
export type StatsSample = "include" | "exclude";

/**
 * セル1つぶんの集計。
 *
 * **セルに読める名前は付かない**（`docs/interfaces/web-ui.md`「場所は地図が示す」）。
 * 逆ジオコーディングもしない。**場所を人に伝えるのは地図の仕事**である。
 */
export type StatsCell = {
  /**
   * セルの**南西の角**の緯度経度（切り捨てた値、小数第3位）。**中心ではない。**
   *
   * **ランキングに出す代表座標**であり、**地図に円を置くときは半セル足す**
   * （緯度 +0.0005 / 経度 +0.0005）。**足し忘れると南へ 55m・西へ 46m ずれる。**
   */
  lat: number;
  lon: number;
  /** 通過。**そのセルを通った走行の数**（率の分母）。**円の半径はこの平方根に比例させる** */
  rides: number;
  /** **そのセルで1件以上あった走行の数**（率の分子）。**件数ではない** */
  hits: number;
  /** `hits / rides`。**円の色の濃さはこれ** */
  rate: number;
};

/** `GET /api/stats/cells` の応答。**マップとランキングは同じこれを見る**（同じデータの2つの見せ方）。 */
export type StatsResponse = {
  layer: StatsLayer;
  sample: StatsSample;
  /** 順位に出した通過の下限。**叩いた側が指定しなければ既定値**（`stats/config.ts`） */
  minRides: number;
  /** **率の高い順。**`rides` が `minRides` に満たないセルは入っていない */
  cells: StatsCell[];
  /**
   * **場所が分からなかった数。**地図にも順位にも入っていない。
   *
   * **数だけでも返す。**捨てると、**集計に出ていないことが「起きていない」に見える**
   * （`docs/interfaces/web-service.md`「検知を場所に結びつける」）。
   * **内訳を見せるのは場所の詳細画面**（#87）。
   *
   * **落ちる理由はレイヤーで違う。**検知は**測位が出ていない間に発火したもの**、
   * 不停止は**標識を取り込み直して `sign_id` が変わり、位置を辿れなくなったもの**である。
   */
  unlocated: number;
  /** セルの数が上限を超えて打ち切られたか。**黙って切らないために返す** */
  truncated: boolean;
};
