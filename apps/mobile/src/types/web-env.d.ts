/**
 * apps/web の Worker は Cloudflare が生成する global な `Env` 型（D1 などのバインディング）を使う。
 * モバイルは API の型（AppType）だけを借りるため、その定義を持っていない。
 *
 * Cloudflare の型一式をモバイルに読み込ませると、fetch や Response が React Native のものと
 * 衝突して収拾がつかなくなる。そこで中身のない `Env` をここで宣言して型解決だけ通す。
 * モバイルはバインディングを使わないので、中身は空で問題ない。
 *
 * **値を `unknown` ではなく `any` にしてある。**Worker のルートはバインディング
 * （D1・Durable Object）のメソッドを呼ぶので、`unknown` だとモバイル側の型チェックだけが
 * 落ちる。ここで正しい型を書き写すと、バインディングが増えるたびに二重管理になる。
 *
 * **バインディング名の綴り間違いは apps/web 側の型チェックが捕まえる**（あちらには
 * `worker-configuration.d.ts` が生成した本物の `Env` がある）ので、ここを厳しくしても
 * 二重に防げるだけである。**ただしルートの戻り値の型注釈だけは、こちらでは守れない**
 * （`apps/web/README.md`「型をモバイルと共有する」）。
 */
// biome-ignore lint/suspicious/noExplicitAny: 上記のとおり、意図的に型を捨てている
declare type Env = Record<string, any>;
