import { describe, expect, test } from "bun:test";
import { hasPrivateCapture } from "../analysis/lib/private-paths";
import {
  clampPaginatedNumTurns,
  convertNativeInitialToLazyConversation,
  isLegacyFullConversationUrl,
  matchConversationApiUrl,
  optimizeConversationPayload,
  optimizePaginatedConversationPayload,
  splitPaginatedMessagesNewestFirst,
  type ConversationMessage,
  type ConversationPayload,
} from "../src/optimizer";
import { loadCapturedConversation, traceActivePath } from "./helpers";

const capturedTest = hasPrivateCapture() ? test : test.skip;
const capturedDescribe = hasPrivateCapture() ? describe : describe.skip;

function activeTurns(payload: ConversationPayload): ConversationMessage[][] {
  const messages = traceActivePath(payload)
    .map(({ node }) => node.message)
    .filter((message): message is ConversationMessage => message != null);
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

capturedDescribe("captured ChatGPT conversation", () => {
  test("compacts the real 5,405-node payload to 137 nodes in balanced mode", async () => {
    const { payload, text } = await loadCapturedConversation();
    const result = optimizeConversationPayload(payload, { recentFullTurns: 1 });
    const optimizedText = JSON.stringify(result.payload);

    expect(result.stats).toMatchObject({
      changed: true,
      reason: "optimized",
      originalNodes: 5_405,
      activePathNodes: 3_720,
      keptNodes: 137,
      removedOffPathNodes: 1_685,
      removedHistoricNodes: 3_583,
      userTurns: 16,
      recentFullTurns: 1,
    });
    expect(Buffer.byteLength(text)).toBe(11_398_475);
    expect(Buffer.byteLength(optimizedText)).toBeLessThan(
      Buffer.byteLength(text) * 0.03,
    );
  });

  test("preserves a valid linear path and the original current leaf", async () => {
    const { payload } = await loadCapturedConversation();
    const originalCurrentNode = payload.current_node;
    const result = optimizeConversationPayload(payload, { recentFullTurns: 1 });
    const path = traceActivePath(result.payload);

    expect(result.payload.current_node).toBe(originalCurrentNode);
    expect(path).toHaveLength(137);
    expect(path[0]?.node.parent).toBeNull();
    expect(path.at(-1)?.id).toBe(originalCurrentNode);

    for (let index = 0; index < path.length; index += 1) {
      const current = path[index]!;
      const previous = path[index - 1];
      const next = path[index + 1];
      expect(current.node.parent).toBe(previous?.id ?? null);
      expect(current.node.children).toEqual(next ? [next.id] : []);
    }
  });

  test("keeps the visible transcript and every node in the newest user turn", async () => {
    const { payload } = await loadCapturedConversation();
    const originalPath = traceActivePath(payload);
    const result = optimizeConversationPayload(payload, { recentFullTurns: 1 });
    const keptIds = new Set(Object.keys(result.payload.mapping ?? {}));

    const latestUserIndex = originalPath.findLastIndex(
      ({ node }) => node.message?.author?.role === "user",
    );
    expect(latestUserIndex).toBeGreaterThan(0);

    for (const { id } of originalPath.slice(latestUserIndex)) {
      expect(keptIds.has(id)).toBeTrue();
    }

    const visibleHistoricIds = originalPath
      .slice(0, latestUserIndex)
      .filter(({ node }) => {
        const message = node.message;
        if (!message) return true;
        const role = message.author?.role;
        if (role === "user" || role === "system" || role === "developer") {
          return true;
        }
        if (role !== "assistant") return false;
        return (
          message.channel === "final" ||
          ["text", "multimodal_text", "reasoning_recap"].includes(
            message.content?.content_type ?? "",
          )
        );
      })
      .map(({ id }) => id);

    for (const id of visibleHistoricIds) expect(keptIds.has(id)).toBeTrue();

    const oldToolTraceIds = originalPath
      .slice(0, latestUserIndex)
      .filter(({ node }) => {
        const role = node.message?.author?.role;
        const contentType = node.message?.content?.content_type;
        return role === "tool" || contentType === "code" || contentType === "thoughts";
      })
      .map(({ id }) => id);

    expect(oldToolTraceIds.length).toBeGreaterThan(3_000);
    expect(oldToolTraceIds.every((id) => !keptIds.has(id))).toBeTrue();
  });

  test("removes inactive branches but leaves every active user message", async () => {
    const { payload } = await loadCapturedConversation();
    const originalPath = traceActivePath(payload);
    const activeIds = new Set(originalPath.map(({ id }) => id));
    const inactiveIds = Object.keys(payload.mapping ?? {}).filter(
      (id) => !activeIds.has(id),
    );
    const result = optimizeConversationPayload(payload, { recentFullTurns: 1 });
    const optimizedIds = new Set(Object.keys(result.payload.mapping ?? {}));

    expect(inactiveIds).toHaveLength(1_685);
    expect(inactiveIds.every((id) => !optimizedIds.has(id))).toBeTrue();

    const activeUserIds = originalPath
      .filter(({ node }) => node.message?.author?.role === "user")
      .map(({ id }) => id);
    expect(activeUserIds).toHaveLength(16);
    expect(activeUserIds.every((id) => optimizedIds.has(id))).toBeTrue();
  });
});

describe("optimizer safety guards", () => {
  test("does not modify ordinary small conversations", () => {
    const payload: ConversationPayload = {
      current_node: "child",
      mapping: {
        root: { id: "root", parent: null, children: ["child"] },
        child: {
          id: "child",
          parent: "root",
          children: [],
          message: {
            id: "child",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["hello"] },
          },
        },
      },
    };

    const result = optimizeConversationPayload(payload);
    expect(result.stats.reason).toBe("below-threshold");
    expect(result.payload).toBe(payload);
  });

  test("does not touch native paginated payloads", () => {
    const payload: ConversationPayload = {
      current_node: "paginated-root:test",
      mapping: {
        "paginated-root:test": {
          id: "paginated-root:test",
          parent: null,
          children: [],
        },
      },
      __paginatedConversationPage: {},
    };

    const result = optimizeConversationPayload(payload, { minNodeCount: 0 });
    expect(result.stats.reason).toBe("already-paginated");
    expect(result.payload).toBe(payload);
  });

  test("fails closed for a cyclic active path", () => {
    const payload: ConversationPayload = {
      current_node: "a",
      mapping: {
        a: { id: "a", parent: "b", children: ["b"] },
        b: { id: "b", parent: "a", children: ["a"] },
      },
    };

    const result = optimizeConversationPayload(payload, { minNodeCount: 0 });
    expect(result.stats.reason).toBe("invalid-active-path");
    expect(result.payload).toBe(payload);
  });
});

