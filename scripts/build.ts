import { mkdirSync, rmSync } from "node:fs";

const VERSION = "0.1.1"; // Keep fixed unless the maintainer explicitly requests a change.

const header = `// ==UserScript==
// @name         ChatGPT Performance Fix
// @name:zh-CN   ChatGPT 性能优化
// @namespace    https://github.com/canxin121
// @version      ${VERSION}
// @description  Improve ChatGPT performance on long conversations.
// @description:zh-CN 改善 ChatGPT 长会话性能。
// @author       canxin
// @homepageURL  https://github.com/canxin121/chatgpt-web-performance-fix
// @supportURL   https://github.com/canxin121/chatgpt-web-performance-fix/issues
// @updateURL    https://raw.githubusercontent.com/canxin121/chatgpt-web-performance-fix/main/dist/chatgpt-performance-fix.user.js
// @downloadURL  https://raw.githubusercontent.com/canxin121/chatgpt-web-performance-fix/main/dist/chatgpt-performance-fix.user.js
// @match        https://chatgpt.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==
`;

mkdirSync("dist", { recursive: true });
rmSync("dist/.build", { recursive: true, force: true });
rmSync("dist/.worker", { recursive: true, force: true });

const workerResult = await Bun.build({
  entrypoints: ["src/optimizer-worker.ts"],
  outdir: "dist/.worker",
  target: "browser",
  format: "iife",
  minify: true,
  sourcemap: "none",
});
if (!workerResult.success || workerResult.outputs.length !== 1) {
  for (const log of workerResult.logs) console.error(log);
  throw new Error("Optimizer worker build failed");
}
const optimizerWorkerSource = await workerResult.outputs[0].text();

const result = await Bun.build({
  entrypoints: ["src/chatgpt-performance-fix.user.ts"],
  outdir: "dist/.build",
  target: "browser",
  format: "iife",
  minify: false,
  sourcemap: "none",
  define: {
    __CHATGPT_OPTIMIZER_WORKER_SOURCE__: JSON.stringify(optimizerWorkerSource),
  },
});

if (!result.success || result.outputs.length !== 1) {
  for (const log of result.logs) console.error(log);
  throw new Error("Userscript build failed");
}

const bundled = await result.outputs[0].text();
await Bun.write("dist/chatgpt-performance-fix.user.js", `${header}\n${bundled}`);
rmSync("dist/.build", { recursive: true, force: true });
rmSync("dist/.worker", { recursive: true, force: true });

console.log(
  `Built dist/chatgpt-performance-fix.user.js (${(
    (header.length + bundled.length) /
    1024
  ).toFixed(1)} KiB)`,
);
