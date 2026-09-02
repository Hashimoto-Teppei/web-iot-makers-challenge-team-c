/**
 * 画面側の設定値。**コードに直書きしない**（`CLAUDE.md`）。
 *
 * **集計そのものの設定は Worker 側にある**（`src/worker/stats/config.ts`）。
 * ここにあるのは**見せ方の数字だけ**で、指標の定義には関わらない。
 */

/**
 * 円の半径（メートル）＝ `RADIUS_PER_SQRT_RIDE × √通過`。
 *
 * **通過そのものに比例させてはいけない**（`docs/interfaces/web-ui.md`「地図の描き方」）。
 * **人は円の面積で量を読む**ので、半径を2倍にすると面積は4倍に見え、
 * **2倍の場所が4倍危険に見える。平方根を取ると、面積が通過に比例する。**
 *
 * 14 は「通過 5走行でおよそ 31m、50走行で 99m」になる値で、
 * **セルの大きさ（南北およそ 111m）に対して大きくなりすぎない**ように選んである。
 */
export const RADIUS_PER_SQRT_RIDE = 14;

/**
 * 円の色。**濃さ（不透明度）が率を表す**（`docs/interfaces/web-ui.md`）。
 *
 * **率 0 のセルも薄く描く。**消すと「通過が多くて安全な場所」が地図から消え、
 * **危ない場所だけが浮いた地図**になる——**通過が多いだけの場所と、本当に危ない場所を
 * 見分けられること**が、色と半径を別々の情報に割り当てた理由である。
 */
export const CIRCLE_COLOR = "#d7263d";
export const MIN_FILL_OPACITY = 0.12;
export const MAX_FILL_OPACITY = 0.75;

/** 地図の初期表示（岡山駅の周辺）。**セルが1つも無いときはここが出る。** */
export const DEFAULT_CENTER = { lat: 34.6651, lng: 133.9183 };
export const DEFAULT_ZOOM = 14;

/** ランキングの行から飛んだときの拡大率。**セル1つが画面に収まる程度。** */
export const FOCUS_ZOOM = 18;
