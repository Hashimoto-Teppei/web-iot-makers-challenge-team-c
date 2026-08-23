#!/usr/bin/env node
// PR を出す前にコードレビューを回し忘れないためのフック。
//
// `gh pr create` を実行しようとしたとき、いま HEAD にあるコミットに対して
// レビュー済みの印がなければ止める。印は `--mark` を付けて実行すると付く。
//
// 仕組み上、印は自己申告でしかない（回さずに印だけ付けることもできてしまう）。
// 不正を防ぐものではなく、「忘れる」ことを防ぐためのもの。
//
// Windows / macOS のどちらでも動くよう Node で書いている（シェルスクリプトにしない）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function markerPathForHead() {
  // .git の中に置くのでコミットされない。クローンごと・コミットごとに独立する。
  const gitDir = git("rev-parse", "--absolute-git-dir");
  const head = git("rev-parse", "HEAD");
  return {
    dir: join(gitDir, "claude-code-review"),
    file: join(gitDir, "claude-code-review", head),
    head,
  };
}

function mark() {
  const { dir, file, head } = markerPathForHead();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${new Date().toISOString()}\n`);
  console.log(`レビュー済みとして記録しました: ${head.slice(0, 7)}`);
}

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv.includes("--mark")) {
  mark();
  process.exit(0);
}

const raw = await readStdin();
let input;
try {
  input = JSON.parse(raw);
} catch {
  allow(); // 入力が読めないときは止めない（開発を止めるほうが害が大きい）
}

if (input.tool_name !== "Bash") allow();

const command = input.tool_input?.command ?? "";
// `gh pr create` 以外は素通しする。--dry-run のような確認は妨げない。
if (!/\bgh\s+pr\s+create\b/.test(command) || command.includes("--dry-run")) allow();

let marker;
try {
  marker = markerPathForHead();
} catch {
  allow(); // git リポジトリでなければ関係ない
}

if (existsSync(marker.file)) allow();

deny(
  [
    `PR を出す前にコードレビューを回してください（現在の HEAD ${marker.head.slice(0, 7)} は未レビューです）。`,
    "",
    "手順:",
    "1. /code-review を実行する（引数なしで現在の差分が対象）",
    "2. 指摘を直してコミットする",
    "3. `node .claude/hooks/require-code-review.mjs --mark` でレビュー済みの印を付ける",
    "4. もう一度 `gh pr create` を実行する",
    "",
    "印はコミットごとに必要です（3 のあとに新しくコミットしたら、もう一度 3 を実行してください）。",
  ].join("\n"),
);
