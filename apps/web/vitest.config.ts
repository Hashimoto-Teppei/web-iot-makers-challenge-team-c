import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// テストは実際の Workers ランタイム（workerd）上で走らせる。
// Node 上で走らせると D1 などのバインディングを本番と同じ形で試せないため。
// マイグレーションの SQL を読み込み、テスト用の空の D1 に毎回適用する。
const migrations = await readD1Migrations("./drizzle/migrations");

export default defineConfig({
  test: {
    // 走る環境が2つあるので project を分ける。
    // workerd 上で動かすのは Worker のテストだけ。画面（src/client）のテストをここに含めると
    // DOM がないため react-dom の読み込みで落ちる。画面のテストを書くときは、
    // jsdom を使う3つ目の project を足すこと。
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
          }),
        ],
        test: {
          name: "worker",
          setupFiles: ["./src/worker/test-setup.ts"],
          include: ["src/worker/**/*.test.ts"],
        },
      },
      {
        // 取り込みスクリプト（scripts/）は開発機の Node で動くものなので、workerd では走らせない。
        test: {
          name: "scripts",
          environment: "node",
          include: ["scripts/**/*.test.ts"],
        },
      },
    ],
  },
});
