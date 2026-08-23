import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// cloudflare() が Worker を Vite の dev サーバー上で動かす。
// これにより画面（React）と API（Hono）が同じオリジンで開発できる。
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    // 既定では IPv6 の [::1] だけで待ち受けるため、Android エミュレータの 10.0.2.2
    // （ホストの IPv4 ループバック）や実機の LAN 経由で届かない。
    // モバイルから API を叩けるようにするため、すべてのインターフェースで待ち受ける。
    //
    // これは開発サーバーと手元の D1 を同じネットワークの全員に公開することでもある。
    // 会場の共用 Wi-Fi では、機微なデータを手元の D1 に入れないこと。
    host: true,
  },
});
