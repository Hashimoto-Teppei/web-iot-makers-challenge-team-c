import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// cloudflare() が Worker を Vite の dev サーバー上で動かす。
// これにより画面（React）と API（Hono）が同じオリジンで開発できる。
export default defineConfig({
  plugins: [react(), cloudflare()],
});
