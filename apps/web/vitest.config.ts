import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// テストは実際の Workers ランタイム（workerd）上で走らせる。
// Node 上で走らせると D1 などのバインディングを本番と同じ形で試せないため。
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    // workerd 上で動かすのは Worker のテストだけ。画面（src/client）のテストをここに含めると
    // DOM がないため react-dom の読み込みで落ちる。画面のテストを書くときは、
    // jsdom を使う2つ目のプロジェクトを足すこと。
    include: ["src/worker/**/*.test.ts"],
  },
});
