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
  "/backend-api/conversation/11111111-1111-4111-8111-111111111111";
const fallbackConversationId = "55555555-5555-4555-8555-555555555555";
const fallbackConversationPath =
  `/backend-api/conversation/${fallbackConversationId}`;
const emptyConversationId = "44444444-4444-4444-8444-444444444444";
const emptyConversationPath = `/backend-api/conversation/${emptyConversationId}`;
const emptyInitialPath = `/backend-api/conversations/${emptyConversationId}`;
const emptyMessagesPath = `${emptyInitialPath}/messages`;
const asyncConversationText = JSON.stringify({
  ...payload,
  conversation_id: "11111111-1111-4111-8111-111111111111",
  async_status: { status: "running" },
});
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
    <pre id="status">running</pre>
    <script type="module">
      const endpoint = ${JSON.stringify(conversationPath)};
      const asyncEndpoint = ${JSON.stringify(asyncConversationPath)};
      const fallbackEndpoint = ${JSON.stringify(fallbackConversationPath)};
      const emptyEndpoint = ${JSON.stringify(emptyConversationPath)};
      const lazyMessagesEndpoint = ${JSON.stringify(lazyMessagesPath)};
      const nativeInitialEndpoint = ${JSON.stringify(nativeInitialPath)};
      const nativeMessagesEndpoint = ${JSON.stringify(nativeMessagesPath)};
      const richMessagesEndpoint = ${JSON.stringify(richMessagesPath)};
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

        await fetch(endpoint + "/touch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const fourthResponse = await fetch(endpoint);
        const fourth = await fourthResponse.json();

        const asyncFirst = await fetch(asyncEndpoint).then((response) => response.json());
        const asyncSecond = await fetch(asyncEndpoint).then((response) => response.json());

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

        const nativeOlderUrl =
          nativeMessagesEndpoint +
          "?before=" +
          encodeURIComponent(nativeLocal.page_info.start_cursor) +
          "&include_has_versions=true&num_turns=20";
        const nativeOlderResponse = await fetch(nativeOlderUrl);
        const nativeOlder = await nativeOlderResponse.json();
        const nativeOlderCachedResponse = await fetch(nativeOlderUrl);
        const nativeOlderCached = await nativeOlderCachedResponse.json();
        const nativeOlderHasNoLocalCursor =
          nativeOlder.page_info.start_cursor == null &&
          nativeOlder.page_info.has_previous_page === false;
        const nativeOlderRoles = nativeOlder.messages.map(
          (message) => message.author?.role ?? null,
        );
        const nativeOlderAnswerChannel = nativeOlder.messages[1]?.channel ?? null;

        const richResponse = await fetch(
          richMessagesEndpoint +
            "?before=rich-cursor&include_has_versions=true&num_turns=20",
        );
        const richPage = await richResponse.json();
        const richAssistant = richPage.messages.find(
          (message) => message.author?.role === "assistant",
        );
        const richAssistantText = Array.isArray(richAssistant?.content?.parts)
          ? richAssistant.content.parts.filter((part) => typeof part === "string").join("\n")
          : "";
        const staticLinks = [
          ...richAssistantText.matchAll(/\((https:\/\/chatgpt\.com\/#cgptperf-code=[^)]+)\)/g),
        ].map((match) => match[1]);
        const richHistoryHasStaticMarkers = staticLinks.length >= 4;
        const richHistoryFenceCount = (richAssistantText.match(/```/g) ?? []).length;
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
        window.dispatchEvent(
          new CustomEvent("chatgpt-performance-fix:history-page-settled"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        const historyButtonBusyAfterSettled =
          historyButton?.getAttribute("aria-busy") === "true";
        paginationObserver.disconnect();

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

        const afterMutation = await fetch("/stats").then((response) => response.json());

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
          asyncFirstNodes: Object.keys(asyncFirst.mapping).length,
          asyncSecondNodes: Object.keys(asyncSecond.mapping).length,
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
          historyCacheHits: Number(
            document.documentElement.dataset.chatgptHistoryCacheHits ?? "0",
          ),
          optimizerWorkerUsed: jsonWorkerParses > 0,
          userTaskRanBeforeLocalHistory,
          nativeInitialUsesLocalCursor:
            typeof localCursor === "string" && localCursor.startsWith("cgptperf-"),
          nativeLocalRestoresServerCursor:
            nativeLocal.page_info.start_cursor === "cursor-older",
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
          tunedPaginationRootMargin,
          historyButtonExists,
          historyButtonEnabledBeforeClick,
          historyButtonBusyAfterClick,
          historyButtonBusyAfterSettled,
          paginationCallsBeforeUserScroll,
          paginationCallsAfterProgrammaticScroll,
          paginationCallsAfterUserScroll,
          paginationCallsAfterManualClick,
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
    if (url.pathname === "/") {
      return new Response(harnessHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === lazyInitialPath && request.method === "GET") {
      lazyInitialGets += 1;
      lazyInitialNumTurns.push(url.searchParams.get("num_turns") ?? "missing");
      // Deliberately return only the tail of the latest turn. The userscript must
      // follow the cursor just far enough to recover the user/AI boundary.
      return jsonNoStore({
        title: "lazy initial harness",
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
      return new Response(asyncConversationText, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
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
    if (
      url.pathname === `${conversationPath}/touch` &&
      request.method === "POST"
    ) {
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
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id == null) return;
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
      url: `http://${server.hostname}:${server.port}/`,
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
    if (!encoded) throw new Error("Browser harness timed out waiting for result");
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
  nativeInitialVisibleRoles: ["user", "assistant"],
  secondNodes: 5,
  cachedNodes: 5,
  postInvalidationNodes: 5,
  asyncFirstNodes: 35,
  asyncSecondNodes: 35,
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
  lazyInitialNetworkGetsAfterOpen: 2,
  lazyMessagesNetworkGetsAfterOpen: 2,
  lazyInitialNetworkGetsBeforeMutation: 2,
  lazyMessagesNetworkGetsBeforeMutation: 4,
  lazyInitialNumTurnsBeforeMutation: ["2", "2"],
  lazyMessagesNumTurnsBeforeMutation: ["4", "4", "2", "4"],
  legacyFullGetsBeforeMutation: 0,
  fallbackLegacyGets: 3,
  nativeInitialMessages: 4,
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
  historyCacheHits: 1,
  optimizerWorkerUsed: true,
  userTaskRanBeforeLocalHistory: true,
  nativeInitialUsesLocalCursor: true,
  nativeLocalRestoresServerCursor: true,
  nativeLocalYieldedAfterPaint: true,
  nativeInitialCurrentNodePreserved: true,
  nativeInitialResponseUrlPreserved: true,
  nativeInitialOptimizationHeader: "618->6",
  nativeLocalPageHeader: "1/1",
  nativeOlderOptimizationHeader: "773->2",
  nativeInitialNetworkGets: 1,
  nativeMessagesNetworkGets: 2,
  nativeInitialNumTurns: ["2"],
  nativeMessagesNumTurns: ["2", "4"],
  tunedPaginationRootMargin: "80px 0px 0px 0px",
  historyButtonExists: true,
  historyButtonEnabledBeforeClick: true,
  historyButtonBusyAfterClick: true,
  historyButtonBusyAfterSettled: false,
  paginationCallsBeforeUserScroll: 0,
  paginationCallsAfterProgrammaticScroll: 0,
  paginationCallsAfterUserScroll: 0,
  paginationCallsAfterManualClick: 1,
  manualHistoryClicks: 1,
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
  lazyInitialGetsAfterMutation: 3,
  legacyFullGetsAfterMutation: 0,
  asyncSequentialNetworkGets: 2,
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
