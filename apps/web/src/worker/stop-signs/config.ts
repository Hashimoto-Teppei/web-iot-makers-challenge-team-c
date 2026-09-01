/**
 * 一時停止の標識を配るときの設定値。**コードに直書きしない**（`CLAUDE.md`）。
 */

/** 都道府県コードの範囲（JIS X 0401。北海道 1 〜 沖縄県 47） */
export const PREF_CODE_MIN = 1;
export const PREF_CODE_MAX = 47;

/**
 * 岡山県。当面はこの県だけを取り込む（`docs/interfaces/mobile-api.md`）。
 * **API の引数には既定値を置かない**——県コードを必ず経路に載せるための器なので、
 * 省略できるようにすると「送っていないのに岡山が返る」実装が端末側に生まれる。
 */
export const PREF_OKAYAMA = 33;

/**
 * JARTIC の共通規制種別コードのうち「一旦停止」。抽出スクリプトが使う。
 * ここに置くのは、D1 に入るものが何かを Worker 側から辿れるようにするため。
 */
export const REGULATION_CODE_STOP = 63;
