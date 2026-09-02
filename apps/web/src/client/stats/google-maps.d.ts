/**
 * Google Maps の JavaScript API のうち、**この画面が実際に触る分だけ**の型。
 *
 * **`@types/google.maps` を入れていない。**入れると pnpm がワークスペース全体を
 * 解決し直し、**`apps/mobile` の依存グラフ**（React と TypeScript のピア、Expo の
 * ビルドツール）まで動く。**モバイルの依存は `npx expo install` で入れる**と決めてあり
 * （`CLAUDE.md`）、**画面の型を1つ足すために Android のビルドを動かさない。**
 *
 * **足りない API を使うときは、ここに1つずつ足す。****推測で広げないこと**——
 * 公式のリファレンスで確かめてから書く（手で書いた型は、間違っていても型検査が通る）。
 */

declare namespace google.maps {
  type LatLngLiteral = { lat: number; lng: number };

  type MapOptions = {
    center?: LatLngLiteral;
    zoom?: number;
    streetViewControl?: boolean;
    mapTypeControl?: boolean;
  };

  // 実物の名前が `google.maps.Map` であり、**名前を変えると宣言が実物と合わなくなる。**
  // `namespace` の中なので、組み込みの `Map` を隠すのは `google.maps` の内側だけである。
  // biome-ignore lint/suspicious/noShadowRestrictedNames: 上のとおり
  class Map {
    constructor(element: HTMLElement, options?: MapOptions);
    panTo(position: LatLngLiteral): void;
    /** 地図がまだ初期化しきっていないと `undefined` を返す。 */
    getZoom(): number | undefined;
    setZoom(zoom: number): void;
  }

  type CircleOptions = {
    map?: Map | null;
    center?: LatLngLiteral;
    /** メートル */
    radius?: number;
    fillColor?: string;
    fillOpacity?: number;
    strokeColor?: string;
    strokeOpacity?: number;
    strokeWeight?: number;
  };

  class Circle {
    constructor(options?: CircleOptions);
    setMap(map: Map | null): void;
    setOptions(options: CircleOptions): void;
    addListener(eventName: string, handler: () => void): MapsEventListener;
  }

  type MapsEventListener = { remove(): void };

  namespace event {
    /**
     * その物体に付いた購読を全部外す。**`setMap(null)` では外れない**
     * ——地図から消えても、`addListener` で足した関数は残り続ける。
     */
    function clearInstanceListeners(instance: object): void;
  }
}
