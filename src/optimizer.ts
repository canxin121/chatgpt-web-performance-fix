export interface ConversationMessage {
  id?: string;
  author?: {
    role?: string;
    name?: string;
  };
  recipient?: string;
  channel?: string;
  content?: {
    content_type?: string;
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ConversationNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: ConversationMessage | null;
  [key: string]: unknown;
}

export interface ConversationPayload {
  current_node?: string | null;
  mapping?: Record<string, ConversationNode>;
  moderation_results?: Array<{ message_id?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface PaginatedConversationPayload {
  current_node?: string | null;
  messages?: ConversationMessage[];
  moderation_results?: Array<{ message_id?: string; [key: string]: unknown }>;
  page_info?: {
    has_previous_page?: boolean;
    start_cursor?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PaginatedConversationPageState {
  blockedUrls: unknown[];
  cursor: string | null;
  messagesLeafToRoot: ConversationMessage[];
  moderationResults: Array<{ message_id?: string; [key: string]: unknown }>;
  numTurns: number;
  oldestMessageId: string | null;
  safeUrls: unknown[];
  serverCurrentLeafId?: string | null;
}

export interface LazyConversationPayload extends ConversationPayload {
  __paginatedConversationPage: PaginatedConversationPageState;
}

export interface OptimizerOptions {
  /** Do not touch ordinary-sized conversations. */
  minNodeCount: number;
  /** Keep every node in the newest N user turns. */
  recentFullTurns: number;
  /** Preserve the direct parent of current_node for live tool-result continuity. */
  preserveCurrentParent: boolean;
  /** Reduce completed legacy turns to one user question and one AI answer. */
  collapseTurnsToQuestionAnswer: boolean;
}

export interface OptimizationStats {
  changed: boolean;
  reason:
    | "optimized"
    | "below-threshold"
    | "already-paginated"
    | "invalid-payload"
    | "invalid-active-path"
    | "no-reduction";
  originalNodes: number;
  activePathNodes: number;
  keptNodes: number;
  removedOffPathNodes: number;
  removedHistoricNodes: number;
  userTurns: number;
  recentFullTurns: number;
  removedByKind: Record<string, number>;
}

export interface OptimizationResult<T extends ConversationPayload = ConversationPayload> {
  payload: T;
  stats: OptimizationStats;
}

export interface PaginatedOptimizationOptions {
  /** Keep every message in the newest N user turns. */
  recentFullTurns: number;
  /** Message ids that must survive filtering, such as current_node. */
  forceKeepMessageIds: Iterable<string>;
  /** Completed paginated turns should render as one semantic user/assistant pair. */
  collapseTurnsToQuestionAnswer: boolean;
}

export interface PaginatedOptimizationStats {
  changed: boolean;
  originalMessages: number;
  keptMessages: number;
  removedMessages: number;
  originalBytes: number;
  keptBytes: number;
  userTurns: number;
  recentFullTurns: number;
  removedByKind: Record<string, number>;
}

export interface PaginatedOptimizationResult<
  T extends PaginatedConversationPayload = PaginatedConversationPayload,
> {
  payload: T;
  stats: PaginatedOptimizationStats;
}

export interface PaginatedChunkOptions {
  /** Maximum user turns committed by one React prepend. */
  maxTurns: number;
  /** Secondary guard for tool-heavy or malformed pages. */
  maxMessages: number;
  /** Approximate serialized-byte guard per local page. */
  maxBytes: number;
  /** Initial live turns should normally stay atomic. */
  allowSplitTurns: boolean;
}

export type ConversationApiKind =
  | "legacy-full"
  | "paginated-initial"
  | "paginated-messages";

export interface ConversationApiMatch {
  kind: ConversationApiKind;
  conversationId: string;
}

export const DEFAULT_OPTIMIZER_OPTIONS: Readonly<OptimizerOptions> = {
  minNodeCount: 250,
  recentFullTurns: 1,
  preserveCurrentParent: false,
  collapseTurnsToQuestionAnswer: false,
};

const ALWAYS_KEEP_ROLES = new Set(["system", "developer"]);

const KNOWN_INTERNAL_CONTENT_TYPES = new Set([
  "code",
  "execution_output",
  "thoughts",
]);

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function messageKind(message: ConversationMessage | null | undefined): string {
  if (!message) return "root/no-message";
  return `${message.author?.role ?? "unknown"}/${
    message.content?.content_type ?? "unknown"
  }`;
}

function kindOf(node: ConversationNode): string {
  return messageKind(node.message);
}

function makeStats(
  reason: OptimizationStats["reason"],
  partial: Partial<OptimizationStats> = {},
): OptimizationStats {
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
    ...partial,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlreadyPaginated(payload: ConversationPayload): boolean {
  if ("__paginatedConversationPage" in payload) return true;
  const mapping = payload.mapping;
  return Boolean(
    mapping && Object.keys(mapping).some((id) => id.startsWith("paginated-root:")),
  );
}

export function shouldKeepHistoricMessage(
  message: ConversationMessage | null | undefined,
): boolean {
  if (!message) return true;

  if (message.metadata?.is_visually_hidden_from_conversation === true) {
    return false;
  }

  const role = message.author?.role;
  if (role === "user" || (role && ALWAYS_KEEP_ROLES.has(role))) return true;

  if (role === "tool") return false;
  if (role !== "assistant") return true;
  if (message.channel === "final") return true;

  // Assistant messages addressed to a tool are invocation payloads rather than
  // transcript content. Ordinary rendered assistant messages target "all".
  if (message.recipient != null && message.recipient !== "all") return false;

  const contentType = message.content?.content_type;
  return !contentType || !KNOWN_INTERNAL_CONTENT_TYPES.has(contentType);
}

function shouldKeepHistoricNode(node: ConversationNode): boolean {
  return shouldKeepHistoricMessage(node.message);
}

function traceActivePath(
  mapping: Record<string, ConversationNode>,
  currentNode: string,
): Array<{ id: string; node: ConversationNode }> | null {
  const reversePath: Array<{ id: string; node: ConversationNode }> = [];
  const seen = new Set<string>();
  let id: string | null | undefined = currentNode;

  while (id != null) {
    if (seen.has(id)) return null;
    seen.add(id);

    const node = mapping[id];
    if (!node) return null;
    reversePath.push({ id, node });
    id = node.parent;
  }

  reversePath.reverse();
  return reversePath;
}

function collapseNodeEntriesToQuestionAnswer(
  entries: Array<{ id: string; node: ConversationNode }>,
  forceKeepNodeIds: ReadonlySet<string>,
): Array<{ id: string; node: ConversationNode }> {
  const collapsed: Array<{ id: string; node: ConversationNode }> = [];
  let turn: Array<{ id: string; node: ConversationNode }> = [];

  const flushTurn = () => {
    if (turn.length === 0) return;
    const user = turn.find(
      ({ node }) => node.message?.author?.role === "user",
    );
    if (!user) {
      collapsed.push(...turn);
      turn = [];
      return;
    }

    const assistants = turn.filter(
      ({ node }) =>
        node.message?.author?.role === "assistant" &&
        shouldKeepHistoricMessage(node.message),
    );
    const answer =
      [...assistants].reverse().find(
        ({ node }) => node.message?.channel === "final",
      ) ?? assistants.at(-1);
    if (!answer) {
      const forcedInTurn = turn.filter((entry) => forceKeepNodeIds.has(entry.id));
      if (forcedInTurn.length > 0) {
        const selected = new Set<string>([
          user.id,
          ...forcedInTurn.map((entry) => entry.id),
        ]);
        collapsed.push(...turn.filter((entry) => selected.has(entry.id)));
      } else {
        collapsed.push(...turn);
      }
      turn = [];
      return;
    }

    const selected = new Set<string>([user.id, answer.id]);
    for (const entry of turn) {
      if (forceKeepNodeIds.has(entry.id)) selected.add(entry.id);
      const role = entry.node.message?.author?.role;
      if (role && ALWAYS_KEEP_ROLES.has(role)) selected.add(entry.id);
    }
    collapsed.push(...turn.filter((entry) => selected.has(entry.id)));
    turn = [];
  };

  for (const entry of entries) {
    if (entry.node.message?.author?.role === "user") flushTurn();
    if (turn.length > 0 || entry.node.message?.author?.role === "user") {
      turn.push(entry);
    } else {
      collapsed.push(entry);
    }
  }
  flushTurn();
  return collapsed;
}

/**
 * Compact a legacy full-conversation response into a linear active branch.
 *
 * ChatGPT only needs the current leaf id to continue a server-side conversation.
 * Keeping all nodes in the newest user turn preserves live tool state, while old
 * tool invocations/results can be removed without changing the visible transcript.
 */
export function optimizeConversationPayload<
  T extends ConversationPayload = ConversationPayload,
>(
  payload: T,
  options: Partial<OptimizerOptions> = {},
): OptimizationResult<T> {
  const resolved: OptimizerOptions = {
    ...DEFAULT_OPTIMIZER_OPTIONS,
    ...options,
    minNodeCount: Math.max(
      0,
      Math.floor(options.minNodeCount ?? DEFAULT_OPTIMIZER_OPTIONS.minNodeCount),
    ),
    recentFullTurns: Math.max(
      0,
      Math.floor(
        options.recentFullTurns ?? DEFAULT_OPTIMIZER_OPTIONS.recentFullTurns,
      ),
    ),
    preserveCurrentParent:
      options.preserveCurrentParent ??
      DEFAULT_OPTIMIZER_OPTIONS.preserveCurrentParent,
    collapseTurnsToQuestionAnswer:
      options.collapseTurnsToQuestionAnswer ??
      DEFAULT_OPTIMIZER_OPTIONS.collapseTurnsToQuestionAnswer,
  };

  if (!isRecord(payload) || !isRecord(payload.mapping)) {
    return { payload, stats: makeStats("invalid-payload") };
  }

  const mapping = payload.mapping as Record<string, ConversationNode>;
  const originalNodes = Object.keys(mapping).length;

  if (isAlreadyPaginated(payload)) {
    return {
      payload,
      stats: makeStats("already-paginated", {
        originalNodes,
        keptNodes: originalNodes,
        recentFullTurns: resolved.recentFullTurns,
      }),
    };
  }

  if (originalNodes < resolved.minNodeCount) {
    return {
      payload,
      stats: makeStats("below-threshold", {
        originalNodes,
        keptNodes: originalNodes,
        recentFullTurns: resolved.recentFullTurns,
      }),
    };
  }

  if (typeof payload.current_node !== "string") {
    return {
      payload,
      stats: makeStats("invalid-payload", {
        originalNodes,
        keptNodes: originalNodes,
        recentFullTurns: resolved.recentFullTurns,
      }),
    };
  }

  const activePath = traceActivePath(mapping, payload.current_node);
  if (!activePath || activePath.length === 0) {
    return {
      payload,
      stats: makeStats("invalid-active-path", {
        originalNodes,
        keptNodes: originalNodes,
        recentFullTurns: resolved.recentFullTurns,
      }),
    };
  }

  const userTurns = activePath.reduce(
    (count, { node }) => count + (node.message?.author?.role === "user" ? 1 : 0),
    0,
  );
  const firstFullTurnIndex = Math.max(0, userTurns - resolved.recentFullTurns);
  const forcedNodeIds = new Set<string>([payload.current_node]);
  if (resolved.preserveCurrentParent) {
    const parentId = mapping[payload.current_node]?.parent;
    if (typeof parentId === "string" && parentId.length > 0) {
      forcedNodeIds.add(parentId);
    }
  }
  let kept: Array<{ id: string; node: ConversationNode }> = [];
  const removedByKind: Record<string, number> = {};
  let currentTurnIndex = -1;

  for (const entry of activePath) {
    if (entry.node.message?.author?.role === "user") currentTurnIndex += 1;

    const inRecentFullTurn =
      resolved.recentFullTurns > 0 && currentTurnIndex >= firstFullTurnIndex;
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
        if (retainedIds.has(entry.id)) continue;
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
        recentFullTurns: resolved.recentFullTurns,
      }),
    };
  }

  const compactMapping: Record<string, ConversationNode> = {};
  for (let index = 0; index < kept.length; index += 1) {
    const { id, node } = kept[index];
    const previousId = kept[index - 1]?.id ?? null;
    const nextId = kept[index + 1]?.id;
    compactMapping[id] = {
      ...node,
      id: node.id ?? id,
      parent: previousId,
      children: nextId ? [nextId] : [],
    };
  }

  const keptMessageIds = new Set(
    kept
      .map(({ node }) => node.message?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const moderationResults = Array.isArray(payload.moderation_results)
    ? payload.moderation_results.filter(
        (result) =>
          typeof result.message_id !== "string" || keptMessageIds.has(result.message_id),
      )
    : payload.moderation_results;

  const optimizedPayload = {
    ...payload,
    mapping: compactMapping,
    current_node: kept.at(-1)?.id ?? payload.current_node,
    ...(moderationResults === undefined
      ? {}
      : { moderation_results: moderationResults }),
  } as T;

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
      removedByKind,
    }),
  };
}

function collapseToQuestionAnswerPairs(
  messages: ConversationMessage[],
  forceKeepMessageIds: ReadonlySet<string> = new Set(),
): ConversationMessage[] {
  if (!messages.some((message) => message.author?.role === "user")) return messages;

  const collapsed: ConversationMessage[] = [];
  let turn: ConversationMessage[] = [];

  const flushTurn = () => {
    if (turn.length === 0) return;
    const user = turn.find((message) => message.author?.role === "user");
    const assistantCandidates = turn.filter(
      (message) =>
        message.author?.role === "assistant" &&
        shouldKeepHistoricMessage(message),
    );
    const answer =
      [...assistantCandidates].reverse().find((message) => message.channel === "final") ??
      assistantCandidates.at(-1);

    if (!user || !answer) {
      collapsed.push(...turn);
      turn = [];
      return;
    }

    const selected = new Set<ConversationMessage>([user, answer]);
    for (const message of turn) {
      if (typeof message.id === "string" && forceKeepMessageIds.has(message.id)) {
        selected.add(message);
      }
    }
    // Preserve server chronology. Forced tool-state nodes may remain in the tree
    // for current_node correctness, but the only visible transcript nodes are the
    // user question and selected assistant answer.
    collapsed.push(...turn.filter((message) => selected.has(message)));
    turn = [];
  };

  for (const message of messages) {
    if (message.author?.role === "user") flushTurn();
    if (turn.length > 0 || message.author?.role === "user") turn.push(message);
  }
  flushTurn();
  return collapsed.length > 0 ? collapsed : messages;
}

/**
 * Remove old tool traces from the linear `messages` arrays returned by ChatGPT's
 * native paginated conversation endpoints. The server cursor remains untouched;
 * the frontend reconstructs its own linear parent/child chain from array order.
 */
export function optimizePaginatedConversationPayload<
  T extends PaginatedConversationPayload = PaginatedConversationPayload,
>(
  payload: T,
  options: Partial<PaginatedOptimizationOptions> = {},
): PaginatedOptimizationResult<T> {
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
        removedByKind: {},
      },
    };
  }

  const recentFullTurns = Math.max(0, Math.floor(options.recentFullTurns ?? 0));
  const forcedIds = new Set(options.forceKeepMessageIds ?? []);
  const userTurns = messages.reduce(
    (count, message) => count + (message.author?.role === "user" ? 1 : 0),
    0,
  );

  // If an initial page unexpectedly begins in the middle of a turn, fail closed
  // rather than accidentally dropping live tool state from that latest turn.
  const preserveEverything = recentFullTurns > 0 && userTurns === 0;
  const firstFullTurnIndex = Math.max(0, userTurns - recentFullTurns);
  let kept: ConversationMessage[] = [];
  const removedByKind: Record<string, number> = {};
  let currentTurnIndex = -1;

  for (const message of messages) {
    if (message.author?.role === "user") currentTurnIndex += 1;

    const id = message.id;
    const inRecentFullTurn =
      recentFullTurns > 0 && currentTurnIndex >= firstFullTurnIndex;
    const keep =
      preserveEverything ||
      (typeof id === "string" && forcedIds.has(id)) ||
      inRecentFullTurn ||
      shouldKeepHistoricMessage(message);

    if (keep) {
      kept.push(message);
    } else {
      const kind = messageKind(message);
      removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
    }
  }

  if (
    options.collapseTurnsToQuestionAnswer === true &&
    recentFullTurns === 0 &&
    userTurns > 0
  ) {
    const collapsed = collapseToQuestionAnswerPairs(kept, forcedIds);
    if (collapsed.length < kept.length) {
      const retained = new Set(collapsed);
      for (const message of kept) {
        if (retained.has(message)) continue;
        const kind = messageKind(message);
        removedByKind[kind] = (removedByKind[kind] ?? 0) + 1;
      }
      kept = collapsed;
    }
  }

  // Native pagination requires an oldest message id after every successful page.
  // Complete turn pages should always retain user/final messages, but keep the
  // newest original message as a conservative bridge if an unusual page does not.
  if (messages.length > 0 && kept.length === 0) {
    const fallback = messages.at(-1)!;
    kept.push(fallback);
    const kind = messageKind(fallback);
    if (removedByKind[kind] != null) {
      removedByKind[kind] -= 1;
      if (removedByKind[kind] <= 0) delete removedByKind[kind];
    }
  }

  const keptIds = new Set(
    kept
      .map((message) => message.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const moderationResults = Array.isArray(payload.moderation_results)
    ? payload.moderation_results.filter(
        (result) =>
          typeof result.message_id !== "string" || keptIds.has(result.message_id),
      )
    : payload.moderation_results;
  const originalBytes = messages.reduce(
    (sum, message) => sum + serializedBytes(message),
    0,
  );
  const keptBytes = kept.reduce(
    (sum, message) => sum + serializedBytes(message),
    0,
  );
  const changed = kept.length !== messages.length;

  return {
    payload: (changed
      ? {
          ...payload,
          messages: kept,
          ...(moderationResults === undefined
            ? {}
            : { moderation_results: moderationResults }),
        }
      : payload) as T,
    stats: {
      changed,
      originalMessages: messages.length,
      keptMessages: kept.length,
      removedMessages: messages.length - kept.length,
      originalBytes,
      keptBytes,
      userTurns,
      recentFullTurns,
      removedByKind,
    },
  };
}


/**
 * Convert ChatGPT's native paginated initial response into the legacy-shaped
 * conversation payload expected by the fallback loader. The captured frontend
 * recognizes `__paginatedConversationPage` and will initialize its own lazy
 * loading state even though it originally requested the singular legacy URL.
 */
export function convertNativeInitialToLazyConversation(
  payload: PaginatedConversationPayload,
  conversationId: string,
  numTurns: number,
): LazyConversationPayload | null {
  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || messages.length === 0) return null;

  const ids = new Set<string>();
  for (const message of messages) {
    if (typeof message.id !== "string" || message.id.length === 0 || ids.has(message.id)) {
      return null;
    }
    ids.add(message.id);
  }

  const rootId = `paginated-root:${conversationId}`;
  if (ids.has(rootId)) return null;

  const mapping: Record<string, ConversationNode> = {
    [rootId]: {
      id: rootId,
      parent: "",
      children: messages[0]?.id ? [messages[0].id] : [],
    },
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const id = message.id!;
    const previousId = messages[index - 1]?.id ?? rootId;
    const nextId = messages[index + 1]?.id;
    mapping[id] = {
      id,
      message,
      parent: previousId,
      children: nextId ? [nextId] : [],
    };
  }

  const messagesLeafToRoot = [...messages].reverse();
  const moderationResults = Array.isArray(payload.moderation_results)
    ? payload.moderation_results
    : [];
  const safeUrls = Array.isArray(payload.safe_urls) ? payload.safe_urls : [];
  const blockedUrls = Array.isArray(payload.blocked_urls) ? payload.blocked_urls : [];
  const cursor =
    payload.page_info?.has_previous_page === true &&
    typeof payload.page_info.start_cursor === "string" &&
    payload.page_info.start_cursor.length > 0
      ? payload.page_info.start_cursor
      : null;
  const serverCurrentLeafId =
    typeof payload.current_node === "string" ? payload.current_node : null;
  const newestMessageId = messagesLeafToRoot[0]?.id ?? rootId;
  const currentNode =
    serverCurrentLeafId != null && Object.hasOwn(mapping, serverCurrentLeafId)
      ? serverCurrentLeafId
      : newestMessageId;

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
      serverCurrentLeafId,
    },
  };
}

