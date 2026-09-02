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
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                // 管理用の共有トークン。**テストの中だけの値**で、実物とは関係がない
                // （実物は `wrangler secret put`、ローカルは `.dev.vars`）。
                ADMIN_TOKEN: "test-admin-token",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          setupFiles: ["./src/worker/test-setup.ts"],
          // **`src/shared/` のテストもここで回す。**中身は純粋な TypeScript なので
          // workerd の上でも素の Node でも同じように動くが、**project を増やすと
          // 「どちらに書くか」を毎回考えることになる。**画面のテストを書くときだけ、
          // jsdom を使う3つ目の project を足す。
          include: ["src/worker/**/*.test.ts", "src/shared/**/*.test.ts"],
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