describe("legacy emergency optimizer", () => {
  test("keeps the structural root, user, and current dependency nodes when a live turn has no visible AI text", () => {
    const payload: ConversationPayload = {
      current_node: "tool-result",
      mapping: {
        root: { id: "root", parent: null, children: ["user"] },
        user: {
          id: "user",
          parent: "root",
          children: ["thought"],
          message: {
            id: "user",
            author: { role: "user" },
            content: { content_type: "text", parts: ["question"] },
          },
        },
        thought: {
          id: "thought",
          parent: "user",
          children: ["old-tool-call"],
          message: {
            id: "thought",
            author: { role: "assistant" },
            content: { content_type: "thoughts", parts: ["internal"] },
          },
        },
        "old-tool-call": {
          id: "old-tool-call",
          parent: "thought",
          children: ["old-tool-result"],
          message: {
            id: "old-tool-call",
            author: { role: "assistant" },
            recipient: "tool.old",
            content: { content_type: "code", parts: ["old call"] },
          },
        },
        "old-tool-result": {
          id: "old-tool-result",
          parent: "old-tool-call",
          children: ["tool-call"],
          message: {
            id: "old-tool-result",
            author: { role: "tool" },
            content: { content_type: "code", parts: ["old result"] },
          },
        },
        "tool-call": {
          id: "tool-call",
          parent: "old-tool-result",
          children: ["tool-result"],
          message: {
            id: "tool-call",
            author: { role: "assistant" },
            recipient: "tool.current",
            content: { content_type: "code", parts: ["current call"] },
          },
        },
        "tool-result": {
          id: "tool-result",
          parent: "tool-call",
          children: [],
          message: {
            id: "tool-result",
            author: { role: "tool" },
            content: { content_type: "code", parts: ["current result"] },
          },
        },
      },
    };

    const result = optimizeConversationPayload(payload, {
      minNodeCount: 0,
      recentFullTurns: 0,
      preserveCurrentParent: true,
      collapseTurnsToQuestionAnswer: true,
    });

    expect(Object.keys(result.payload.mapping ?? {})).toEqual([
      "root",
      "user",
      "tool-call",
      "tool-result",
    ]);
    expect(result.payload.current_node).toBe("tool-result");
    expect(result.payload.mapping?.["tool-call"]?.parent).toBe("user");
    expect(result.payload.mapping?.["tool-result"]?.parent).toBe("tool-call");
  });
});

