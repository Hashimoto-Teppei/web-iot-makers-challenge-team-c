// ビルドした dist/ の入口ページを作る。
// slidev はデッキごとに dist/<名前>/ を作るだけで、dist/ の直下には何も置かない。
//
// デッキの一覧をここに書かず、ビルド結果を読んで組み立てている。
// 書くと package.json の build スクリプトと二重管理になり、デッキを増やしたときに必ず片方が古くなる。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const decks = readdirSync(dist, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    // 見出しはデッキの headmatter の title: をそのまま使う（スライド側が正本）。
    const source = readFileSync(join(root, `${entry.name}.md`), "utf8");
    const title = source.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? entry.name;
    return { slug: entry.name, title };
  });

const links = decks
  .map((deck) => `      <li><a href="./${deck.slug}/">${deck.title}</a></li>`)
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

console.log(`dist/index.html: ${decks.map((deck) => deck.slug).join(", ")}`);
