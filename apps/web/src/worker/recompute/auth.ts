/**
 * 管理用の共有トークンの検証。
 *
 * **書き込みに認証を置かないと決めているのに、この1本だけ守るのは壊せる範囲が違うから**である
 * （`docs/interfaces/web-stats.md`「いつ計算するか」）。`POST /api/logs` で壊せるのは
 * **足された行だけ**（既にある行は上書きも削除もできない）だが、
 * **再計算は既存の行を丸ごと置き換える。しかも重い**——誰でも叩ければ、
 * **それだけで D1 の読み取りを使い切れる。**
 *
 * トークンは `wrangler secret put ADMIN_TOKEN` で登録する。**`wrangler.jsonc` に書かない**
 * （`CLAUDE.md`「機密情報の扱い」）。ローカルは `.dev.vars`。
 */

/**
 * 長さと中身を、**先に違いが見つかっても打ち切らずに**比べる。
 *
 * 早く返す実装だと、**一致した文字数が応答時間に出る**（1文字ずつ試して総当たりできる）。
 * `crypto.subtle.timingSafeEqual` は Workers にあるが、**長さが違うと例外を投げる**ため、
 * 長さの違いを自分で潰す必要があり、結局この形になる。
 */
function equals(a: string, b: string): boolean {
  // **長さの違いは隠せない**（隠すには固定長へ伸ばす必要があり、トークンの長さは秘密ではない）。
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `Authorization: Bearer <token>` からトークンを取り出す。無ければ `null`。 */
function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

/** 認証の結果。**「合っていない」と「そもそも設定されていない」を混ぜない。** */
export type AuthResult = "ok" | "unauthorized" | "not-configured";

/**
 * 管理用のリクエストを通してよいか。
 *
 * **`ADMIN_TOKEN` が未設定なら通さない。**空の秘密値を「認証なし」として扱うと、
 * **設定を忘れたデプロイが誰でも叩ける再計算の口になる。**
 * 401 ではなく分けて返すのは、**叩く側が「トークンが違う」と「サーバーの設定漏れ」を
 * 取り違えると、正しいトークンを探して延々と試すことになる**ため。
 */
export function authorize(expected: string | undefined, header: string | undefined): AuthResult {
  if (!expected || expected.length === 0) return "not-configured";
  const given = bearerOf(header);
  if (given === null) return "unauthorized";
  return equals(expected, given) ? "ok" : "unauthorized";
}
