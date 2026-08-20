import { mkdirSync, readFileSync } from "node:fs";
import type { ConversationMessage, ConversationPayload } from "../src/optimizer";
import { readCdx, readWarcResponse } from "./lib/wacz";
import { PRIVATE_WACZ_INDEX, PRIVATE_WARC_ARCHIVE, PRIVATE_EXTRACTED_DIR, requirePrivateCapture } from "./lib/private-paths";

requirePrivateCapture();

function traceActiveMessages(payload: ConversationPayload): ConversationMessage[] {
  if (!payload.mapping || typeof payload.current_node !== "string") {
    throw new Error("Conversation payload has no mapping/current_node");
  }
  const reverse: ConversationMessage[] = [];
  const seen = new Set<string>();
  let id: string | null | undefined = payload.current_node;
  while (id != null) {
    if (seen.has(id)) throw new Error(`Conversation cycle at ${id}`);
    seen.add(id);
    const node = payload.mapping[id];
    if (!node) throw new Error(`Missing node ${id}`);
    if (node.message) reverse.push(node.message);
    id = node.parent;
  }
  return reverse.reverse();
}

function textOf(message: ConversationMessage): string {
  const parts = message.content?.parts;
  if (Array.isArray(parts)) {
    return parts.filter((part): part is string => typeof part === "string").join("\n");
  }
  const text = message.content?.text;
  return typeof text === "string" ? text : "";
}

function countRichText(text: string) {
  return {
    chars: text.length,
    codeBlocks: Math.floor((text.match(/```/g) ?? []).length / 2),
    tableLines: (text.match(/^\s*\|.*\|\s*$/gm) ?? []).length,
    mathMarkers: (text.match(/\$\$|\\\[|\\begin\{/g) ?? []).length,
  };
}

const records = await readCdx(PRIVATE_WACZ_INDEX);
const record = records.find(
  (candidate) =>
    candidate.mime === "application/json" &&
    /\/backend-api\/conversation\/[0-9a-f-]{36}$/i.test(
      new URL(candidate.url).pathname,
    ),
);
if (!record) throw new Error("Captured conversation response not found");

const response = readWarcResponse(PRIVATE_WARC_ARCHIVE, record);
const payload = JSON.parse(response.body.toString("utf8")) as ConversationPayload;
const visibleRichMessages = traceActiveMessages(payload)
  .filter((message) => {
    if (message.metadata?.is_visually_hidden_from_conversation === true) return false;
    if (message.author?.role === "user") return true;
    return message.author?.role === "assistant" &&
      (message.channel === "final" || message.recipient === "all");
  })
  .map((message) => ({
    role: message.author?.role ?? "unknown",
    channel: message.channel ?? null,
    ...countRichText(textOf(message)),
  }))
  .filter((entry) => entry.codeBlocks > 0 || entry.tableLines > 0 || entry.mathMarkers > 0)
  .toSorted(
    (left, right) =>
      right.codeBlocks - left.codeBlocks ||
      right.tableLines - left.tableLines ||
      right.chars - left.chars,
  );

const smoothedSource = readFileSync(
  `${PRIVATE_EXTRACTED_DIR}/richtext/core-pretty/2afb55f3-lofadpw8ciylwivb.js`,
  "utf8",
);
const codeBlockSource = readFileSync(
  `${PRIVATE_EXTRACTED_DIR}/richtext/core-pretty/18e7d84e-j91l5tlq8s5au97e.js`,
  "utf8",
);
const editorSource = readFileSync(
  `${PRIVATE_EXTRACTED_DIR}/richtext/live-cdn-pretty/e4c59151-kd5paoudwul03tzc.js`,
  "utf8",
);
const smoothedCss = readFileSync(
  `${PRIVATE_EXTRACTED_DIR}/richtext/SmoothedMarkdown-3zguu66h.css`,
  "utf8",
);

const report = {
  capture: {
    visibleRichMessageCount: visibleRichMessages.length,
    topMessages: visibleRichMessages.slice(0, 5),
    maxCodeBlocksPerVisibleMessage: visibleRichMessages[0]?.codeBlocks ?? 0,
  },
  frontend: {
    smoothedMarkdownSyntheticTickMs: smoothedSource.includes("TP = 16") ? 16 : null,
    visibilityStateOnlyControlsSmoothing:
      (smoothedSource.match(/visibilityState/g) ?? []).length === 2,
    perSmoothedCodeBlockResizeObserver:
      smoothedSource.includes("new ResizeObserver") &&
      smoothedSource.includes("SmoothedCodeBlock"),
    zeroHeightStartingStyle:
      smoothedCss.includes("height:0") && smoothedCss.includes("opacity:0"),
    editorPaneMountedForInlineCode:
      codeBlockSource.includes("CodeBlockEditorPane") &&
      codeBlockSource.includes("ti = !B && (U || N)"),
    editorCreatesStateAndView:
      editorSource.includes("languageCompartmentInit") &&
      editorSource.includes("parent: e") &&
      editorSource.includes("r?.destroy()"),
  },
  fix: {
    bypassSyntheticMarkdownSmoothing: true,
    removeSmoothedCodeHeightAnimation: true,
    skipSmoothedCodeResizeObservers: true,
    richBlockContentVisibility: true,
    richBlockWarmDistancePx: 8000,
    codeEditorWarmDistancePx: 3000,
    warmTrigger: "requestAnimationFrame-distance-scan",
    deferCodeMirrorObserversUntilHot: true,
    codeMirrorActivationsPerAnimationFrame: 1,
    ordinaryRichBlockActivationsPerAnimationFrame: 3,
    warmedBlocksStayMaterialized: true,
  },
};

mkdirSync("analysis/output", { recursive: true });
await Bun.write(
  "analysis/output/richtext-analysis.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
