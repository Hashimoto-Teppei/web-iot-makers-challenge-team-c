// デッキをまとめてビルドし、入口ページ（dist/index.html）を作る。
//
// デッキの一覧はこのディレクトリの *.md を数えて決めている。
// package.json にデッキ名を書くと二重管理になり、増やしたときに必ず片方が古くなるため。
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// slidev の実行ファイルを node で直接動かす。
// node_modules/.bin/slidev を叩くと、Windows では .cmd を探しにいって失敗する。
const slidev = createRequire(import.meta.url).resolve("@slidev/cli/bin/slidev.mjs");

const decks = readdirSync(root)
  .filter((name) => name.endsWith(".md") && name !== "README.md")
  .map((name) => name.replace(/\.md$/, ""));

if (decks.length === 0) throw new Error("デッキが1つもない");

// 消したデッキの出力が残っていると、入口ページに死んだリンクが並ぶ。
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const deck of decks) {
  // --base が要る。付けないと配信先が /<deck>/ でも資産を /assets/... に取りにいき、
  // 真っ白な画面になる（--router-mode hash が直すのは経路であって資産の場所ではない）。
  execFileSync(
    process.execPath,
    [
      slidev,
      "build",
      `${deck}.md`,
      "--out",
      join(dist, deck),
      "--base",
      `/${deck}/`,
      "--router-mode",
      "hash",
    ],
    { cwd: root, stdio: "inherit" },
  );
}

// 見出しはデッキの headmatter の title: をそのまま使う（スライド側が正本）。
const links = decks
  .map((deck) => {
    const source = readFileSync(join(root, `${deck}.md`), "utf8");
    const title = source.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? deck;
    return `      <li><a href="./${deck}/">${title}</a></li>`;
  })
  .join("\n");

writeFileSync(
  join(dist, "index.html"),
  `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>チームC のスライド</title>
  </head>
  <body>
    <h1>チームC のスライド</h1>
    <ul>
${links}
    </ul>
  </body>
</html>
`,
);

console.log(`dist/index.html: ${decks.join(", ")}`);