describe("native paginated conversation optimizer", () => {
  capturedTest("reduces a real 773-message historical turn to 8 visible messages", async () => {
    const { payload } = await loadCapturedConversation();
    const heaviestTurn = activeTurns(payload).toSorted(
      (left, right) => right.length - left.length,
    )[0]!;
    const result = optimizePaginatedConversationPayload(
      { messages: heaviestTurn },
      { recentFullTurns: 0 },
    );

    expect(result.stats).toMatchObject({
      changed: true,
      originalMessages: 773,
      keptMessages: 8,
      removedMessages: 765,
      userTurns: 1,
      recentFullTurns: 0,
    });
    expect(result.stats.keptBytes).toBeLessThan(result.stats.originalBytes * 0.02);
    expect(result.payload.messages?.some((message) => message.author?.role === "user"))
      .toBeTrue();
    expect(
      result.payload.messages?.every(
        (message) =>
          message.author?.role !== "tool" &&
          message.content?.content_type !== "thoughts" &&
          !(
            message.author?.role === "assistant" &&
            message.content?.content_type === "code"
          ),
      ),
    ).toBeTrue();
  });

  capturedTest("keeps the newest initial turn complete while compacting the previous turn", async () => {
    const { payload } = await loadCapturedConversation();
    const turns = activeTurns(payload);
    const initialMessages = [...turns.at(-2)!, ...turns.at(-1)!];
    const newestTurnIds = new Set(turns.at(-1)!.map((message) => message.id));
    const result = optimizePaginatedConversationPayload(
      {
        current_node: payload.current_node,
        messages: initialMessages,
      },
      {
        recentFullTurns: 1,
        forceKeepMessageIds:
          typeof payload.current_node === "string" ? [payload.current_node] : [],
      },
    );
    const keptIds = new Set(result.payload.messages?.map((message) => message.id));

    expect(result.stats).toMatchObject({
      changed: true,
      originalMessages: 618,
      keptMessages: 59,
      removedMessages: 559,
      userTurns: 2,
      recentFullTurns: 1,
    });
    expect([...newestTurnIds].every((id) => keptIds.has(id))).toBeTrue();
    expect(keptIds.has(payload.current_node)).toBeTrue();
  });

  capturedTest("collapses a completed historical turn to one user question and one AI answer", async () => {
    const { payload } = await loadCapturedConversation();
    const turns = activeTurns(payload);
    const heavyTurn = turns.toSorted((left, right) => right.length - left.length)[0]!;
    const result = optimizePaginatedConversationPayload(
      { messages: heavyTurn },
      {
        recentFullTurns: 0,
        collapseTurnsToQuestionAnswer: true,
      },
    );

    expect(result.payload.messages).toHaveLength(2);
    expect(result.payload.messages?.[0]?.author?.role).toBe("user");
    expect(result.payload.messages?.[1]?.author?.role).toBe("assistant");
    expect(result.payload.messages?.[1]?.channel).toBe("final");
    expect(result.stats.originalMessages).toBe(773);
    expect(result.stats.keptMessages).toBe(2);

    const chunks = splitPaginatedMessagesNewestFirst(result.payload.messages ?? [], {
      maxTurns: 1,
      maxMessages: 2,
      maxBytes: 32 * 1_024,
      allowSplitTurns: false,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.map((message) => message.author?.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  capturedTest("collapses a completed initial page to one visible user/AI pair while preserving forced current ids", async () => {
    const { payload } = await loadCapturedConversation();
    const turns = activeTurns(payload);
    const completeTurn = turns.at(-2)!;
    const final = [...completeTurn].reverse().find(
      (message) =>
        message.author?.role === "assistant" && message.channel === "final",
    )!;
    const result = optimizePaginatedConversationPayload(
      {
        current_node: final.id,
        messages: completeTurn,
      },
      {
        recentFullTurns: 0,
        forceKeepMessageIds: [final.id!],
        collapseTurnsToQuestionAnswer: true,
      },
    );

    expect(result.payload.messages).toHaveLength(2);
    expect(result.payload.messages?.[0]?.author?.role).toBe("user");
    expect(result.payload.messages?.[1]?.author?.role).toBe("assistant");
    expect(result.payload.messages?.[1]?.channel).toBe("final");
    expect(result.payload.messages?.[1]?.id).toBe(final.id);
  });

  test("keeps a bridge message for an unusual all-internal page", () => {
    const messages: ConversationMessage[] = [
      {
        id: "invoke",
        author: { role: "assistant" },
        recipient: "tool.example",
        content: { content_type: "code", parts: ["large args"] },
      },
      {
        id: "result",
        author: { role: "tool" },
        content: { content_type: "code", parts: ["large result"] },
      },
    ];
    const result = optimizePaginatedConversationPayload(
      { messages },
      { recentFullTurns: 0 },
    );

    expect(result.payload.messages).toHaveLength(1);
    expect(result.payload.messages?.[0]?.id).toBe("result");
  });

  capturedTest("micro-pages a two-turn initial response newest-first without reordering", async () => {
    const { payload } = await loadCapturedConversation();
    const turns = activeTurns(payload);
    const result = optimizePaginatedConversationPayload(
      {
        current_node: payload.current_node,
        messages: [...turns.at(-2)!, ...turns.at(-1)!],
      },
      {
        recentFullTurns: 1,
        forceKeepMessageIds:
          typeof payload.current_node === "string" ? [payload.current_node] : [],
      },
    );
    const kept = result.payload.messages ?? [];
    const chunks = splitPaginatedMessagesNewestFirst(kept, {
      maxTurns: 1,
      maxMessages: 16,
      maxBytes: 128 * 1_024,
      allowSplitTurns: false,
    });

    expect(chunks.map((chunk) => chunk.length)).toEqual([53, 6]);
    expect(chunks[0]?.at(-1)?.id).toBe(payload.current_node);
    expect(
      chunks
        .toReversed()
        .flat()
        .map((message) => message.id),
    ).toEqual(kept.map((message) => message.id));
  });
});


describe("native initial response conversion", () => {
  test("builds the exact lazy conversation envelope expected by the fallback loader", () => {
    const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const messages: ConversationMessage[] = [
      {
        id: "user-message",
        author: { role: "user" },
        content: { content_type: "text", parts: ["hello"] },
        status: "finished_successfully",
      },
      {
        id: "assistant-message",
        author: { role: "assistant" },
        channel: "final",
        recipient: "all",
        content: { content_type: "text", parts: ["world"] },
        status: "finished_successfully",
      },
    ];
    const converted = convertNativeInitialToLazyConversation(
      {
        title: "lazy",
        conversation_id: conversationId,
        current_node: "assistant-message",
        messages,
        moderation_results: [],
        page_info: { has_previous_page: true, start_cursor: "server-cursor" },
        safe_urls: ["https://example.com"],
        blocked_urls: [],
      },
      conversationId,
      2,
    );

    expect(converted).not.toBeNull();
    expect(converted?.current_node).toBe("assistant-message");
    expect(Object.keys(converted?.mapping ?? {})).toEqual([
      `paginated-root:${conversationId}`,
      "user-message",
      "assistant-message",
    ]);
    expect(converted?.mapping?.["user-message"]?.parent).toBe(
      `paginated-root:${conversationId}`,
    );
    expect(converted?.mapping?.["assistant-message"]?.children).toEqual([]);
    expect(converted?.__paginatedConversationPage).toMatchObject({
      cursor: "server-cursor",
      numTurns: 2,
      oldestMessageId: "user-message",
      serverCurrentLeafId: "assistant-message",
    });
    expect(
      converted?.__paginatedConversationPage.messagesLeafToRoot.map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-message", "user-message"]);
    expect("messages" in (converted ?? {})).toBeFalse();
    expect("page_info" in (converted ?? {})).toBeFalse();
  });

  test("fails closed for duplicate or missing message ids", () => {
    expect(
      convertNativeInitialToLazyConversation(
        {
          messages: [
            { id: "same", author: { role: "user" } },
            { id: "same", author: { role: "assistant" } },
          ],
        },
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        1,
      ),
    ).toBeNull();
  });
});

describe("conversation API URL matcher", () => {
  const base = "https://chatgpt.com/c/anything";
  const id = "33333333-3333-4333-8333-333333333333";

  test("matches only the singular full-conversation endpoint", () => {
    expect(
      isLegacyFullConversationUrl(`/backend-api/conversation/${id}`, base),
    ).toBeTrue();
    expect(
      isLegacyFullConversationUrl(
        `https://chatgpt.com/backend-api/conversation/${id}/`,
        base,
      ),
    ).toBeTrue();
    expect(
      isLegacyFullConversationUrl(`/backend-api/conversations/${id}`, base),
    ).toBeFalse();
    expect(
      isLegacyFullConversationUrl(
        `/backend-api/conversation/${id}/messages`,
        base,
      ),
    ).toBeFalse();
    expect(isLegacyFullConversationUrl("/backend-api/conversation/init", base)).toBeFalse();
  });

  test("classifies native initial and older-message endpoints", () => {
    expect(
      matchConversationApiUrl(`/backend-api/conversations/${id}?num_turns=20`, base),
    ).toEqual({ kind: "paginated-initial", conversationId: id });
    expect(
      matchConversationApiUrl(
        `/backend-api/conversations/${id}/messages?before=cursor&num_turns=20`,
        base,
      ),
    ).toEqual({ kind: "paginated-messages", conversationId: id });
    expect(matchConversationApiUrl("/backend-api/conversations?limit=20", base)).toBeNull();
  });

  test("clamps native page size without touching other query parameters", () => {
    const clamped = new URL(
      clampPaginatedNumTurns(
        `/backend-api/conversations/${id}/messages?before=abc&include_has_versions=true&num_turns=20`,
        base,
        2,
      ),
    );
    expect(clamped.searchParams.get("num_turns")).toBe("2");
    expect(clamped.searchParams.get("before")).toBe("abc");
    expect(clamped.searchParams.get("include_has_versions")).toBe("true");

    const alreadySmall = clampPaginatedNumTurns(
      `/backend-api/conversations/${id}?num_turns=1`,
      base,
      2,
    );
    expect(new URL(alreadySmall).searchParams.get("num_turns")).toBe("1");
  });
});
