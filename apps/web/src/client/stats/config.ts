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

/**
 * 円の縁。**役割の分担は `docs/interfaces/web-ui.md`「地図の描き方」が正本**で、
 * ここにあるのは**値と、その値を選んだ根拠の数字だけ**である。
 *
 * 0.55 は**地（`MAP_STYLES` の #e4e8e0）との比が 2.30:1** になる濃さ。
 * 旧 0.35 は 1.69:1 で、**率 0 の円（塗りは 1.19:1）と合わせても見つけられなかった。**
 *
 * **塗りの下端（`MIN_FILL_OPACITY`）は上げない。**上げると**率の幅 0.63 がそのぶん狭まり、
 * 隣り合う率が今より見分けにくくなる**（0.20 にすると 1.34:1 と引き換えに幅が 0.55 へ）。
 */
export const STROKE_OPACITY = 0.55;
export const STROKE_OPACITY_SELECTED = 1;
export const STROKE_WEIGHT = 1;
export const STROKE_WEIGHT_SELECTED = 3;

/**
 * 円の重なり順。**率の高い円ほど上に置く。**
 *
 * **置かないと、率の高い円が下に沈む。**一覧は**率の降順**で返ってくるので
 * （`src/worker/stats/aggregate.ts`）、**素直に作ると最も危ない円が最初に作られ、
 * いちばん下に描かれる。**半径は通過の平方根なので、**通過が多いだけの大きな円が
 * その上に乗る**——**縁が隠れるだけでなく、クリックも大きい円が奪う**ので、
 * **一番危ないセルを地図から選べない。**
 *
 * **選択中は全部より上。**選ばれた円の太い縁は、重なりの下にあっては意味がない。
 */
export const Z_INDEX_SELECTED = 10000;
/** 率（0〜1）を重なり順に写す。**率が同じなら順序は問わない。** */
export const zIndexForRate = (rate: number): number => Math.round(rate * 1000);

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
 * **地の色をページの背景に近づけるのはやめた**（変更・2026-09-02）。
 * **近づけた結果、地図が背景に溶けて、面としてどこで始まりどこで終わるのかが見えなくなった。**
 * ページの地（`--bg` #f6f7f5）と地図の地（旧 #f4f5f2）のコントラスト比は **1.02:1** で、
 * **枠線（`--border`）も 1.17:1 しかなく、縁でも面が立っていなかった。**
 *
 * **いまは地図の地を一段暗くして、画面の中で最も暗い面にしてある**（1.16:1）。
 * 地が暗くなったぶん白い道路が浮き上がり、**道路網が地図の構造として読める**
 * （地と幹線の比が 1.06:1 → 1.24:1）。**`.map` の枠線も `--border-strong` に上げてある**
 * （`index.css`）。
 *
 * **代償として、率の幅が 15% 縮む。**塗りは半透明なので、**地が暗くなると円も一緒に暗くなる**
 * ——率 0 と率 1 の輝度差は 0.51 から 0.43 へ、相互の比は 2.77:1 から 2.57:1 へ落ちた。
 * **下の `MIN_FILL_OPACITY` を上げない理由と同じ性質の損**である。
 * **それでも地を暗くしたのは、地図が面として見えないことの方が重いから**——
 * **率の読み取り以前に、どこを見ればいいのかが分からなかった。**
 *
 * **ページ側の色は1つも変えていない。**`--bg` / `--surface` / `--danger` を動かすと、
 * **`--danger` と下の `CIRCLE_COLOR` を同じ値に保つ約束**にも触れることになる。
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
  // 地の色。**ページの背景より一段暗くして、地図を面として立てる**（上の注記）。
  { elementType: "geometry", stylers: [{ color: "#e4e8e0" }] },
  // 地が暗くなったので、文字も一段暗くして読みやすさを保つ（地の上で 6.1:1）。
  { elementType: "labels.text.fill", stylers: [{ color: "#4d5651" }] },
  // 文字の縁取り。**白で縁を取る**と、地の上でも赤い円の上でも字が読める。
  { elementType: "labels.text.stroke", stylers: [{ color: "#ffffff" }] },
  // 店・施設のラベルは消す（地名ではないうえ、密集して円を隠す）。
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#dde3d6" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#d6e2c9" }] },
  // 道路は白。**既定の黄色をやめる**のがこのスタイルの主目的。
  // **道路の階層を作っているのは幅**（Google が道路種別ごとに変えている）で、**色は補助**。
  // 一般道を白から少しだけ落として、**幹線・高速の白を目立たせる**（幹線との比 1.09:1）。
  // **これ以上落とせない**——地との比が 1.14:1 しかなく、**落とすほど一般道が地に沈む。**
  // 地と白の間に 1.24:1 しか無いので、**2段に割ると、どちらの段も薄くなる。**
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#f4f6f1" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#79837d" }] },
  // **番号標識（国道・県道の青い図記号）は消す**（変更・2026-09-02）。
  // **画面で最も彩度の高いものが青い標識になっていて、赤い円より目を引いていた**——
  // 「赤い円を画面で唯一の強い色にする」という上の決定が、実際には成立していなかった。
  // **消すのは図記号だけで、道路名の文字は残る**（`labels.text` には触れていない）。
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#cfd6cd" }] },
  // 岡山は川と海があるので、水面は残しつつ彩度を落とす（地形の手がかりになる）。
  // **地が暗くなったぶん、水面も落とす**——旧 #dde7e6 は旧い地との比が 1.15:1 しかなく、
  // **新しい地の上ではさらに 1.05:1 まで落ちて、旭川が消える。**新 #bdd4d4 で 1.25:1。
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#bdd4d4" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#6f7f7d" }] },
  // 交通機関の線は消す。**円と同じくらいの太さで走っていて、地図の主題を奪う。**
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];
