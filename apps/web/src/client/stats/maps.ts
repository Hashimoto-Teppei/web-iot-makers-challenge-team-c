/**
 * Google Maps の JavaScript API を読み込むところ。
 *
 * **鍵はバンドルに埋め込まれ、利用者が読める**（`VITE_*`。`CLAUDE.md`）。
 * **隠そうとせず、悪用されても損害が出ない形にする**——割り当て上限・API 制限・
 * リファラ制限の3つで守る（手順は `docs/interfaces/web-ui.md`「地図の鍵」）。
 *
 * **鍵が無くても画面は出る。**未設定なら地図の代わりに案内を出し、
 * **ランキングはそのまま動く**——鍵を持たない人の手元で画面全体が落ちると、
 * 集計が正しいかどうかを確かめられない。
 */

/** ビルド時に埋め込まれる鍵。**空文字なら未設定として扱う。** */
export const MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "";

/** 読み込みは1回だけ。**再描画のたびに `<script>` を足さない。** */
let loading: Promise<typeof google.maps> | null = null;

/**
 * Maps JavaScript API を読み込む。**2回目以降は最初の Promise を返す。**
 *
 * `callback` を使うのは、**スクリプトの `load` イベントだけでは
 * `google.maps` が使えるようになったことを保証できない**ため（公式の作法）。
 */
export function loadGoogleMaps(apiKey: string): Promise<typeof google.maps> {
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const callbackName = "__onGoogleMapsReady";
    // 型に無い名前を window に足すので、ここだけ any を挟む代わりに index シグネチャで受ける。
    (window as unknown as Record<string, () => void>)[callbackName] = () => resolve(google.maps);

    const script = document.createElement("script");
    const params = new URLSearchParams({
      key: apiKey,
      // **使う API を絞る。**鍵の API 制限（Maps JavaScript API だけ）と合わせる。
      libraries: "maps",
      v: "weekly",
      loading: "async",
      callback: callbackName,
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    // **失敗を握り潰さない。**鍵の制限に引っかかったときも、割り当てを使い切ったときも
    // ここに来る。黙って地図が出ないと、原因が集計の側にあると読まれる。
    script.onerror = () => {
      // **失敗した Promise を残さない。**残すと、一度でも読み込みに失敗した画面は
      // **再読み込みするまで永久に地図が出ない**——一時的な回線の途切れでもそうなる。
      loading = null;
      reject(new Error("地図を読み込めませんでした"));
    };
    document.head.appendChild(script);
  });

  return loading;
}
