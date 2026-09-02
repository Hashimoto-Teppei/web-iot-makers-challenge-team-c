/// <reference types="vite/client" />

/**
 * 画面に渡る環境変数。**`VITE_` で始まるものはバンドルに埋め込まれ、利用者が読める**
 * （`CLAUDE.md`「機密情報の扱い」）。**ここに秘密を増やさないこと。**
 */
interface ImportMetaEnv {
  /**
   * Google Maps の JavaScript API の鍵。**未設定なら地図の代わりに案内が出る。**
   *
   * 実値はコミットしない（ローカルは `apps/web/.env`。`.env.example` を写して作る）。
   */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
