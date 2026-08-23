/**
 * apps/web の Worker は Cloudflare が生成する global な `Env` 型（D1 などのバインディング）を使う。
 * モバイルは API の型（AppType）だけを借りるため、その定義を持っていない。
 *
 * Cloudflare の型一式をモバイルに読み込ませると、fetch や Response が React Native のものと
 * 衝突して収拾がつかなくなる。そこで中身のない `Env` をここで宣言して型解決だけ通す。
 * モバイルはバインディングを使わないので、中身は空で問題ない。
 */
declare type Env = Record<string, unknown>;
