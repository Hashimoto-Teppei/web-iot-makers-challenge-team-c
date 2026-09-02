import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// テストは実際の Workers ランタイム（workerd）上で走らせる。
// Node 上で走らせると D1 などのバインディングを本番と同じ形で試せないため。
// マイグレーションの SQL を読み込み、テスト用の空の D1 に毎回適用する。
const migrations = await readD1Migrations("./drizzle/migrations");

export default defineConfig({
  test: {
    // 走る環境が違うので project を分ける。
    // workerd 上で動かすのは Worker のテストだけ。画面（src/client）のテストをここに含めると
    // DOM がないため react-dom の読み込みで落ちる。
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
          // 「どちらに書くか」を毎回考えることになる。
          include: ["src/worker/**/*.test.{ts,tsx}", "src/shared/**/*.test.{ts,tsx}"],
        },
      },
      {
        // 画面（src/client）のうち、**描画しないもの**——URL の読み書き（`route.ts`）など。
        // **`environment` は node のまま**にしてある。**コンポーネントを描いて確かめる
        // テストを書くときに jsdom を足す**（パッケージが1つ増えるので、要るまで入れない）。
        test: {
          name: "client",
          environment: "node",
          // **`.tsx` も拾う。**コンポーネントのテストはこの拡張子になるので、
          // `.ts` だけにすると**書いたテストが1つも走らないまま CI が緑になる。**
          include: ["src/client/**/*.test.{ts,tsx}"],
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
