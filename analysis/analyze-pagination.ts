import { mkdirSync } from "node:fs";
import {
  convertNativeInitialToLazyConversation,
  optimizePaginatedConversationPayload,
  splitPaginatedMessagesNewestFirst,
  type ConversationMessage,
  type ConversationPayload,
} from "../src/optimizer";
import { PRIVATE_WACZ_INDEX, PRIVATE_WARC_ARCHIVE, requirePrivateCapture } from "./lib/private-paths";
import { readCdx, readWarcResponse } from "./lib/wacz";

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
    if (!node) throw new Error(`Missing conversation node ${id}`);
    if (node.message) reverse.push(node.message);
    id = node.parent;
  }
  return reverse.reverse();
}

function groupTurns(messages: ConversationMessage[]): ConversationMessage[][] {
  const turns: ConversationMessage[][] = [];
  let current: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.author?.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
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
const turns = groupTurns(traceActiveMessages(payload));
const heaviestTurn = turns.toSorted((left, right) => right.length - left.length)[0];
if (!heaviestTurn || turns.length < 2) {
  throw new Error("Captured conversation does not contain enough turns");
}

const historical = optimizePaginatedConversationPayload(
  { messages: heaviestTurn },
  {
    recentFullTurns: 0,
    collapseTurnsToQuestionAnswer: true,
  },
);
const latestTurn = turns.at(-1)!;
const requiredLatestIds = new Set<string>();
if (typeof payload.current_node === "string") {
  requiredLatestIds.add(payload.current_node);
  const current = latestTurn.find((message) => message.id === payload.current_node);
  const parentId = current?.metadata?.parent_id;
  if (typeof parentId === "string") requiredLatestIds.add(parentId);
}
const lazyInitial = optimizePaginatedConversationPayload(
  {
    current_node: payload.current_node,
    async_status: null,
    messages: latestTurn,
    page_info: {
      has_previous_page: true,
      start_cursor: "captured-history-cursor",
    },
    moderation_results: payload.moderation_results ?? [],
    safe_urls: [],
    blocked_urls: [],
  },
  {
    recentFullTurns: 0,
    forceKeepMessageIds: requiredLatestIds,
    collapseTurnsToQuestionAnswer: true,
  },
);
const lazyEnvelope = convertNativeInitialToLazyConversation(
  lazyInitial.payload,
  String(payload.conversation_id ?? "captured-conversation"),
  2,
);
const initialMessages = [...turns.at(-2)!, ...turns.at(-1)!];
const initial = optimizePaginatedConversationPayload(
  { current_node: payload.current_node, messages: initialMessages },
  {
    recentFullTurns: 0,
    forceKeepMessageIds: requiredLatestIds,
    collapseTurnsToQuestionAnswer: true,
  },
);
const localPages = splitPaginatedMessagesNewestFirst(initial.payload.messages ?? [], {
  maxTurns: 1,
  maxMessages: 4,
  maxBytes: 48 * 1024,
  allowSplitTurns: false,
});
const historicalLocalPages = splitPaginatedMessagesNewestFirst(
  historical.payload.messages ?? [],
  {
    maxTurns: 1,
    maxMessages: 2,
    maxBytes: 32 * 1024,
    allowSplitTurns: false,
  },
);

const report = {
  trueLazyInitial: {
    legacyFullBytesAvoided: response.body.length,
    legacyFullMappingNodesAvoided: Object.keys(payload.mapping ?? {}).length,
    nativeRequestedTurns: 2,
    serverMessagesInLatestTurn: latestTurn.length,
    keptInitialMessages: lazyInitial.stats.keptMessages,
    lazyEnvelopeMappingNodes: Object.keys(lazyEnvelope?.mapping ?? {}).length,
    lazyCursorPreserved:
      lazyEnvelope?.__paginatedConversationPage.cursor === "captured-history-cursor",
    currentNodePreserved: lazyEnvelope?.current_node === payload.current_node,
  },
  historicalHeavyTurn: {
    ...historical.stats,
    byteReductionPercent:
      (1 - historical.stats.keptBytes / historical.stats.originalBytes) * 100,
    manualTurnPageMessageCounts: historicalLocalPages.map((page) => page.length),
  },
  initialTwoTurns: {
    ...initial.stats,
    byteReductionPercent:
      (1 - initial.stats.keptBytes / initial.stats.originalBytes) * 100,
    localPageMessageCounts: localPages.map((page) => page.length),
  },
  stockPagination: { rootMarginTopPx: 80 },
  balancedFix: {
    initialServerNumTurns: 2,
    olderServerNumTurns: 2,
    historyTrigger: "manual-button",
    automaticHistoryOnScroll: false,
    localRenderTurns: 1,
    historyUnit: "one-user-question-plus-one-ai-answer",
    transportWindowStartsAt: 2,
    fragmentedTurnCursorCompletion: true,
    preserveTurnAtomicity: true,
    minimumIdleBudgetMsBeforeCommit: 12,
  },
};

mkdirSync("analysis/output", { recursive: true });
await Bun.write(
  "analysis/output/pagination-analysis.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
