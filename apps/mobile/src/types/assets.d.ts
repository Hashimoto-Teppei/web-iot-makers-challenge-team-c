/**
 * Metro が資産として扱うファイルの型。
 *
 * `require()` / `import` が返すのは**資産の ID（数値）**で、中身ではない
 * （`expo-sqlite` の `assetSource.assetId` がこれを受け取る）。
 *
 * **`metro.config.js` の `assetExts` と対で意味を持つ。**片方だけ足すと、
 * 型は通るのにビルドで落ちる（またはその逆）。
 */
declare module "*.db" {
  const assetId: number;
  export default assetId;
}
