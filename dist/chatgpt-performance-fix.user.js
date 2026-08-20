// ==UserScript==
// @name         ChatGPT Performance Fix
// @name:zh-CN   ChatGPT 性能优化
// @namespace    local.chatgpt.performance.fix
// @version      0.1.0
// @description  Improve ChatGPT performance on long conversations.
// @description:zh-CN 改善 ChatGPT 长会话性能。
// @author       Local
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

(() => {
  // src/optimizer.ts
  var DEFAULT_OPTIMIZER_OPTIONS = {
    minNodeCount: 250,
    recentFullTurns: 1
  };
  var ALWAYS_KEEP_ROLES = new Set(["system", "developer"]);
  var KNOWN_INTERNAL_CONTENT_TYPES = new Set([
    "code",
    "execution_output",
    "thoughts"
  ]);
  function serializedBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
  function messageKind(message) {
    if (!message)
      return "root/no-message";
    return `${message.author?.role ?? "unknown"}/${message.content?.content_type ?? "unknown"}`;
  }
  function kindOf(node) {
    return messageKind(node.message);
  }
  function makeStats(reason, partial = {}) {
    return {
      changed: reason === "optimized",
      reason,
      originalNodes: 0,
      activePathNodes: 0,
      keptNodes: 0,
      removedOffPathNodes: 0,
      removedHistoricNodes: 0,
      userTurns: 0,
      recentFullTurns: 0,
      removedByKind: {},
      ...partial
    };
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isAlreadyPaginated(payload) {
    if ("__paginatedConversationPage" in payload)
      return true;
    const mapping = payload.mapping;
    return Boolean(mapping && Object.keys(mapping).some((id) => id.startsWith("paginated-root:")));
  }
  function shouldKeepHistoricMessage(message) {
    if (!message)
      return true;
    if (message.metadata?.is_visually_hidden_from_conversation === true) {
      return false;
    }
    const role = message.author?.role;
    if (role === "user" || role && ALWAYS_KEEP_ROLES.has(role))
      return true;
    if (role === "tool")
      return false;
    if (role !== "assistant")
      return true;
    if (message.channel === "final")
      return true;
    if (message.recipient != null && message.recipient !== "all")
      return false;
    const contentType = message.content?.content_type;
    return !contentType || !KNOWN_INTERNAL_CONTENT_TYPES.has(contentType);
  }
  function shouldKeepHistoricNode(node) {
    return shouldKeepHistoricMessage(node.message);
  }
  function traceActivePath(mapping, currentNode) {
    const reversePath = [];
    const seen = new Set;
    let id = currentNode;
    while (id != null) {
      if (seen.has(id))
        return null;
      seen.add(id);
      const node = mapping[id];
      if (!node)
        return null;
      reversePath.push({ id, node });
      id = node.parent;
    }
    reversePath.reverse();
    return reversePath;
  }
  function optimizeConversationPayload(payload, options = {}) {
    const resolved = {
      ...DEFAULT_OPTIMIZER_OPTIONS,
      ...options,
      minNodeCount: Math.max(0, Math.floor(options.minNodeCount ?? DEFAULT_OPTIMIZER_OPTIONS.minNodeCount)),
      recentFullTurns: Math.max(0, Math.floor(options.recentFullTurns ?? DEFAULT_OPTIMIZER_OPTIONS.recentFullTurns))
    };
    if (!isRecord(payload) || !isRecord(payload.mapping)) {
      return { payload, stats: makeStats("invalid-payload") };
    }
    const mapping = payload.mapping;
    const originalNodes = Object.keys(mapping).length;
    if (isAlreadyPaginated(payload)) {
      return {
        payload,
        stats: makeStats("already-paginated", {
          originalNodes,
          keptNodes: originalNodes,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    if (originalNodes < resolved.minNodeCount) {
      return {
        payload,
        stats: makeStats("below-threshold", {
          originalNodes,
          keptNodes: originalNodes,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    if (typeof payload.current_node !== "string") {
      return {
        payload,
        stats: makeStats("invalid-payload", {
          originalNodes,
          keptNodes: originalNodes,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    const activePath = traceActivePath(mapping, payload.current_node);
    if (!activePath || activePath.length === 0) {
      return {
        payload,
        stats: makeStats("invalid-active-path", {
          originalNodes,
          keptNodes: originalNodes,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    const userTurns = activePath.reduce((count, { node }) => count + (node.message?.author?.role === "user" ? 1 : 0), 0);
    const firstFullTurnIndex = Math.max(0, userTurns - resolved.recentFullTurns);
    const kept = [];
    const removedByKind = {};
    let currentTurnIndex = -1;
    for (const entry of activePath) {
      if (entry.node.message?.author?.role === "user")
        currentTurnIndex += 1;
      const inRecentFullTurn = resolved.recentFullTurns > 0 && currentTurnIndex >= firstFullTurnIndex;
      const keep = inRecentFullTurn || shouldKeepHistoricNode(entry.node);
      if (keep || entry.id === payload.current_node) {
        kept.push(entry);
      } else {
        const kind = kindOf(entry.node);
        removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
      }
    }
    const removedOffPathNodes = originalNodes - activePath.length;
    const removedHistoricNodes = activePath.length - kept.length;
    if (removedOffPathNodes <= 0 && removedHistoricNodes <= 0) {
      return {
        payload,
        stats: makeStats("no-reduction", {
          originalNodes,
          activePathNodes: activePath.length,
          keptNodes: originalNodes,
          userTurns,
          recentFullTurns: resolved.recentFullTurns
        })
      };
    }
    const compactMapping = {};
    for (let index = 0;index < kept.length; index += 1) {
      const { id, node } = kept[index];
      const previousId = kept[index - 1]?.id ?? null;
      const nextId = kept[index + 1]?.id;
      compactMapping[id] = {
        ...node,
        id: node.id ?? id,
        parent: previousId,
        children: nextId ? [nextId] : []
      };
    }
    const keptMessageIds = new Set(kept.map(({ node }) => node.message?.id).filter((id) => typeof id === "string"));
    const moderationResults = Array.isArray(payload.moderation_results) ? payload.moderation_results.filter((result) => typeof result.message_id !== "string" || keptMessageIds.has(result.message_id)) : payload.moderation_results;
    const optimizedPayload = {
      ...payload,
      mapping: compactMapping,
      current_node: kept.at(-1)?.id ?? payload.current_node,
      ...moderationResults === undefined ? {} : { moderation_results: moderationResults }
    };
    return {
      payload: optimizedPayload,
      stats: makeStats("optimized", {
        originalNodes,
        activePathNodes: activePath.length,
        keptNodes: kept.length,
        removedOffPathNodes,
        removedHistoricNodes,
        userTurns,
        recentFullTurns: resolved.recentFullTurns,
        removedByKind
      })
    };
  }
  function collapseToQuestionAnswerPairs(messages, forceKeepMessageIds = new Set) {
    if (!messages.some((message) => message.author?.role === "user"))
      return messages;
    const collapsed = [];
    let turn = [];
    const flushTurn = () => {
      if (turn.length === 0)
        return;
      const user = turn.find((message) => message.author?.role === "user");
      const assistantCandidates = turn.filter((message) => message.author?.role === "assistant" && shouldKeepHistoricMessage(message));
      const answer = [...assistantCandidates].reverse().find((message) => message.channel === "final") ?? assistantCandidates.at(-1);
      if (!user || !answer) {
        collapsed.push(...turn);
        turn = [];
        return;
      }
      const selected = new Set([user, answer]);
      for (const message of turn) {
        if (typeof message.id === "string" && forceKeepMessageIds.has(message.id)) {
          selected.add(message);
        }
      }
      collapsed.push(...turn.filter((message) => selected.has(message)));
      turn = [];
    };
    for (const message of messages) {
      if (message.author?.role === "user")
        flushTurn();
      if (turn.length > 0 || message.author?.role === "user")
        turn.push(message);
    }
    flushTurn();
    return collapsed.length > 0 ? collapsed : messages;
  }
  function optimizePaginatedConversationPayload(payload, options = {}) {
    const messages = Array.isArray(payload.messages) ? payload.messages : null;
    if (!messages) {
      return {
        payload,
        stats: {
          changed: false,
          originalMessages: 0,
          keptMessages: 0,
          removedMessages: 0,
          originalBytes: 0,
          keptBytes: 0,
          userTurns: 0,
          recentFullTurns: 0,
          removedByKind: {}
        }
      };
    }
    const recentFullTurns = Math.max(0, Math.floor(options.recentFullTurns ?? 0));
    const forcedIds = new Set(options.forceKeepMessageIds ?? []);
    const userTurns = messages.reduce((count, message) => count + (message.author?.role === "user" ? 1 : 0), 0);
    const preserveEverything = recentFullTurns > 0 && userTurns === 0;
    const firstFullTurnIndex = Math.max(0, userTurns - recentFullTurns);
    let kept = [];
    const removedByKind = {};
    let currentTurnIndex = -1;
    for (const message of messages) {
      if (message.author?.role === "user")
        currentTurnIndex += 1;
      const id = message.id;
      const inRecentFullTurn = recentFullTurns > 0 && currentTurnIndex >= firstFullTurnIndex;
      const keep = preserveEverything || typeof id === "string" && forcedIds.has(id) || inRecentFullTurn || shouldKeepHistoricMessage(message);
      if (keep) {
        kept.push(message);
      } else {
        const kind = messageKind(message);
        removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
      }
    }
    if (options.collapseTurnsToQuestionAnswer === true && recentFullTurns === 0 && userTurns > 0) {
      const collapsed = collapseToQuestionAnswerPairs(kept, forcedIds);
      if (collapsed.length < kept.length) {
        const retained = new Set(collapsed);
        for (const message of kept) {
          if (retained.has(message))
            continue;
          const kind = messageKind(message);
          removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
        }
        kept = collapsed;
      }
    }
    if (messages.length > 0 && kept.length === 0) {
      const fallback = messages.at(-1);
      kept.push(fallback);
      const kind = messageKind(fallback);
      if (removedByKind[kind] != null) {
        removedByKind[kind] -= 1;
        if (removedByKind[kind] <= 0)
          delete removedByKind[kind];
      }
    }
    const keptIds = new Set(kept.map((message) => message.id).filter((id) => typeof id === "string"));
    const moderationResults = Array.isArray(payload.moderation_results) ? payload.moderation_results.filter((result) => typeof result.message_id !== "string" || keptIds.has(result.message_id)) : payload.moderation_results;
    const originalBytes = messages.reduce((sum, message) => sum + serializedBytes(message), 0);
    const keptBytes = kept.reduce((sum, message) => sum + serializedBytes(message), 0);
    const changed = kept.length !== messages.length;
    return {
      payload: changed ? {
        ...payload,
        messages: kept,
        ...moderationResults === undefined ? {} : { moderation_results: moderationResults }
      } : payload,
      stats: {
        changed,
        originalMessages: messages.length,
        keptMessages: kept.length,
        removedMessages: messages.length - kept.length,
        originalBytes,
        keptBytes,
        userTurns,
        recentFullTurns,
        removedByKind
      }
    };
  }
  function convertNativeInitialToLazyConversation(payload, conversationId, numTurns) {
    const messages = Array.isArray(payload.messages) ? payload.messages : null;
    if (!messages || messages.length === 0)
      return null;
    const ids = new Set;
    for (const message of messages) {
      if (typeof message.id !== "string" || message.id.length === 0 || ids.has(message.id)) {
        return null;
      }
      ids.add(message.id);
    }
    const rootId = `paginated-root:${conversationId}`;
    if (ids.has(rootId))
      return null;
    const mapping = {
      [rootId]: {
        id: rootId,
        parent: "",
        children: messages[0]?.id ? [messages[0].id] : []
      }
    };
    for (let index = 0;index < messages.length; index += 1) {
      const message = messages[index];
      const id = message.id;
      const previousId = messages[index - 1]?.id ?? rootId;
      const nextId = messages[index + 1]?.id;
      mapping[id] = {
        id,
        message,
        parent: previousId,
        children: nextId ? [nextId] : []
      };
    }
    const messagesLeafToRoot = [...messages].reverse();
    const moderationResults = Array.isArray(payload.moderation_results) ? payload.moderation_results : [];
    const safeUrls = Array.isArray(payload.safe_urls) ? payload.safe_urls : [];
    const blockedUrls = Array.isArray(payload.blocked_urls) ? payload.blocked_urls : [];
    const cursor = payload.page_info?.has_previous_page === true && typeof payload.page_info.start_cursor === "string" && payload.page_info.start_cursor.length > 0 ? payload.page_info.start_cursor : null;
    const serverCurrentLeafId = typeof payload.current_node === "string" ? payload.current_node : null;
    const newestMessageId = messagesLeafToRoot[0]?.id ?? rootId;
    const currentNode = serverCurrentLeafId != null && Object.hasOwn(mapping, serverCurrentLeafId) ? serverCurrentLeafId : newestMessageId;
    const {
      messages: _messages,
      page_info: _pageInfo,
      moderation_results: _moderationResults,
      ...metadata
    } = payload;
    return {
      ...metadata,
      current_node: currentNode,
      mapping,
      moderation_results: moderationResults,
      __paginatedConversationPage: {
        blockedUrls,
        cursor,
        messagesLeafToRoot,
        moderationResults,
        numTurns: Math.max(1, Math.floor(numTurns)),
        oldestMessageId: messagesLeafToRoot.at(-1)?.id ?? null,
        safeUrls,
        serverCurrentLeafId
      }
    };
  }
  function splitPaginatedMessagesNewestFirst(messages, options = {}) {
    if (messages.length === 0)
      return [];
    const maxTurns = Math.max(1, Math.floor(options.maxTurns ?? 1));
    const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? 16));
    const maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? 128 * 1024));
    const allowSplitTurns = options.allowSplitTurns ?? true;
    const turns = [];
    let currentTurn = [];
    for (const message of messages) {
      if (message.author?.role === "user" && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }
      currentTurn.push(message);
    }
    if (currentTurn.length > 0)
      turns.push(currentTurn);
    const atomicSegments = [];
    for (const turn of turns) {
      const turnBytes = turn.reduce((sum, message) => sum + serializedBytes(message), 0);
      if (!allowSplitTurns || turn.length <= maxMessages && turnBytes <= maxBytes) {
        atomicSegments.push({ messages: turn, startsTurn: true, bytes: turnBytes });
        continue;
      }
      const splitNewestFirst = [];
      let segment = [];
      let segmentBytes = 0;
      for (let index = turn.length - 1;index >= 0; index -= 1) {
        const message = turn[index];
        const bytes = serializedBytes(message);
        if (segment.length > 0 && (segment.length + 1 > maxMessages || segmentBytes + bytes > maxBytes)) {
          splitNewestFirst.push({ messages: segment, bytes: segmentBytes });
          segment = [];
          segmentBytes = 0;
        }
        segment.unshift(message);
        segmentBytes += bytes;
      }
      if (segment.length > 0) {
        splitNewestFirst.push({ messages: segment, bytes: segmentBytes });
      }
      const chronologicalSegments = splitNewestFirst.reverse();
      for (let index = 0;index < chronologicalSegments.length; index += 1) {
        const item = chronologicalSegments[index];
        atomicSegments.push({
          ...item,
          startsTurn: index === 0
        });
      }
    }
    const chunksNewestFirst = [];
    let chunk = [];
    let chunkBytes = 0;
    let chunkTurns = 0;
    for (let index = atomicSegments.length - 1;index >= 0; index -= 1) {
      const segment = atomicSegments[index];
      const nextTurns = chunkTurns + (segment.startsTurn ? 1 : 0);
      const exceeds = chunk.length > 0 && (nextTurns > maxTurns || chunk.length + segment.messages.length > maxMessages || chunkBytes + segment.bytes > maxBytes);
      if (exceeds) {
        chunksNewestFirst.push(chunk);
        chunk = [];
        chunkBytes = 0;
        chunkTurns = 0;
      }
      chunk = [...segment.messages, ...chunk];
      chunkBytes += segment.bytes;
      chunkTurns += segment.startsTurn ? 1 : 0;
    }
    if (chunk.length > 0)
      chunksNewestFirst.push(chunk);
    return chunksNewestFirst;
  }
  function matchConversationApiUrl(rawUrl, baseUrl) {
    try {
      const pathname = new URL(rawUrl, baseUrl).pathname;
      const legacy = pathname.match(/^\/backend-api\/conversation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
      if (legacy) {
        return { kind: "legacy-full", conversationId: legacy[1] };
      }
      const paginated = pathname.match(/^\/backend-api\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/messages)?\/?$/i);
      if (!paginated)
        return null;
      return {
        kind: paginated[2] ? "paginated-messages" : "paginated-initial",
        conversationId: paginated[1]
      };
    } catch {
      return null;
    }
  }
  function clampPaginatedNumTurns(rawUrl, baseUrl, maxTurns) {
    const url = new URL(rawUrl, baseUrl);
    const match = matchConversationApiUrl(url.href, baseUrl);
    if (!match || match.kind === "legacy-full")
      return url.href;
    const limit = Math.max(1, Math.floor(maxTurns));
    const requested = Number(url.searchParams.get("num_turns"));
    if (!Number.isFinite(requested) || requested <= 0 || requested > limit) {
      url.searchParams.set("num_turns", String(limit));
    }
    return url.href;
  }

  // src/chatgpt-performance-fix.user.ts
  var SCRIPT_NAME = "ChatGPT Long Conversation Performance Fix";
  var SETTINGS_KEY = "chatgpt-performance-fix:settings:v1";
  var FULL_ONCE_PREFIX = "chatgpt-performance-fix:full-once:";
  var CACHE_TTL_MS = 20000;
  var MODE_OPTIONS = {
    balanced: {
      minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
      recentFullTurns: 1,
      lazyInitialTurns: 2,
      paginatedMaxTurns: 2,
      paginatedRenderTurns: 1,
      richTextWarmDistancePx: 8000
    },
    aggressive: {
      minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
      recentFullTurns: 0,
      lazyInitialTurns: 2,
      paginatedMaxTurns: 2,
      paginatedRenderTurns: 1,
      richTextWarmDistancePx: 5000
    }
  };
  function readSettings(storage) {
    try {
      const value = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "null");
      if (value?.mode === "off" || value?.mode === "aggressive") {
        return { mode: value.mode };
      }
      return { mode: "balanced" };
    } catch {
      return { mode: "balanced" };
    }
  }
  function yieldUntilInteractionIdle(pageWindow) {
    return new Promise((resolve) => {
      const afterPaint = () => {
        pageWindow.setTimeout(() => {
          if (typeof pageWindow.requestIdleCallback !== "function") {
            resolve();
            return;
          }
          const waitForUsefulIdleBudget = () => {
            pageWindow.requestIdleCallback((deadline) => {
              if (deadline.timeRemaining() >= 12) {
                resolve();
                return;
              }
              waitForUsefulIdleBudget();
            });
          };
          waitForUsefulIdleBudget();
        }, 0);
      };
      if (pageWindow.document.visibilityState === "hidden" || typeof pageWindow.requestAnimationFrame !== "function") {
        afterPaint();
      } else {
        pageWindow.requestAnimationFrame(afterPaint);
      }
    });
  }
  function rewriteGetRequest(pageWindow, input, init, rewrittenUrl) {
    const requestLike = input;
    if (typeof requestLike.method !== "string" || requestLike.headers == null) {
      return [rewrittenUrl, init];
    }
    const rewrittenInit = {
      method: "GET",
      headers: requestLike.headers,
      credentials: requestLike.credentials,
      cache: requestLike.cache,
      redirect: requestLike.redirect,
      referrer: requestLike.referrer,
      referrerPolicy: requestLike.referrerPolicy,
      integrity: requestLike.integrity,
      keepalive: requestLike.keepalive,
      mode: requestLike.mode,
      signal: requestLike.signal,
      ...init
    };
    return [new pageWindow.URL(rewrittenUrl).href, rewrittenInit];
  }
  function installManualPaginationObserver(pageWindow) {
    const marker = "__chatgptPerformanceFixIntersectionObserver";
    if (Reflect.get(pageWindow, marker))
      return;
    const NativeIntersectionObserver = pageWindow.IntersectionObserver;
    if (typeof NativeIntersectionObserver !== "function")
      return;
    const HISTORY_SETTLED_EVENT = "chatgpt-performance-fix:history-page-settled";

    class TunedIntersectionObserver {
      callback;
      options;
      observer;
      isPaginationObserver = false;
      lastPaginationEntries;
      control;
      button;
      loading = false;
      fallbackResetTimer;
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
      }
      updateButton() {
        if (!this.button)
          return;
        const canLoad = Boolean(this.lastPaginationEntries?.some((entry) => entry.isIntersecting));
        this.button.disabled = this.loading || !canLoad;
        this.button.textContent = this.loading ? "加载中…" : "加载更多";
        this.button.setAttribute("aria-busy", this.loading ? "true" : "false");
        this.button.title = canLoad ? "加载更多历史消息" : "滚到顶部后可加载更多";
      }
      resetLoading = () => {
        this.loading = false;
        if (this.fallbackResetTimer != null) {
          pageWindow.clearTimeout(this.fallbackResetTimer);
          this.fallbackResetTimer = undefined;
        }
        this.updateButton();
      };
      onHistorySettled = () => {
        if (!this.loading)
          return;
        this.resetLoading();
      };
      triggerManualLoad = () => {
        const entries = this.lastPaginationEntries;
        if (this.loading || !entries?.some((entry) => entry.isIntersecting)) {
          return;
        }
        this.loading = true;
        this.updateButton();
        const root = pageWindow.document.documentElement;
        const clicks = Number(root.dataset.chatgptManualHistoryClicks ?? "0");
        root.dataset.chatgptManualHistoryClicks = String(clicks + 1);
        this.callback(entries, this);
        this.fallbackResetTimer = pageWindow.setTimeout(this.resetLoading, 8000);
      };
      installControl(target) {
        if (this.control?.isConnected)
          return;
        const control = pageWindow.document.createElement("div");
        control.dataset.chatgptHistoryLoadControl = "true";
        control.style.cssText = [
          "display:flex",
          "justify-content:center",
          "align-items:center",
          "padding:10px 0 14px",
          "min-height:48px",
          "position:relative",
          "z-index:2"
        ].join(";");
        const button = pageWindow.document.createElement("button");
        button.type = "button";
        button.dataset.chatgptHistoryLoadButton = "true";
        button.style.cssText = [
          "appearance:none",
          "border:1px solid var(--border-light,rgba(127,127,127,.24))",
          "border-radius:999px",
          "padding:7px 13px",
          "font:500 13px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
          "background:var(--main-surface-secondary,rgba(127,127,127,.10))",
          "color:var(--text-primary,inherit)",
          "cursor:pointer",
          "box-shadow:0 1px 2px rgba(0,0,0,.06)"
        ].join(";");
        button.addEventListener("click", this.triggerManualLoad);
        control.append(button);
        target.insertAdjacentElement("afterend", control);
        this.control = control;
        this.button = button;
        pageWindow.addEventListener(HISTORY_SETTLED_EVENT, this.onHistorySettled);
        this.updateButton();
      }
      dispatchNative(entries) {
        if (!this.isPaginationObserver) {
          this.callback(entries, this);
          return;
        }
        this.lastPaginationEntries = entries;
        this.updateButton();
        if (!entries.some((entry) => entry.isIntersecting)) {
          this.callback(entries, this);
        }
      }
      ensureObserver(target) {
        if (this.observer)
          return this.observer;
        this.isPaginationObserver = target instanceof pageWindow.Element && target.matches('[data-testid="conversation-pagination-sentinel"]');
        if (this.isPaginationObserver)
          this.installControl(target);
        this.observer = new NativeIntersectionObserver((entries) => this.dispatchNative(entries), this.options);
        return this.observer;
      }
      observe(target) {
        this.ensureObserver(target).observe(target);
      }
      unobserve(target) {
        this.observer?.unobserve(target);
      }
      disconnect() {
        this.observer?.disconnect();
        if (this.fallbackResetTimer != null) {
          pageWindow.clearTimeout(this.fallbackResetTimer);
        }
        pageWindow.removeEventListener(HISTORY_SETTLED_EVENT, this.onHistorySettled);
        this.button?.removeEventListener("click", this.triggerManualLoad);
        this.control?.remove();
        this.control = undefined;
        this.button = undefined;
        this.lastPaginationEntries = undefined;
      }
      takeRecords() {
        return this.observer?.takeRecords() ?? [];
      }
      get root() {
        return this.observer?.root ?? this.options?.root ?? null;
      }
      get rootMargin() {
        return this.observer?.rootMargin ?? this.options?.rootMargin ?? "0px 0px 0px 0px";
      }
      get thresholds() {
        if (this.observer)
          return this.observer.thresholds;
        const threshold = this.options?.threshold;
        if (Array.isArray(threshold))
          return [...threshold].sort((a, b) => a - b);
        return [typeof threshold === "number" ? threshold : 0];
      }
    }
    try {
      Object.setPrototypeOf(TunedIntersectionObserver.prototype, NativeIntersectionObserver.prototype);
      Object.setPrototypeOf(TunedIntersectionObserver, NativeIntersectionObserver);
      Object.defineProperty(TunedIntersectionObserver, "name", {
        value: "IntersectionObserver"
      });
      Object.defineProperty(pageWindow, "IntersectionObserver", {
        configurable: true,
        writable: true,
        value: TunedIntersectionObserver
      });
      Reflect.set(pageWindow, marker, true);
      pageWindow.document.documentElement.dataset.chatgptHistoryLoadingMode = "manual";
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not install manual history loading`, error);
    }
  }
  function isFinishedMessageStatus(status) {
    return status === "finished_successfully" || status === "finished" || status === "complete";
  }
  function isIdleConversation(payload) {
    if (payload.async_status != null)
      return false;
    if (typeof payload.current_node !== "string" || typeof payload.mapping !== "object" || payload.mapping === null) {
      return false;
    }
    const current = payload.mapping[payload.current_node];
    return isFinishedMessageStatus(current?.message?.status);
  }
  function currentPaginatedMessage(payload) {
    if (typeof payload.current_node !== "string" || !Array.isArray(payload.messages)) {
      return;
    }
    return payload.messages.find((message) => message.id === payload.current_node);
  }
  function hasActivePaginatedWork(payload) {
    if (payload.async_status != null)
      return true;
    if (!Array.isArray(payload.messages))
      return true;
    const messages = payload.messages;
    if (messages.some((message) => ["in_progress", "streaming", "pending"].includes(String(message.status)))) {
      return true;
    }
    const current = currentPaginatedMessage(payload);
    return !current || !isFinishedMessageStatus(current.status);
  }
  function isIdlePaginatedConversation(payload) {
    return !hasActivePaginatedWork(payload);
  }
  function requiredInitialMessageIds(payload) {
    if (!Array.isArray(payload.messages) || typeof payload.current_node !== "string") {
      return [];
    }
    const messages = payload.messages;
    const byId = new Map(messages.filter((message) => typeof message.id === "string").map((message) => [message.id, message]));
    const ids = new Set([payload.current_node]);
    const current = byId.get(payload.current_node);
    if (current?.author?.role === "tool") {
      const parentId = current.metadata?.parent_id;
      if (typeof parentId === "string" && byId.has(parentId))
        ids.add(parentId);
    }
    return [...ids];
  }
  function isRenderableAssistantMessage(message) {
    if (message.author?.role !== "assistant")
      return false;
    if (message.metadata?.is_visually_hidden_from_conversation === true)
      return false;
    if (message.recipient != null && message.recipient !== "all")
      return false;
    if (message.channel === "final")
      return true;
    const contentType = message.content?.content_type;
    return !["code", "execution_output", "thoughts", "reasoning_recap"].includes(String(contentType ?? ""));
  }
  function hasRenderableQuestionAnswerTurn(messages, requireFinal) {
    let userIndex = -1;
    for (let index = 0;index < messages.length; index += 1) {
      if (messages[index]?.author?.role === "user")
        userIndex = index;
    }
    if (userIndex < 0)
      return false;
    return messages.slice(userIndex + 1).some((message) => isRenderableAssistantMessage(message) && (!requireFinal || message.channel === "final"));
  }
  function mergeChronologicalMessages(older, newer) {
    const seen = new Set;
    const merged = [];
    for (const message of [...older, ...newer]) {
      const id = message.id;
      if (typeof id === "string") {
        if (seen.has(id))
          continue;
        seen.add(id);
      }
      merged.push(message);
    }
    return merged;
  }
  function writeSettings(storage, settings) {
    try {
      storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }
  function requestUrl(pageWindow, input, baseUrl) {
    if (typeof input === "string")
      return new pageWindow.URL(input, baseUrl).href;
    const requestLike = input;
    if (typeof requestLike.url === "string") {
      return new pageWindow.URL(requestLike.url, baseUrl).href;
    }
    if (typeof requestLike.href === "string") {
      return new pageWindow.URL(requestLike.href, baseUrl).href;
    }
    return new pageWindow.URL(String(input), baseUrl).href;
  }
  function requestMethod(input, init) {
    if (init?.method)
      return init.method.toUpperCase();
    const method = input?.method;
    if (typeof method === "string") {
      return method.toUpperCase();
    }
    return "GET";
  }
  function isConversationMutation(rawUrl, method, baseUrl) {
    if (method === "GET" || method === "HEAD")
      return false;
    try {
      const url = new URL(rawUrl, baseUrl);
      return url.pathname.includes("/conversation");
    } catch {
      return false;
    }
  }
  function addVirtualizationCss(pageWindow) {
    const id = "chatgpt-performance-fix-style";
    if (pageWindow.document.getElementById(id))
      return;
    const style = pageWindow.document.createElement("style");
    style.id = id;
    style.textContent = `
/* Whole-message virtualization is intentionally disabled. True lazy history
   keeps the DOM small, while message-level content-visibility:auto caused the
   entire message to switch from an intrinsic placeholder after it was visible. */
html[data-chatgpt-performance-fix="large"] [data-message-id] {
  content-visibility: visible;
  contain-intrinsic-size: none;
}`;
    const mount = pageWindow.document.head ?? pageWindow.document.documentElement;
    mount?.append(style);
  }
  function installRichTextPerformanceFix(pageWindow, warmDistancePx) {
    const marker = "__chatgptRichTextPerformanceFixInstalled";
    if (Reflect.get(pageWindow, marker))
      return;
    Reflect.set(pageWindow, marker, true);
    try {
      let visibilityOwner = pageWindow.Document?.prototype ?? null;
      let visibilityDescriptor;
      while (visibilityOwner) {
        visibilityDescriptor = Object.getOwnPropertyDescriptor(visibilityOwner, "visibilityState");
        if (visibilityDescriptor)
          break;
        visibilityOwner = Object.getPrototypeOf(visibilityOwner);
      }
      const nativeVisibilityGet = visibilityDescriptor?.get;
      if (visibilityOwner && nativeVisibilityGet && visibilityDescriptor?.configurable !== false) {
        Object.defineProperty(visibilityOwner, "visibilityState", {
          configurable: true,
          enumerable: visibilityDescriptor.enumerable ?? true,
          get() {
            const actual = nativeVisibilityGet.call(this);
            if (this === pageWindow.document && actual !== "hidden") {
              const stack = new Error().stack ?? "";
              if (stack.includes("/2afb55f3-")) {
                pageWindow.document.documentElement.dataset.chatgptSmoothedMarkdownBypass = "enabled";
                return "hidden";
              }
            }
            return actual;
          }
        });
      }
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not bypass markdown smoothing`, error);
    }
    const styleId = "chatgpt-rich-text-performance-fix-style";
    if (!pageWindow.document.getElementById(styleId)) {
      const style = pageWindow.document.createElement("style");
      style.id = styleId;
      style.textContent = `
/* ChatGPT's SmoothedMarkdown starts code blocks at height:0/opacity:0 and
   measures every block with a ResizeObserver. For code-heavy replies that turns
   into a wall of empty bars followed by one huge layout/paint burst. */
html [class*="SmoothedCodeBlock"][data-animate-height] {
  height: auto !important;
  min-height: 3.25rem;
  opacity: 1 !important;
  transition: none !important;
}
html [class*="SmoothedCodeBlock"] [class*="ClipText"] {
  height: auto !important;
  overflow: visible !important;
  transition: none !important;
}
html [class*="SmoothedCodeBlock"] [class*="SmoothingOverlay"],
html [class*="SmoothedCodeBlock"] [class*="FixedSmoothingOverlay"] {
  display: none !important;
}

/* Heavy rich-text descendants are explicitly pre-rendered well before they
   enter the viewport. Unlike content-visibility:auto, this prevents the browser
   from waiting until the block is already visible before materializing it. */
html [data-chatgpt-rich-block-state="cold"],
html [class*="_codemirror"][data-chatgpt-rich-editor-state="cold"] {
  content-visibility: auto !important;
  contain-intrinsic-size: var(--chatgpt-rich-intrinsic-size, 180px) !important;
}
html [data-chatgpt-rich-block-state="hot"],
html [class*="_codemirror"][data-chatgpt-rich-editor-state="hot"] {
  content-visibility: visible !important;
  contain-intrinsic-size: auto var(--chatgpt-rich-intrinsic-size, 180px) !important;
}
html [class*="_codemirror"][data-chatgpt-rich-editor-state="cold"] {
  min-height: 5rem;
}

@media print {
  html [class*="SmoothedCodeBlock"],
  html [class*="_codemirror"],
  html .markdown table,
  html [class*="MarkdownContent"] table,
  html .katex-display,
  html [data-code-block-preview-pane] {
    content-visibility: visible;
    contain-intrinsic-size: none;
  }
}`;
      const mount = pageWindow.document.head ?? pageWindow.document.documentElement;
      mount?.append(style);
    }
    const NativeResizeObserver = pageWindow.ResizeObserver;
    if (typeof NativeResizeObserver !== "function")
      return;
    const isSmoothedCodeMeasurement = (target) => {
      if (!(target instanceof pageWindow.Element))
        return false;
      if (target.tagName !== "SPAN" || !target.classList.contains("block")) {
        return false;
      }
      const clip = target.parentElement;
      return Boolean(clip && Array.from(clip.classList).some((name) => name.includes("ClipText")) && clip.closest('[class*="SmoothedCodeBlock"]'));
    };

    class RichTextResizeObserver {
      native;
      skipped = new Set;
      constructor(callback) {
        this.native = new NativeResizeObserver((entries) => callback(entries, this));
      }
      observe(target, options) {
        if (isSmoothedCodeMeasurement(target)) {
          this.skipped.add(target);
          const root2 = pageWindow.document.documentElement;
          const count = Number(root2.dataset.chatgptRichTextSkippedResizeObservers ?? "0");
          root2.dataset.chatgptRichTextSkippedResizeObservers = String(count + 1);
          return;
        }
        this.native.observe(target, options);
      }
      unobserve(target) {
        if (this.skipped.delete(target))
          return;
        this.native.unobserve(target);
      }
      disconnect() {
        this.skipped.clear();
        this.native.disconnect();
      }
    }
    try {
      Object.setPrototypeOf(RichTextResizeObserver.prototype, NativeResizeObserver.prototype);
      Object.setPrototypeOf(RichTextResizeObserver, NativeResizeObserver);
      Object.defineProperty(RichTextResizeObserver, "name", {
        value: "ResizeObserver"
      });
      Object.defineProperty(pageWindow, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: RichTextResizeObserver
      });
      pageWindow.document.documentElement.dataset.chatgptRichTextPerformanceFix = "enabled";
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not tune rich-text rendering`, error);
    }
    const isConversationCodeEditor = (element) => Array.from(element.classList).some((name) => name.includes("_codemirror")) && Boolean(element.closest('[data-message-id], .markdown, [class*="MarkdownContent"], [class*="SmoothedMarkdown"]'));
    const RICH_BLOCK_SELECTOR = [
      '[class*="SmoothedCodeBlock"]',
      ".markdown table",
      '[class*="MarkdownContent"] table',
      ".katex-display",
      "[data-code-block-preview-pane]"
    ].join(",");
    const isRichBlock = (element) => element.matches(RICH_BLOCK_SELECTOR) && Boolean(element.closest('[data-message-id], .markdown, [class*="MarkdownContent"], [class*="SmoothedMarkdown"]'));
    const intrinsicSizeFor = (element) => {
      if (Array.from(element.classList).some((name) => name.includes("SmoothedCodeBlock"))) {
        return 220;
      }
      if (element.matches("table"))
        return 240;
      if (element.matches(".katex-display"))
        return 96;
      if (element.matches("[data-code-block-preview-pane]"))
        return 360;
      return 180;
    };
    const activationQueue = [];
    const queued = new WeakSet;
    const coldElements = new Set;
    let activationFrame = null;
    let warmScanFrame = null;
    const incrementMetric = (name) => {
      const root2 = pageWindow.document.documentElement;
      const current = Number(root2.dataset[name] ?? "0");
      root2.dataset[name] = String(current + 1);
    };
    const activate = (item) => {
      if (!item.element.isConnected) {
        coldElements.delete(item.element);
        return;
      }
      if (item.element.getAttribute(item.attribute) === "hot")
        return;
      item.element.setAttribute(item.attribute, "hot");
      coldElements.delete(item.element);
      incrementMetric(item.metric);
    };
    const drainActivationQueue = () => {
      activationFrame = null;
      let editorsActivated = 0;
      let blocksActivated = 0;
      for (let index = 0;index < activationQueue.length; ) {
        const item = activationQueue[index];
        const isEditor = item.attribute === "data-chatgpt-rich-editor-state";
        const allowed = isEditor ? editorsActivated < 1 : blocksActivated < 3;
        if (!allowed) {
          index += 1;
          continue;
        }
        activationQueue.splice(index, 1);
        activate(item);
        if (isEditor)
          editorsActivated += 1;
        else
          blocksActivated += 1;
        if (editorsActivated >= 1 && blocksActivated >= 3)
          break;
      }
      if (activationQueue.length > 0) {
        activationFrame = pageWindow.requestAnimationFrame(drainActivationQueue);
      }
    };
    const enqueueActivation = (item, distance = Number.POSITIVE_INFINITY) => {
      if (item.element.getAttribute(item.attribute) === "hot")
        return;
      if (queued.has(item.element))
        return;
      queued.add(item.element);
      activationQueue.push({ ...item, distance });
      activationQueue.sort((left, right) => (left.distance ?? Number.POSITIVE_INFINITY) - (right.distance ?? Number.POSITIVE_INFINITY));
      if (activationFrame == null) {
        activationFrame = pageWindow.requestAnimationFrame(drainActivationQueue);
      }
    };
    const activationFor = (element) => {
      if (isConversationCodeEditor(element)) {
        return {
          element,
          attribute: "data-chatgpt-rich-editor-state",
          metric: "chatgptRichTextEditorsActivated"
        };
      }
      if (isRichBlock(element)) {
        return {
          element,
          attribute: "data-chatgpt-rich-block-state",
          metric: "chatgptRichTextBlocksActivated"
        };
      }
      return null;
    };
    const effectiveWarmDistance = Math.max(1500, Math.floor(warmDistancePx));
    const scanWarmDistance = () => {
      warmScanFrame = null;
      for (const element of [...coldElements]) {
        if (!element.isConnected) {
          coldElements.delete(element);
          continue;
        }
        const item = activationFor(element);
        if (!item || element.getAttribute(item.attribute) === "hot") {
          coldElements.delete(element);
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.bottom < -effectiveWarmDistance || rect.top > pageWindow.innerHeight + effectiveWarmDistance) {
          continue;
        }
        const visibleNow = rect.bottom >= 0 && rect.top <= pageWindow.innerHeight;
        if (visibleNow) {
          activate(item);
        } else {
          const distance = rect.top > pageWindow.innerHeight ? rect.top - pageWindow.innerHeight : Math.max(0, -rect.bottom);
          enqueueActivation(item, distance);
        }
      }
    };
    const scheduleWarmScan = () => {
      if (warmScanFrame != null)
        return;
      warmScanFrame = pageWindow.requestAnimationFrame(scanWarmDistance);
    };
    const registerHeavyElement = (element) => {
      const item = activationFor(element);
      if (!item || element.hasAttribute(item.attribute))
        return;
      const size = intrinsicSizeFor(element);
      element.style.setProperty("--chatgpt-rich-intrinsic-size", `${size}px`);
      element.setAttribute(item.attribute, "cold");
      coldElements.add(element);
      if (item.attribute === "data-chatgpt-rich-editor-state") {
        incrementMetric("chatgptRichTextEditorsCold");
      } else {
        incrementMetric("chatgptRichTextBlocksCold");
      }
      scheduleWarmScan();
    };
    const scanForHeavyElements = (node) => {
      if (!(node instanceof pageWindow.Element))
        return;
      registerHeavyElement(node);
      for (const element of node.querySelectorAll(`${RICH_BLOCK_SELECTOR},[class*="_codemirror"]`)) {
        registerHeavyElement(element);
      }
    };
    const root = pageWindow.document.documentElement;
    if (root) {
      root.dataset.chatgptRichTextWarmDistancePx = String(effectiveWarmDistance);
      scanForHeavyElements(root);
      pageWindow.addEventListener("scroll", scheduleWarmScan, {
        capture: true,
        passive: true
      });
      pageWindow.addEventListener("resize", scheduleWarmScan, { passive: true });
      const mutationObserver = new pageWindow.MutationObserver((records) => {
        for (const record of records) {
          for (const added of record.addedNodes)
            scanForHeavyElements(added);
        }
        scheduleWarmScan();
      });
      mutationObserver.observe(root, { childList: true, subtree: true });
      scheduleWarmScan();
    }
  }
  function showOptimizationToast(pageWindow, message, onLoadFull) {
    const id = "chatgpt-performance-fix-toast";
    const render = () => {
      if (!pageWindow.document.body || pageWindow.document.getElementById(id))
        return;
      const host = pageWindow.document.createElement("div");
      host.id = id;
      host.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
      ].join(";");
      const shadow = host.attachShadow({ mode: "open" });
      const panel = pageWindow.document.createElement("div");
      panel.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:10px",
        "padding:9px 11px",
        "border:1px solid rgba(127,127,127,.25)",
        "border-radius:12px",
        "background:rgba(24,24,24,.92)",
        "color:#fff",
        "box-shadow:0 8px 30px rgba(0,0,0,.24)",
        "backdrop-filter:blur(12px)"
      ].join(";");
      const text = pageWindow.document.createElement("span");
      text.textContent = message;
      const button = pageWindow.document.createElement("button");
      button.type = "button";
      button.textContent = "完整加载";
      button.style.cssText = [
        "appearance:none",
        "border:0",
        "border-radius:8px",
        "padding:5px 8px",
        "background:rgba(255,255,255,.14)",
        "color:inherit",
        "font:inherit",
        "cursor:pointer"
      ].join(";");
      button.addEventListener("click", onLoadFull);
      panel.append(text, button);
      shadow.append(panel);
      pageWindow.document.body.append(host);
      pageWindow.setTimeout(() => host.remove(), 8000);
    };
    if (pageWindow.document.body)
      render();
    else
      pageWindow.document.addEventListener("DOMContentLoaded", render, { once: true });
  }
  function cloneMaterializedResponse(pageWindow, response) {
    const clone = new pageWindow.Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    for (const [key, value] of [
      ["url", response.url],
      ["redirected", response.redirected],
      ["type", response.type]
    ]) {
      try {
        Object.defineProperty(clone, key, {
          configurable: true,
          enumerable: false,
          value
        });
      } catch {}
    }
    return clone;
  }
  async function materializeAndOptimize(pageWindow, response, mode, exposedUrl = response.url) {
    const originalBody = await response.text();
    let body = originalBody;
    let optimized = false;
    let cacheable = false;
    let stats;
    if (response.ok) {
      try {
        const parsed = JSON.parse(originalBody);
        const result = optimizeConversationPayload(parsed, MODE_OPTIONS[mode]);
        stats = result.stats;
        if (result.stats.changed) {
          body = JSON.stringify(result.payload);
          optimized = true;
          cacheable = isIdleConversation(result.payload);
        }
      } catch (error) {
        console.warn(`[${SCRIPT_NAME}] Conversation response was not optimized`, error);
      }
    }
    const headers = new pageWindow.Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (optimized && stats) {
      headers.set("x-chatgpt-performance-fix", `${stats.originalNodes}->${stats.keptNodes}`);
    }
    return {
      body,
      headers: [...headers.entries()],
      status: response.status,
      statusText: response.statusText,
      url: exposedUrl,
      redirected: response.redirected,
      type: response.type,
      optimized,
      cacheable,
      stats,
      apiKind: "legacy-full"
    };
  }
  async function materializeAndOptimizePaginated(pageWindow, response, apiKind, mode, exposedUrl, requestWasClamped, createLocalCursor) {
    const originalBody = await response.text();
    let body = originalBody;
    let optimized = requestWasClamped;
    let stats;
    let optimizedPayload;
    let cacheable = false;
    let localPagePayloads = [];
    if (response.ok) {
      try {
        const parsed = JSON.parse(originalBody);
        const activeInitial = apiKind === "paginated-initial" && hasActivePaginatedWork(parsed);
        cacheable = apiKind === "paginated-initial" && isIdlePaginatedConversation(parsed);
        const result = optimizePaginatedConversationPayload(parsed, {
          recentFullTurns: apiKind === "paginated-initial" && activeInitial ? MODE_OPTIONS[mode].recentFullTurns : 0,
          forceKeepMessageIds: apiKind === "paginated-initial" ? requiredInitialMessageIds(parsed) : [],
          collapseTurnsToQuestionAnswer: apiKind === "paginated-messages" || apiKind === "paginated-initial" && !activeInitial
        });
        stats = result.stats;
        optimizedPayload = result.payload;
        if (result.stats.changed) {
          optimized = true;
        }
        const messages = Array.isArray(result.payload.messages) ? result.payload.messages : [];
        const chunksNewestFirst = splitPaginatedMessagesNewestFirst(messages, {
          maxTurns: MODE_OPTIONS[mode].paginatedRenderTurns,
          maxMessages: Number.MAX_SAFE_INTEGER,
          maxBytes: Number.MAX_SAFE_INTEGER,
          allowSplitTurns: false
        });
        if (chunksNewestFirst.length > 1) {
          const originalPageInfo = result.payload.page_info && typeof result.payload.page_info === "object" ? { ...result.payload.page_info } : { has_previous_page: false, start_cursor: null };
          const localCursors = chunksNewestFirst.slice(1).map(() => createLocalCursor());
          optimizedPayload = {
            ...result.payload,
            messages: chunksNewestFirst[0],
            page_info: {
              ...originalPageInfo,
              has_previous_page: true,
              start_cursor: localCursors[0]
            }
          };
          localPagePayloads = chunksNewestFirst.slice(1).map((messages2, index) => {
            const hasAnotherLocalPage = index + 1 < localCursors.length;
            return {
              cursor: localCursors[index],
              payload: {
                messages: messages2,
                page_info: hasAnotherLocalPage ? {
                  ...originalPageInfo,
                  has_previous_page: true,
                  start_cursor: localCursors[index + 1]
                } : originalPageInfo,
                safe_urls: result.payload.safe_urls ?? [],
                blocked_urls: result.payload.blocked_urls ?? []
              }
            };
          });
          optimized = true;
        }
        if (optimizedPayload)
          body = JSON.stringify(optimizedPayload);
      } catch (error) {
        console.warn(`[${SCRIPT_NAME}] Paginated response was not optimized`, error);
      }
    }
    const headers = new pageWindow.Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (stats) {
      headers.set("x-chatgpt-performance-fix-page", `${stats.originalMessages}->${stats.keptMessages}`);
    }
    headers.set("x-chatgpt-performance-fix-cacheable", cacheable ? "1" : "0");
    const responseHeaders = [...headers.entries()];
    const localPages = localPagePayloads.map(({ cursor, payload }, index) => {
      const localHeaders = new pageWindow.Headers(responseHeaders);
      localHeaders.set("x-chatgpt-performance-fix-local-page", `${index + 1}/${localPagePayloads.length}`);
      return {
        cursor,
        response: {
          body: JSON.stringify(payload),
          headers: [...localHeaders.entries()],
          status: response.status,
          statusText: response.statusText,
          url: "",
          redirected: false,
          type: response.type,
          optimized: true,
          cacheable: false,
          apiKind: "paginated-messages"
        }
      };
    });
    return {
      body,
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
      url: exposedUrl,
      redirected: response.redirected,
      type: response.type,
      optimized,
      cacheable,
      stats,
      apiKind,
      localPages
    };
  }
  function requestSignal(input, init) {
    if (init?.signal)
      return init.signal;
    const signal = input?.signal;
    return signal != null && typeof signal.aborted === "boolean" ? signal : undefined;
  }
  async function fetchCompleteInitialPage(pageWindow, originalFetch, input, init, rewrittenUrl, conversationId) {
    const [firstInput, firstInit] = rewriteGetRequest(pageWindow, input, init, rewrittenUrl);
    const firstResponse = await originalFetch(firstInput, firstInit);
    if (!firstResponse.ok)
      return firstResponse;
    let payload = await firstResponse.clone().json();
    const seenCursors = new Set;
    let combined = false;
    for (let attempt = 0;attempt < 9; attempt += 1) {
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (hasRenderableQuestionAnswerTurn(messages, false))
        break;
      const cursor = payload.page_info?.has_previous_page === true && typeof payload.page_info.start_cursor === "string" ? payload.page_info.start_cursor : null;
      if (!cursor || seenCursors.has(cursor))
        break;
      seenCursors.add(cursor);
      const olderUrl = new pageWindow.URL(`/backend-api/conversations/${conversationId}/messages`, rewrittenUrl);
      olderUrl.searchParams.set("before", cursor);
      olderUrl.searchParams.set("include_has_versions", "true");
      olderUrl.searchParams.set("num_turns", String(Math.min(512, 2 ** Math.min(9, attempt + 2))));
      const [olderInput, olderInit] = rewriteGetRequest(pageWindow, input, init, olderUrl.href);
      const olderResponse = await originalFetch(olderInput, olderInit);
      if (!olderResponse.ok)
        break;
      const olderPayload = await olderResponse.json();
      payload = {
        ...payload,
        messages: mergeChronologicalMessages(Array.isArray(olderPayload.messages) ? olderPayload.messages : [], messages),
        page_info: olderPayload.page_info,
        safe_urls: [...new Set([
          ...olderPayload.safe_urls ?? [],
          ...payload.safe_urls ?? []
        ])],
        blocked_urls: [...new Set([
          ...olderPayload.blocked_urls ?? [],
          ...payload.blocked_urls ?? []
        ])]
      };
      combined = true;
    }
    if (!combined)
      return firstResponse;
    return new pageWindow.Response(JSON.stringify(payload), {
      status: firstResponse.status,
      statusText: firstResponse.statusText,
      headers: firstResponse.headers
    });
  }
  async function fetchCompleteHistoryPage(pageWindow, originalFetch, input, init, rewrittenUrl) {
    const [firstInput, firstInit] = rewriteGetRequest(pageWindow, input, init, rewrittenUrl);
    const firstResponse = await originalFetch(firstInput, firstInit);
    if (!firstResponse.ok)
      return firstResponse;
    let payload = await firstResponse.clone().json();
    const seenCursors = new Set;
    let combined = false;
    for (let attempt = 0;attempt < 9; attempt += 1) {
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (hasRenderableQuestionAnswerTurn(messages, true))
        break;
      const cursor = payload.page_info?.has_previous_page === true && typeof payload.page_info.start_cursor === "string" ? payload.page_info.start_cursor : null;
      if (!cursor || seenCursors.has(cursor))
        break;
      seenCursors.add(cursor);
      const olderUrl = new pageWindow.URL(rewrittenUrl);
      olderUrl.searchParams.set("before", cursor);
      olderUrl.searchParams.set("num_turns", String(Math.min(512, 2 ** Math.min(9, attempt + 2))));
      const [olderInput, olderInit] = rewriteGetRequest(pageWindow, input, init, olderUrl.href);
      const olderResponse = await originalFetch(olderInput, olderInit);
      if (!olderResponse.ok)
        break;
      const olderPayload = await olderResponse.json();
      payload = {
        ...payload,
        messages: mergeChronologicalMessages(Array.isArray(olderPayload.messages) ? olderPayload.messages : [], messages),
        page_info: olderPayload.page_info,
        safe_urls: [...new Set([
          ...olderPayload.safe_urls ?? [],
          ...payload.safe_urls ?? []
        ])],
        blocked_urls: [...new Set([
          ...olderPayload.blocked_urls ?? [],
          ...payload.blocked_urls ?? []
        ])]
      };
      combined = true;
    }
    if (!combined)
      return firstResponse;
    return new pageWindow.Response(JSON.stringify(payload), {
      status: firstResponse.status,
      statusText: firstResponse.statusText,
      headers: firstResponse.headers
    });
  }
  async function materializeLegacyRequestLazily(pageWindow, originalFetch, input, init, legacyUrl, conversationId, mode, createLocalCursor) {
    const lazyUrl = new pageWindow.URL(`/backend-api/conversations/${conversationId}`, legacyUrl);
    lazyUrl.searchParams.set("include_has_versions", "true");
    lazyUrl.searchParams.set("num_turns", String(MODE_OPTIONS[mode].lazyInitialTurns));
    const [lazyInput, lazyInit] = rewriteGetRequest(pageWindow, input, init, lazyUrl.href);
    try {
      const nativeResponse = await originalFetch(lazyInput, {
        ...lazyInit,
        cache: "no-store"
      });
      if (!nativeResponse.ok) {
        throw new Error(`Native pagination returned HTTP ${nativeResponse.status}`);
      }
      let nativePayload = await nativeResponse.clone().json();
      let fetchedOlderPage = false;
      const seenCursors = new Set;
      for (let attempt = 0;attempt < 9; attempt += 1) {
        const collected = Array.isArray(nativePayload.messages) ? nativePayload.messages : [];
        if (hasRenderableQuestionAnswerTurn(collected, false))
          break;
        const cursor = nativePayload.page_info?.has_previous_page === true && typeof nativePayload.page_info.start_cursor === "string" ? nativePayload.page_info.start_cursor : null;
        if (!cursor)
          break;
        if (seenCursors.has(cursor)) {
          throw new Error("Native pagination cursor did not advance");
        }
        seenCursors.add(cursor);
        const olderUrl = new pageWindow.URL(`/backend-api/conversations/${conversationId}/messages`, legacyUrl);
        olderUrl.searchParams.set("before", cursor);
        olderUrl.searchParams.set("include_has_versions", "true");
        olderUrl.searchParams.set("num_turns", String(Math.min(512, 2 ** Math.min(9, attempt + 2))));
        const [olderInput, olderInit] = rewriteGetRequest(pageWindow, input, init, olderUrl.href);
        const olderResponse = await originalFetch(olderInput, {
          ...olderInit,
          cache: "no-store"
        });
        if (!olderResponse.ok) {
          throw new Error(`Native history pagination returned HTTP ${olderResponse.status}`);
        }
        const olderPayload = await olderResponse.json();
        nativePayload = {
          ...nativePayload,
          messages: mergeChronologicalMessages(Array.isArray(olderPayload.messages) ? olderPayload.messages : [], collected),
          page_info: olderPayload.page_info,
          safe_urls: olderPayload.safe_urls ?? nativePayload.safe_urls ?? [],
          blocked_urls: olderPayload.blocked_urls ?? nativePayload.blocked_urls ?? []
        };
        fetchedOlderPage = true;
      }
      if (!Array.isArray(nativePayload.messages) || nativePayload.messages.length === 0) {
        throw new Error("Native pagination returned no messages");
      }
      const preparedNativeResponse = fetchedOlderPage ? new pageWindow.Response(JSON.stringify(nativePayload), {
        status: nativeResponse.status,
        statusText: nativeResponse.statusText,
        headers: nativeResponse.headers
      }) : nativeResponse;
      const nativeMaterialized = await materializeAndOptimizePaginated(pageWindow, preparedNativeResponse, "paginated-initial", mode, legacyUrl, true, createLocalCursor);
      const optimizedNativePayload = JSON.parse(nativeMaterialized.body);
      const lazyPayload = convertNativeInitialToLazyConversation(optimizedNativePayload, conversationId, MODE_OPTIONS[mode].paginatedMaxTurns);
      if (!lazyPayload) {
        throw new Error("Native pagination response could not form a lazy conversation");
      }
      const headers = new pageWindow.Headers(nativeMaterialized.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.set("x-chatgpt-performance-fix-lazy", "native-pagination");
      headers.set("x-chatgpt-performance-fix-initial-turns", String(MODE_OPTIONS[mode].lazyInitialTurns));
      headers.set("x-chatgpt-performance-fix-cacheable", "0");
      return {
        ...nativeMaterialized,
        body: JSON.stringify(lazyPayload),
        headers: [...headers.entries()],
        url: legacyUrl,
        optimized: true,
        cacheable: false,
        lazyInitial: true
      };
    } catch (error) {
      if (requestSignal(input, init)?.aborted)
        throw error;
      console.warn(`[${SCRIPT_NAME}] Native lazy loading was unavailable; falling back to the legacy response`, error);
      const legacyResponse = await originalFetch(input, init);
      return materializeAndOptimize(pageWindow, legacyResponse, mode, legacyUrl);
    }
  }
  function install(pageWindow) {
    if (!pageWindow.fetch || Reflect.get(pageWindow, "__chatgptPerformanceFixInstalled")) {
      return;
    }
    Reflect.set(pageWindow, "__chatgptPerformanceFixInstalled", true);
    const settings = readSettings(pageWindow.localStorage);
    const fullOnceKey = `${FULL_ONCE_PREFIX}${pageWindow.location.pathname}`;
    let bypassThisPageLoad = false;
    try {
      bypassThisPageLoad = pageWindow.sessionStorage.getItem(fullOnceKey) === "1";
      if (bypassThisPageLoad)
        pageWindow.sessionStorage.removeItem(fullOnceKey);
    } catch {}
    const loadCurrentConversationFully = () => {
      try {
        pageWindow.sessionStorage.setItem(`${FULL_ONCE_PREFIX}${pageWindow.location.pathname}`, "1");
      } catch {}
      pageWindow.location.reload();
    };
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("完整加载一次", loadCurrentConversationFully);
      GM_registerMenuCommand(`切换模式（${settings.mode}）`, () => {
        const nextMode = settings.mode === "balanced" ? "aggressive" : settings.mode === "aggressive" ? "off" : "balanced";
        writeSettings(pageWindow.localStorage, { mode: nextMode });
        pageWindow.location.reload();
      });
    }
    addVirtualizationCss(pageWindow);
    if (settings.mode !== "off") {
      installRichTextPerformanceFix(pageWindow, MODE_OPTIONS[settings.mode].richTextWarmDistancePx);
    }
    const deepLink = new pageWindow.URLSearchParams(pageWindow.location.search);
    if (settings.mode === "off" || bypassThisPageLoad || deepLink.has("message") || deepLink.has("messageId")) {
      return;
    }
    const activeMode = settings.mode;
    installManualPaginationObserver(pageWindow);
    const originalFetch = pageWindow.fetch.bind(pageWindow);
    const cache = new Map;
    const inFlight = new Map;
    const notifiedKeys = new Set;
    const localPages = new Map;
    const localCursorSession = pageWindow.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    let localCursorCounter = 0;
    const createLocalCursor = () => `cgptperf-${localCursorSession}-${(++localCursorCounter).toString(36)}`;
    const clearConversationCache = () => {
      cache.clear();
      inFlight.clear();
      localPages.clear();
    };
    const wrappedFetch = async (input, init) => {
      const rawUrl = requestUrl(pageWindow, input, pageWindow.location.href);
      const method = requestMethod(input, init);
      const apiMatch = matchConversationApiUrl(rawUrl, pageWindow.location.href);
      if (isConversationMutation(rawUrl, method, pageWindow.location.href)) {
        clearConversationCache();
        return originalFetch(input, init);
      }
      if (method !== "GET" || !apiMatch) {
        return originalFetch(input, init);
      }
      const normalizedRawUrl = new pageWindow.URL(rawUrl, pageWindow.location.href).href;
      const requestUrlObject = new pageWindow.URL(normalizedRawUrl);
      if (apiMatch.kind === "paginated-messages") {
        const before = requestUrlObject.searchParams.get("before");
        const localPage = before == null ? undefined : localPages.get(before);
        if (localPage) {
          await yieldUntilInteractionIdle(pageWindow);
          const cloned = cloneMaterializedResponse(pageWindow, {
            ...localPage,
            url: normalizedRawUrl
          });
          pageWindow.setTimeout(() => {
            pageWindow.dispatchEvent(new pageWindow.CustomEvent("chatgpt-performance-fix:history-page-settled"));
          }, 0);
          return cloned;
        }
      }
      if (apiMatch.kind !== "legacy-full" && requestUrlObject.searchParams.has("include_message_id")) {
        return originalFetch(input, init);
      }
      let key;
      let task;
      if (apiMatch.kind === "legacy-full") {
        const explicitlyFull = ["true", "1"].includes(requestUrlObject.searchParams.get("include_full_conversation") ?? "");
        if (explicitlyFull)
          return originalFetch(input, init);
        key = `lazy:${normalizedRawUrl}`;
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
          return cloneMaterializedResponse(pageWindow, cached.response);
        }
        if (cached)
          cache.delete(key);
        task = inFlight.get(key);
        if (!task) {
          task = materializeLegacyRequestLazily(pageWindow, originalFetch, input, init, normalizedRawUrl, apiMatch.conversationId, activeMode, createLocalCursor);
          inFlight.set(key, task);
        }
      } else {
        const maxTurns = apiMatch.kind === "paginated-initial" ? MODE_OPTIONS[activeMode].lazyInitialTurns : MODE_OPTIONS[activeMode].paginatedMaxTurns;
        const rewrittenUrl = clampPaginatedNumTurns(normalizedRawUrl, pageWindow.location.href, maxTurns);
        const requestWasClamped = rewrittenUrl !== normalizedRawUrl;
        const [rewrittenInput, rewrittenInit] = rewriteGetRequest(pageWindow, input, init, rewrittenUrl);
        key = `paginated:${rewrittenUrl}`;
        task = inFlight.get(key);
        if (!task) {
          const responseTask = apiMatch.kind === "paginated-messages" ? fetchCompleteHistoryPage(pageWindow, originalFetch, input, init, rewrittenUrl) : fetchCompleteInitialPage(pageWindow, originalFetch, input, init, rewrittenUrl, apiMatch.conversationId);
          task = responseTask.then((response) => materializeAndOptimizePaginated(pageWindow, response, apiMatch.kind, activeMode, normalizedRawUrl, requestWasClamped, createLocalCursor));
          inFlight.set(key, task);
        }
      }
      try {
        const materialized = await task;
        for (const localPage of materialized.localPages ?? []) {
          localPages.set(localPage.cursor, localPage.response);
        }
        while (localPages.size > 256) {
          const oldest = localPages.keys().next().value;
          if (typeof oldest !== "string")
            break;
          localPages.delete(oldest);
        }
        if ((materialized.apiKind === "legacy-full" || materialized.lazyInitial) && materialized.optimized && materialized.cacheable) {
          cache.set(key, {
            expiresAt: Date.now() + CACHE_TTL_MS,
            response: materialized
          });
        }
        if (materialized.optimized) {
          const stats = materialized.stats;
          pageWindow.document.documentElement.dataset.chatgptPerformanceFix = "large";
          const notificationKind = materialized.lazyInitial ? "lazy-initial" : materialized.apiKind;
          const notificationKey = `${apiMatch.conversationId}:${notificationKind}`;
          if (stats && !notifiedKeys.has(notificationKey)) {
            notifiedKeys.add(notificationKey);
            console.info(`[${SCRIPT_NAME}]`, {
              apiKind: materialized.apiKind,
              ...stats,
              paginatedMaxTurns: MODE_OPTIONS[activeMode].paginatedMaxTurns,
              manualHistoryLoading: true,
              responseCacheTtlMs: materialized.cacheable ? CACHE_TTL_MS : 0
            });
            if (materialized.lazyInitial && "originalMessages" in stats) {
              showOptimizationToast(pageWindow, `已启用长会话加速`, loadCurrentConversationFully);
            } else if (materialized.apiKind === "legacy-full" && "originalNodes" in stats) {
              showOptimizationToast(pageWindow, `长会话已加速`, loadCurrentConversationFully);
            } else if (materialized.apiKind === "paginated-initial" && "originalMessages" in stats) {
              showOptimizationToast(pageWindow, `历史按需加载`, loadCurrentConversationFully);
            }
          }
        }
        if (materialized.apiKind === "paginated-messages") {
          await yieldUntilInteractionIdle(pageWindow);
          const cloned = cloneMaterializedResponse(pageWindow, materialized);
          pageWindow.setTimeout(() => {
            pageWindow.dispatchEvent(new pageWindow.CustomEvent("chatgpt-performance-fix:history-page-settled"));
          }, 0);
          return cloned;
        }
        return cloneMaterializedResponse(pageWindow, materialized);
      } finally {
        if (inFlight.get(key) === task)
          inFlight.delete(key);
      }
    };
    try {
      Object.defineProperty(wrappedFetch, "name", { value: "fetch" });
      Object.defineProperty(pageWindow, "fetch", {
        configurable: true,
        writable: true,
        value: wrappedFetch
      });
    } catch {
      pageWindow.fetch = wrappedFetch;
    }
  }
  var pageWindow = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  install(pageWindow);
})();
