import { MIN_RADIUS_M, RATE_BANDS, radiusForRides } from "./config";

/**
 * 地図の凡例。**色の段と円の大きさが何を指すかを画面に出す**（#157）。
 *
 * **これが無いと、抑揚を付けても意味が伝わらない。**円の色と大きさは
 * この画面の主題そのものなのに、**以前はどこにも説明が無く、
 * 「なんとなく赤い模様」として読まれていた。**
 *
 * **Google Maps の API を使わず、地図の面に重ねるだけにする**（`../index.css` の `.legend`）。
 * 地図の部品として作ると**地図の読み込みが終わるまで凡例が出ない。**
 *
 * **円の見本の大きさは実際の縮尺ではない。**縮尺は地図の拡大率で変わるので、
 * **合わせようとすると拡大するたびに凡例が動く**——ここで見せたいのは
 * **「大きいほど通行が多い」という向きだけ**である。
 */

/**
 * 見本に使う通行の数。**目安であって、実際に出ている値ではない。**
 *
 * **データの最大・最小を書き写さない。**サンプルを作り直せば変わるし、
 * **実走行のデータではその数の区画が1つも無い**——**凡例が、無い区画を指すことになる。**
 * ここで見せたいのは**大きさの向きだけ**なので、丸い数を2つ置く。
 */
const RIDES_SAMPLES = [10, 50];

/**
 * 見本の直径（px）。**半径の比だけを保ち、px の大きさはここで決める**
 * （地図の縮尺とは無関係。上の注記）。
 */
const SWATCH_MAX_PX = 28;
const maxRadius = radiusForRides(RIDES_SAMPLES[RIDES_SAMPLES.length - 1] ?? 1);
const swatchPx = (rides: number): number =>
  Math.round((radiusForRides(rides) / maxRadius) * SWATCH_MAX_PX);

export function Legend() {
  return (
    <div className="legend">
      <div className="legend__group">
        <span className="legend__title">危険率（色）</span>
        <ul className="legend__scale">
          {RATE_BANDS.map((band) => (
            <li key={band.label}>
              <span
                className="legend__chip"
                style={{ background: band.fill, borderColor: band.stroke }}
                // **色だけで意味を運ばない。**隣に文字があるので `aria-hidden` にして、
                // **読み上げで「色見本」が二重に読まれないようにする。**
                aria-hidden="true"
              />
              {band.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="legend__group">
        <span className="legend__title">通行（大きさ）</span>
        <ul className="legend__sizes">
          {RIDES_SAMPLES.map((rides) => (
            <li key={rides}>
              <span
                className="legend__circle"
                style={{ width: `${swatchPx(rides)}px`, height: `${swatchPx(rides)}px` }}
                aria-hidden="true"
              />
              {rides}
            </li>
          ))}
          {/* **床に当たる範囲があることを書いておく**（`./config.ts` の `MIN_RADIUS_M`）。
              書かないと、**通行 1 と 3 の円が同じ大きさなのが不具合に見える。** */}
          <li className="legend__note">通行が少ない区画は同じ大きさ（最小 {MIN_RADIUS_M}m）</li>
        </ul>
      </div>
    </div>
  );
}
