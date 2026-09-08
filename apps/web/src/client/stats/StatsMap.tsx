import { useEffect, useRef, useState } from "react";
import type { StatsCell } from "../../shared/api";
import { cellCenter, cellOf } from "../../shared/cell";
import {
  bandForPercent,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  FILL_OPACITY,
  FOCUS_ZOOM,
  HOVER_RING_COLOR,
  HOVER_RING_PAD_M,
  HOVER_RING_PAD_PX,
  HOVER_RING_WEIGHT,
  MAP_STYLES,
  radiusForRides,
  ratePercent,
  STROKE_OPACITY,
  STROKE_WEIGHT,
  STROKE_WEIGHT_SELECTED,
  Z_INDEX_HOVER,
  Z_INDEX_SELECTED,
  zIndexForRate,
} from "./config";
import { Legend } from "./Legend";
import { loadGoogleMaps, MAPS_API_KEY } from "./maps";

/**
 * セルごとの円を地図に置く。
 *
 * **円はセルの中心に置く。**代表座標（`lat` / `lon`）は**南西の角**なので、
 * **半セル足す**（`docs/interfaces/web-ui.md`）。**足し忘れると南へ 55m・西へ 46m ずれる。**
 *
 * **半径は通行の平方根、色は率の段**（同上）。2つを入れ替えないこと——
 * **半径を通行そのものに比例させると、2倍の場所が4倍危険に見える。**
 */

export type StatsMapProps = {
  cells: StatsCell[];
  /** ランキングから選ばれたセル。**地図はここへ飛ぶ** */
  selected: StatsCell | null;
  onSelect: (cell: StatsCell) => void;
  /** いま指されているセル。**順位表の行にマウスを乗せている間だけ入る**（#157） */
  hovered: StatsCell | null;
  /** 地図の円を指したことを親へ返す。**外れたら `null`** */
  onHover: (cell: StatsCell | null) => void;
};

/** セルを1つに指す文字列。代表座標がそのまま識別子になる（名前は持たない）。 */
export const cellId = (cell: StatsCell): string => `${cell.lat}/${cell.lon}`;

/**
 * 円を置く点。**代表座標（南西の角）ではなくセルの中心。**
 *
 * **半セルの足し方をここに書かない。**`src/shared/cell.ts` が丸め方を持っているので、
 * そこへ通す——**足す量を画面側に書き写すと、切り方を変えたときに円だけが取り残される。**
 */
const centerOf = (cell: StatsCell): google.maps.LatLngLiteral => {
  const center = cellCenter(cellOf(cell.lat, cell.lon));
  return { lat: center.lat, lng: center.lon };
};

/**
 * 円の見た目。**色は率の段が持ち、大きさは通行が持つ**（値はすべて `./config.ts`）。
 *
 * **選ばれたセルは縁を太くし、全部より上に出す**（塗りと色は段のものなので触らない）。
 * **`cell` をまるごと受けるのは、選択が外れたときに段の色と重なり順へ戻すため。**
 * ここで返さないと、**一度選んだ円が最前面に居座る。**
 *
 * **段は表示上のパーセントから引く**（`ratePercent`）。率そのものから引くと、
 * **「0%」と表示される区画が「1〜9%」の色になる。**
 */
const optionsFor = (cell: StatsCell, isSelected: boolean): google.maps.CircleOptions => {
  const band = bandForPercent(ratePercent(cell.rate));
  return {
    fillColor: band.fill,
    fillOpacity: FILL_OPACITY,
    strokeColor: band.stroke,
    strokeOpacity: STROKE_OPACITY,
    strokeWeight: isSelected ? STROKE_WEIGHT_SELECTED : STROKE_WEIGHT,
    zIndex: isSelected ? Z_INDEX_SELECTED : zIndexForRate(cell.rate),
  };
};

/**
 * その緯度・拡大率で、画面の 1px が何メートルにあたるか。
 *
 * **Google Maps のタイルは 256px で、拡大率 0 のとき地球1周（40,075km）を1枚に収める。**
 * 40075016.686 / 256 = 156543.03392 が赤道での 1px、**緯度が上がるほど縮む**（`cos`）。
 * **リングの太さを画面の見え方で決めるために要る**（`./config.ts` の `HOVER_RING_PAD_PX`）。
 */
