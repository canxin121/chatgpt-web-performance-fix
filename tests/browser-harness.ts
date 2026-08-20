import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage } from "../src/optimizer";
import { hasPrivateCapture } from "../analysis/lib/private-paths";
import { loadCapturedConversation, traceActivePath } from "./helpers";

if (!hasPrivateCapture()) {
  console.log("Skipping browser capture regression: .private capture data is not available.");
  process.exit(0);
}

const chrome =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const userscript = readFileSync("dist/chatgpt-performance-fix.user.js");
const { payload, text: conversationText } = await loadCapturedConversation();
const conversationId = "33333333-3333-4333-8333-333333333333";
const conversationPath = `/backend-api/conversation/${conversationId}`;
const lazyInitialPath = `/backend-api/conversations/${conversationId}`;
const lazyMessagesPath = `${lazyInitialPath}/messages`;
const asyncConversationPath =
  "/backend-api/conversations/11111111-1111-4111-8111-111111111111";
const fallbackConversationId = "55555555-5555-4555-8555-555555555555";
const fallbackConversationPath =
  `/backend-api/conversation/${fallbackConversationId}`;
const emptyConversationId = "44444444-4444-4444-8444-444444444444";
const emptyConversationPath = `/backend-api/conversation/${emptyConversationId}`;
const emptyInitialPath = `/backend-api/conversations/${emptyConversationId}`;
const emptyMessagesPath = `${emptyInitialPath}/messages`;
const rateLimitedConversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rateLimitedConversationPath =
  `/backend-api/conversation/${rateLimitedConversationId}`;
const rateLimitedInitialPath =
  `/backend-api/conversations/${rateLimitedConversationId}`;
const metadataConversationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const metadataInitialPath =
  `/backend-api/conversations/${metadataConversationId}`;
const metadataUserMessageId = "c0000000-0000-4000-8000-000000000001";
const metadataAssistantMessageId = "c0000000-0000-4000-8000-000000000002";
const metadataUserCreateTime = 1_787_244_123.456;
const metadataAssistantCreateTime = 1_787_244_130.789;
const metadataMessages: ConversationMessage[] = [
  {
    id: metadataUserMessageId,
    author: { role: "user" },
    content: { content_type: "text", parts: ["metadata display question"] },
    create_time: metadataUserCreateTime,
    update_time: null,
    status: "finished_successfully",
  },
  {
    id: metadataAssistantMessageId,
    author: { role: "assistant" },
    content: { content_type: "text", parts: ["metadata display answer"] },
    create_time: metadataAssistantCreateTime,
    update_time: null,
    status: "finished_successfully",
    recipient: "all",
    channel: "final",
    metadata: {
      resolved_model_slug: "gpt-5-6-thinking",
      model_slug: "gpt-5-6-pro",
      default_model_slug: "gpt-5-6-pro",
    },
  },
];
const asyncCurrentMessageId = "11111111-1111-4111-8111-111111111112";
const asyncProgressMessages: ConversationMessage[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    author: { role: "user" },
    content: { content_type: "text", parts: ["active progress question"] },
    status: "finished_successfully",
  },
  {
    id: asyncCurrentMessageId,
    author: { role: "assistant" },
    content: { content_type: "text", parts: ["active progress 0"] },
    status: "in_progress",
    recipient: "all",
    channel: "final",
  },
];
const fallbackConversationText = JSON.stringify({
  ...payload,
  conversation_id: fallbackConversationId,
});
const activeMessages = traceActivePath(payload)
  .map(({ node }) => node.message)
  .filter((message): message is ConversationMessage => message != null);
const activeTurns: ConversationMessage[][] = [];
let currentTurn: ConversationMessage[] = [];
for (const message of activeMessages) {
  if (message.author?.role === "user" && currentTurn.length > 0) {
    activeTurns.push(currentTurn);
    currentTurn = [];
  }
  currentTurn.push(message);
}
if (currentTurn.length > 0) activeTurns.push(currentTurn);
const lazyInitialMessages = activeTurns.at(-1)!;
const lazyOlderMessages = activeTurns.at(-2)!;

