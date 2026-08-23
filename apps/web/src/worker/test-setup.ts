import { applyD1Migrations, env } from "cloudflare:test";

// テスト用の D1 は空の状態で立ち上がるため、先にマイグレーションを当てる。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