const metersPerPixel = (lat: number, zoom: number): number =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

export function StatsMap({ cells, selected, onSelect, hovered, onHover }: StatsMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const circles = useRef<google.maps.Circle[]>([]);
  const ring = useRef<google.maps.Circle | null>(null);
  const [error, setError] = useState<string | null>(null);
  // **地図は ref ではなく state に持つ。**作られるのは読み込みが終わったあとなので、
  // ref に入れると**円を置く効果が「まだ地図が無い」まま一度きり動いて終わる。**
  const [map, setMap] = useState<google.maps.Map | null>(null);

  // 地図そのものは1回だけ作る（セルが変わるたびに作り直すと表示位置が戻る）。
  useEffect(() => {
    if (!MAPS_API_KEY || !container.current) return;

    let live = true;
    loadGoogleMaps(MAPS_API_KEY)
      .then((maps) => {
        if (!live || !container.current) return;
        setMap(
          new maps.Map(container.current, {
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            // 走行後に振り返る画面なので、余計な操作系は出さない。
            streetViewControl: false,
            mapTypeControl: false,
            // **ホイールで地図を拡大しない。ページを送る**（変更・2026-09-08）。
            // **既定（`auto`）では、地図の上にポインタがある間ホイールが地図に吸われる。**
            // この画面は**地図と順位表で画面の大半が埋まる**ので、
            // **ポインタがどちらかの上にあるのが普通の状態**であり、
            // **「下までスクロールできない」ように見える**（実際に報告された）。
            // 拡大は ctrl / ⌘ を押しながら、指なら2本で。
            gestureHandling: "cooperative",
            // **彩度を落とす。**既定の黄色い道路の上では、円の色の段が読めない
            // （`./config.ts` の `MAP_STYLES`）。
            styles: MAP_STYLES,
          }),
        );
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      live = false;
    };
  }, []);

  // セルが変わったら円を置き直す。**前の円を消してから置く**（重ねると色が嘘になる）。
  //
  // **選ばれたセルとホバーの印はこの効果の外で扱う**（下）。ここに混ぜると、
  // **行を1つ指すたびに最大 500 個の円を作り直す**ことになり、
  // **`setMap(null)` では外れない `addListener` の購読がそのぶん積み上がる。**
  useEffect(() => {
    if (!map) return;

    circles.current = cells.map((cell) => {
      const circle = new google.maps.Circle({
        map,
        center: centerOf(cell),
        // **通行の平方根に比例**（面積が通行に比例する）。**下に床がある。**
        radius: radiusForRides(cell.rides),
        ...optionsFor(cell, false),
      });
      // 地図の円からも選べるようにする（順位表との往復は双方向でないと片道になる）。
      circle.addListener("click", () => onSelect(cell));
      // **地図から順位表へも指せるようにする**（#157）。円を見つけても、
      // **それが何位なのかを座標で探し直すのでは、往復がまた片道になる。**
      circle.addListener("mouseover", () => onHover(cell));
      circle.addListener("mouseout", () => onHover(null));
      return circle;
    });

    const placed = circles.current;
    return () => {
      // **購読を明示的に外す。**`setMap(null)` は地図から消すだけで、
      // `addListener` で足した関数は物体に残り続ける。
      for (const circle of placed) {
        google.maps.event.clearInstanceListeners(circle);
        circle.setMap(null);
      }
      circles.current = [];
    };
  }, [map, cells, onSelect, onHover]);

  // 選ばれたセルの縁だけを塗り替える。**円は作り直さない。**
  useEffect(() => {
    const selectedId = selected ? cellId(selected) : null;
    for (const [index, circle] of circles.current.entries()) {
      const cell = cells[index];
      if (cell === undefined) continue;
      circle.setOptions(optionsFor(cell, cellId(cell) === selectedId));
    }
  }, [cells, selected]);

  // ホバーのリング。**円を1つだけ作って使い回す**——指すたびに作ると、
  // **表を上から下へなぞるだけで円が積み上がる。**
  //
  // **円そのものの色は変えない**（`./config.ts` の `HOVER_RING_COLOR`）。
  // **色を読むために指したのに色が変わる**のでは、指す意味が無い。
  useEffect(() => {
    if (!map) return;
    const created = new google.maps.Circle({
      map,
      visible: false,
      // **押す的にしない。**リングは円の上に重なるので、
      // **クリックできると、下にある円を選べなくなる。**
      clickable: false,
      fillOpacity: 0,
      strokeColor: HOVER_RING_COLOR,
      strokeOpacity: 1,
      strokeWeight: HOVER_RING_WEIGHT,
      zIndex: Z_INDEX_HOVER,
    });
    ring.current = created;
    return () => {
      created.setMap(null);
      ring.current = null;
    };
  }, [map]);

  // **拡大率が変わったら引き直す。**すき間は px でも決まるので（`./config.ts`）、
  // **寄せたり引いたりしている間、指したままのリングだけが古い大きさで残る。**
  useEffect(() => {
    const circle = ring.current;
    if (!map || !circle) return;

    const draw = () => {
      if (!hovered) {
        circle.setVisible(false);
        return;
      }
      const gap = Math.max(
        HOVER_RING_PAD_M,
        metersPerPixel(hovered.lat, map.getZoom() ?? DEFAULT_ZOOM) * HOVER_RING_PAD_PX,
      );
      circle.setCenter(centerOf(hovered));
      circle.setRadius(radiusForRides(hovered.rides) + gap);
      circle.setVisible(true);
    };

    draw();
    const listener = map.addListener("zoom_changed", draw);
    return () => listener.remove();
  }, [map, hovered]);

  // **最初の1回だけ、円が全部入る範囲へ合わせる。**
  //
  // **初期値（`DEFAULT_CENTER` / `DEFAULT_ZOOM`）だけでは、データの一部しか見えない**
  // ——**地図の高さは画面の幅と高さで変わる**ので（`--panel-h`。`../index.css`）、
  // **固定の拡大率は、どこかの大きさで必ず外れる**（広い画面では引きすぎ、狭い画面では切れる）。
  // **初期値は残す**——**セルが1件も無いとき**（データがまだ無い / 下限で全部隠れた）に出る。
  //
  // **2回目以降は合わせ直さない。**タブや下限を変えるたびに動くと、
  // **人が動かした地図の位置が勝手に戻る。**
  const fitted = useRef(false);
  useEffect(() => {
    if (!map || fitted.current || cells.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const cell of cells) bounds.extend(centerOf(cell));
    // 余白を置く。**円は点ではないので、中心で合わせると端の円が縁で切れる。**
    map.fitBounds(bounds, 48);
    fitted.current = true;
  }, [map, cells]);

  // 選ばれたセルへ飛ぶ。**行をクリックすると地図がその場所へ飛ぶ**（1ページに並べた理由そのもの）。
  //
  // **ホバーでは飛ばさない。**順位表を上から下へなぞるだけで地図が暴れる。
  useEffect(() => {
    if (!map || !selected) return;
    map.panTo(centerOf(selected));
    if ((map.getZoom() ?? 0) < FOCUS_ZOOM) map.setZoom(FOCUS_ZOOM);
  }, [map, selected]);

  if (!MAPS_API_KEY) {
    return (
      <div className="map map--empty">
        <p>
          地図の鍵（<code>VITE_GOOGLE_MAPS_API_KEY</code>）が設定されていません。
          <code>apps/web/.env.example</code> を <code>apps/web/.env</code>{" "}
          に写して鍵を入れてください （手順は <code>docs/interfaces/web-ui.md</code>「地図の鍵」）。
        </p>
        {/* **「右の」と書かない。**狭い画面では順位表は地図の下に来る（`../index.css`）。 */}
        <p>鍵が無くても、順位表はそのまま動きます。</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="map map--empty">
        <p>{error}</p>
        <p>鍵の API 制限・リファラ制限・1日あたりの割り当てを確かめてください。</p>
      </div>
    );
  }

  // **地図そのものは内側の要素に描かせる。**Google Maps は渡した要素の中身を
  // 自分で作り替えるので、**凡例を同じ要素に入れると消される。**
  return (
    <div className="map">
      <div className="map__canvas" ref={container} />
      <Legend />
    </div>
  );
}
