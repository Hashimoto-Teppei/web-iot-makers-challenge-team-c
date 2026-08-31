import { defineConfig } from "vitest/config";

// 検知（src/detect）もシミュレータ（#12）も、測位にも BLE にも触れない純粋な TypeScript
// なので、React Native のランタイムを立てずに Node 上でそのまま走らせる。
// 実機も Android エミュレータも要らない。
export default defineConfig({
  test: {
    // src 全体を見る。src/detect だけに絞ると、あとから src/sim などに置かれたテストが
    // 走らないまま CI が緑になる（CI の唯一の関門が turbo test であるため気づけない）。
    include: ["src/**/*.test.ts"],
    // 画面のテストだけは react-native の解決が要るのでここでは走らせない。
    // 書くときは、react-native のプリセットを持つ2つ目のプロジェクトを足すこと。
    exclude: ["src/app/**"],
  },
});
