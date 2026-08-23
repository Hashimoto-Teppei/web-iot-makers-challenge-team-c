import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// vitest.config.ts からテスト用に渡すバインディング。
// テスト実行時にしか存在しないので、本体のコード（src/worker/index.ts）から参照しないこと。
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
