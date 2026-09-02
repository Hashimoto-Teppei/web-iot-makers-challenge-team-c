import { useEffect, useRef, useState } from "react";
import type { StatsCell } from "../../shared/api";
import { cellCenter, cellOf } from "../../shared/cell";
import {
  CIRCLE_COLOR,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  FOCUS_ZOOM,
  MAP_STYLES,
  MAX_FILL_OPACITY,
  MIN_FILL_OPACITY,
  RADIUS_PER_SQRT_RIDE,
} from "./config";
import { loadGoogleMaps, MAPS_API_KEY } from "./maps";

/**
 * セルごとの円を地図に置く。
 *
 * **円はセルの中心に置く。**代表座標（`lat` / `lon`）は**南西の角**なので、
 * **半セル足す**（`docs/interfaces/web-ui.md`）。**足し忘れると南へ 55m・西へ 46m ずれる。**
 *
 * **半径は通過の平方根、色の濃さは率**（同上）。2つを入れ替えないこと——
 * **半径を通過そのものに比例させると、2倍の場所が4倍危険に見える。**
 */

export type StatsMapProps = {
  cells: StatsCell[];
  /** ランキングから選ばれたセル。**地図はここへ飛ぶ** */
  selected: StatsCell | null;
  onSelect: (cell: StatsCell) => void;
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

/** 円の縁。**選ばれたセルだけ濃く太くする**（塗りは率のためのものなので触らない）。 */
const strokeFor = (isSelected: boolean) => ({
  strokeColor: CIRCLE_COLOR,
  strokeOpacity: isSelected ? 1 : 0.35,
  strokeWeight: isSelected ? 3 : 1,
});

export function StatsMap({ cells, selected, onSelect }: StatsMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const circles = useRef<google.maps.Circle[]>([]);
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
            // **彩度を落とす。**既定の黄色い道路の上では、赤い円の濃さが読めない
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

  // セルが変わったら円を置き直す。**前の円を消してから置く**（重ねると濃さが嘘になる）。
  //
  // **選ばれたセルはこの効果の外で塗り替える**（下）。ここに混ぜると、
  // **行を1つ押すたびに最大 500 個の円を作り直す**ことになり、
  // **`setMap(null)` では外れない `addListener` の購読がそのぶん積み上がる。**
  useEffect(() => {
    if (!map) return;

    circles.current = cells.map((cell) => {
      const circle = new google.maps.Circle({
        map,
        center: centerOf(cell),
        // **通過の平方根に比例**（面積が通過に比例する）。
        radius: RADIUS_PER_SQRT_RIDE * Math.sqrt(cell.rides),
        fillColor: CIRCLE_COLOR,
        fillOpacity: MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * cell.rate,
        ...strokeFor(false),
      });
      // 地図の円からも選べるようにする（順位表との往復は双方向でないと片道になる）。
      circle.addListener("click", () => onSelect(cell));
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
  }, [map, cells, onSelect]);

  // 選ばれたセルの縁だけを塗り替える。**円は作り直さない。**
  useEffect(() => {
    const selectedId = selected ? cellId(selected) : null;
    for (const [index, circle] of circles.current.entries()) {
      const cell = cells[index];
      circle.setOptions(strokeFor(cell !== undefined && cellId(cell) === selectedId));
    }
  }, [cells, selected]);

  // 選ばれたセルへ飛ぶ。**行をクリックすると地図がその場所へ飛ぶ**（1ページに並べた理由そのもの）。
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
        <p>鍵が無くても、右のランキングはそのまま動きます。</p>
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

  return <div className="map" ref={container} />;
}