const nativeConversationId = "22222222-2222-4222-8222-222222222222";
const nativeInitialPath = `/backend-api/conversations/${nativeConversationId}`;
const nativeMessagesPath = `${nativeInitialPath}/messages`;
const nativeInitialMessages = [
  ...activeTurns.at(-2)!,
  ...activeTurns.at(-1)!,
];
const nativeOlderMessages = activeTurns.toSorted(
  (left, right) => right.length - left.length,
)[0]!;
const codeBlockCount = (messages: ConversationMessage[]) =>
  messages.reduce((sum, message) => {
    const text = Array.isArray(message.content?.parts)
      ? message.content.parts.filter((part): part is string => typeof part === "string").join("\n")
      : "";
    return sum + Math.floor((text.match(/```/g) ?? []).length / 2);
  }, 0);
const nativeRichMessages = activeTurns.toSorted(
  (left, right) => codeBlockCount(right) - codeBlockCount(left),
)[0]!;
const richConversationId = "55555555-5555-4555-8555-555555555555";
const richMessagesPath = `/backend-api/conversations/${richConversationId}/messages`;
const statusHistoryConversationId = "66666666-6666-4666-8666-666666666666";
const statusHistoryMessagesPath =
  `/backend-api/conversations/${statusHistoryConversationId}/messages`;
const statusHistoryAsyncPath =
  `/backend-api/conversation/${statusHistoryConversationId}/async-status`;
const exactManualConversationId = "99999999-9999-4999-8999-999999999999";
const exactManualMessagesPath =
  `/backend-api/conversations/${exactManualConversationId}/messages`;
const exactManualMessages: ConversationMessage[] = [
  {
    id: "90000000-0000-4000-8000-000000000001",
    author: { role: "user" },
    content: { content_type: "text", parts: ["exact manual question one"] },
    status: "finished_successfully",
  },
  {
    id: "90000000-0000-4000-8000-000000000002",
    author: { role: "assistant" },
    content: { content_type: "text", parts: ["exact manual answer one"] },
    status: "finished_successfully",
    recipient: "all",
    channel: "final",
  },
  {
    id: "90000000-0000-4000-8000-000000000003",
    author: { role: "user" },
    content: { content_type: "text", parts: ["exact manual question two"] },
    status: "finished_successfully",
  },
  {
    id: "90000000-0000-4000-8000-000000000004",
    author: { role: "assistant" },
    content: { content_type: "text", parts: ["exact manual answer two"] },
    status: "finished_successfully",
    recipient: "all",
    channel: "final",
  },
];
const currentAsyncStatusPath = `/backend-api/conversation/${conversationId}/async-status`;
const sendPath = "/backend-api/f/conversation";
const resumePath = "/backend-api/f/conversation/resume";
const authSeedPath = "/backend-api/auth-seed";
const harnessAuthHeader = "Bearer harness-request-context";
const sentMessageId = "77777777-7777-4777-8777-777777777777";
const sentMessageText = "browser harness persistence probe";
const sentMessageCreateTime = 1_787_244_200.125;
const sentAssistantMessageId = "88888888-8888-4888-8888-888888888888";
const sentAssistantCreateTime = 1_787_244_202.875;
const statusHistoryMessages = [
  ...activeTurns.at(-3)!,
  ...activeTurns.at(-2)!,
];
let conversationGets = 0;
let asyncConversationGets = 0;
let fallbackLegacyGets = 0;
let emptyLegacyGets = 0;
let emptyInitialGets = 0;
let emptyMessagesGets = 0;
let lazyInitialGets = 0;
let lazyMessagesGets = 0;
let nativeInitialGets = 0;
let nativeMessagesGets = 0;
let richMessagesGets = 0;
let statusHistoryMessagesGets = 0;
let statusMutationPosts = 0;
let sidebarListGets = 0;
let sendPosts = 0;
let resumePosts = 0;
let unauthorizedProbeGets = 0;
let authenticatedSidebarListProbeGets = 0;
let authenticatedSidebarDetailProbeGets = 0;
let authenticatedPersistenceProbeGets = 0;
let exactManualHistoryGets = 0;
const exactManualHistoryNumTurns: string[] = [];
let rateLimitedLegacyGets = 0;
let rateLimitedInitialGets = 0;
let metadataInitialGets = 0;
const rateLimitedInitialNumTurns: string[] = [];
let sentMessagePersisted = false;
let sidebarAsyncStatus: unknown = 3;
const deliveryIncludeMessageIds: string[] = [];
const lazyInitialNumTurns: string[] = [];
const lazyMessagesNumTurns: string[] = [];
const nativeInitialNumTurns: string[] = [];
const nativeMessagesNumTurns: string[] = [];
let mutations = 0;

function harnessHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>ChatGPT performance-fix browser harness</title>
    <script>
      window.__capturedNativeFetch = window.fetch.bind(window);
      window.__richNativeResizeObserveCalls = 0;
      window.__richNativeIntersectionObserveCalls = 0;
      window.__gmMenuCommands = [];
      window.GM_registerMenuCommand = (label, callback) => {
        window.__gmMenuCommands.push({ label, callback });
        return label;
      };
      const HarnessNativeIntersectionObserver = window.IntersectionObserver;
      window.IntersectionObserver = class HarnessCountingIntersectionObserver extends HarnessNativeIntersectionObserver {
        observe(target) {
          window.__richNativeIntersectionObserveCalls += 1;
          return super.observe(target);
        }
      };
      const HarnessNativeResizeObserver = window.ResizeObserver;
      window.ResizeObserver = class HarnessCountingResizeObserver extends HarnessNativeResizeObserver {
        observe(target, options) {
          window.__richNativeResizeObserveCalls += 1;
          return super.observe(target, options);
        }
      };
    </script>
    <script src="/userscript.js"></script>
  </head>
  <body>
    <nav id="sidebar-harness">
      <a id="sidebar-conversation" href="/c/${conversationId}">
        <span class="truncate">stale sidebar title</span>
      </a>
    </nav>
    <pre id="status">running</pre>
    <script type="module">
      const endpoint = ${JSON.stringify(conversationPath)};
      const asyncEndpoint = ${JSON.stringify(asyncConversationPath)};
      const fallbackEndpoint = ${JSON.stringify(fallbackConversationPath)};
      const emptyEndpoint = ${JSON.stringify(emptyConversationPath)};
      const rateLimitedEndpoint = ${JSON.stringify(rateLimitedConversationPath)};
      const metadataEndpoint = ${JSON.stringify(metadataInitialPath)};
      const lazyMessagesEndpoint = ${JSON.stringify(lazyMessagesPath)};
      const nativeInitialEndpoint = ${JSON.stringify(nativeInitialPath)};
      const nativeMessagesEndpoint = ${JSON.stringify(nativeMessagesPath)};
      const richMessagesEndpoint = ${JSON.stringify(richMessagesPath)};
      const statusHistoryMessagesEndpoint = ${JSON.stringify(statusHistoryMessagesPath)};
      const statusHistoryAsyncEndpoint = ${JSON.stringify(statusHistoryAsyncPath)};
      const exactManualMessagesEndpoint = ${JSON.stringify(exactManualMessagesPath)};
      const currentAsyncStatusEndpoint = ${JSON.stringify(currentAsyncStatusPath)};
      const sendEndpoint = ${JSON.stringify(sendPath)};
      const resumeEndpoint = ${JSON.stringify(resumePath)};
      const authSeedEndpoint = ${JSON.stringify(authSeedPath)};
      const harnessAuthHeader = ${JSON.stringify(harnessAuthHeader)};
      const sentProbeMessageId = ${JSON.stringify(sentMessageId)};
      const sentProbeMessageText = ${JSON.stringify(sentMessageText)};
      const sentProbeCreateTime = ${JSON.stringify(sentMessageCreateTime)};
      const sentReplyMessageId = ${JSON.stringify(sentAssistantMessageId)};
      const sentReplyCreateTime = ${JSON.stringify(sentAssistantCreateTime)};
      const metadataUserId = ${JSON.stringify(metadataUserMessageId)};
      const metadataAssistantId = ${JSON.stringify(metadataAssistantMessageId)};
      const metadataUserTime = ${JSON.stringify(metadataUserCreateTime)};
      const metadataAssistantTime = ${JSON.stringify(metadataAssistantCreateTime)};
      const expectedCurrentNode = ${JSON.stringify(payload.current_node)};

      function visibleTranscriptRoles(messages) {
        return messages
          .filter((message) => {
            if (message?.author?.role === "user") return true;
            if (message?.author?.role !== "assistant") return false;
            if (message?.recipient != null && message.recipient !== "all") return false;
            const type = message?.content?.content_type;
            return !["code", "execution_output", "thoughts", "reasoning_recap"].includes(
              String(type ?? ""),
            );
          })
          .map((message) => message.author.role);
      }

      function mappingMessages(mapping) {
        return Object.values(mapping ?? {})
          .map((node) => node?.message)
          .filter(Boolean);
      }

      function publish(value) {
        const json = JSON.stringify(value);
        const bytes = new TextEncoder().encode(json);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        const meta = document.createElement("meta");
        meta.name = "harness-result";
        meta.content = btoa(binary);
        document.head.append(meta);
        document.querySelector("#status").textContent = json;
        document.documentElement.dataset.harnessDone = "true";
      }

      try {
        const normalVisibilityState = document.visibilityState;
        const authSeedResponse = await fetch(authSeedEndpoint, {
          headers: {
            authorization: harnessAuthHeader,
            "chatgpt-account-id": "harness-account",
            "oai-device-id": "harness-device",
            "oai-session-id": "harness-session",
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        const backendRequestContextCaptured =
          authSeedResponse.ok &&
          document.documentElement.dataset.chatgptBackendRequestContextReady === "true";
        await new Promise((resolve) => setTimeout(resolve, 200));
        const idleStatsBefore = await fetch("/stats").then((response) => response.json());
        await new Promise((resolve) => setTimeout(resolve, 2_800));
        const idleStatsAfter = await fetch("/stats").then((response) => response.json());
        const noAutomaticSidebarRequests =
          idleStatsBefore.authenticatedSidebarListProbeGets === 0 &&
          idleStatsBefore.authenticatedSidebarDetailProbeGets === 0 &&
          idleStatsAfter.authenticatedSidebarListProbeGets === 0 &&
          idleStatsAfter.authenticatedSidebarDetailProbeGets === 0;
        const idleSidebarDetailDidNotRepeat =
          idleStatsAfter.authenticatedSidebarDetailProbeGets ===
          idleStatsBefore.authenticatedSidebarDetailProbeGets;
        const idleSidebarListDidNotRepeatAtLegacyCadence =
          idleStatsAfter.authenticatedSidebarListProbeGets ===
          idleStatsBefore.authenticatedSidebarListProbeGets;
        const smoothedVisibilityState = (
          await import("/cdn/assets/2afb55f3-harness.js")
        ).readVisibilityState();
        const smoothedMarkdownBypass =
          document.documentElement.dataset.chatgptSmoothedMarkdownBypass;

        // Simulate ChatGPT capturing the original fetch before the userscript
        // replaces window.fetch. Response.prototype must still compact the full
        // legacy payload before the application receives JSON/text.
        const fallbackFirstResponse = await window.__capturedNativeFetch(
          fallbackEndpoint,
          { cache: "no-store" },
        );
        const fallbackFirst = await fallbackFirstResponse.json();
        const fallbackSecondResponse = await window.__capturedNativeFetch(
          fallbackEndpoint,
          { cache: "no-store" },
        );
        const fallbackSecond = await fallbackSecondResponse.json();
        const fallbackTextResponse = await window.__capturedNativeFetch(
          fallbackEndpoint,
          { cache: "no-store" },
        );
        const fallbackTextPayload = JSON.parse(await fallbackTextResponse.text());
        const fallbackResponseHook =
          document.documentElement.dataset.chatgptResponseFallback;
        const fallbackOptimizedCount = Number(
          document.documentElement.dataset.chatgptLegacyFallbackOptimized ?? "0",
        );
        const fallbackCacheHits = Number(
          document.documentElement.dataset.chatgptLegacyFallbackCacheHits ?? "0",
        );
        const fallbackOriginalNodes = Number(
          document.documentElement.dataset.chatgptLegacyFallbackOriginalNodes ?? "0",
        );
        const fallbackKeptNodes = Number(
          document.documentElement.dataset.chatgptLegacyFallbackKeptNodes ?? "0",
        );

        const [firstResponse, secondResponse] = await Promise.all([
          fetch(endpoint),
          fetch(endpoint),
        ]);
        const [first, second] = await Promise.all([
          firstResponse.json(),
          secondResponse.json(),
        ]);
        const thirdResponse = await fetch(endpoint);
        const third = await thirdResponse.json();
        const nativeDateNow = Date.now;
        let hourLaterResponse;
        let hourLater;
        try {
          Date.now = () => nativeDateNow() + 60 * 60 * 1_000;
          hourLaterResponse = await fetch(endpoint);
          hourLater = await hourLaterResponse.json();
        } finally {
          Date.now = nativeDateNow;
        }
        const hourLaterInitialSnapshotHeader = hourLaterResponse.headers.get(
          "x-chatgpt-performance-fix-initial-snapshot",
        );
        const hourLaterCurrentNodePreserved =
          hourLater.current_node === expectedCurrentNode;
        const afterOpen = await fetch("/stats").then((response) => response.json());

        const lazyCursor = first.__paginatedConversationPage?.cursor;
        const lazyOlderUrl =
          lazyMessagesEndpoint +
          "?before=" +
          encodeURIComponent(lazyCursor) +
          "&include_has_versions=true&num_turns=20";
        const lazyOlderResponse = await fetch(lazyOlderUrl);
        const lazyOlder = await lazyOlderResponse.json();

        const beforeMutation = await fetch("/stats").then((response) => response.json());

        await fetch(endpoint, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const fourthResponse = await fetch(endpoint);
        const fourth = await fourthResponse.json();
        const postMutationSnapshotRefreshed =
          first.server_revision === 0 && fourth.server_revision === 1;

        const asyncRequestUrl =
          asyncEndpoint + "?include_has_versions=true&num_turns=2";
        const asyncFirstResponse = await fetch(asyncRequestUrl);
        const asyncFirst = await asyncFirstResponse.json();
        const asyncSecondResponse = await fetch(asyncRequestUrl);
        const asyncSecond = await asyncSecondResponse.json();
        const asyncFinishedResponse = await fetch(asyncRequestUrl);
        const asyncFinished = await asyncFinishedResponse.json();
        const asyncPinnedResponse = await fetch(asyncRequestUrl);
        const asyncPinned = await asyncPinnedResponse.json();
        const asyncFirstText = asyncFirst.messages?.[1]?.content?.parts?.[0] ?? "";
        const asyncSecondText = asyncSecond.messages?.[1]?.content?.parts?.[0] ?? "";
        const activeSequentialProgressFresh =
          asyncFirst.progress_revision === 1 &&
          asyncSecond.progress_revision === 2 &&
          asyncFirstText === "active progress 1" &&
          asyncSecondText === "active progress 2";
        const activeResponsesMarkedLive =
          asyncFirstResponse.headers.get("x-chatgpt-performance-fix-active") === "1" &&
          asyncSecondResponse.headers.get("x-chatgpt-performance-fix-active") === "1";
        const activeResponsesNotSnapshotted =
          asyncFirstResponse.headers.get("x-chatgpt-performance-fix-initial-snapshot") == null &&
          asyncSecondResponse.headers.get("x-chatgpt-performance-fix-initial-snapshot") == null;
        const completedActiveConversationPinned =
          asyncFinished.progress_revision === 3 &&
          asyncFinishedResponse.headers.get("x-chatgpt-performance-fix-active") === "0" &&
          asyncPinned.progress_revision === 3 &&
          asyncPinnedResponse.headers.get("x-chatgpt-performance-fix-initial-snapshot") === "hit";

        // A 429 from the lightweight initial endpoint must be retained for
        // Retry-After. Revalidation must neither hit it again nor fall back to
        // the legacy full-conversation endpoint.
        const rateLimitedFirstResponse = await fetch(rateLimitedEndpoint);
        const rateLimitedSecondResponse = await fetch(rateLimitedEndpoint);
        const rateLimitedFirstStatus = rateLimitedFirstResponse.status;
        const rateLimitedSecondStatus = rateLimitedSecondResponse.status;
        const rateLimitedSnapshotHeader = rateLimitedSecondResponse.headers.get(
          "x-chatgpt-performance-fix-initial-snapshot",
        );

        const emptyResponse = await fetch(emptyEndpoint);
        const emptyLazy = await emptyResponse.json();

        const nativeInitialUrl =
          nativeInitialEndpoint + "?include_has_versions=true&num_turns=20";
        const nativeInitialRequest = new Request(nativeInitialUrl, {
          headers: { "x-harness-request-object": "1" },
        });
        const nativeInitialResponse = await fetch(nativeInitialRequest);
        const nativeInitial = await nativeInitialResponse.json();

        const localCursor = nativeInitial.page_info.start_cursor;
        const nativeLocalUrl =
          nativeMessagesEndpoint +
          "?before=" +
          encodeURIComponent(localCursor) +
          "&include_has_versions=true&num_turns=20";
        let paintOccurredBeforeLocalResponse = false;
        let userTaskRanBeforeLocalHistory = false;
        requestAnimationFrame(() => {
          paintOccurredBeforeLocalResponse = true;
        });
        setTimeout(() => {
          userTaskRanBeforeLocalHistory = true;
        }, 0);
        const nativeLocalResponse = await fetch(nativeLocalUrl);
        const nativeLocal = await nativeLocalResponse.json();

        const nativeOlderResponse = nativeLocalResponse;
        const nativeOlder = nativeLocal;
        await new Promise((resolve) => setTimeout(resolve, 60));
        const settledSignalsBeforeCachedHistory = Number(
          document.documentElement.dataset.chatgptHistorySettledSignals ?? "0",
        );
        const nativeRequestIdleCallback = window.requestIdleCallback;
        const forcedIdleBefore = Number(
          document.documentElement.dataset.chatgptHistoryIdleForced ?? "0",
        );
        window.requestIdleCallback = (callback) => {
          return setTimeout(() => {
            callback({
              didTimeout: false,
              timeRemaining: () => 0,
            });
          }, 0);
        };
        const cachedHistoryStartedAt = performance.now();
        const nativeOlderCachedResponse = await fetch(nativeLocalUrl);
        const nativeOlderCached = await nativeOlderCachedResponse.json();
        const cachedHistoryElapsedMs = performance.now() - cachedHistoryStartedAt;
        window.requestIdleCallback = nativeRequestIdleCallback;
        await new Promise((resolve) => setTimeout(resolve, 80));
        const cachedHistoryCompletionSignal =
          Number(document.documentElement.dataset.chatgptHistorySettledSignals ?? "0") >
          settledSignalsBeforeCachedHistory;
        const historyIdleWaitForcedButBounded =
          Number(document.documentElement.dataset.chatgptHistoryIdleForced ?? "0") >
            forcedIdleBefore &&
          cachedHistoryElapsedMs >= 200 &&
          cachedHistoryElapsedMs < 900;
        const nativeOlderHasNoLocalCursor =
          nativeOlder.page_info.start_cursor == null &&
          nativeOlder.page_info.has_previous_page === false;
        const nativeOlderRoles = nativeOlder.messages.map(
          (message) => message.author?.role ?? null,
        );
        const nativeOlderAnswerChannel = nativeOlder.messages[1]?.channel ?? null;

        // A status-only POST must never invalidate synthetic history cursors.
        const statusHistoryFirstResponse = await fetch(
          statusHistoryMessagesEndpoint +
            "?before=status-root&include_has_versions=true&num_turns=20",
        );
        const statusHistoryFirst = await statusHistoryFirstResponse.json();
        const statusLocalCursor = statusHistoryFirst.page_info.start_cursor;
        await fetch(statusHistoryAsyncEndpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "status=4",
        });
        const statusHistoryLocalResponse = await fetch(
          statusHistoryMessagesEndpoint +
            "?before=" +
            encodeURIComponent(statusLocalCursor) +
            "&include_has_versions=true&num_turns=20",
        );
        const statusHistoryLocal = await statusHistoryLocalResponse.json();
        const statusMutationPreservedLocalCursor =
          typeof statusLocalCursor === "string" &&
          statusLocalCursor.startsWith("cgptperf-") &&
          statusHistoryLocalResponse.headers.get("x-chatgpt-performance-fix-local-page") != null &&
          statusHistoryLocal.messages.length > 0;

        const richResponse = await fetch(
          richMessagesEndpoint +
            "?before=rich-cursor&include_has_versions=true&num_turns=20",
        );
        const richPage = await richResponse.json();
        const richAssistant = richPage.messages.find(
          (message) => message.author?.role === "assistant",
        );
        const richAssistantText = Array.isArray(richAssistant?.content?.parts)
          ? richAssistant.content.parts.filter((part) => typeof part === "string").join("\\n")
          : "";
        const staticLinks = [
          ...richAssistantText.matchAll(/\\((https:\\/\\/chatgpt\\.com\\/#cgptperf-code=[^)]+)\\)/g),
        ].map((match) => match[1]);
        const richHistoryHasStaticMarkers = staticLinks.length >= 4;
        const richHistoryFenceCount = (richAssistantText.match(/\`\`\`/g) ?? []).length;
        let staticCodeHydrated = false;
        let staticCodeReady = false;
        let staticCodeNoCodeMirror = false;
        let staticCodeHeightStable = false;
        if (staticLinks[0]) {
          const markerMessage = document.createElement("article");
          markerMessage.dataset.messageId = "static-code-test";
          const paragraph = document.createElement("p");
          const anchor = document.createElement("a");
          anchor.href = staticLinks[0];
          anchor.textContent = "代码块";
          paragraph.append(anchor);
          markerMessage.append(paragraph);
          document.body.append(markerMessage);
          await new Promise((resolve) => setTimeout(resolve, 30));
          const staticBlock = markerMessage.querySelector('[data-chatgpt-static-code]');
          const heightBefore = staticBlock?.getBoundingClientRect().height ?? 0;
          await new Promise((resolve) => setTimeout(resolve, 250));
          const heightAfter = staticBlock?.getBoundingClientRect().height ?? 0;
          staticCodeHydrated = Boolean(staticBlock);
          staticCodeReady =
            staticBlock?.getAttribute("data-chatgpt-static-code-state") === "ready" &&
            (staticBlock.querySelector("code")?.textContent?.length ?? 0) > 0;
          staticCodeNoCodeMirror = !staticBlock?.querySelector('[class*="_codemirror"]');
          staticCodeHeightStable =
            heightBefore > 0 && Math.abs(heightAfter - heightBefore) < 1;
        }

        // A button must be usable immediately at the top even before the
        // browser delivers the observer's initial entry. The fallback remains
        // manual: no pagination callback may run until this explicit click.
        const noEntryRoot = document.createElement("div");
        noEntryRoot.style.cssText =
          "height:100px;width:100px;overflow:auto;position:relative";
        const noEntrySentinel = document.createElement("div");
        noEntrySentinel.dataset.testid = "conversation-pagination-sentinel";
        noEntrySentinel.style.height = "10px";
        const noEntrySpacer = document.createElement("div");
        noEntrySpacer.style.height = "500px";
        noEntryRoot.append(noEntrySentinel, noEntrySpacer);
        document.body.append(noEntryRoot);
        noEntryRoot.scrollTop = 0;
        let noEntryPaginationCalls = 0;
        const noEntryObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            noEntryPaginationCalls += 1;
          }
        }, { root: noEntryRoot });
        noEntryObserver.observe(noEntrySentinel);
        const noEntryButton = noEntryRoot.querySelector(
          '[data-chatgpt-history-load-button="true"]',
        );
        const noEntrySelect = noEntryRoot.querySelector(
          '[data-chatgpt-history-batch-select="true"]',
        );
        if (noEntrySelect instanceof HTMLSelectElement) {
          noEntrySelect.value = "1";
          noEntrySelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const noEntryButtonEnabledImmediately =
          noEntryButton instanceof HTMLButtonElement && !noEntryButton.disabled;
        const noEntryCallsBeforeClick = noEntryPaginationCalls;
        if (noEntryButton instanceof HTMLButtonElement) noEntryButton.click();
        for (let attempt = 0; attempt < 10 && noEntryPaginationCalls === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const noEntryCallsAfterClick = noEntryPaginationCalls;
        window.dispatchEvent(
          new CustomEvent("chatgpt-performance-fix:history-page-settled"),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (noEntrySelect instanceof HTMLSelectElement) {
          noEntrySelect.value = "2";
          noEntrySelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
        const missingInitialEntryUsesManualFallback =
          noEntryButtonEnabledImmediately &&
          noEntryCallsBeforeClick === 0 &&
          noEntryCallsAfterClick === 1 &&
          noEntryPaginationCalls === 1;
        noEntryObserver.disconnect();
        noEntryRoot.remove();

        // React can call observe() before it commits data-testid. A later
        // attribute commit must classify the same target without leaking an
        // automatic intersecting callback.
        const lateIdRoot = document.createElement("div");
        lateIdRoot.style.cssText =
          "height:100px;width:100px;overflow:auto;position:relative";
        const lateIdSentinel = document.createElement("div");
        lateIdSentinel.style.height = "10px";
        const lateIdSpacer = document.createElement("div");
        lateIdSpacer.style.height = "500px";
        lateIdRoot.append(lateIdSentinel, lateIdSpacer);
        document.body.append(lateIdRoot);
        let lateIdPaginationCalls = 0;
        const lateIdObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            lateIdPaginationCalls += 1;
          }
        }, { root: lateIdRoot });
        lateIdObserver.observe(lateIdSentinel);
        lateIdSentinel.dataset.testid =
          "conversation-pagination-sentinel-react";
        await new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(resolve, 0)),
          ),
        );
        const lateIdButtonAppeared = Boolean(
          lateIdRoot.querySelector('[data-chatgpt-history-load-button="true"]'),
        );
        const lateControl = lateIdRoot.querySelector(
          '[data-chatgpt-history-load-control="true"]',
        );
        lateControl?.remove();
        await new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(resolve, 0)),
          ),
        );
        const removedControlWasRestored = Boolean(
          lateIdRoot.querySelector('[data-chatgpt-history-load-button="true"]'),
        );
        const lateClassificationStayedManual = lateIdPaginationCalls === 0;
        lateIdObserver.disconnect();
        lateIdRoot.remove();

        // An observed sentinel may still be detached while React builds the
        // subtree. Connecting it later must install the control at that time.
        const detachedRoot = document.createElement("div");
        detachedRoot.style.cssText =
          "height:100px;width:100px;overflow:auto;position:relative";
        const detachedSentinel = document.createElement("div");
        detachedSentinel.dataset.testid = "conversation-pagination-sentinel";
        detachedSentinel.style.height = "10px";
        const detachedSpacer = document.createElement("div");
        detachedSpacer.style.height = "500px";
        detachedRoot.append(detachedSentinel, detachedSpacer);
        let detachedPaginationCalls = 0;
        const detachedObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            detachedPaginationCalls += 1;
          }
        }, { root: detachedRoot });
        detachedObserver.observe(detachedSentinel);
        const detachedControlAbsentBeforeConnect = !detachedRoot.querySelector(
          '[data-chatgpt-history-load-control="true"]',
        );
        document.body.append(detachedRoot);
        await new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(resolve, 0)),
          ),
        );
        const detachedControlAppearedAfterConnect = Boolean(
          detachedRoot.querySelector('[data-chatgpt-history-load-button="true"]'),
        );
        const detachedClassificationStayedManual = detachedPaginationCalls === 0;
        detachedObserver.disconnect();
        detachedRoot.remove();

        const observerRoot = document.createElement("div");
        observerRoot.style.cssText =
          "height:100px;width:100px;overflow:auto;position:relative";
        const observerSentinel = document.createElement("div");
        observerSentinel.dataset.testid = "conversation-pagination-sentinel";
        observerSentinel.style.height = "10px";
        const observerSpacer = document.createElement("div");
        observerSpacer.style.height = "500px";
        observerRoot.append(observerSentinel);
        observerRoot.append(observerSpacer);
        document.body.append(observerRoot);
        observerRoot.scrollTop = 100;
        let paginationObserverCalls = 0;
        const paginationObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) paginationObserverCalls += 1;
        }, {
          root: observerRoot,
          rootMargin: "80px 0px 0px",
        });
        paginationObserver.observe(observerSentinel);
        const tunedPaginationRootMargin = paginationObserver.rootMargin;
        await new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(resolve, 0)),
          ),
        );
        const historyButton = observerRoot.querySelector(
          '[data-chatgpt-history-load-button="true"]',
        );
        const historyButtonExists = historyButton instanceof HTMLButtonElement;
        const paginationCallsBeforeUserScroll = paginationObserverCalls;
        observerRoot.scrollTop = 0;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const paginationCallsAfterProgrammaticScroll = paginationObserverCalls;
        observerRoot.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -120, bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        const paginationCallsAfterUserScroll = paginationObserverCalls;
        const historyButtonEnabledBeforeClick =
          historyButton instanceof HTMLButtonElement && !historyButton.disabled;
        if (historyButton instanceof HTMLButtonElement) historyButton.click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const paginationCallsAfterManualClick = paginationObserverCalls;
        const historyButtonBusyAfterClick =
          historyButton?.getAttribute("aria-busy") === "true";
        // Real ChatGPT tears down and re-arms the pagination observer when the
        // cursor advances. Re-observe the sentinel to model that new generation
        // before signalling that page 1 has settled.
        paginationObserver.observe(observerSentinel);
        window.dispatchEvent(
          new CustomEvent("chatgpt-performance-fix:history-page-settled"),
        );
        await new Promise((resolve) =>
          requestAnimationFrame(() => setTimeout(resolve, 20)),
        );
        const historyButtonBusyAfterSettled =
          historyButton?.getAttribute("aria-busy") === "true";
        const paginationCallsAfterFirstSettled = paginationObserverCalls;
        window.dispatchEvent(
          new CustomEvent("chatgpt-performance-fix:history-page-settled"),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        const historyButtonBusyAfterBatchSettled =
          historyButton?.getAttribute("aria-busy") === "true";
        const historyBatchSelect = observerRoot.querySelector(
          '[data-chatgpt-history-batch-select="true"]',
        );
        const historyBatchSelectValue =
          historyBatchSelect instanceof HTMLSelectElement ? historyBatchSelect.value : null;

        // After a finite manual batch is completely settled, rapidly leaving
        // and re-entering the sentinel region must not trigger another native
        // pagination callback. This reproduces the user's "quick upward scroll"
        // immediately after loading N turns.
        const paginationCallsBeforeRapidUpScroll = paginationObserverCalls;
        observerRoot.scrollTop = 140;
        await new Promise((resolve) => setTimeout(resolve, 20));
        observerRoot.scrollTop = 0;
        observerRoot.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -720, bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        const rapidUpScrollDidNotAutoLoad =
          paginationObserverCalls === paginationCallsBeforeRapidUpScroll;

        // Also cover a shared IntersectionObserver. The old implementation
        // classified the whole observer by its first observed target; if an
        // unrelated target came first, a later pagination sentinel leaked its
        // intersecting callback through and auto-loaded history.
        const sharedRoot = document.createElement("div");
        sharedRoot.style.cssText =
          "height:100px;width:100px;overflow:auto;position:relative";
        const sharedOtherTarget = document.createElement("div");
        sharedOtherTarget.style.height = "10px";
        const sharedSpacerBefore = document.createElement("div");
        sharedSpacerBefore.style.height = "120px";
        const sharedSentinel = document.createElement("div");
        sharedSentinel.dataset.testid = "conversation-pagination-sentinel";
        sharedSentinel.style.height = "10px";
        const sharedSpacerAfter = document.createElement("div");
        sharedSpacerAfter.style.height = "500px";
        sharedRoot.append(
          sharedOtherTarget,
          sharedSpacerBefore,
          sharedSentinel,
          sharedSpacerAfter,
        );
        document.body.append(sharedRoot);
        sharedRoot.scrollTop = 140;
        let sharedPaginationObserverCalls = 0;
        let sharedOrdinaryObserverCalls = 0;
        const sharedObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.target === sharedSentinel && entry.isIntersecting) {
              sharedPaginationObserverCalls += 1;
            }
            if (entry.target === sharedOtherTarget) sharedOrdinaryObserverCalls += 1;
          }
        }, {
          root: sharedRoot,
          rootMargin: "80px 0px 0px",
        });
        sharedObserver.observe(sharedOtherTarget);
        sharedObserver.observe(sharedSentinel);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const ordinaryEntryStillForwarded = sharedOrdinaryObserverCalls > 0;
        sharedRoot.scrollTop = 0;
        sharedRoot.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -720, bubbles: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        const sharedObserverPaginationBlocked = sharedPaginationObserverCalls === 0;
        const suppressedAutoPaginationCallbacks = Number(
          document.documentElement.dataset.chatgptSuppressedAutoPaginationCallbacks ?? "0",
        );
        sharedObserver.disconnect();
        sharedRoot.remove();

        const exactRoot = document.createElement("div");
        exactRoot.style.cssText =
          "height:100px;width:100px;overflow:auto;position:relative";
        const exactSentinel = document.createElement("div");
        exactSentinel.dataset.testid = "conversation-pagination-sentinel";
        exactSentinel.style.height = "10px";
        const exactSpacer = document.createElement("div");
        exactSpacer.style.height = "500px";
        exactRoot.append(exactSentinel, exactSpacer);
        document.body.append(exactRoot);
        exactRoot.scrollTop = 0;
        let exactCursor = "exact-server-start";
        let exactVisibleTurns = 0;
        let exactFetchChain = Promise.resolve();
        const exactObserver = new IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          exactFetchChain = exactFetchChain.then(async () => {
            const response = await fetch(
              exactManualMessagesEndpoint +
                "?before=" + encodeURIComponent(exactCursor) +
                "&include_has_versions=true&num_turns=1",
            );
            const page = await response.json();
            exactVisibleTurns += page.messages.filter(
              (message) => message.author?.role === "user",
            ).length;
            exactCursor = page.page_info.start_cursor ?? exactCursor;
            if (page.page_info.has_previous_page && page.page_info.start_cursor) {
              exactObserver.observe(exactSentinel);
            }
          });
        }, {
          root: exactRoot,
          rootMargin: "80px 0px 0px",
        });
        exactObserver.observe(exactSentinel);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const exactButton = exactRoot.querySelector(
          '[data-chatgpt-history-load-button="true"]',
        );
        const exactStatsBefore = await fetch("/stats").then((response) => response.json());
        if (exactButton instanceof HTMLButtonElement) exactButton.click();
        for (let attempt = 0; attempt < 80; attempt += 1) {
          await exactFetchChain;
          if (
            document.documentElement.dataset.chatgptHistoryBatchActive === "false"
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await exactFetchChain;
        await new Promise((resolve) => setTimeout(resolve, 80));
        const exactStatsAfter = await fetch("/stats").then((response) => response.json());
        const finiteTwoTurnsExact =
          exactVisibleTurns === 2 &&
          exactStatsAfter.exactManualHistoryGets ===
            exactStatsBefore.exactManualHistoryGets + 1 &&
          exactStatsAfter.exactManualHistoryNumTurns.at(-1) === "2";
        const finiteTwoTurnsUsedLocalSecondPage =
          exactStatsAfter.exactManualHistoryGets ===
            exactStatsBefore.exactManualHistoryGets + 1 &&
          exactCursor.startsWith("exact-server-");
        exactObserver.disconnect();
        exactRoot.remove();

        const loadAllButton = observerRoot.querySelector(
          '[data-chatgpt-history-load-all-button="true"]',
        );
        const paginationCallsBeforeLoadAll = paginationObserverCalls;
        if (loadAllButton instanceof HTMLButtonElement) loadAllButton.click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        const loadAllStarted =
          document.documentElement.dataset.chatgptHistoryBatchMode === "all" &&
          paginationObserverCalls === paginationCallsBeforeLoadAll + 1;

        // Simulate React replacing the pagination sentinel after the first page.
        paginationObserver.disconnect();
        observerRoot.remove();
        const replacementRoot = document.createElement("div");
        replacementRoot.style.cssText =
          "height:100px;width:100px;overflow:auto;position:relative";
        const replacementSentinel = document.createElement("div");
        replacementSentinel.dataset.testid = "conversation-pagination-sentinel";
        replacementSentinel.style.height = "10px";
        const replacementSpacer = document.createElement("div");
        replacementSpacer.style.height = "500px";
        replacementRoot.append(replacementSentinel, replacementSpacer);
        document.body.append(replacementRoot);
        replacementRoot.scrollTop = 0;
        const replacementPaginationObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) paginationObserverCalls += 1;
        }, {
          root: replacementRoot,
          rootMargin: "80px 0px 0px",
        });
        replacementPaginationObserver.observe(replacementSentinel);
        await new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(resolve, 20)),
          ),
        );
        window.dispatchEvent(
          new CustomEvent("chatgpt-performance-fix:history-page-settled"),
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        const loadAllSurvivedSentinelReplacement =
          paginationObserverCalls >= paginationCallsBeforeLoadAll + 2 &&
          document.documentElement.dataset.chatgptHistoryBatchMode === "all";

        // Cursor/page state advances re-arm the pagination observer before the
        // next page is eligible to load. Model that generation change here too.
        replacementPaginationObserver.observe(replacementSentinel);
        window.dispatchEvent(
          new CustomEvent("chatgpt-performance-fix:history-page-settled"),
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        const loadAllContinuedPastTwoPages =
          paginationObserverCalls >= paginationCallsBeforeLoadAll + 3;

        // Final page: no replacement sentinel should terminate "load all".
        replacementPaginationObserver.disconnect();
        replacementRoot.remove();
        window.dispatchEvent(
          new CustomEvent("chatgpt-performance-fix:history-page-settled"),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_150));
        const loadAllStoppedAtEnd =
          document.documentElement.dataset.chatgptHistoryBatchActive === "false";

        const menuCommands = window.__gmMenuCommands ?? [];
        const loadAllMessagesMenuExists = menuCommands.some(
          (command) => command.label === "加载全部消息",
        );
        const defaultMenu = menuCommands.find((command) =>
          String(command.label).startsWith("默认打开："),
        );
        defaultMenu?.callback();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const defaultDialog = document.querySelector("#chatgpt-turn-load-setting-dialog");
        const defaultDialogOpened = Boolean(defaultDialog);
        const cancelButton = [...(defaultDialog?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent === "取消",
        );
        cancelButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const settingsDialogCancelCloses =
          !document.querySelector("#chatgpt-turn-load-setting-dialog");
        await new Promise((resolve) => setTimeout(resolve, 120));
        const settingsDialogDoesNotReopenAfterCancel =
          !document.querySelector("#chatgpt-turn-load-setting-dialog");

        const historyMenu = menuCommands.find((command) =>
          String(command.label).startsWith("历史批量："),
        );
        historyMenu?.callback();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const historyDialog = document.querySelector("#chatgpt-turn-load-setting-dialog");
        const historyInput = historyDialog?.querySelector("input");
        if (historyInput instanceof HTMLInputElement) historyInput.value = "5";
        const saveButton = [...(historyDialog?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent === "保存",
        );
        saveButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const settingsDialogSaveCloses =
          !document.querySelector("#chatgpt-turn-load-setting-dialog");
        await new Promise((resolve) => setTimeout(resolve, 120));
        const settingsDialogDoesNotReopenAfterSave =
          !document.querySelector("#chatgpt-turn-load-setting-dialog");
        const savedSettings = JSON.parse(
          localStorage.getItem("chatgpt-performance-fix:settings:v1") ?? "{}",
        );
        const historyMenuSettingSaved = savedSettings.historyBatchTurns === 5;

        const richHost = document.createElement("div");
        richHost.innerHTML =
          '<article data-message-id="rich-test-message" class="markdown">' +
          '<div id="rich-smoothed" class="co8dpq_SmoothedCodeBlock" data-animate-height style="height:0;opacity:0">' +
          '<div id="rich-clip" class="co8dpq_ClipText" style="height:0px">' +
          '<span id="rich-measure" class="block">const answer = 42;</span>' +
          '<span id="rich-overlay" class="co8dpq_SmoothingOverlay"></span>' +
          '</div></div>' +
          '<div id="rich-editor" class="Rx43rG_codemirror"></div>' +
          '<table id="rich-table"><tbody><tr><td>cell</td></tr></tbody></table>' +
          '</article>';
        document.body.append(richHost);
        const hotRichHost = document.createElement("article");
        hotRichHost.dataset.messageId = "rich-hot-message";
        hotRichHost.style.cssText =
          "position:fixed;left:4px;top:4px;width:120px;height:120px;z-index:-1";
        const hotRichEditor = document.createElement("div");
        hotRichEditor.id = "rich-hot-editor";
        hotRichEditor.className = "Rx43rG_codemirror";
        hotRichHost.append(hotRichEditor);
        document.body.append(hotRichHost);
        const coldRichHost = document.createElement("article");
        coldRichHost.dataset.messageId = "rich-cold-message";
        coldRichHost.style.cssText =
          "position:fixed;left:0;top:12000px;width:120px;height:120px";
        const coldRichEditor = document.createElement("div");
        coldRichEditor.id = "rich-cold-editor";
        coldRichEditor.className = "Rx43rG_codemirror";
        coldRichHost.append(coldRichEditor);
        document.body.append(coldRichHost);

        const deferredRichHost = document.createElement("article");
        deferredRichHost.dataset.messageId = "rich-deferred-message";
        deferredRichHost.style.cssText =
          "position:fixed;left:140px;top:14000px;width:120px;height:120px";
        const deferredRichEditor = document.createElement("div");
        deferredRichEditor.id = "rich-deferred-editor";
        deferredRichEditor.className = "Rx43rG_codemirror";
        const deferredScroller = document.createElement("div");
        deferredScroller.className = "cm-scroller";
        const deferredContent = document.createElement("div");
        deferredContent.className = "cm-content";
        deferredScroller.append(deferredContent);
        deferredRichEditor.append(deferredScroller);
        deferredRichHost.append(deferredRichEditor);
        document.body.append(deferredRichHost);

        const prewarmRichHost = document.createElement("article");
        prewarmRichHost.dataset.messageId = "rich-prewarm-message";
        prewarmRichHost.style.cssText =
          "position:fixed;left:280px;top:2200px;width:120px;height:120px;z-index:-1";
        const prewarmRichEditor = document.createElement("div");
        prewarmRichEditor.id = "rich-prewarm-editor";
        prewarmRichEditor.className = "Rx43rG_codemirror";
        prewarmRichHost.append(prewarmRichEditor);
        document.body.append(prewarmRichHost);
        for (let index = 1; index < 36; index += 1) {
          const block = document.createElement("div");
          block.className = "co8dpq_SmoothedCodeBlock";
          block.setAttribute("data-animate-height", "");
          const clip = document.createElement("div");
          clip.className = "co8dpq_ClipText";
          clip.style.height = "0px";
          const span = document.createElement("span");
          span.className = "block";
          span.textContent = "const value" + index + " = " + index + ";";
          clip.append(span);
          block.append(clip);
          richHost.querySelector("article")?.append(block);
        }
        const measureTargets = richHost.querySelectorAll(
          '[class*="SmoothedCodeBlock"] [class*="ClipText"] > span.block',
        );
        const normalTarget = document.createElement("div");
        richHost.append(normalTarget);
        const nativeResizeBefore = window.__richNativeResizeObserveCalls;
        const richResizeObservers = [];
        for (const measureTarget of measureTargets) {
          const observer = new ResizeObserver(() => {});
          observer.observe(measureTarget);
          richResizeObservers.push(observer);
        }
        const nativeResizeAfterSmoothed = window.__richNativeResizeObserveCalls;
        const normalResizeObserver = new ResizeObserver(() => {});
        normalResizeObserver.observe(normalTarget);
        const nativeResizeAfterNormal = window.__richNativeResizeObserveCalls;

        await new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(resolve, 700)),
          ),
        );
        const deferredEditorInitialState = deferredRichEditor.getAttribute(
          "data-chatgpt-rich-editor-state",
        );
        const nativeIoBeforeDeferred = window.__richNativeIntersectionObserveCalls;
        const nativeRoBeforeDeferred = window.__richNativeResizeObserveCalls;
        const deferredIntersectionObserver = new IntersectionObserver(() => {});
        const deferredResizeObserver = new ResizeObserver(() => {});
        deferredIntersectionObserver.observe(deferredContent);
        deferredResizeObserver.observe(deferredScroller);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const nativeIoAfterDeferred = window.__richNativeIntersectionObserveCalls;
        const nativeRoAfterDeferred = window.__richNativeResizeObserveCalls;
        deferredRichEditor.setAttribute("data-chatgpt-rich-editor-state", "hot");
        await new Promise((resolve) => setTimeout(resolve, 30));
        const nativeIoAfterHot = window.__richNativeIntersectionObserveCalls;
        const nativeRoAfterHot = window.__richNativeResizeObserveCalls;
        const codeMirrorIoDeferred = Number(
          document.documentElement.dataset.chatgptCodeMirrorIoDeferred ?? "0",
        );
        const codeMirrorIoResumed = Number(
          document.documentElement.dataset.chatgptCodeMirrorIoResumed ?? "0",
        );
        const codeMirrorRoDeferred = Number(
          document.documentElement.dataset.chatgptCodeMirrorRoDeferred ?? "0",
        );
        const codeMirrorRoResumed = Number(
          document.documentElement.dataset.chatgptCodeMirrorRoResumed ?? "0",
        );
        deferredIntersectionObserver.disconnect();
        deferredResizeObserver.disconnect();

        const richMessage = richHost.querySelector('[data-message-id="rich-test-message"]');
        const richMessageContentVisibility = getComputedStyle(richMessage).contentVisibility;
        const smoothedStyle = getComputedStyle(document.querySelector("#rich-smoothed"));
        const clipStyle = getComputedStyle(document.querySelector("#rich-clip"));
        const overlayStyle = getComputedStyle(document.querySelector("#rich-overlay"));
        const editor = document.querySelector("#rich-editor");
        const editorStyle = getComputedStyle(editor);
        const tableStyle = getComputedStyle(document.querySelector("#rich-table"));
        const richStyleInstalled = Boolean(
          document.querySelector("#chatgpt-rich-text-performance-fix-style"),
        );
        const skippedRichResizeObservers = Number(
          document.documentElement.dataset.chatgptRichTextSkippedResizeObservers ?? "0",
        );
        const richEditorsCold = Number(
          document.documentElement.dataset.chatgptRichTextEditorsCold ?? "0",
        );
        const richEditorsActivated = Number(
          document.documentElement.dataset.chatgptRichTextEditorsActivated ?? "0",
        );
        const richEditorState = editor.getAttribute("data-chatgpt-rich-editor-state");
        const richEditorContentVisibilityAfterState =
          getComputedStyle(editor).contentVisibility;
        const richHotEditorState = hotRichEditor.getAttribute(
          "data-chatgpt-rich-editor-state",
        );
        const richHotEditorContentVisibility =
          getComputedStyle(hotRichEditor).contentVisibility;
        const richColdEditorState = coldRichEditor.getAttribute(
          "data-chatgpt-rich-editor-state",
        );
        const richColdEditorContentVisibility =
          getComputedStyle(coldRichEditor).contentVisibility;
        const richPrewarmEditorState = prewarmRichEditor.getAttribute(
          "data-chatgpt-rich-editor-state",
        );
        const richPrewarmEditorTop =
          Math.round(prewarmRichEditor.getBoundingClientRect().top);
        const richTextWarmDistancePx = Number(
          document.documentElement.dataset.chatgptRichTextWarmDistancePx ?? "0",
        );
        const codeEditorWarmDistancePx = Number(
          document.documentElement.dataset.chatgptCodeEditorWarmDistancePx ?? "0",
        );
        const richBlocksCold = Number(
          document.documentElement.dataset.chatgptRichTextBlocksCold ?? "0",
        );
        const richBlocksActivated = Number(
          document.documentElement.dataset.chatgptRichTextBlocksActivated ?? "0",
        );
        for (const observer of richResizeObservers) observer.disconnect();
        normalResizeObserver.disconnect();

        const metadataResponse = await fetch(
          metadataEndpoint + "?include_has_versions=true&num_turns=2",
        );
        const metadataPayload = await metadataResponse.json();
        const metadataStatsBeforeMount = await fetch("/stats").then(
          (response) => response.json(),
        );
        const metadataUserTurn = document.createElement("section");
        metadataUserTurn.dataset.turn = "user";
        metadataUserTurn.dataset.testid = "conversation-turn-metadata-user";
        const metadataUserElement = document.createElement("div");
        metadataUserElement.dataset.messageAuthorRole = "user";
        metadataUserElement.dataset.messageId = metadataUserId;
        metadataUserElement.textContent = "metadata display question";
        metadataUserTurn.append(metadataUserElement);

        const metadataAssistantTurn = document.createElement("section");
        metadataAssistantTurn.dataset.turn = "assistant";
        metadataAssistantTurn.dataset.testid = "conversation-turn-metadata-assistant";
        const metadataAssistantElement = document.createElement("div");
        metadataAssistantElement.dataset.messageAuthorRole = "assistant";
        metadataAssistantElement.dataset.messageId = metadataAssistantId;
        metadataAssistantElement.textContent = "metadata display answer";
        metadataAssistantTurn.append(metadataAssistantElement);
        document.body.append(metadataUserTurn, metadataAssistantTurn);
        await new Promise((resolve) => setTimeout(resolve, 80));

        const metadataUserBadge = metadataUserElement.querySelector(
          '[data-chatgpt-message-metadata="true"]',
        );
        const metadataAssistantBadge = metadataAssistantElement.querySelector(
          '[data-chatgpt-message-metadata="true"]',
        );
        const historicalMessageMetadataRendered =
          metadataPayload.messages?.length === 2 &&
          metadataUserBadge instanceof HTMLElement &&
          metadataAssistantBadge instanceof HTMLElement;
        const historicalTimestampUsesServerCreateTime =
          metadataUserBadge?.querySelector("time")?.dateTime ===
            new Date(metadataUserTime * 1000).toISOString() &&
          metadataAssistantBadge?.querySelector("time")?.dateTime ===
            new Date(metadataAssistantTime * 1000).toISOString() &&
          metadataUserBadge?.getAttribute(
            "data-chatgpt-message-metadata-time-source",
          ) === "server";
        const resolvedModelPreferred =
          metadataAssistantBadge
            ?.querySelector("[data-chatgpt-message-model]")
            ?.getAttribute("data-chatgpt-message-model") === "gpt-5-6-thinking" &&
          metadataAssistantBadge?.textContent?.includes("GPT-5.6 Thinking") === true &&
          metadataAssistantBadge?.getAttribute(
            "data-chatgpt-message-metadata-model-source",
          ) === "resolved";
        const userModelInferredFromReply =
          metadataUserBadge
            ?.querySelector("[data-chatgpt-message-model]")
            ?.getAttribute("data-chatgpt-message-model") === "gpt-5-6-thinking" &&
          metadataUserBadge?.getAttribute(
            "data-chatgpt-message-metadata-model-source",
          ) === "inferred";
        const metadataPlacementMatchesRole =
          metadataUserBadge?.getAttribute("data-chatgpt-message-metadata-role") ===
            "user" &&
          metadataAssistantBadge?.getAttribute(
            "data-chatgpt-message-metadata-role",
          ) === "assistant" &&
          metadataUserBadge?.parentElement === metadataUserElement &&
          metadataAssistantBadge?.parentElement === metadataAssistantElement;
        const metadataStyleInstalled = Boolean(
          document.querySelector("#chatgpt-message-metadata-style"),
        );
        const metadataMenuExists = (window.__gmMenuCommands ?? []).some(
          (command) => command.label === "隐藏消息时间与模型",
        );
        const metadataStatsAfterMount = await fetch("/stats").then(
          (response) => response.json(),
        );
        const metadataDomMountMadeNoRequests =
          metadataStatsAfterMount.metadataInitialGets ===
          metadataStatsBeforeMount.metadataInitialGets;

        await new Promise((resolve) => setTimeout(resolve, 80));
        const sidebarRefreshButton = document.querySelector(
          '[data-chatgpt-sidebar-refresh-button="true"]',
        );
        const sidebarRefreshButtonExists =
          sidebarRefreshButton instanceof HTMLButtonElement;
        const sidebarRefreshStyleInstalled = Boolean(
          document.querySelector("#chatgpt-sidebar-refresh-style"),
        );
        const sidebarRefreshUsesIconAndText =
          sidebarRefreshButton instanceof HTMLButtonElement &&
          Boolean(sidebarRefreshButton.querySelector("[data-chatgpt-refresh-icon] svg")) &&
          Boolean(
            sidebarRefreshButton
              .querySelector("[data-chatgpt-refresh-label]")
              ?.textContent?.trim(),
          );
        const sidebarOnlyHasRefreshButton =
          document.querySelectorAll(
            '[data-chatgpt-sidebar-refresh-control="true"] button',
          ).length === 1;
        const conversationRefreshUiRemoved =
          !document.querySelector(
            '[data-chatgpt-conversation-refresh-button="true"], [data-chatgpt-conversation-refresh-control="true"]',
          ) &&
          document.documentElement.dataset.chatgptConversationRefreshPlacement == null;
        const conversationRefreshMenuRemoved = !(window.__gmMenuCommands ?? []).some(
          (command) => command.label === "刷新当前会话",
        );
        const sidebarStatsBeforeManualRefresh = await fetch("/stats").then(
          (response) => response.json(),
        );
        if (sidebarRefreshButton instanceof HTMLButtonElement) {
          sidebarRefreshButton.click();
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
        const sidebarStatsAfterManualRefresh = await fetch("/stats").then(
          (response) => response.json(),
        );
        const sidebarManualRefreshTriggered =
          sidebarStatsAfterManualRefresh.authenticatedSidebarListProbeGets ===
            sidebarStatsBeforeManualRefresh.authenticatedSidebarListProbeGets + 1 &&
          sidebarStatsAfterManualRefresh.authenticatedSidebarDetailProbeGets ===
            sidebarStatsBeforeManualRefresh.authenticatedSidebarDetailProbeGets + 1;
        const sidebarRefreshIconPreserved = Boolean(
          sidebarRefreshButton?.querySelector("[data-chatgpt-refresh-icon] svg"),
        );
        const sidebarAnchor = document.querySelector("#sidebar-conversation");
        const sidebarTitleFresh =
          sidebarAnchor?.querySelector(".truncate")?.textContent === "fresh sidebar title";
        const sidebarHasNoCustomStatusDisplay =
          !sidebarAnchor?.querySelector('[data-chatgpt-sidebar-sync-status="true"]') &&
          !sidebarAnchor?.hasAttribute("data-chatgpt-async-active");

        await fetch(sendEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversation_id: ${JSON.stringify(conversationId)},
            action: "next",
            client_prepare_source: "context_change",
          }),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const backgroundSendDidNotShowStatus =
          !document.querySelector('[data-chatgpt-delivery-status="true"]') &&
          document.documentElement.dataset.chatgptLastSendVerified !== "pending";

        const sentUserTurn = document.createElement("section");
        sentUserTurn.dataset.turn = "user";
        sentUserTurn.dataset.turnId = "harness-user-turn";
        sentUserTurn.dataset.testid = "conversation-turn-999";
        const sentMessageElement = document.createElement("div");
        sentMessageElement.dataset.messageAuthorRole = "user";
        sentMessageElement.dataset.messageId = sentProbeMessageId;
        sentMessageElement.textContent = sentProbeMessageText;
        sentUserTurn.append(sentMessageElement);
        document.body.append(sentUserTurn);

        const sendPromise = fetch(sendEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversation_id: ${JSON.stringify(conversationId)},
            messages: [
              {
                id: sentProbeMessageId,
                author: { role: "user" },
                content: { content_type: "text", parts: [sentProbeMessageText] },
                create_time: sentProbeCreateTime,
                metadata: { requested_model_slug: "gpt-5-6-pro" },
              },
            ],
          }),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const sendingStatus = sentMessageElement.querySelector(
          '[data-chatgpt-delivery-status="true"]',
        );
        const inlineSendingStatus =
          sendingStatus?.getAttribute("data-chatgpt-delivery-stage") === "sending" &&
          Boolean(sendingStatus.querySelector(".chatgpt-delivery-spinner"));
        const deliveryStatusInsideMessage =
          sendingStatus?.closest('[data-message-author-role="user"]') === sentMessageElement;

        const sendResponse = await sendPromise;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const inlineAcceptedStatus =
          sentMessageElement
            .querySelector('[data-chatgpt-delivery-status="true"]')
            ?.getAttribute("data-chatgpt-delivery-stage") === "sent" &&
          document.documentElement.dataset.chatgptLastSendVerified === "true" &&
          !sentMessageElement.querySelector(".chatgpt-delivery-spinner");
        const outgoingMetadataBadge = sentMessageElement.querySelector(
          '[data-chatgpt-message-metadata="true"]',
        );
        const outgoingMetadataRendered =
          outgoingMetadataBadge?.querySelector("time")?.dateTime ===
            new Date(sentProbeCreateTime * 1000).toISOString() &&
          outgoingMetadataBadge?.querySelector("[data-chatgpt-message-model]")
            ?.getAttribute("data-chatgpt-message-model") === "gpt-5-6-thinking";

        const assistantReplyTurn = document.createElement("section");
        assistantReplyTurn.dataset.turn = "assistant";
        assistantReplyTurn.dataset.turnId = "harness-assistant-turn";
        assistantReplyTurn.dataset.testid = "conversation-turn-1000";
        const assistantReplyElement = document.createElement("div");
        assistantReplyElement.className = "agent-turn";
        assistantReplyElement.textContent = "streaming reply started";
        assistantReplyTurn.append(assistantReplyElement);
        document.body.append(assistantReplyTurn);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const outgoingMetadataServerCorrected =
          sentMessageElement
            .querySelector('[data-chatgpt-message-metadata="true"]')
            ?.getAttribute("data-chatgpt-message-metadata-time-source") === "server" &&
          sentMessageElement
            .querySelector('[data-chatgpt-message-metadata="true"]')
            ?.getAttribute("data-chatgpt-message-metadata-model-source") === "inferred" &&
          sentMessageElement
            .querySelector('[data-chatgpt-message-model="gpt-5-6-thinking"]') != null;
        const replyStartConfirmedSend =
          document.documentElement.dataset.chatgptLastSendVerified === "true" &&
          document.documentElement.dataset.chatgptLastSendEvidence === "assistant-turn" &&
          sentMessageElement
            .querySelector('[data-chatgpt-delivery-status="true"]')
            ?.getAttribute("data-chatgpt-delivery-stage") === "sent";

        await fetch(resumeEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversation_id: ${JSON.stringify(conversationId)},
            messages: [
              {
                id: sentProbeMessageId,
                author: { role: "user" },
                content: { content_type: "text", parts: [sentProbeMessageText] },
              },
            ],
            resume_token: "harness-resume-token",
          }),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const resumeDidNotRestartVerifier =
          Number(document.documentElement.dataset.chatgptDeliveryTrackedSends ?? "0") === 1 &&
          document.documentElement.dataset.chatgptLastSendVerified === "true" &&
          document.documentElement.dataset.chatgptLastSendEvidence === "assistant-turn";

        await new Promise((resolve) => setTimeout(resolve, 900));
        const sendVerified =
          sendResponse.ok && document.documentElement.dataset.chatgptLastSendVerified === "true";
        const deliveryIndicatorText =
          sentMessageElement.querySelector('[data-chatgpt-delivery-status="true"]')?.textContent ?? "";
        const deliveryIndicatorConfirmed = deliveryIndicatorText.includes("已发送");

        await fetch(currentAsyncStatusEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: 4 }),
        });
        await new Promise((resolve) => setTimeout(resolve, 180));
        const sidebarStillHasNoCustomStatusDisplay =
          !sidebarAnchor?.querySelector('[data-chatgpt-sidebar-sync-status="true"]') &&
          !sidebarAnchor?.hasAttribute("data-chatgpt-async-active");

        const afterMutation = await fetch("/stats").then((response) => response.json());
        const jsonWorkerParses = Number(
          document.documentElement.dataset.chatgptJsonWorkerParses ?? "0",
        );

        publish({
          ok: true,
          normalVisibilityState,
          smoothedVisibilityState,
          smoothedMarkdownBypass,
          fallbackResponseHook,
          fallbackFirstNodes: Object.keys(fallbackFirst.mapping).length,
          fallbackSecondNodes: Object.keys(fallbackSecond.mapping).length,
          fallbackTextNodes: Object.keys(fallbackTextPayload.mapping).length,
          fallbackResponseUrlPreserved:
            fallbackFirstResponse.url === new URL(fallbackEndpoint, location.href).href &&
            fallbackSecondResponse.url === new URL(fallbackEndpoint, location.href).href &&
            fallbackTextResponse.url === new URL(fallbackEndpoint, location.href).href,
          fallbackOptimizedCount,
          fallbackCacheHits,
          fallbackOriginalNodes,
          fallbackKeptNodes,
          firstNodes: Object.keys(first.mapping).length,
          lazyInitialVisibleRoles: visibleTranscriptRoles(mappingMessages(first.mapping)),
          nativeInitialVisibleRoles: visibleTranscriptRoles(nativeInitial.messages),
          secondNodes: Object.keys(second.mapping).length,
          cachedNodes: Object.keys(third.mapping).length,
          postInvalidationNodes: Object.keys(fourth.mapping).length,
          postMutationSnapshotRefreshed,
          asyncFirstMessages: asyncFirst.messages.length,
          asyncSecondMessages: asyncSecond.messages.length,
          activeSequentialProgressFresh,
          activeResponsesMarkedLive,
          activeResponsesNotSnapshotted,
          completedActiveConversationPinned,
          emptyLazyNodes: Object.keys(emptyLazy.mapping).length,
          emptyLazyPaginationEnabled: Boolean(emptyLazy.__paginatedConversationPage),
          emptyLazyHeader:
            emptyResponse.headers.get("x-chatgpt-performance-fix-lazy"),
          lazyPaginationEnabled: Boolean(first.__paginatedConversationPage),
          lazyInitialCursor: first.__paginatedConversationPage?.cursor,
          lazyInitialHeader:
            firstResponse.headers.get("x-chatgpt-performance-fix-lazy"),
          lazyInitialTurnsHeader:
            firstResponse.headers.get("x-chatgpt-performance-fix-initial-turns"),
          lazyInitialOptimizationHeader:
            firstResponse.headers.get("x-chatgpt-performance-fix-page"),
          lazyInitialCacheableHeader:
            firstResponse.headers.get("x-chatgpt-performance-fix-cacheable"),
          lazyOlderMessages: lazyOlder.messages.length,
          lazyOlderRoles: lazyOlder.messages.map(
            (message) => message.author?.role ?? null,
          ),
          lazyOlderAnswerChannel: lazyOlder.messages[1]?.channel ?? null,
          lazyOlderOptimizationHeader:
            lazyOlderResponse.headers.get("x-chatgpt-performance-fix-page"),
          lazyInitialNetworkGetsAfterOpen: afterOpen.lazyInitialGets,
          lazyMessagesNetworkGetsAfterOpen: afterOpen.lazyMessagesGets,
          lazyInitialNetworkGetsBeforeMutation: beforeMutation.lazyInitialGets,
          lazyMessagesNetworkGetsBeforeMutation: beforeMutation.lazyMessagesGets,
          lazyInitialNumTurnsBeforeMutation: beforeMutation.lazyInitialNumTurns,
          lazyMessagesNumTurnsBeforeMutation: beforeMutation.lazyMessagesNumTurns,
          legacyFullGetsBeforeMutation: beforeMutation.conversationGets,
          hourLaterInitialSnapshotHeader,
          hourLaterCurrentNodePreserved,
          automaticInitialRevalidationsServedLocally:
            Number(
              document.documentElement.dataset.chatgptInitialSnapshotHits ?? "0",
            ) >= 2,
          initialSnapshotsStored:
            Number(
              document.documentElement.dataset.chatgptInitialSnapshotsStored ?? "0",
            ) >= 4,
          activeSnapshotsSkipped:
            Number(
              document.documentElement.dataset.chatgptInitialSnapshotSkippedActive ?? "0",
            ) >= 2,
          rateLimitedFirstStatus,
          rateLimitedSecondStatus,
          rateLimitedSnapshotHeader,
          rateLimitedInitialGets: afterMutation.rateLimitedInitialGets,
          rateLimitedInitialNumTurns: afterMutation.rateLimitedInitialNumTurns,
          rateLimitedLegacyGets: afterMutation.rateLimitedLegacyGets,
          rateLimitRevalidationSuppressed:
            Number(
              document.documentElement.dataset.chatgptInitialRateLimitSuppressions ?? "0",
            ) >= 1,
          fallbackLegacyGets: afterMutation.fallbackLegacyGets,
          nativeInitialMessages: nativeInitial.messages.length,
          nativeLocalMessages: nativeLocal.messages.length,
          nativeOlderMessages: nativeOlder.messages.length,
          nativeOlderRoles,
          nativeOlderAnswerChannel,
          nativeOlderHasNoLocalCursor,
          richHistoryHasStaticMarkers,
          richHistoryFenceCount,
          staticCodeHydrated,
          staticCodeReady,
          staticCodeNoCodeMirror,
          staticCodeHeightStable,
          nativeOlderCachedRoles: nativeOlderCached.messages.map(
            (message) => message.author?.role ?? null,
          ),
          cachedHistoryCompletionSignal,
          historyIdleWaitForcedButBounded,
          historyCacheHits: Number(
            document.documentElement.dataset.chatgptHistoryCacheHits ?? "0",
          ),
          optimizerWorkerUsed: jsonWorkerParses > 0,
          userTaskRanBeforeLocalHistory,
          nativeInitialKeepsServerCursor: localCursor === "cursor-older",
          nativeLocalYieldedAfterPaint: paintOccurredBeforeLocalResponse,
          nativeInitialCurrentNodePreserved:
            nativeInitial.current_node === expectedCurrentNode,
          nativeInitialResponseUrlPreserved:
            nativeInitialResponse.url === new URL(nativeInitialUrl, location.href).href,
          nativeInitialOptimizationHeader:
            nativeInitialResponse.headers.get("x-chatgpt-performance-fix-page"),
          nativeLocalPageHeader:
            nativeLocalResponse.headers.get("x-chatgpt-performance-fix-local-page"),
          nativeOlderOptimizationHeader:
            nativeOlderResponse.headers.get("x-chatgpt-performance-fix-page"),
          nativeInitialNetworkGets: afterMutation.nativeInitialGets,
          nativeMessagesNetworkGets: afterMutation.nativeMessagesGets,
          nativeInitialNumTurns: afterMutation.nativeInitialNumTurns,
          nativeMessagesNumTurns: afterMutation.nativeMessagesNumTurns,
          statusMutationPreservedLocalCursor,
          statusHistoryMessagesGets: afterMutation.statusHistoryMessagesGets,
          statusMutationPosts: afterMutation.statusMutationPosts,
          historicalMessageMetadataRendered,
          historicalTimestampUsesServerCreateTime,
          resolvedModelPreferred,
          userModelInferredFromReply,
          metadataPlacementMatchesRole,
          metadataStyleInstalled,
          metadataMenuExists,
          metadataDomMountMadeNoRequests,
          metadataInitialGets: afterMutation.metadataInitialGets,
          backendRequestContextCaptured,
          noAutomaticSidebarRequests,
          idleSidebarDetailDidNotRepeat,
          idleSidebarListDidNotRepeatAtLegacyCadence,
          sidebarRefreshButtonExists,
          sidebarRefreshStyleInstalled,
          sidebarRefreshUsesIconAndText,
          sidebarOnlyHasRefreshButton,
          conversationRefreshUiRemoved,
          conversationRefreshMenuRemoved,
          sidebarRefreshIconPreserved,
          sidebarManualRefreshTriggered,
          authenticatedSidebarListProbeUsed:
            afterMutation.authenticatedSidebarListProbeGets > 0,
          authenticatedSidebarDetailProbeUsed:
            afterMutation.authenticatedSidebarDetailProbeGets > 0,
          noDeliveryPolling:
            afterMutation.authenticatedPersistenceProbeGets === 0 &&
            afterMutation.deliveryIncludeMessageIds.length === 0,
          unauthorizedProbeGets: afterMutation.unauthorizedProbeGets,
          sidebarTitleFresh,
          sidebarHasNoCustomStatusDisplay,
          sidebarStillHasNoCustomStatusDisplay,
          sidebarListRefreshed: afterMutation.sidebarListGets >= 1,
          backgroundSendDidNotShowStatus,
          inlineSendingStatus,
          inlineAcceptedStatus,
          deliveryStatusInsideMessage,
          replyStartConfirmedSend,
          resumeDidNotRestartVerifier,
          sendVerified,
          deliveryIndicatorConfirmed,
          outgoingMetadataRendered,
          outgoingMetadataServerCorrected,
          sendPosts: afterMutation.sendPosts,
          resumePosts: afterMutation.resumePosts,
          tunedPaginationRootMargin,
          historyButtonExists,
          historyButtonEnabledBeforeClick,
          historyButtonBusyAfterClick,
          historyButtonBusyAfterSettled,
          historyButtonBusyAfterBatchSettled,
          historyBatchSelectValue,
          paginationCallsBeforeUserScroll,
          paginationCallsAfterProgrammaticScroll,
          paginationCallsAfterUserScroll,
          paginationCallsAfterManualClick,
          paginationCallsAfterFirstSettled,
          rapidUpScrollDidNotAutoLoad,
          ordinaryEntryStillForwarded,
          sharedObserverPaginationBlocked,
          suppressedAutoPaginationCallbacksObserved:
            suppressedAutoPaginationCallbacks > 0,
          missingInitialEntryUsesManualFallback,
          lateIdButtonAppeared,
          removedControlWasRestored,
          lateClassificationStayedManual,
          detachedControlAbsentBeforeConnect,
          detachedControlAppearedAfterConnect,
          detachedClassificationStayedManual,
          finiteTwoTurnsExact,
          finiteTwoTurnsUsedLocalSecondPage,
          loadAllStarted,
          loadAllSurvivedSentinelReplacement,
          loadAllContinuedPastTwoPages,
          loadAllStoppedAtEnd,
          loadAllMessagesMenuExists,
          defaultDialogOpened,
          settingsDialogCancelCloses,
          settingsDialogDoesNotReopenAfterCancel,
          settingsDialogSaveCloses,
          settingsDialogDoesNotReopenAfterSave,
          historyMenuSettingSaved,
          manualHistoryClicks: Number(
            document.documentElement.dataset.chatgptManualHistoryClicks ?? "0",
          ),
          richStyleInstalled,
          richMessageContentVisibility,
          richSmoothedVisible:
            parseFloat(smoothedStyle.height) >= 50 && smoothedStyle.opacity === "1",
          richClipExpanded: parseFloat(clipStyle.height) > 0,
          richOverlayHidden: overlayStyle.display === "none",
          richEditorContentVisibility: editorStyle.contentVisibility,
          richEditorContentVisibilityAfterState,
          richTableContentVisibility: tableStyle.contentVisibility,
          nativeResizeBefore,
          nativeResizeAfterSmoothed,
          nativeResizeAfterNormal,
          skippedRichResizeObservers,
          richEditorsCold,
          richEditorsActivated,
          richEditorState,
          richHotEditorState,
          richHotEditorContentVisibility,
          richColdEditorState,
          richColdEditorContentVisibility,
          richPrewarmEditorState,
          richPrewarmEditorTop,
          richTextWarmDistancePx,
          codeEditorWarmDistancePx,
          deferredEditorInitialState,
          nativeIoBeforeDeferred,
          nativeIoAfterDeferred,
          nativeIoAfterHot,
          codeMirrorIoStayedDeferred:
            nativeIoAfterDeferred === nativeIoBeforeDeferred,
          codeMirrorIoResumedOnce:
            nativeIoAfterHot === nativeIoBeforeDeferred + 1,
          nativeRoBeforeDeferred,
          nativeRoAfterDeferred,
          nativeRoAfterHot,
          codeMirrorRoStayedDeferred:
            nativeRoAfterDeferred === nativeRoBeforeDeferred,
          codeMirrorRoResumedOnce:
            nativeRoAfterHot === nativeRoBeforeDeferred + 1,
          codeMirrorIoDeferred,
          codeMirrorIoResumed,
          codeMirrorRoDeferred,
          codeMirrorRoResumed,
          richBlocksCold,
          richBlocksActivated,
          currentNodePreserved:
            first.current_node === expectedCurrentNode &&
            second.current_node === expectedCurrentNode &&
            third.current_node === expectedCurrentNode &&
            fourth.current_node === expectedCurrentNode,
          responseUrlPreserved:
            firstResponse.url === new URL(endpoint, location.href).href &&
            secondResponse.url === new URL(endpoint, location.href).href &&
            thirdResponse.url === new URL(endpoint, location.href).href,
          lazyInitialGetsAfterMutation: afterMutation.lazyInitialGets,
          legacyFullGetsAfterMutation: afterMutation.conversationGets,
          asyncSequentialNetworkGets: afterMutation.asyncConversationGets,
          emptyLegacyGets: afterMutation.emptyLegacyGets,
          emptyInitialGets: afterMutation.emptyInitialGets,
          emptyMessagesGets: afterMutation.emptyMessagesGets,
          mutations: afterMutation.mutations,
          largeConversationFlag:
            document.documentElement.dataset.chatgptPerformanceFix,
          virtualizationStyleInstalled: Boolean(
            document.querySelector("#chatgpt-performance-fix-style"),
          ),
        });
      } catch (error) {
        publish({
          ok: false,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
      }
    </script>
  </body>
</html>`;
}

function jsonNoStore(value: unknown): Response {
  return Response.json(value, {
    headers: { "cache-control": "no-store" },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const hasHarnessAuth = request.headers.get("authorization") === harnessAuthHeader;
    if (url.pathname === "/" || url.pathname === `/c/${conversationId}`) {
      return new Response(harnessHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === authSeedPath && request.method === "GET") {
      return jsonNoStore({ ok: true });
    }
    if (url.pathname === statusHistoryMessagesPath && request.method === "GET") {
      statusHistoryMessagesGets += 1;
      return jsonNoStore({
        messages: statusHistoryMessages,
        page_info: { has_previous_page: false, start_cursor: null },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === exactManualMessagesPath && request.method === "GET") {
      exactManualHistoryGets += 1;
      exactManualHistoryNumTurns.push(url.searchParams.get("num_turns") ?? "missing");
      return jsonNoStore({
        messages: exactManualMessages,
        page_info: {
          has_previous_page: true,
          start_cursor: "exact-server-next",
        },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === rateLimitedInitialPath && request.method === "GET") {
      rateLimitedInitialGets += 1;
      rateLimitedInitialNumTurns.push(url.searchParams.get("num_turns") ?? "missing");
      return new Response(JSON.stringify({ detail: "rate limited by harness" }), {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
          "retry-after": "120",
        },
      });
    }
    if (url.pathname === metadataInitialPath && request.method === "GET") {
      metadataInitialGets += 1;
      return jsonNoStore({
        title: "message metadata harness",
        conversation_id: metadataConversationId,
        current_node: metadataAssistantMessageId,
        async_status: null,
        messages: metadataMessages,
        page_info: { has_previous_page: false, start_cursor: null },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === "/backend-api/conversations" && request.method === "GET") {
      if (!hasHarnessAuth) {
        unauthorizedProbeGets += 1;
        return new Response(
          JSON.stringify({
            detail: { message: "Unauthorized - Access token is missing" },
          }),
          {
            status: 401,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json",
            },
          },
        );
      }
      authenticatedSidebarListProbeGets += 1;
      sidebarListGets += 1;
      return jsonNoStore({
        items: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "other conversation",
            update_time: Date.now() / 1000,
            async_status: null,
          },
        ],
        total: 1,
        limit: 28,
        offset: 0,
      });
    }
    if (url.pathname === sendPath && request.method === "POST") {
      sendPosts += 1;
      let hasUserMessage = false;
      try {
        const parsed = JSON.parse(await request.text()) as {
          messages?: Array<{ author?: { role?: string } }>;
        };
        hasUserMessage =
          parsed.messages?.some((message) => message.author?.role === "user") === true;
      } catch {
        // The false-positive regression intentionally sends a non-message body.
      }
      if (hasUserMessage) {
        await Bun.sleep(80);
        sentMessagePersisted = true;
        return jsonNoStore({
          messages: [
            {
              id: sentMessageId,
              author: { role: "user" },
              content: { content_type: "text", parts: [sentMessageText] },
              create_time: sentMessageCreateTime,
            },
            {
              id: sentAssistantMessageId,
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["streaming reply started"] },
              create_time: sentAssistantCreateTime,
              recipient: "all",
              channel: "final",
              metadata: { resolved_model_slug: "gpt-5-6-thinking" },
            },
          ],
        });
      }
      return jsonNoStore({ ok: true });
    }
    if (url.pathname === resumePath && request.method === "POST") {
      resumePosts += 1;
      return jsonNoStore({ ok: true, resumed: true });
    }
    if (
      (url.pathname === statusHistoryAsyncPath || url.pathname === currentAsyncStatusPath) &&
      request.method === "POST"
    ) {
      statusMutationPosts += 1;
      const rawBody = await request.text();
      let status: unknown;
      try {
        status = (JSON.parse(rawBody) as { status?: unknown }).status;
      } catch {
        const body = new URLSearchParams(rawBody);
        const rawStatus = body.get("status");
        status = rawStatus == null || rawStatus === "null" ? null : Number(rawStatus);
      }
      if (url.pathname === currentAsyncStatusPath) {
        sidebarAsyncStatus = status;
      }
      return jsonNoStore({ status: "OK" });
    }
    if (url.pathname === lazyInitialPath && request.method === "GET") {
      const numTurns = url.searchParams.get("num_turns");
      const includeMessageId = url.searchParams.get("include_message_id");
      if (numTurns === "1" && includeMessageId == null) {
        if (!hasHarnessAuth) {
          unauthorizedProbeGets += 1;
          return new Response(
            JSON.stringify({
              detail: { message: "Unauthorized - Access token is missing" },
            }),
            {
              status: 401,
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json",
              },
            },
          );
        }
        authenticatedSidebarDetailProbeGets += 1;
        return jsonNoStore({
          title: "fresh sidebar title",
          conversation_id: conversationId,
          current_node: payload.current_node,
          async_status: sidebarAsyncStatus,
          messages: [],
          page_info: { has_previous_page: true, start_cursor: "sidebar-probe" },
          safe_urls: [],
          blocked_urls: [],
        });
      }
      lazyInitialGets += 1;
      lazyInitialNumTurns.push(numTurns ?? "missing");
      if (includeMessageId) deliveryIncludeMessageIds.push(includeMessageId);
      if (includeMessageId) {
        if (!hasHarnessAuth) {
          unauthorizedProbeGets += 1;
          return new Response(
            JSON.stringify({
              detail: { message: "Unauthorized - Access token is missing" },
            }),
            {
              status: 401,
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json",
              },
            },
          );
        }
        authenticatedPersistenceProbeGets += 1;
      }
      if (sentMessagePersisted && url.searchParams.get("num_turns") === "4") {
        return jsonNoStore({
          title: "fresh sidebar title",
          conversation_id: conversationId,
          current_node: sentMessageId,
          async_status: sidebarAsyncStatus,
          messages: [
            {
              id: sentMessageId,
              author: { role: "user" },
              content: { content_type: "text", parts: [sentMessageText] },
              status: "finished_successfully",
            },
          ],
          page_info: { has_previous_page: false, start_cursor: null },
          safe_urls: [],
          blocked_urls: [],
        });
      }
      // Deliberately return only the tail of the latest turn. The userscript must
      // follow the cursor just far enough to recover the user/AI boundary.
      return jsonNoStore({
        title: "lazy initial harness",
        server_revision: mutations,
        conversation_id: conversationId,
        current_node: payload.current_node,
        async_status: null,
        messages: lazyInitialMessages.slice(-2),
        moderation_results: payload.moderation_results ?? [],
        page_info: {
          has_previous_page: true,
          start_cursor: "lazy-initial-fragment",
        },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === lazyMessagesPath && request.method === "GET") {
      lazyMessagesGets += 1;
      lazyMessagesNumTurns.push(url.searchParams.get("num_turns") ?? "missing");
      const before = url.searchParams.get("before");
      if (before === "lazy-initial-fragment") {
        return jsonNoStore({
          messages: lazyInitialMessages.slice(0, -2),
          page_info: {
            has_previous_page: true,
            start_cursor: "lazy-server-cursor",
          },
          safe_urls: [],
          blocked_urls: [],
        });
      }
      if (before === "lazy-server-cursor") {
        return jsonNoStore({
          messages: [lazyOlderMessages.at(-1)],
          page_info: {
            has_previous_page: true,
            start_cursor: "lazy-history-fragment",
          },
          safe_urls: [],
          blocked_urls: [],
        });
      }
      if (before === "lazy-history-fragment") {
        return jsonNoStore({
          messages: lazyOlderMessages.slice(0, -1),
          page_info: {
            has_previous_page: false,
            start_cursor: null,
          },
          safe_urls: [],
          blocked_urls: [],
        });
      }
      return jsonNoStore({
        messages: [],
        page_info: { has_previous_page: false, start_cursor: null },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === emptyInitialPath && request.method === "GET") {
      emptyInitialGets += 1;
      return jsonNoStore({
        title: "empty initial pagination harness",
        conversation_id: emptyConversationId,
        current_node: payload.current_node,
        async_status: null,
        messages: [],
        moderation_results: payload.moderation_results ?? [],
        page_info: {
          has_previous_page: true,
          start_cursor: "empty-page-cursor",
        },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === emptyMessagesPath && request.method === "GET") {
      emptyMessagesGets += 1;
      return jsonNoStore({
        messages: lazyInitialMessages,
        page_info: {
          has_previous_page: false,
          start_cursor: null,
        },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === emptyConversationPath && request.method === "GET") {
      emptyLegacyGets += 1;
      return new Response(conversationText, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    }
    if (url.pathname === richMessagesPath && request.method === "GET") {
      richMessagesGets += 1;
      return jsonNoStore({
        messages: nativeRichMessages,
        page_info: { has_previous_page: false, start_cursor: null },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === nativeInitialPath && request.method === "GET") {
      nativeInitialGets += 1;
      nativeInitialNumTurns.push(url.searchParams.get("num_turns") ?? "missing");
      return jsonNoStore({
        title: "native pagination harness",
        conversation_id: nativeConversationId,
        current_node: payload.current_node,
        messages: nativeInitialMessages,
        moderation_results: payload.moderation_results ?? [],
        page_info: {
          has_previous_page: true,
          start_cursor: "cursor-older",
        },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === nativeMessagesPath && request.method === "GET") {
      nativeMessagesGets += 1;
      nativeMessagesNumTurns.push(url.searchParams.get("num_turns") ?? "missing");
      const before = url.searchParams.get("before");
      if (before === "cursor-older") {
        return jsonNoStore({
          messages: [nativeOlderMessages.at(-1)],
          page_info: {
            has_previous_page: true,
            start_cursor: "native-history-fragment",
          },
          safe_urls: [],
          blocked_urls: [],
        });
      }
      if (before === "native-history-fragment") {
        return jsonNoStore({
          messages: nativeOlderMessages.slice(0, -1),
          page_info: {
            has_previous_page: false,
            start_cursor: null,
          },
          safe_urls: [],
          blocked_urls: [],
        });
      }
      return jsonNoStore({
        messages: nativeOlderMessages,
        page_info: { has_previous_page: false, start_cursor: null },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === asyncConversationPath && request.method === "GET") {
      asyncConversationGets += 1;
      const revision = asyncConversationGets;
      const stillActive = revision < 3;
      return jsonNoStore({
        title: `active progress ${revision}`,
        progress_revision: revision,
        conversation_id: "11111111-1111-4111-8111-111111111111",
        current_node: asyncCurrentMessageId,
        async_status: stillActive ? { status: "running" } : null,
        messages: asyncProgressMessages.map((message) =>
          message.id === asyncCurrentMessageId
            ? {
                ...message,
                status: stillActive ? "in_progress" : "finished_successfully",
                content: {
                  ...message.content,
                  parts: [`active progress ${revision}`],
                },
              }
            : message,
        ),
        page_info: { has_previous_page: false, start_cursor: null },
        safe_urls: [],
        blocked_urls: [],
      });
    }
    if (url.pathname === "/cdn/assets/2afb55f3-harness.js") {
      return new Response(
        "export function readVisibilityState(){return document.visibilityState}",
        { headers: { "content-type": "application/javascript; charset=utf-8" } },
      );
    }
    if (url.pathname === "/userscript.js") {
      return new Response(userscript, {
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    }
    if (url.pathname === fallbackConversationPath && request.method === "GET") {
      fallbackLegacyGets += 1;
      return new Response(fallbackConversationText, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    }
    if (url.pathname === rateLimitedConversationPath && request.method === "GET") {
      rateLimitedLegacyGets += 1;
      return new Response(conversationText, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    }
    if (url.pathname === conversationPath && request.method === "GET") {
      conversationGets += 1;
      await Bun.sleep(75);
      return new Response(conversationText, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
          "x-origin-request-number": String(conversationGets),
        },
      });
    }
    if (url.pathname === conversationPath && request.method === "PATCH") {
      mutations += 1;
      return jsonNoStore({ ok: true });
    }
    if (url.pathname === "/stats") {
      return jsonNoStore({
        conversationGets,
        asyncConversationGets,
        fallbackLegacyGets,
        emptyLegacyGets,
        emptyInitialGets,
        emptyMessagesGets,
        lazyInitialGets,
        lazyMessagesGets,
        nativeInitialGets,
        nativeMessagesGets,
        lazyInitialNumTurns,
        lazyMessagesNumTurns,
        nativeInitialNumTurns,
        nativeMessagesNumTurns,
        statusHistoryMessagesGets,
        statusMutationPosts,
        sidebarListGets,
        sendPosts,
        resumePosts,
        unauthorizedProbeGets,
        authenticatedSidebarListProbeGets,
        authenticatedSidebarDetailProbeGets,
        authenticatedPersistenceProbeGets,
        exactManualHistoryGets,
        exactManualHistoryNumTurns,
        rateLimitedLegacyGets,
        rateLimitedInitialGets,
        rateLimitedInitialNumTurns,
        metadataInitialGets,
        deliveryIncludeMessageIds,
        mutations,
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const profile = mkdtempSync(join(tmpdir(), "chatgpt-performance-fix-chrome-"));
let stderr = "";
let encoded: string | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;

class CdpClient {
  readonly socket: WebSocket;
  readonly events: Array<{ method?: string; params?: unknown }> = [];
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id == null) {
        if (
          message.method === "Runtime.exceptionThrown" ||
          message.method === "Runtime.consoleAPICalled"
        ) {
          this.events.push({ method: message.method, params: message.params });
        }
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "CDP command failed"));
      } else {
        pending.resolve(message.result);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("CDP socket closed"));
      }
      this.#pending.clear();
    });
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new CdpClient(socket)), {
        once: true,
      });
      socket.addEventListener(
        "error",
        () => reject(new Error(`Could not connect to ${url}`)),
        { once: true },
      );
    });
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function waitForDevToolsPort(): Promise<number> {
  const path = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const port = Number(readFileSync(path, "utf8").split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    await Bun.sleep(50);
  }
  throw new Error("Chrome did not publish DevToolsActivePort");
}

try {
  child = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stderrPromise = new Response(child.stderr).text();
  const port = await waitForDevToolsPort();
  const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
    response.json(),
  )) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
  const target = targets.find(
    (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl,
  );
  if (!target?.webSocketDebuggerUrl) throw new Error("No debuggable page target");

  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.call("Page.enable");
    await cdp.call("Runtime.enable");
    await cdp.call("Page.navigate", {
      url: `http://${server.hostname}:${server.port}/c/${conversationId}`,
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const evaluation = await cdp.call<{
        result?: { value?: unknown };
      }>("Runtime.evaluate", {
        expression:
          'document.querySelector(\'meta[name="harness-result"]\')?.content ?? null',
        returnByValue: true,
      });
      if (typeof evaluation.result?.value === "string") {
        encoded = evaluation.result.value;
        break;
      }
      await Bun.sleep(100);
    }
    if (!encoded) {
      const diagnostic = await cdp.call<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression: `JSON.stringify({
            readyState: document.readyState,
            status: document.querySelector('#status')?.textContent ?? null,
            href: location.href,
            datasets: {...document.documentElement.dataset}
          })`,
          returnByValue: true,
        },
      );
      throw new Error(
        `Browser harness timed out waiting for result. State=${String(
          diagnostic.result?.value ?? "unknown",
        )} Events=${JSON.stringify(cdp.events.slice(-8))}`,
      );
    }
  } finally {
    cdp.close();
  }

  child.kill();
  await child.exited;
  stderr = await stderrPromise;
} finally {
  if (child && child.exitCode == null) {
    child.kill();
    await child.exited.catch(() => undefined);
  }
  server.stop(true);
  rmSync(profile, { recursive: true, force: true });
}

if (!encoded) {
  throw new Error(`Browser harness did not publish a result.\n${stderr.slice(-4_000)}`);
}

const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
  ok: boolean;
  [key: string]: unknown;
};

const expected = {
  ok: true,
  normalVisibilityState: "visible",
  smoothedVisibilityState: "hidden",
  smoothedMarkdownBypass: "enabled",
  fallbackResponseHook: "enabled",
  fallbackFirstNodes: 35,
  fallbackSecondNodes: 35,
  fallbackTextNodes: 35,
  fallbackResponseUrlPreserved: true,
  fallbackOptimizedCount: 1,
  fallbackCacheHits: 2,
  fallbackOriginalNodes: 5_405,
  fallbackKeptNodes: 35,
  firstNodes: 5,
  lazyInitialVisibleRoles: ["user", "assistant"],
  nativeInitialVisibleRoles: ["user", "assistant", "user", "assistant"],
  secondNodes: 5,
  cachedNodes: 5,
  postInvalidationNodes: 5,
  postMutationSnapshotRefreshed: true,
  asyncFirstMessages: 2,
  asyncSecondMessages: 2,
  activeSequentialProgressFresh: true,
  activeResponsesMarkedLive: true,
  activeResponsesNotSnapshotted: true,
  completedActiveConversationPinned: true,
  emptyLazyNodes: 5,
  emptyLazyPaginationEnabled: true,
  emptyLazyHeader: "native-pagination",
  lazyPaginationEnabled: true,
  lazyInitialCursor: "lazy-server-cursor",
  lazyInitialHeader: "native-pagination",
  lazyInitialTurnsHeader: "2",
  lazyInitialOptimizationHeader: "53->4",
  lazyInitialCacheableHeader: "0",
  lazyOlderMessages: 2,
  lazyOlderRoles: ["user", "assistant"],
  lazyOlderAnswerChannel: "final",
  lazyOlderOptimizationHeader: "565->2",
  lazyInitialNetworkGetsAfterOpen: 1,
  lazyMessagesNetworkGetsAfterOpen: 1,
  lazyInitialNetworkGetsBeforeMutation: 1,
  lazyMessagesNetworkGetsBeforeMutation: 3,
  lazyInitialNumTurnsBeforeMutation: ["2"],
  lazyMessagesNumTurnsBeforeMutation: ["4", "2", "4"],
  legacyFullGetsBeforeMutation: 0,
  hourLaterInitialSnapshotHeader: "hit",
  hourLaterCurrentNodePreserved: true,
  automaticInitialRevalidationsServedLocally: true,
  initialSnapshotsStored: true,
  activeSnapshotsSkipped: true,
  rateLimitedFirstStatus: 429,
  rateLimitedSecondStatus: 429,
  rateLimitedSnapshotHeader: "rate-limit-backoff",
  rateLimitedInitialGets: 1,
  rateLimitedInitialNumTurns: ["2"],
  rateLimitedLegacyGets: 0,
  rateLimitRevalidationSuppressed: true,
  fallbackLegacyGets: 3,
  nativeInitialMessages: 6,
  nativeLocalMessages: 2,
  nativeOlderMessages: 2,
  nativeOlderRoles: ["user", "assistant"],
  nativeOlderAnswerChannel: "final",
  nativeOlderHasNoLocalCursor: true,
  richHistoryHasStaticMarkers: true,
  richHistoryFenceCount: 0,
  staticCodeHydrated: true,
  staticCodeReady: true,
  staticCodeNoCodeMirror: true,
  staticCodeHeightStable: true,
  nativeOlderCachedRoles: ["user", "assistant"],
  cachedHistoryCompletionSignal: true,
  historyIdleWaitForcedButBounded: true,
  historyCacheHits: 1,
  optimizerWorkerUsed: true,
  userTaskRanBeforeLocalHistory: true,
  nativeInitialKeepsServerCursor: true,
  nativeLocalYieldedAfterPaint: true,
  nativeInitialCurrentNodePreserved: true,
  nativeInitialResponseUrlPreserved: true,
  nativeInitialOptimizationHeader: "618->6",
  nativeLocalPageHeader: null,
  nativeOlderOptimizationHeader: "773->2",
  nativeInitialNetworkGets: 1,
  nativeMessagesNetworkGets: 2,
  nativeInitialNumTurns: ["2"],
  nativeMessagesNumTurns: ["2", "4"],
  statusMutationPreservedLocalCursor: true,
  statusHistoryMessagesGets: 1,
  statusMutationPosts: 2,
  historicalMessageMetadataRendered: true,
  historicalTimestampUsesServerCreateTime: true,
  resolvedModelPreferred: true,
  userModelInferredFromReply: true,
  metadataPlacementMatchesRole: true,
  metadataStyleInstalled: true,
  metadataMenuExists: true,
  metadataDomMountMadeNoRequests: true,
  metadataInitialGets: 1,
  backendRequestContextCaptured: true,
  noAutomaticSidebarRequests: true,
  idleSidebarDetailDidNotRepeat: true,
  idleSidebarListDidNotRepeatAtLegacyCadence: true,
  sidebarRefreshButtonExists: true,
  sidebarRefreshStyleInstalled: true,
  sidebarRefreshUsesIconAndText: true,
  sidebarOnlyHasRefreshButton: true,
  conversationRefreshUiRemoved: true,
  conversationRefreshMenuRemoved: true,
  sidebarRefreshIconPreserved: true,
  sidebarManualRefreshTriggered: true,
  authenticatedSidebarListProbeUsed: true,
  authenticatedSidebarDetailProbeUsed: true,
  noDeliveryPolling: true,
  unauthorizedProbeGets: 0,
  sidebarTitleFresh: true,
  sidebarHasNoCustomStatusDisplay: true,
  sidebarStillHasNoCustomStatusDisplay: true,
  sidebarListRefreshed: true,
  backgroundSendDidNotShowStatus: true,
  inlineSendingStatus: true,
  inlineAcceptedStatus: true,
  deliveryStatusInsideMessage: true,
  replyStartConfirmedSend: true,
  resumeDidNotRestartVerifier: true,
  sendVerified: true,
  deliveryIndicatorConfirmed: true,
  outgoingMetadataRendered: true,
  outgoingMetadataServerCorrected: true,
  sendPosts: 2,
  resumePosts: 1,
  tunedPaginationRootMargin: "80px 0px 0px 0px",
  historyButtonExists: true,
  historyButtonEnabledBeforeClick: true,
  historyButtonBusyAfterClick: true,
  historyButtonBusyAfterSettled: true,
  historyButtonBusyAfterBatchSettled: false,
  historyBatchSelectValue: "2",
  paginationCallsBeforeUserScroll: 0,
  paginationCallsAfterProgrammaticScroll: 0,
  paginationCallsAfterUserScroll: 0,
  paginationCallsAfterManualClick: 1,
  paginationCallsAfterFirstSettled: 2,
  rapidUpScrollDidNotAutoLoad: true,
  ordinaryEntryStillForwarded: true,
  sharedObserverPaginationBlocked: true,
  suppressedAutoPaginationCallbacksObserved: true,
  missingInitialEntryUsesManualFallback: true,
  lateIdButtonAppeared: true,
  removedControlWasRestored: true,
  lateClassificationStayedManual: true,
  detachedControlAbsentBeforeConnect: true,
  detachedControlAppearedAfterConnect: true,
  detachedClassificationStayedManual: true,
  finiteTwoTurnsExact: true,
  finiteTwoTurnsUsedLocalSecondPage: true,
  loadAllStarted: true,
  loadAllSurvivedSentinelReplacement: true,
  loadAllContinuedPastTwoPages: true,
  loadAllStoppedAtEnd: true,
  loadAllMessagesMenuExists: true,
  defaultDialogOpened: true,
  settingsDialogCancelCloses: true,
  settingsDialogDoesNotReopenAfterCancel: true,
  settingsDialogSaveCloses: true,
  settingsDialogDoesNotReopenAfterSave: true,
  historyMenuSettingSaved: true,
  manualHistoryClicks: 8,
  richStyleInstalled: true,
  richMessageContentVisibility: "visible",
  richSmoothedVisible: true,
  richClipExpanded: true,
  richOverlayHidden: true,
  richEditorContentVisibility: "visible",
  richEditorContentVisibilityAfterState: "visible",
  richTableContentVisibility: "visible",
  nativeResizeBefore: 0,
  nativeResizeAfterSmoothed: 0,
  nativeResizeAfterNormal: 1,
  skippedRichResizeObservers: 36,
  richEditorsCold: 5,
  richEditorsActivated: 3,
  richEditorState: "hot",
  richHotEditorState: "hot",
  richHotEditorContentVisibility: "visible",
  richColdEditorState: "cold",
  richColdEditorContentVisibility: "auto",
  richPrewarmEditorState: "hot",
  richPrewarmEditorTop: 2200,
  richTextWarmDistancePx: 8000,
  codeEditorWarmDistancePx: 3000,
  deferredEditorInitialState: "cold",
  codeMirrorIoStayedDeferred: true,
  codeMirrorIoResumedOnce: true,
  codeMirrorRoStayedDeferred: true,
  codeMirrorRoResumedOnce: true,
  codeMirrorIoDeferred: 1,
  codeMirrorIoResumed: 1,
  codeMirrorRoDeferred: 1,
  codeMirrorRoResumed: 1,
  richBlocksCold: 37,
  richBlocksActivated: 37,
  currentNodePreserved: true,
  responseUrlPreserved: true,
  lazyInitialGetsAfterMutation: 2,
  legacyFullGetsAfterMutation: 0,
  asyncSequentialNetworkGets: 3,
  emptyLegacyGets: 0,
  emptyInitialGets: 1,
  emptyMessagesGets: 1,
  mutations: 1,
  largeConversationFlag: "large",
  virtualizationStyleInstalled: true,
};

for (const [key, value] of Object.entries(expected)) {
  const actual = result[key];
  const matches =
    typeof value === "object" && value !== null
      ? JSON.stringify(actual) === JSON.stringify(value)
      : Object.is(actual, value);
  if (!matches) {
    throw new Error(
      `Browser harness assertion failed for ${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}\n${JSON.stringify(result, null, 2)}`,
    );
  }
}

mkdirSync("analysis/output", { recursive: true });
await Bun.write(
  "analysis/output/browser-harness.json",
  `${JSON.stringify(
    {
      chromeVersion: stderr.match(/Chrome\/[^\s]+/)?.[0] ?? "Google Chrome 151",
      result,
    },
    null,
    2,
  )}\n`,
);

console.log(JSON.stringify(result, null, 2));
