import { defineConfig } from "drizzle-kit";

// スキーマから SQL のマイグレーションを生成するための設定。
// 適用（apply）は wrangler が行うため、ここに Cloudflare の認証情報は要らない。
export default defineConfig({
  schema: "./src/worker/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
});
