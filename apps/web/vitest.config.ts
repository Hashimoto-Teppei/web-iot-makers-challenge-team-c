import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// テストは実際の Workers ランタイム（workerd）上で走らせる。
// Node 上で走らせると D1 などのバインディングを本番と同じ形で試せないため。
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
