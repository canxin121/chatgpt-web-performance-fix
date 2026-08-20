// ==UserScript==
// @name         ChatGPT Performance Fix
// @name:zh-CN   ChatGPT 性能优化
// @namespace    https://github.com/canxin121
// @version      0.1.0
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

(() => {
  // src/optimizer.ts
  var DEFAULT_OPTIMIZER_OPTIONS = {
    minNodeCount: 250,
    recentFullTurns: 1,
    preserveCurrentParent: false,
    collapseTurnsToQuestionAnswer: false
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
  function collapseNodeEntriesToQuestionAnswer(entries, forceKeepNodeIds) {
    const collapsed = [];
    let turn = [];
    const flushTurn = () => {
      if (turn.length === 0)
        return;
      const user = turn.find(({ node }) => node.message?.author?.role === "user");
      if (!user) {
        collapsed.push(...turn);
        turn = [];
        return;
      }
      const assistants = turn.filter(({ node }) => node.message?.author?.role === "assistant" && shouldKeepHistoricMessage(node.message));
      const answer = [...assistants].reverse().find(({ node }) => node.message?.channel === "final") ?? assistants.at(-1);
      if (!answer) {
        const forcedInTurn = turn.filter((entry) => forceKeepNodeIds.has(entry.id));
        if (forcedInTurn.length > 0) {
          const selected2 = new Set([
            user.id,
            ...forcedInTurn.map((entry) => entry.id)
          ]);
          collapsed.push(...turn.filter((entry) => selected2.has(entry.id)));
        } else {
          collapsed.push(...turn);
        }
        turn = [];
        return;
      }
      const selected = new Set([user.id, answer.id]);
      for (const entry of turn) {
        if (forceKeepNodeIds.has(entry.id))
          selected.add(entry.id);
        const role = entry.node.message?.author?.role;
        if (role && ALWAYS_KEEP_ROLES.has(role))
          selected.add(entry.id);
      }
      collapsed.push(...turn.filter((entry) => selected.has(entry.id)));
      turn = [];
    };
    for (const entry of entries) {
      if (entry.node.message?.author?.role === "user")
        flushTurn();
      if (turn.length > 0 || entry.node.message?.author?.role === "user") {
        turn.push(entry);
      } else {
        collapsed.push(entry);
      }
    }
    flushTurn();
    return collapsed;
  }
  function optimizeConversationPayload(payload, options = {}) {
    const resolved = {
      ...DEFAULT_OPTIMIZER_OPTIONS,
      ...options,
      minNodeCount: Math.max(0, Math.floor(options.minNodeCount ?? DEFAULT_OPTIMIZER_OPTIONS.minNodeCount)),
      recentFullTurns: Math.max(0, Math.floor(options.recentFullTurns ?? DEFAULT_OPTIMIZER_OPTIONS.recentFullTurns)),
      preserveCurrentParent: options.preserveCurrentParent ?? DEFAULT_OPTIMIZER_OPTIONS.preserveCurrentParent,
      collapseTurnsToQuestionAnswer: options.collapseTurnsToQuestionAnswer ?? DEFAULT_OPTIMIZER_OPTIONS.collapseTurnsToQuestionAnswer
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
    const forcedNodeIds = new Set([payload.current_node]);
    if (resolved.preserveCurrentParent) {
      const parentId = mapping[payload.current_node]?.parent;
      if (typeof parentId === "string" && parentId.length > 0) {
        forcedNodeIds.add(parentId);
      }
    }
    let kept = [];
    const removedByKind = {};
    let currentTurnIndex = -1;
    for (const entry of activePath) {
      if (entry.node.message?.author?.role === "user")
        currentTurnIndex += 1;
      const inRecentFullTurn = resolved.recentFullTurns > 0 && currentTurnIndex >= firstFullTurnIndex;
      const keep = inRecentFullTurn || shouldKeepHistoricNode(entry.node);
      if (keep || forcedNodeIds.has(entry.id)) {
        kept.push(entry);
      } else {
        const kind = kindOf(entry.node);
        removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
      }
    }
    if (resolved.collapseTurnsToQuestionAnswer) {
      const collapsed = collapseNodeEntriesToQuestionAnswer(kept, forcedNodeIds);
      if (collapsed.length < kept.length) {
        const retainedIds = new Set(collapsed.map((entry) => entry.id));
        for (const entry of kept) {
          if (retainedIds.has(entry.id))
            continue;
          const kind = kindOf(entry.node);
          removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
        }
        kept = collapsed;
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
  var HISTORY_CACHE_TTL_MS = 5 * 60000;
  var INTERNAL_RESPONSE_READS = new WeakSet;
  var MODE_OPTIONS = {
    balanced: {
      minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
      recentFullTurns: 1,
      lazyInitialTurns: 2,
      paginatedMaxTurns: 2,
      paginatedRenderTurns: 1,
      richTextWarmDistancePx: 8000,
      codeEditorWarmDistancePx: 3000
    },
    aggressive: {
      minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
      recentFullTurns: 0,
      lazyInitialTurns: 2,
      paginatedMaxTurns: 2,
      paginatedRenderTurns: 1,
      richTextWarmDistancePx: 5000,
      codeEditorWarmDistancePx: 1800
    }
  };
  function legacyOptimizerOptions(mode) {
    return {
      minNodeCount: MODE_OPTIONS[mode].minNodeCount,
      recentFullTurns: 0,
      preserveCurrentParent: true,
      collapseTurnsToQuestionAnswer: true
    };
  }
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
    const startedAt = pageWindow.performance.now();
    const finish = () => {
      try {
        pageWindow.performance.measure("chatgpt-perf:history-idle-wait", {
          start: startedAt,
          end: pageWindow.performance.now()
        });
      } catch {}
    };
    return new Promise((resolve) => {
      const afterPaint = () => {
        pageWindow.setTimeout(() => {
          if (typeof pageWindow.requestIdleCallback !== "function") {
            finish();
            resolve();
            return;
          }
          const waitForUsefulIdleBudget = () => {
            pageWindow.requestIdleCallback((deadline) => {
              if (deadline.timeRemaining() >= 12) {
                finish();
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
  var jsonWorkerState;
  function ensureJsonWorker(pageWindow) {
    if (jsonWorkerState !== undefined)
      return jsonWorkerState;
    if (typeof pageWindow.Worker !== "function") {
      jsonWorkerState = null;
      return null;
    }
    try {
      const source = '(()=>{var S={minNodeCount:250,recentFullTurns:1,preserveCurrentParent:!1,collapseTurnsToQuestionAnswer:!1},h=new Set(["system","developer"]),y=new Set(["code","execution_output","thoughts"]);function P(G){return new TextEncoder().encode(JSON.stringify(G)).byteLength}function B(G){if(!G)return"root/no-message";return`${G.author?.role??"unknown"}/${G.content?.content_type??"unknown"}`}function q(G){return B(G.message)}function w(G,V={}){return{changed:G==="optimized",reason:G,originalNodes:0,activePathNodes:0,keptNodes:0,removedOffPathNodes:0,removedHistoricNodes:0,userTurns:0,recentFullTurns:0,removedByKind:{},...V}}function b(G){return typeof G==="object"&&G!==null&&!Array.isArray(G)}function g(G){if("__paginatedConversationPage"in G)return!0;let V=G.mapping;return Boolean(V&&Object.keys(V).some(($)=>$.startsWith("paginated-root:")))}function f(G){if(!G)return!0;if(G.metadata?.is_visually_hidden_from_conversation===!0)return!1;let V=G.author?.role;if(V==="user"||V&&h.has(V))return!0;if(V==="tool")return!1;if(V!=="assistant")return!0;if(G.channel==="final")return!0;if(G.recipient!=null&&G.recipient!=="all")return!1;let $=G.content?.content_type;return!$||!y.has($)}function m(G){return f(G.message)}function u(G,V){let $=[],X=new Set,Q=V;while(Q!=null){if(X.has(Q))return null;X.add(Q);let Y=G[Q];if(!Y)return null;$.push({id:Q,node:Y}),Q=Y.parent}return $.reverse(),$}function i(G,V){let $=[],X=[],Q=()=>{if(X.length===0)return;let Y=X.find(({node:J})=>J.message?.author?.role==="user");if(!Y){$.push(...X),X=[];return}let L=X.filter(({node:J})=>J.message?.author?.role==="assistant"&&f(J.message)),A=[...L].reverse().find(({node:J})=>J.message?.channel==="final")??L.at(-1);if(!A){let J=X.filter((D)=>V.has(D.id));if(J.length>0){let D=new Set([Y.id,...J.map((R)=>R.id)]);$.push(...X.filter((R)=>D.has(R.id)))}else $.push(...X);X=[];return}let z=new Set([Y.id,A.id]);for(let J of X){if(V.has(J.id))z.add(J.id);let D=J.node.message?.author?.role;if(D&&h.has(D))z.add(J.id)}$.push(...X.filter((J)=>z.has(J.id))),X=[]};for(let Y of G){if(Y.node.message?.author?.role==="user")Q();if(X.length>0||Y.node.message?.author?.role==="user")X.push(Y);else $.push(Y)}return Q(),$}function T(G,V={}){let $={...S,...V,minNodeCount:Math.max(0,Math.floor(V.minNodeCount??S.minNodeCount)),recentFullTurns:Math.max(0,Math.floor(V.recentFullTurns??S.recentFullTurns)),preserveCurrentParent:V.preserveCurrentParent??S.preserveCurrentParent,collapseTurnsToQuestionAnswer:V.collapseTurnsToQuestionAnswer??S.collapseTurnsToQuestionAnswer};if(!b(G)||!b(G.mapping))return{payload:G,stats:w("invalid-payload")};let X=G.mapping,Q=Object.keys(X).length;if(g(G))return{payload:G,stats:w("already-paginated",{originalNodes:Q,keptNodes:Q,recentFullTurns:$.recentFullTurns})};if(Q<$.minNodeCount)return{payload:G,stats:w("below-threshold",{originalNodes:Q,keptNodes:Q,recentFullTurns:$.recentFullTurns})};if(typeof G.current_node!=="string")return{payload:G,stats:w("invalid-payload",{originalNodes:Q,keptNodes:Q,recentFullTurns:$.recentFullTurns})};let Y=u(X,G.current_node);if(!Y||Y.length===0)return{payload:G,stats:w("invalid-active-path",{originalNodes:Q,keptNodes:Q,recentFullTurns:$.recentFullTurns})};let L=Y.reduce((W,{node:C})=>W+(C.message?.author?.role==="user"?1:0),0),A=Math.max(0,L-$.recentFullTurns),z=new Set([G.current_node]);if($.preserveCurrentParent){let W=X[G.current_node]?.parent;if(typeof W==="string"&&W.length>0)z.add(W)}let J=[],D={},R=-1;for(let W of Y){if(W.node.message?.author?.role==="user")R+=1;if($.recentFullTurns>0&&R>=A||m(W.node)||z.has(W.id))J.push(W);else{let U=q(W.node);D[U]=(D[U]??0)+1}}if($.collapseTurnsToQuestionAnswer){let W=i(J,z);if(W.length<J.length){let C=new Set(W.map((E)=>E.id));for(let E of J){if(C.has(E.id))continue;let U=q(E.node);D[U]=(D[U]??0)+1}J=W}}let j=Q-Y.length,Z=Y.length-J.length;if(j<=0&&Z<=0)return{payload:G,stats:w("no-reduction",{originalNodes:Q,activePathNodes:Y.length,keptNodes:Q,userTurns:L,recentFullTurns:$.recentFullTurns})};let M={};for(let W=0;W<J.length;W+=1){let{id:C,node:E}=J[W],U=J[W-1]?.id??null,N=J[W+1]?.id;M[C]={...E,id:E.id??C,parent:U,children:N?[N]:[]}}let O=new Set(J.map(({node:W})=>W.message?.id).filter((W)=>typeof W==="string")),H=Array.isArray(G.moderation_results)?G.moderation_results.filter((W)=>typeof W.message_id!=="string"||O.has(W.message_id)):G.moderation_results;return{payload:{...G,mapping:M,current_node:J.at(-1)?.id??G.current_node,...H===void 0?{}:{moderation_results:H}},stats:w("optimized",{originalNodes:Q,activePathNodes:Y.length,keptNodes:J.length,removedOffPathNodes:j,removedHistoricNodes:Z,userTurns:L,recentFullTurns:$.recentFullTurns,removedByKind:D})}}function p(G,V=new Set){if(!G.some((Y)=>Y.author?.role==="user"))return G;let $=[],X=[],Q=()=>{if(X.length===0)return;let Y=X.find((J)=>J.author?.role==="user"),L=X.filter((J)=>J.author?.role==="assistant"&&f(J)),A=[...L].reverse().find((J)=>J.channel==="final")??L.at(-1);if(!Y||!A){$.push(...X),X=[];return}let z=new Set([Y,A]);for(let J of X)if(typeof J.id==="string"&&V.has(J.id))z.add(J);$.push(...X.filter((J)=>z.has(J))),X=[]};for(let Y of G){if(Y.author?.role==="user")Q();if(X.length>0||Y.author?.role==="user")X.push(Y)}return Q(),$.length>0?$:G}function v(G,V={}){let $=Array.isArray(G.messages)?G.messages:null;if(!$)return{payload:G,stats:{changed:!1,originalMessages:0,keptMessages:0,removedMessages:0,originalBytes:0,keptBytes:0,userTurns:0,recentFullTurns:0,removedByKind:{}}};let X=Math.max(0,Math.floor(V.recentFullTurns??0)),Q=new Set(V.forceKeepMessageIds??[]),Y=$.reduce((H,_)=>H+(_.author?.role==="user"?1:0),0),L=X>0&&Y===0,A=Math.max(0,Y-X),z=[],J={},D=-1;for(let H of $){if(H.author?.role==="user")D+=1;let _=H.id,W=X>0&&D>=A;if(L||typeof _==="string"&&Q.has(_)||W||f(H))z.push(H);else{let E=B(H);J[E]=(J[E]??0)+1}}if(V.collapseTurnsToQuestionAnswer===!0&&X===0&&Y>0){let H=p(z,Q);if(H.length<z.length){let _=new Set(H);for(let W of z){if(_.has(W))continue;let C=B(W);J[C]=(J[C]??0)+1}z=H}}if($.length>0&&z.length===0){let H=$.at(-1);z.push(H);let _=B(H);if(J[_]!=null){if(J[_]-=1,J[_]<=0)delete J[_]}}let R=new Set(z.map((H)=>H.id).filter((H)=>typeof H==="string")),j=Array.isArray(G.moderation_results)?G.moderation_results.filter((H)=>typeof H.message_id!=="string"||R.has(H.message_id)):G.moderation_results,Z=$.reduce((H,_)=>H+P(_),0),M=z.reduce((H,_)=>H+P(_),0),O=z.length!==$.length;return{payload:O?{...G,messages:z,...j===void 0?{}:{moderation_results:j}}:G,stats:{changed:O,originalMessages:$.length,keptMessages:z.length,removedMessages:$.length-z.length,originalBytes:Z,keptBytes:M,userTurns:Y,recentFullTurns:X,removedByKind:J}}}function x(G,V={}){if(G.length===0)return[];let $=Math.max(1,Math.floor(V.maxTurns??1)),X=Math.max(1,Math.floor(V.maxMessages??16)),Q=Math.max(1024,Math.floor(V.maxBytes??131072)),Y=V.allowSplitTurns??!0,L=[],A=[];for(let Z of G){if(Z.author?.role==="user"&&A.length>0)L.push(A),A=[];A.push(Z)}if(A.length>0)L.push(A);let z=[];for(let Z of L){let M=Z.reduce((C,E)=>C+P(E),0);if(!Y||Z.length<=X&&M<=Q){z.push({messages:Z,startsTurn:!0,bytes:M});continue}let O=[],H=[],_=0;for(let C=Z.length-1;C>=0;C-=1){let E=Z[C],U=P(E);if(H.length>0&&(H.length+1>X||_+U>Q))O.push({messages:H,bytes:_}),H=[],_=0;H.unshift(E),_+=U}if(H.length>0)O.push({messages:H,bytes:_});let W=O.reverse();for(let C=0;C<W.length;C+=1){let E=W[C];z.push({...E,startsTurn:C===0})}}let J=[],D=[],R=0,j=0;for(let Z=z.length-1;Z>=0;Z-=1){let M=z[Z],O=j+(M.startsTurn?1:0);if(D.length>0&&(O>$||D.length+M.messages.length>X||R+M.bytes>Q))J.push(D),D=[],R=0,j=0;D=[...M.messages,...D],R+=M.bytes,j+=M.startsTurn?1:0}if(D.length>0)J.push(D);return J}function F(G){if(G.buffer instanceof ArrayBuffer)return JSON.parse(new TextDecoder().decode(G.buffer));return F(G)}function l(G){return G==="finished_successfully"||G==="finished"||G==="complete"}function d(G){if(typeof G.current_node!=="string"||!Array.isArray(G.messages))return;return G.messages.find((V)=>V.id===G.current_node)}function c(G){if(G.async_status!=null||!Array.isArray(G.messages))return!0;if(G.messages.some(($)=>["in_progress","streaming","pending"].includes(String($.status))))return!0;let V=d(G);return!V||!l(V.status)}function n(G){return!c(G)}function r(G){if(!Array.isArray(G.messages)||typeof G.current_node!=="string")return[];let V=new Map(G.messages.filter((Q)=>typeof Q.id==="string").map((Q)=>[Q.id,Q])),$=new Set([G.current_node]),X=V.get(G.current_node);if(X?.author?.role==="tool"){let Q=X.metadata?.parent_id;if(typeof Q==="string"&&V.has(Q))$.add(Q)}return[...$]}var K=new Map,o=1;function t(G){if(G.author?.role!=="assistant")return!1;if(G.metadata?.is_visually_hidden_from_conversation===!0)return!1;if(G.recipient!=null&&G.recipient!=="all")return!1;if(G.channel==="final")return!0;return!["code","execution_output","thoughts","reasoning_recap"].includes(String(G.content?.content_type??""))}function a(G,V){let $=-1;for(let X=0;X<G.length;X+=1)if(G[X]?.author?.role==="user")$=X;if($<0)return!1;return G.slice($+1).some((X)=>t(X)&&(!V||X.channel==="final"))}function s(G,V){let $=new Set,X=[];for(let Q of[...G,...V]){if(typeof Q.id==="string"){if($.has(Q.id))continue;$.add(Q.id)}X.push(Q)}return X}function e(G,V){return{...G,messages:s(Array.isArray(V.messages)?V.messages:[],Array.isArray(G.messages)?G.messages:[]),page_info:V.page_info,safe_urls:[...new Set([...V.safe_urls??[],...G.safe_urls??[]])],blocked_urls:[...new Set([...V.blocked_urls??[],...G.blocked_urls??[]])]}}function I(G,V){let $=Array.isArray(V.payload.messages)?V.payload.messages:[],X=V.payload.page_info?.has_previous_page===!0&&typeof V.payload.page_info.start_cursor==="string"?V.payload.page_info.start_cursor:null;return{token:G,complete:a($,V.requireFinal),cursor:X,messageCount:$.length}}var GG=Math.random().toString(36).slice(2),VG=1;function XG(G,V){let $=G.split(`\n`),X=[];for(let z=0;z<$.length;z+=1){let J=$[z].match(/^\\s*(`{3,}|~{3,})\\s*([^`]*)$/);if(!J)continue;let D=J[1],R=D[0],j=new RegExp(`^\\\\s*${R}{${D.length},}\\\\s*$`),Z=z+1;while(Z<$.length&&!j.test($[Z]))Z+=1;if(Z>=$.length)continue;let M=J[2].trim().split(/\\s+/,1)[0]??"",O=$.slice(z+1,Z).join(`\n`);X.push({start:z,end:Z,language:M,code:O}),z=Z}let Q=X.reduce((z,J)=>z+J.code.length,0);if(X.length<4&&Q<8000)return{text:G,blocks:[]};let Y=new Map(X.map((z)=>[z.start,z])),L=[],A=[];for(let z=0;z<$.length;z+=1){let J=Y.get(z);if(!J){L.push($[z]);continue}let D=`${GG}-${V}-${VG++}`,R=Math.max(1,J.code.split(`\n`).length);A.push({token:D,language:J.language,code:J.code,lineCount:R}),L.push(`[代码块](https://chatgpt.com/#cgptperf-code=${D}&lines=${R})`),z=J.end}return{text:L.join(`\n`),blocks:A}}function $G(G){if(!Array.isArray(G.messages))return{payload:G,codeBlocks:[]};let V=[],$=G.messages.map((X,Q)=>{if(!["assistant","user"].includes(String(X.author?.role))||!Array.isArray(X.content?.parts))return X;let Y=!1,L=X.content.parts.map((A,z)=>{if(typeof A!=="string")return A;let J=XG(A,`m${Q}p${z}`);if(J.blocks.length===0)return A;return Y=!0,V.push(...J.blocks),J.text});if(!Y)return X;return{...X,content:{...X.content,parts:L}}});return{payload:{...G,messages:$},codeBlocks:V}}function k(G,V){let $=c(G),X=V.apiKind==="paginated-initial",Q=v(G,{recentFullTurns:X&&$?V.recentFullTurns??1:0,forceKeepMessageIds:X?r(G):[],collapseTurnsToQuestionAnswer:V.apiKind==="paginated-messages"||X&&!$}),Y=V.lightweightCodeBlocks===!0&&!$?$G(Q.payload):{payload:Q.payload,codeBlocks:[]},L=Array.isArray(Y.payload.messages)?Y.payload.messages:[];return{payload:Y.payload,stats:Q.stats,chunks:x(L,V.chunkOptions),codeBlocks:Y.codeBlocks,active:$,cacheable:X&&n(G)}}self.addEventListener("message",(G)=>{let V=G.data;try{if(V.operation==="parse"){self.postMessage({id:V.id,ok:!0,value:F(V)});return}if(V.operation==="optimize-legacy"){let X=F(V),Q=T(X,V.legacyOptions);self.postMessage({id:V.id,ok:!0,value:{payload:Q.payload,stats:Q.stats}});return}if(V.operation==="start-paginated-job"){let X=F(V),Q=`page-${o++}`,Y={payload:X,requireFinal:V.requireFinal===!0};K.set(Q,Y),self.postMessage({id:V.id,ok:!0,value:I(Q,Y)});return}if(V.operation==="prepend-paginated-job"){let X=V.token??"",Q=K.get(X);if(!Q)throw Error("Unknown paginated job");let Y=F(V);Q.payload=e(Q.payload,Y),self.postMessage({id:V.id,ok:!0,value:I(X,Q)});return}if(V.operation==="finish-paginated-job"){let X=V.token??"",Q=K.get(X);if(!Q)throw Error("Unknown paginated job");K.delete(X),self.postMessage({id:V.id,ok:!0,value:k(Q.payload,V)});return}if(V.operation==="cancel-paginated-job"){K.delete(V.token??""),self.postMessage({id:V.id,ok:!0,value:null});return}let $=F(V);self.postMessage({id:V.id,ok:!0,value:k($,V)})}catch($){self.postMessage({id:V.id,ok:!1,error:$ instanceof Error?$.message:String($)})}});})();\n';
      const url = pageWindow.URL.createObjectURL(new pageWindow.Blob([source], { type: "application/javascript" }));
      const worker = new pageWindow.Worker(url, {
        name: "chatgpt-performance-json"
      });
      pageWindow.URL.revokeObjectURL(url);
      const state = {
        worker,
        nextId: 1,
        pending: new Map
      };
      worker.addEventListener("message", (event) => {
        const reply = event.data;
        const pending = state.pending.get(reply.id);
        if (!pending)
          return;
        state.pending.delete(reply.id);
        const finishedAt = pageWindow.performance.now();
        const elapsed = finishedAt - pending.startedAt;
        try {
          pageWindow.performance.measure(`chatgpt-perf:worker:${pending.operation}`, {
            start: pending.startedAt,
            end: finishedAt,
            detail: { durationMs: elapsed }
          });
        } catch {}
        const root = pageWindow.document.documentElement;
        const count = Number(root.dataset.chatgptJsonWorkerParses ?? "0");
        const total = Number(root.dataset.chatgptJsonWorkerTotalMs ?? "0");
        root.dataset.chatgptJsonWorkerParses = String(count + 1);
        root.dataset.chatgptJsonWorkerTotalMs = String(Math.round(total + elapsed));
        if (reply.ok)
          pending.resolve(reply.value);
        else
          pending.reject(new Error(reply.error ?? "Worker JSON parse failed"));
      });
      worker.addEventListener("error", () => {
        for (const pending of state.pending.values()) {
          pending.reject(new Error("JSON worker failed"));
        }
        state.pending.clear();
        worker.terminate();
        jsonWorkerState = null;
      });
      jsonWorkerState = state;
      return state;
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not create JSON worker`, error);
      jsonWorkerState = null;
      return null;
    }
  }
  async function runOptimizerWorker(pageWindow, request, transfer = []) {
    const state = ensureJsonWorker(pageWindow);
    if (!state)
      throw new Error("Optimizer worker is unavailable");
    const id = state.nextId++;
    return await new Promise((resolve, reject) => {
      state.pending.set(id, {
        resolve,
        reject,
        startedAt: pageWindow.performance.now(),
        operation: String(request.operation ?? "unknown")
      });
      state.worker.postMessage({ id, ...request }, transfer);
    });
  }
  async function optimizeLegacyOffMain(pageWindow, text, options) {
    try {
      return await runOptimizerWorker(pageWindow, {
        operation: "optimize-legacy",
        text,
        legacyOptions: options
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Worker legacy optimization fell back`, error);
      const payload = JSON.parse(text);
      return optimizeConversationPayload(payload, options);
    }
  }
  async function optimizePaginatedOffMain(pageWindow, text, apiKind, mode) {
    try {
      return await runOptimizerWorker(pageWindow, {
        operation: "optimize-paginated",
        text,
        apiKind,
        recentFullTurns: MODE_OPTIONS[mode].recentFullTurns,
        lightweightCodeBlocks: true,
        chunkOptions: {
          maxTurns: MODE_OPTIONS[mode].paginatedRenderTurns,
          maxMessages: Number.MAX_SAFE_INTEGER,
          maxBytes: Number.MAX_SAFE_INTEGER,
          allowSplitTurns: false
        }
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Worker paginated optimization fell back`, error);
      const payload = JSON.parse(text);
      const active = hasActivePaginatedWork(payload);
      const initial = apiKind === "paginated-initial";
      const result = optimizePaginatedConversationPayload(payload, {
        recentFullTurns: initial && active ? MODE_OPTIONS[mode].recentFullTurns : 0,
        forceKeepMessageIds: initial ? requiredInitialMessageIds(payload) : [],
        collapseTurnsToQuestionAnswer: apiKind === "paginated-messages" || initial && !active
      });
      return {
        payload: result.payload,
        stats: result.stats,
        chunks: splitPaginatedMessagesNewestFirst(result.payload.messages ?? [], {
          maxTurns: MODE_OPTIONS[mode].paginatedRenderTurns,
          maxMessages: Number.MAX_SAFE_INTEGER,
          maxBytes: Number.MAX_SAFE_INTEGER,
          allowSplitTurns: false
        }),
        active,
        cacheable: initial && isIdlePaginatedConversation(payload)
      };
    }
  }
  async function startPaginatedWorkerJob(pageWindow, buffer, requireFinal) {
    return runOptimizerWorker(pageWindow, {
      operation: "start-paginated-job",
      buffer,
      requireFinal
    }, [buffer]);
  }
  async function prependPaginatedWorkerJob(pageWindow, token, buffer) {
    return runOptimizerWorker(pageWindow, {
      operation: "prepend-paginated-job",
      token,
      buffer
    }, [buffer]);
  }
  async function finishPaginatedWorkerJob(pageWindow, token, apiKind, mode) {
    return runOptimizerWorker(pageWindow, {
      operation: "finish-paginated-job",
      token,
      apiKind,
      recentFullTurns: MODE_OPTIONS[mode].recentFullTurns,
      lightweightCodeBlocks: true,
      chunkOptions: {
        maxTurns: MODE_OPTIONS[mode].paginatedRenderTurns,
        maxMessages: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
        allowSplitTurns: false
      }
    });
  }
  async function cancelPaginatedWorkerJob(pageWindow, token) {
    try {
      await runOptimizerWorker(pageWindow, {
        operation: "cancel-paginated-job",
        token
      });
    } catch {}
  }
  async function parseJsonOffMain(pageWindow, text) {
    if (text.length < 128 * 1024)
      return JSON.parse(text);
    const state = ensureJsonWorker(pageWindow);
    if (!state)
      return JSON.parse(text);
    const id = state.nextId++;
    try {
      return await new Promise((resolve, reject) => {
        state.pending.set(id, {
          resolve,
          reject,
          startedAt: pageWindow.performance.now()
        });
        state.worker.postMessage({ id, operation: "parse", text });
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Worker parse fell back to main thread`, error);
      return JSON.parse(text);
    }
  }
  async function responseJsonOffMain(pageWindow, response) {
    return parseJsonOffMain(pageWindow, await response.text());
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
  function findConversationCodeMirrorContainer(pageWindow, target) {
    if (!(target instanceof pageWindow.Element))
      return null;
    const container = target.closest('[class*="_codemirror"]');
    if (!container)
      return null;
    return container.closest('[data-message-id], .markdown, [class*="MarkdownContent"], [class*="SmoothedMarkdown"]') ? container : null;
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
      deferredCodeMirrorTargets = new Map;
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
        const observer = this.ensureObserver(target);
        const container = findConversationCodeMirrorContainer(pageWindow, target);
        if (container && container.getAttribute("data-chatgpt-rich-editor-state") !== "hot") {
          if (this.deferredCodeMirrorTargets.has(target))
            return;
          const attributeObserver = new pageWindow.MutationObserver(() => {
            if (container.getAttribute("data-chatgpt-rich-editor-state") !== "hot") {
              return;
            }
            attributeObserver.disconnect();
            this.deferredCodeMirrorTargets.delete(target);
            observer.observe(target);
            const root2 = pageWindow.document.documentElement;
            const count2 = Number(root2.dataset.chatgptCodeMirrorIoResumed ?? "0");
            root2.dataset.chatgptCodeMirrorIoResumed = String(count2 + 1);
          });
          attributeObserver.observe(container, {
            attributes: true,
            attributeFilter: ["data-chatgpt-rich-editor-state"]
          });
          this.deferredCodeMirrorTargets.set(target, attributeObserver);
          const root = pageWindow.document.documentElement;
          const count = Number(root.dataset.chatgptCodeMirrorIoDeferred ?? "0");
          root.dataset.chatgptCodeMirrorIoDeferred = String(count + 1);
          return;
        }
        observer.observe(target);
      }
      unobserve(target) {
        this.deferredCodeMirrorTargets.get(target)?.disconnect();
        this.deferredCodeMirrorTargets.delete(target);
        this.observer?.unobserve(target);
      }
      disconnect() {
        this.observer?.disconnect();
        for (const observer of this.deferredCodeMirrorTargets.values()) {
          observer.disconnect();
        }
        this.deferredCodeMirrorTargets.clear();
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
  var staticCodeBlocks = new Map;
  var staticCodeHydrated = new WeakSet;
  var staticCodeFillQueue = [];
  var staticCodeFillHandle = null;
  var staticCodeHydratorInstalled = false;
  function scheduleStaticCodeFill(pageWindow) {
    if (staticCodeFillHandle != null)
      return;
    const drain = (deadline) => {
      staticCodeFillHandle = null;
      let filled = 0;
      while (staticCodeFillQueue.length > 0 && filled < 2) {
        if (deadline && deadline.timeRemaining() < 8)
          break;
        const item = staticCodeFillQueue.shift();
        if (!item.container.isConnected)
          continue;
        item.code.textContent = item.block.code;
        item.copy.disabled = false;
        item.container.dataset.chatgptStaticCodeState = "ready";
        filled += 1;
      }
      if (staticCodeFillQueue.length > 0)
        scheduleStaticCodeFill(pageWindow);
    };
    if (typeof pageWindow.requestIdleCallback === "function") {
      staticCodeFillHandle = pageWindow.requestIdleCallback(drain);
    } else {
      staticCodeFillHandle = pageWindow.requestAnimationFrame(() => drain());
    }
  }
  function staticCodeToken(anchor) {
    try {
      const url = new URL(anchor.href);
      if (url.origin !== "https://chatgpt.com")
        return null;
      const params = new URLSearchParams(url.hash.slice(1));
      return params.get("cgptperf-code");
    } catch {
      return null;
    }
  }
  var STATIC_CODE_MARKER_RE = /\[代码块\]\(https:\/\/chatgpt\.com\/#cgptperf-code=([^&\s)]+)&lines=\d+\)/g;
  function restoreStaticCodeMarkdown(text) {
    if (!text.includes("#cgptperf-code="))
      return text;
    return text.replace(STATIC_CODE_MARKER_RE, (full, token) => {
      const block = staticCodeBlocks.get(token);
      if (!block)
        return full;
      const fence = block.code.includes("```") ? "````" : "```";
      const language = block.language ? block.language : "";
      return `${fence}${language}
${block.code}
${fence}`;
    });
  }
  function restoreStaticCodeTextarea(pageWindow, textarea) {
    if (!textarea.value.includes("#cgptperf-code="))
      return;
    const restored = restoreStaticCodeMarkdown(textarea.value);
    if (restored === textarea.value)
      return;
    const setter = Object.getOwnPropertyDescriptor(pageWindow.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, restored);
    textarea.dispatchEvent(new pageWindow.InputEvent("input", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: null
    }));
  }
  function restoreStaticCodeRequestInit(init) {
    if (!init || typeof init.body !== "string" || !init.body.includes("#cgptperf-code=")) {
      return init;
    }
    const body = restoreStaticCodeMarkdown(init.body);
    return body === init.body ? init : { ...init, body };
  }
  function hydrateStaticCodeAnchor(pageWindow, anchor) {
    if (staticCodeHydrated.has(anchor))
      return;
    const token = staticCodeToken(anchor);
    const block = token ? staticCodeBlocks.get(token) : undefined;
    if (!token || !block)
      return;
    staticCodeHydrated.add(anchor);
    const lineHeight = 20;
    const collapsedHeight = Math.min(420, Math.max(92, block.lineCount * lineHeight + 44));
    const container = pageWindow.document.createElement("div");
    container.dataset.chatgptStaticCode = token;
    container.dataset.chatgptStaticCodeState = "loading";
    container.style.height = `${collapsedHeight}px`;
    const header = pageWindow.document.createElement("div");
    header.dataset.chatgptStaticCodeHeader = "true";
    const label = pageWindow.document.createElement("span");
    label.textContent = block.language || "code";
    const actions = pageWindow.document.createElement("span");
    actions.dataset.chatgptStaticCodeActions = "true";
    const expand = pageWindow.document.createElement("button");
    expand.type = "button";
    expand.textContent = "展开";
    expand.addEventListener("click", () => {
      const expanded = container.dataset.chatgptStaticCodeExpanded === "true";
      container.dataset.chatgptStaticCodeExpanded = expanded ? "false" : "true";
      container.style.height = expanded ? `${collapsedHeight}px` : "auto";
      expand.textContent = expanded ? "展开" : "收起";
    });
    const copy = pageWindow.document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.disabled = true;
    copy.addEventListener("click", async () => {
      try {
        await pageWindow.navigator.clipboard.writeText(block.code);
        copy.textContent = "已复制";
        pageWindow.setTimeout(() => copy.textContent = "复制", 1200);
      } catch {
        copy.textContent = "复制失败";
        pageWindow.setTimeout(() => copy.textContent = "复制", 1200);
      }
    });
    actions.append(expand, copy);
    header.append(label, actions);
    const pre = pageWindow.document.createElement("pre");
    const code = pageWindow.document.createElement("code");
    code.textContent = "";
    pre.append(code);
    container.append(header, pre);
    const replaceTarget = anchor.parentElement?.tagName === "P" && anchor.parentElement.childNodes.length === 1 ? anchor.parentElement : anchor;
    replaceTarget.replaceWith(container);
    const rect = container.getBoundingClientRect();
    if (rect.bottom >= 0 && rect.top <= pageWindow.innerHeight) {
      code.textContent = block.code;
      copy.disabled = false;
      container.dataset.chatgptStaticCodeState = "ready";
    } else {
      staticCodeFillQueue.push({ block, container, code, copy });
      scheduleStaticCodeFill(pageWindow);
    }
  }
  function scanStaticCodeMarkers(pageWindow, node) {
    if (!(node instanceof pageWindow.Element))
      return;
    const messageScope = node.matches("[data-message-id]") || node.closest("[data-message-id]") ? node : node.querySelector("[data-message-id]");
    if (!messageScope)
      return;
    if (node instanceof pageWindow.HTMLTextAreaElement) {
      restoreStaticCodeTextarea(pageWindow, node);
    }
    if (node instanceof pageWindow.HTMLAnchorElement) {
      hydrateStaticCodeAnchor(pageWindow, node);
    }
    for (const textarea of node.querySelectorAll("textarea")) {
      restoreStaticCodeTextarea(pageWindow, textarea);
    }
    for (const anchor of node.querySelectorAll('a[href^="https://chatgpt.com/#cgptperf-code="]')) {
      hydrateStaticCodeAnchor(pageWindow, anchor);
    }
  }
  function installStaticCodeHydrator(pageWindow) {
    if (staticCodeHydratorInstalled)
      return;
    staticCodeHydratorInstalled = true;
    const root = pageWindow.document.documentElement;
    if (!root)
      return;
    scanStaticCodeMarkers(pageWindow, root);
    const observer = new pageWindow.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes)
          scanStaticCodeMarkers(pageWindow, node);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
  }
  function registerStaticCodeBlocks(pageWindow, blocks) {
    if (!blocks?.length)
      return;
    for (const block of blocks)
      staticCodeBlocks.set(block.token, block);
    while (staticCodeBlocks.size > 1024) {
      const oldest = staticCodeBlocks.keys().next().value;
      if (typeof oldest !== "string")
        break;
      staticCodeBlocks.delete(oldest);
    }
    installStaticCodeHydrator(pageWindow);
    scanStaticCodeMarkers(pageWindow, pageWindow.document.documentElement);
  }
  function installRichTextPerformanceFix(pageWindow, warmDistancePx, editorWarmDistancePx) {
    const marker = "__chatgptRichTextPerformanceFixInstalled";
    if (Reflect.get(pageWindow, marker))
      return;
    Reflect.set(pageWindow, marker, true);
    const smoothedMarkdownSourceHints = new Set(["/2afb55f3-"]);
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
              if ([...smoothedMarkdownSourceHints].some((hint) => stack.includes(hint))) {
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

html [data-chatgpt-static-code] {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 92px;
  overflow: hidden;
  border: 1px solid rgba(127, 127, 127, .22);
  border-radius: 10px;
  background: var(--main-surface-secondary, rgba(127, 127, 127, .08));
  margin: .75rem 0;
}
html [data-chatgpt-static-code-header] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid rgba(127, 127, 127, .18);
  font: 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
}
html [data-chatgpt-static-code-actions] {
  display: inline-flex;
  gap: 6px;
}
html [data-chatgpt-static-code] button {
  appearance: none;
  border: 0;
  border-radius: 6px;
  padding: 4px 7px;
  background: rgba(127, 127, 127, .14);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
html [data-chatgpt-static-code] button:disabled {
  opacity: .45;
  cursor: default;
}
html [data-chatgpt-static-code] pre {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 12px;
  overflow: auto;
  white-space: pre;
  tab-size: 2;
  font: 12px/20px ui-monospace, SFMono-Regular, Menlo, monospace;
}
html [data-chatgpt-static-code-state="loading"] pre {
  background: linear-gradient(90deg, transparent, rgba(127,127,127,.08), transparent);
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
      deferredCodeMirrorTargets = new Map;
      constructor(callback) {
        this.native = new NativeResizeObserver((entries) => callback(entries, this));
      }
      observe(target, options) {
        if (isSmoothedCodeMeasurement(target)) {
          this.skipped.add(target);
          const stack = new Error().stack ?? "";
          for (const match of stack.matchAll(/https:\/\/[^/]+\/(?:cdn\/)?assets\/([^/:]+\.js)/g)) {
            const filename = match[1];
            if (!filename || filename.includes("performance-fix"))
              continue;
            const hint = `/${filename.split("-")[0]}-`;
            smoothedMarkdownSourceHints.add(hint);
          }
          const root2 = pageWindow.document.documentElement;
          root2.dataset.chatgptSmoothedMarkdownSourceCount = String(smoothedMarkdownSourceHints.size);
          const count = Number(root2.dataset.chatgptRichTextSkippedResizeObservers ?? "0");
          root2.dataset.chatgptRichTextSkippedResizeObservers = String(count + 1);
          return;
        }
        const container = findConversationCodeMirrorContainer(pageWindow, target);
        if (container && container.getAttribute("data-chatgpt-rich-editor-state") !== "hot") {
          if (this.deferredCodeMirrorTargets.has(target))
            return;
          const attributeObserver = new pageWindow.MutationObserver(() => {
            if (container.getAttribute("data-chatgpt-rich-editor-state") !== "hot") {
              return;
            }
            attributeObserver.disconnect();
            this.deferredCodeMirrorTargets.delete(target);
            this.native.observe(target, options);
            const root3 = pageWindow.document.documentElement;
            const count2 = Number(root3.dataset.chatgptCodeMirrorRoResumed ?? "0");
            root3.dataset.chatgptCodeMirrorRoResumed = String(count2 + 1);
          });
          attributeObserver.observe(container, {
            attributes: true,
            attributeFilter: ["data-chatgpt-rich-editor-state"]
          });
          this.deferredCodeMirrorTargets.set(target, attributeObserver);
          const root2 = pageWindow.document.documentElement;
          const count = Number(root2.dataset.chatgptCodeMirrorRoDeferred ?? "0");
          root2.dataset.chatgptCodeMirrorRoDeferred = String(count + 1);
          return;
        }
        this.native.observe(target, options);
      }
      unobserve(target) {
        if (this.skipped.delete(target))
          return;
        this.deferredCodeMirrorTargets.get(target)?.disconnect();
        this.deferredCodeMirrorTargets.delete(target);
        this.native.unobserve(target);
      }
      disconnect() {
        this.skipped.clear();
        for (const observer of this.deferredCodeMirrorTargets.values()) {
          observer.disconnect();
        }
        this.deferredCodeMirrorTargets.clear();
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
    const effectiveEditorWarmDistance = Math.max(800, Math.floor(editorWarmDistancePx));
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
        const itemWarmDistance = item.attribute === "data-chatgpt-rich-editor-state" ? effectiveEditorWarmDistance : effectiveWarmDistance;
        if (rect.bottom < -itemWarmDistance || rect.top > pageWindow.innerHeight + itemWarmDistance) {
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
      root.dataset.chatgptCodeEditorWarmDistancePx = String(effectiveEditorWarmDistance);
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
  async function readResponseText(response) {
    INTERNAL_RESPONSE_READS.add(response);
    try {
      return await response.text();
    } finally {
      INTERNAL_RESPONSE_READS.delete(response);
    }
  }
  async function fingerprintResponseBody(pageWindow, body) {
    try {
      const encoded = new pageWindow.TextEncoder().encode(body);
      const digest = await pageWindow.crypto.subtle.digest("SHA-256", encoded);
      return `${body.length}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    } catch {
      const updateTime = body.match(/"update_time"\s*:\s*([^,}\n]+)/)?.[1] ?? "";
      const currentNode = body.match(/"current_node"\s*:\s*"([^"]+)"/)?.[1] ?? "";
      return `${body.length}:${updateTime}:${currentNode}:${body.slice(-256)}`;
    }
  }
  function cloneJsonPayload(pageWindow, payload, body) {
    try {
      return pageWindow.structuredClone(payload);
    } catch {
      return JSON.parse(body);
    }
  }
  function installLegacyResponseFallback(pageWindow, mode) {
    const marker = "__chatgptPerformanceFixResponseFallback";
    const existing = Reflect.get(pageWindow, marker);
    if (existing?.clear)
      return { clear: existing.clear };
    const prototype = pageWindow.Response?.prototype;
    if (!prototype)
      return { clear: () => {
        return;
      } };
    const nativeJson = prototype.json;
    const nativeText = prototype.text;
    const perResponse = new WeakMap;
    const byUrl = new Map;
    const incrementMetric = (name) => {
      const root = pageWindow.document.documentElement;
      const current = Number(root.dataset[name] ?? "0");
      root.dataset[name] = String(current + 1);
    };
    const shouldHandle = (response) => {
      if (INTERNAL_RESPONSE_READS.has(response) || !response.ok || response.bodyUsed) {
        return false;
      }
      const match = matchConversationApiUrl(response.url, pageWindow.location.href);
      if (match?.kind !== "legacy-full")
        return false;
      try {
        const url = new pageWindow.URL(response.url, pageWindow.location.href);
        return !["1", "true"].includes(url.searchParams.get("include_full_conversation") ?? "");
      } catch {
        return false;
      }
    };
    const process = (response) => {
      const previous = perResponse.get(response);
      if (previous)
        return previous;
      const task = (async () => {
        const originalBody = await nativeText.call(response);
        const fingerprint = await fingerprintResponseBody(pageWindow, originalBody);
        const cached = byUrl.get(response.url);
        if (cached?.fingerprint === fingerprint) {
          incrementMetric("chatgptLegacyFallbackCacheHits");
          return cached;
        }
        let parsed = JSON.parse(originalBody);
        let body = originalBody;
        let stats;
        try {
          const result = optimizeConversationPayload(parsed, legacyOptimizerOptions(mode));
          stats = result.stats;
          if (result.stats.changed) {
            parsed = result.payload;
            body = JSON.stringify(result.payload);
            incrementMetric("chatgptLegacyFallbackOptimized");
            const root = pageWindow.document.documentElement;
            root.dataset.chatgptLegacyFallbackOriginalNodes = String(result.stats.originalNodes);
            root.dataset.chatgptLegacyFallbackKeptNodes = String(result.stats.keptNodes);
            root.dataset.chatgptPerformanceFix = "large";
          }
        } catch (error) {
          console.warn(`[${SCRIPT_NAME}] Legacy response fallback failed`, error);
        }
        const value = { body, payload: parsed, fingerprint, stats };
        byUrl.set(response.url, value);
        while (byUrl.size > 8) {
          const oldest = byUrl.keys().next().value;
          if (typeof oldest !== "string")
            break;
          byUrl.delete(oldest);
        }
        return value;
      })();
      perResponse.set(response, task);
      return task;
    };
    const patchedJson = function() {
      if (!shouldHandle(this))
        return nativeJson.call(this);
      return process(this).then((value) => cloneJsonPayload(pageWindow, value.payload, value.body));
    };
    const patchedText = function() {
      if (!shouldHandle(this))
        return nativeText.call(this);
      return process(this).then((value) => value.body);
    };
    try {
      Object.defineProperty(patchedJson, "name", { value: "json" });
      Object.defineProperty(patchedText, "name", { value: "text" });
      Object.defineProperty(prototype, "json", {
        configurable: true,
        writable: true,
        value: patchedJson
      });
      Object.defineProperty(prototype, "text", {
        configurable: true,
        writable: true,
        value: patchedText
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Could not install response fallback`, error);
      return { clear: () => {
        return;
      } };
    }
    const controller = {
      clear: () => {
        byUrl.clear();
      }
    };
    Reflect.set(pageWindow, marker, controller);
    pageWindow.document.documentElement.dataset.chatgptResponseFallback = "enabled";
    return controller;
  }
  async function materializeAndOptimize(pageWindow, response, mode, exposedUrl = response.url) {
    const originalBody = await readResponseText(response);
    let body = originalBody;
    let optimized = false;
    let cacheable = false;
    let stats;
    if (response.ok) {
      try {
        const result = await optimizeLegacyOffMain(pageWindow, originalBody, MODE_OPTIONS[mode]);
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
    const originalBody = await readResponseText(response);
    let body = originalBody;
    let optimized = requestWasClamped;
    let stats;
    let optimizedPayload;
    let cacheable = false;
    let localPagePayloads = [];
    if (response.ok) {
      try {
        const result = workerJobToken ? await finishPaginatedWorkerJob(pageWindow, workerJobToken, apiKind, mode) : await optimizePaginatedOffMain(pageWindow, originalBody, apiKind, mode);
        stats = result.stats;
        cacheable = result.cacheable;
        optimizedPayload = result.payload;
        registerStaticCodeBlocks(pageWindow, result.codeBlocks);
        if (result.stats.changed || workerJobToken)
          optimized = true;
        const chunksNewestFirst = result.chunks;
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
          localPagePayloads = chunksNewestFirst.slice(1).map((messages, index) => {
            const hasAnotherLocalPage = index + 1 < localCursors.length;
            return {
              cursor: localCursors[index],
              payload: {
                messages,
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
  async function prepareCompletePaginatedResponse(pageWindow, originalFetch, input, init, rewrittenUrl, apiKind, conversationId) {
    const [firstInput, firstInit] = rewriteGetRequest(pageWindow, input, init, rewrittenUrl);
    const firstResponse = await originalFetch(firstInput, firstInit);
    if (!firstResponse.ok || !ensureJsonWorker(pageWindow)) {
      return {
        response: apiKind === "paginated-messages" ? await fetchCompleteHistoryPage(pageWindow, originalFetch, input, init, rewrittenUrl) : await fetchCompleteInitialPage(pageWindow, originalFetch, input, init, rewrittenUrl, conversationId)
      };
    }
    let probe;
    try {
      probe = await startPaginatedWorkerJob(pageWindow, await firstResponse.clone().arrayBuffer(), apiKind === "paginated-messages");
      const seenCursors = new Set;
      for (let attempt = 0;!probe.complete && attempt < 9; attempt += 1) {
        const cursor = probe.cursor;
        if (!cursor || seenCursors.has(cursor))
          break;
        seenCursors.add(cursor);
        const olderUrl = apiKind === "paginated-initial" ? new pageWindow.URL(`/backend-api/conversations/${conversationId}/messages`, rewrittenUrl) : new pageWindow.URL(rewrittenUrl);
        olderUrl.searchParams.set("before", cursor);
        olderUrl.searchParams.set("include_has_versions", "true");
        olderUrl.searchParams.set("num_turns", String(Math.min(512, 2 ** Math.min(9, attempt + 2))));
        const [olderInput, olderInit] = rewriteGetRequest(pageWindow, input, init, olderUrl.href);
        const olderResponse = await originalFetch(olderInput, olderInit);
        if (!olderResponse.ok)
          break;
        probe = await prependPaginatedWorkerJob(pageWindow, probe.token, await olderResponse.arrayBuffer());
      }
      return { response: firstResponse, workerJobToken: probe.token };
    } catch (error) {
      if (probe?.token)
        await cancelPaginatedWorkerJob(pageWindow, probe.token);
      console.warn(`[${SCRIPT_NAME}] Worker page assembly fell back`, error);
      return {
        response: apiKind === "paginated-messages" ? await fetchCompleteHistoryPage(pageWindow, originalFetch, input, init, rewrittenUrl) : await fetchCompleteInitialPage(pageWindow, originalFetch, input, init, rewrittenUrl, conversationId)
      };
    }
  }
  async function fetchCompleteInitialPage(pageWindow, originalFetch, input, init, rewrittenUrl, conversationId) {
    const [firstInput, firstInit] = rewriteGetRequest(pageWindow, input, init, rewrittenUrl);
    const firstResponse = await originalFetch(firstInput, firstInit);
    if (!firstResponse.ok)
      return firstResponse;
    let payload = await responseJsonOffMain(pageWindow, firstResponse.clone());
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
      const olderPayload = await responseJsonOffMain(pageWindow, olderResponse);
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
    let payload = await responseJsonOffMain(pageWindow, firstResponse.clone());
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
      const olderPayload = await responseJsonOffMain(pageWindow, olderResponse);
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
    try {
      const prepared = await prepareCompletePaginatedResponse(pageWindow, originalFetch, input, { ...init, cache: "no-store" }, lazyUrl.href, "paginated-initial", conversationId);
      const nativeResponse = prepared.response;
      if (!nativeResponse.ok) {
        throw new Error(`Native pagination returned HTTP ${nativeResponse.status}`);
      }
      const nativeMaterialized = await materializeAndOptimizePaginated(pageWindow, nativeResponse, "paginated-initial", mode, legacyUrl, true, createLocalCursor, prepared.workerJobToken);
      const optimizedNativePayload = await parseJsonOffMain(pageWindow, nativeMaterialized.body);
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
      installRichTextPerformanceFix(pageWindow, MODE_OPTIONS[settings.mode].richTextWarmDistancePx, MODE_OPTIONS[settings.mode].codeEditorWarmDistancePx);
    }
    const deepLink = new pageWindow.URLSearchParams(pageWindow.location.search);
    if (settings.mode === "off" || bypassThisPageLoad || deepLink.has("message") || deepLink.has("messageId")) {
      return;
    }
    const activeMode = settings.mode;
    const responseFallback = installLegacyResponseFallback(pageWindow, activeMode);
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
      responseFallback.clear();
    };
    const wrappedFetch = async (input, init) => {
      const rawUrl = requestUrl(pageWindow, input, pageWindow.location.href);
      const method = requestMethod(input, init);
      const apiMatch = matchConversationApiUrl(rawUrl, pageWindow.location.href);
      if (isConversationMutation(rawUrl, method, pageWindow.location.href)) {
        clearConversationCache();
        return originalFetch(input, restoreStaticCodeRequestInit(init));
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
        if (apiMatch.kind === "paginated-messages") {
          const cached = cache.get(key);
          if (cached && cached.expiresAt > Date.now()) {
            const root = pageWindow.document.documentElement;
            const hits = Number(root.dataset.chatgptHistoryCacheHits ?? "0");
            root.dataset.chatgptHistoryCacheHits = String(hits + 1);
            await yieldUntilInteractionIdle(pageWindow);
            return cloneMaterializedResponse(pageWindow, cached.response);
          }
          if (cached)
            cache.delete(key);
        }
        task = inFlight.get(key);
        if (!task) {
          const responseTask = prepareCompletePaginatedResponse(pageWindow, originalFetch, input, init, rewrittenUrl, apiMatch.kind, apiMatch.conversationId);
          task = responseTask.then((prepared) => materializeAndOptimizePaginated(pageWindow, prepared.response, apiMatch.kind, activeMode, normalizedRawUrl, requestWasClamped, createLocalCursor, prepared.workerJobToken));
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
        if (materialized.apiKind === "paginated-messages" && materialized.optimized) {
          cache.set(key, {
            expiresAt: Date.now() + HISTORY_CACHE_TTL_MS,
            response: materialized
          });
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
