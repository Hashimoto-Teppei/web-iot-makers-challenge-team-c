import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// テストは実際の Workers ランタイム（workerd）上で走らせる。
// Node 上で走らせると D1 などのバインディングを本番と同じ形で試せないため。
// マイグレーションの SQL を読み込み、テスト用の空の D1 に毎回適用する。
const migrations = await readD1Migrations("./drizzle/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["./src/worker/test-setup.ts"],
    // workerd 上で動かすのは Worker のテストだけ。画面（src/client）のテストをここに含めると
    // DOM がないため react-dom の読み込みで落ちる。画面のテストを書くときは、
    // jsdom を使う2つ目のプロジェクトを足すこと。
    include: ["src/worker/**/*.test.ts"],
  },
});