/**
 * Split a chronological message page into local pages ordered newest-first.
 * ChatGPT prepends one response with ReactDOM.flushSync, so keeping each local
 * response to roughly one turn prevents a large server page from becoming one
 * multi-second synchronous commit.
 */
export function splitPaginatedMessagesNewestFirst(
  messages: ConversationMessage[],
  options: Partial<PaginatedChunkOptions> = {},
): ConversationMessage[][] {
  if (messages.length === 0) return [];

  const maxTurns = Math.max(1, Math.floor(options.maxTurns ?? 1));
  const maxMessages = Math.max(1, Math.floor(options.maxMessages ?? 16));
  const maxBytes = Math.max(1_024, Math.floor(options.maxBytes ?? 128 * 1_024));
  const allowSplitTurns = options.allowSplitTurns ?? true;

  const turns: ConversationMessage[][] = [];
  let currentTurn: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.author?.role === "user" && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(message);
  }
  if (currentTurn.length > 0) turns.push(currentTurn);

  const atomicSegments: Array<{
    messages: ConversationMessage[];
    startsTurn: boolean;
    bytes: number;
  }> = [];

  for (const turn of turns) {
    const turnBytes = turn.reduce(
      (sum, message) => sum + serializedBytes(message),
      0,
    );
    if (
      !allowSplitTurns ||
      (turn.length <= maxMessages && turnBytes <= maxBytes)
    ) {
      atomicSegments.push({ messages: turn, startsTurn: true, bytes: turnBytes });
      continue;
    }

    // Split a pathological turn from newest to oldest while preserving the
    // chronological order inside every emitted segment.
    const splitNewestFirst: Array<{
      messages: ConversationMessage[];
      bytes: number;
    }> = [];
    let segment: ConversationMessage[] = [];
    let segmentBytes = 0;
    for (let index = turn.length - 1; index >= 0; index -= 1) {
      const message = turn[index];
      const bytes = serializedBytes(message);
      if (
        segment.length > 0 &&
        (segment.length + 1 > maxMessages || segmentBytes + bytes > maxBytes)
      ) {
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
    for (let index = 0; index < chronologicalSegments.length; index += 1) {
      const item = chronologicalSegments[index];
      atomicSegments.push({
        ...item,
        startsTurn: index === 0,
      });
    }
  }

  const chunksNewestFirst: ConversationMessage[][] = [];
  let chunk: ConversationMessage[] = [];
  let chunkBytes = 0;
  let chunkTurns = 0;

  for (let index = atomicSegments.length - 1; index >= 0; index -= 1) {
    const segment = atomicSegments[index];
    const nextTurns = chunkTurns + (segment.startsTurn ? 1 : 0);
    const exceeds =
      chunk.length > 0 &&
      (nextTurns > maxTurns ||
        chunk.length + segment.messages.length > maxMessages ||
        chunkBytes + segment.bytes > maxBytes);

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
  if (chunk.length > 0) chunksNewestFirst.push(chunk);

  return chunksNewestFirst;
}

export function matchConversationApiUrl(
  rawUrl: string,
  baseUrl: string,
): ConversationApiMatch | null {
  try {
    const pathname = new URL(rawUrl, baseUrl).pathname;
    const legacy = pathname.match(
      /^\/backend-api\/conversation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i,
    );
    if (legacy) {
      return { kind: "legacy-full", conversationId: legacy[1] };
    }

    const paginated = pathname.match(
      /^\/backend-api\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/messages)?\/?$/i,
    );
    if (!paginated) return null;
    return {
      kind: paginated[2] ? "paginated-messages" : "paginated-initial",
      conversationId: paginated[1],
    };
  } catch {
    return null;
  }
}

export function clampPaginatedNumTurns(
  rawUrl: string,
  baseUrl: string,
  maxTurns: number,
): string {
  const url = new URL(rawUrl, baseUrl);
  const match = matchConversationApiUrl(url.href, baseUrl);
  if (!match || match.kind === "legacy-full") return url.href;

  const limit = Math.max(1, Math.floor(maxTurns));
  const requested = Number(url.searchParams.get("num_turns"));
  if (!Number.isFinite(requested) || requested <= 0 || requested > limit) {
    url.searchParams.set("num_turns", String(limit));
  }
  return url.href;
}

export function isLegacyFullConversationUrl(rawUrl: string, baseUrl: string): boolean {
  return matchConversationApiUrl(rawUrl, baseUrl)?.kind === "legacy-full";
}
