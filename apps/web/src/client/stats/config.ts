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

/**
 * 地図の配色。**彩度を落として、赤い円を画面で唯一の強い色にする**
 * （決定済み・2026-09-02。`docs/interfaces/web-ui.md`「画面のトーン」）。
 *
 * **Google の既定の地図は道路が黄色く、水面が水色**で、明るく落ち着いた画面の中で浮く。
 * それ以上に困るのが**赤い円との競合**で、**黄色い道路の上に赤を重ねると、
 * 濃さの違いが読めなくなる**——濃さが率を表している以上、これは指標が読めないのと同じである。
 *
 * **地名・道路名のラベルは消さない。**`docs/interfaces/web-ui.md`「場所は地図が示す」が、
 * **セルに読める名前を持たない**代わりに**地図が地名を描いていること**を根拠にしている。
 * 消すと、**画面上のどこにも場所を指す言葉が無くなる。**
 *
 * **消すのは POI（店・施設）のラベルだけ。**これは地名ではなく、密集して円を隠す。
 *
 * **`mapId` を使うクラウド側のスタイル指定は採らない**（決定済み・2026-09-02）。
 * Google Cloud コンソールでの作業と環境変数がもう1つ増えるのに対し、
 * **得られる見た目は同じ**である。将来 `styles` が使えなくなったら、そのときに移す。
 */
export const MAP_STYLES: google.maps.MapTypeStyle[] = [
  // 地の色。画面の背景（--bg）に近づけて、地図だけが白く浮かないようにする。
  { elementType: "geometry", stylers: [{ color: "#f4f5f2" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#5c6560" }] },
  // 文字の縁取り。**白で縁を取る**と、地の上でも赤い円の上でも字が読める。
  { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }] },
  // 店・施設のラベルは消す（地名ではないうえ、密集して円を隠す）。
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#eaeee7" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#e2eadd" }] },
  // 道路は白〜薄いグレー。**既定の黄色をやめる**のがこのスタイルの主目的。
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8a938d" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#fbfbfa" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#f0f0ec" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#e3e6e3" }] },
  // 岡山は川と海があるので、水面は残しつつ彩度を落とす（地形の手がかりになる）。
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#dde7e6" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#93a3a1" }] },
  // 交通機関の線は消す。**円と同じくらいの太さで走っていて、地図の主題を奪う。**
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];
