// Metro（React Native のバンドラ）の設定。
//
// **`db` を資産として扱えるようにする。**同梱した `assets/signs.db` を
// `import` で読み込むために要る（`src/signs/expo.ts`。
// `docs/adr/0009-on-device-storage.md`）。足さないと **Metro が
// 「JavaScript として読めない」と言って落ちる。**
//
// **`json` は足さない。**足すとリポジトリ内の全 JSON の import 挙動が変わる
// （同 ADR「4」で JSON を同梱しないと決めた理由の1つ）。
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("db");

module.exports = config;
