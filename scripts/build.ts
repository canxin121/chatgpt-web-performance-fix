import { mkdirSync, rmSync } from "node:fs";

const VERSION = "0.1.0"; // Keep fixed unless the maintainer explicitly requests a change.

const header = `// ==UserScript==
// @name         ChatGPT Performance Fix
// @name:zh-CN   ChatGPT 性能优化
// @namespace    local.chatgpt.performance.fix
// @version      ${VERSION}
// @description  Improve ChatGPT performance on long conversations.
// @description:zh-CN 改善 ChatGPT 长会话性能。
// @author       Local
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==
`;

mkdirSync("dist", { recursive: true });
rmSync("dist/.build", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/chatgpt-performance-fix.user.ts"],
  outdir: "dist/.build",
  target: "browser",
  format: "iife",
  minify: false,
  sourcemap: "none",
});

if (!result.success || result.outputs.length !== 1) {
  for (const log of result.logs) console.error(log);
  throw new Error("Userscript build failed");
}

const bundled = await result.outputs[0].text();
await Bun.write("dist/chatgpt-performance-fix.user.js", `${header}\n${bundled}`);
rmSync("dist/.build", { recursive: true, force: true });

console.log(
  `Built dist/chatgpt-performance-fix.user.js (${(
    (header.length + bundled.length) /
    1024
  ).toFixed(1)} KiB)`,
);
