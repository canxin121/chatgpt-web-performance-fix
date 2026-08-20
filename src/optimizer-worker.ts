import {
  optimizeConversationPayload,
  optimizePaginatedConversationPayload,
  splitPaginatedMessagesNewestFirst,
  type ConversationMessage,
  type ConversationPayload,
  type OptimizerOptions,
  type PaginatedChunkOptions,
  type PaginatedConversationPayload,
} from "./optimizer";

interface WorkerRequest {
  id: number;
  operation:
    | "parse"
    | "optimize-legacy"
    | "optimize-paginated"
    | "start-paginated-job"
    | "prepend-paginated-job"
    | "finish-paginated-job"
    | "cancel-paginated-job";
  text?: string;
  buffer?: ArrayBuffer;
  token?: string;
  requireFinal?: boolean;
  lightweightCodeBlocks?: boolean;
  legacyOptions?: Partial<OptimizerOptions>;
  apiKind?: "paginated-initial" | "paginated-messages";
  recentFullTurns?: number;
  chunkOptions?: Partial<PaginatedChunkOptions>;
}

function parseRequestJson(request: WorkerRequest): any {
  if (request.buffer instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(request.buffer));
  }
  if (typeof request.text !== "string") {
    throw new Error("Worker request is missing JSON text/buffer");
  }
  return JSON.parse(request.text);
}

function isFinishedStatus(status: unknown): boolean {
  return status === "finished_successfully" || status === "finished" || status === "complete";
}

function currentMessage(payload: PaginatedConversationPayload): ConversationMessage | undefined {
  if (typeof payload.current_node !== "string" || !Array.isArray(payload.messages)) return undefined;
  return payload.messages.find((message) => message.id === payload.current_node);
}

function hasActiveWork(payload: PaginatedConversationPayload): boolean {
  if (payload.async_status != null || !Array.isArray(payload.messages)) return true;
  if (
    payload.messages.some((message) =>
      ["in_progress", "streaming", "pending"].includes(String(message.status)),
    )
  ) {
    return true;
  }
  const current = currentMessage(payload);
  return !current || !isFinishedStatus(current.status);
}

function idleInitial(payload: PaginatedConversationPayload): boolean {
  return !hasActiveWork(payload);
}

function requiredInitialMessageIds(payload: PaginatedConversationPayload): string[] {
  if (!Array.isArray(payload.messages) || typeof payload.current_node !== "string") {
    return [];
  }
  const byId = new Map(
    payload.messages
      .filter((message): message is ConversationMessage & { id: string } =>
        typeof message.id === "string",
      )
      .map((message) => [message.id, message]),
  );
  const ids = new Set<string>([payload.current_node]);
  const current = byId.get(payload.current_node);
  if (current?.author?.role === "tool") {
    const parentId = current.metadata?.parent_id;
    if (typeof parentId === "string" && byId.has(parentId)) ids.add(parentId);
  }
  return [...ids];
}

interface PageJob {
  payload: PaginatedConversationPayload;
  requireFinal: boolean;
}

const pageJobs = new Map<string, PageJob>();
let nextPageJobId = 1;

function isRenderableAssistantMessage(message: ConversationMessage): boolean {
  if (message.author?.role !== "assistant") return false;
  if (message.metadata?.is_visually_hidden_from_conversation === true) return false;
  if (message.recipient != null && message.recipient !== "all") return false;
  if (message.channel === "final") return true;
  return !["code", "execution_output", "thoughts", "reasoning_recap"].includes(
    String(message.content?.content_type ?? ""),
  );
}

function hasRenderablePair(
  messages: ConversationMessage[],
  requireFinal: boolean,
): boolean {
  let userIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.author?.role === "user") userIndex = index;
  }
  if (userIndex < 0) return false;
  return messages.slice(userIndex + 1).some(
    (message) =>
      isRenderableAssistantMessage(message) &&
      (!requireFinal || message.channel === "final"),
  );
}

function mergeMessages(
  older: ConversationMessage[],
  newer: ConversationMessage[],
): ConversationMessage[] {
  const seen = new Set<string>();
  const merged: ConversationMessage[] = [];
  for (const message of [...older, ...newer]) {
    if (typeof message.id === "string") {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
    }
    merged.push(message);
  }
  return merged;
}

function mergePagePayload(
  current: PaginatedConversationPayload,
  older: PaginatedConversationPayload,
): PaginatedConversationPayload {
  return {
    ...current,
    messages: mergeMessages(
      Array.isArray(older.messages) ? older.messages : [],
      Array.isArray(current.messages) ? current.messages : [],
    ),
    page_info: older.page_info,
    safe_urls: [...new Set([
      ...(older.safe_urls ?? []),
      ...(current.safe_urls ?? []),
    ])],
    blocked_urls: [...new Set([
      ...(older.blocked_urls ?? []),
      ...(current.blocked_urls ?? []),
    ])],
  };
}

function pageProbe(token: string, job: PageJob) {
  const messages = Array.isArray(job.payload.messages) ? job.payload.messages : [];
  const cursor =
    job.payload.page_info?.has_previous_page === true &&
    typeof job.payload.page_info.start_cursor === "string"
      ? job.payload.page_info.start_cursor
      : null;
  return {
    token,
    complete: hasRenderablePair(messages, job.requireFinal),
    cursor,
    messageCount: messages.length,
  };
}

interface StaticCodeBlock {
  token: string;
  language: string;
  code: string;
  lineCount: number;
}

const staticCodeSession = Math.random().toString(36).slice(2);
let nextStaticCodeId = 1;

function extractFencedCodeBlocks(
  text: string,
  tokenPrefix: string,
): { text: string; blocks: StaticCodeBlock[] } {
  const lines = text.split("\n");
  const candidates: Array<{
    start: number;
    end: number;
    language: string;
    code: string;
  }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const open = lines[index].match(/^\s*(`{3,}|~{3,})\s*([^`]*)$/);
    if (!open) continue;
    const fence = open[1];
    const fenceChar = fence[0];
    const closePattern = new RegExp(`^\\s*${fenceChar}{${fence.length},}\\s*$`);
    let close = index + 1;
    while (close < lines.length && !closePattern.test(lines[close])) close += 1;
    if (close >= lines.length) continue;
    const language = open[2].trim().split(/\s+/, 1)[0] ?? "";
    const code = lines.slice(index + 1, close).join("\n");
    candidates.push({ start: index, end: close, language, code });
    index = close;
  }

  const totalCodeChars = candidates.reduce((sum, block) => sum + block.code.length, 0);
  if (candidates.length < 4 && totalCodeChars < 8_000) {
    return { text, blocks: [] };
  }

  const byStart = new Map(candidates.map((block) => [block.start, block]));
  const output: string[] = [];
  const blocks: StaticCodeBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const block = byStart.get(index);
    if (!block) {
      output.push(lines[index]);
      continue;
    }
    const token = `${staticCodeSession}-${tokenPrefix}-${nextStaticCodeId++}`;
    const lineCount = Math.max(1, block.code.split("\n").length);
    blocks.push({
      token,
      language: block.language,
      code: block.code,
      lineCount,
    });
    output.push(
      `[代码块](https://chatgpt.com/#cgptperf-code=${token}&lines=${lineCount})`,
    );
    index = block.end;
  }
  return { text: output.join("\n"), blocks };
}

function lightenHeavyCodeBlocks(
  payload: PaginatedConversationPayload,
): { payload: PaginatedConversationPayload; codeBlocks: StaticCodeBlock[] } {
  if (!Array.isArray(payload.messages)) return { payload, codeBlocks: [] };
  const codeBlocks: StaticCodeBlock[] = [];
  const messages = payload.messages.map((message, messageIndex) => {
    if (
      !["assistant", "user"].includes(String(message.author?.role)) ||
      !Array.isArray(message.content?.parts)
    ) {
      return message;
    }
    let changed = false;
    const parts = message.content.parts.map((part, partIndex) => {
      if (typeof part !== "string") return part;
      const result = extractFencedCodeBlocks(
        part,
        `m${messageIndex}p${partIndex}`,
      );
      if (result.blocks.length === 0) return part;
      changed = true;
      codeBlocks.push(...result.blocks);
      return result.text;
    });
    if (!changed) return message;
    return {
      ...message,
      content: {
        ...message.content,
        parts,
      },
    };
  });
  return {
    payload: { ...payload, messages },
    codeBlocks,
  };
}

function optimizePaginatedPayload(
  payload: PaginatedConversationPayload,
  request: WorkerRequest,
) {
  const initial = request.apiKind === "paginated-initial";
  // Historical /messages responses intentionally omit current_node, so a
  // missing current leaf there is not evidence of an in-flight turn.
  const active = initial ? hasActiveWork(payload) : false;
  const result = optimizePaginatedConversationPayload(payload, {
    recentFullTurns: initial && active ? request.recentFullTurns ?? 1 : 0,
    forceKeepMessageIds: initial ? requiredInitialMessageIds(payload) : [],
    collapseTurnsToQuestionAnswer:
      request.apiKind === "paginated-messages" || (initial && !active),
  });
  const lightened =
    request.lightweightCodeBlocks === true && !active
      ? lightenHeavyCodeBlocks(result.payload)
      : { payload: result.payload, codeBlocks: [] as StaticCodeBlock[] };
  const messages = Array.isArray(lightened.payload.messages)
    ? lightened.payload.messages
    : [];
  return {
    payload: lightened.payload,
    stats: result.stats,
    chunks: splitPaginatedMessagesNewestFirst(messages, request.chunkOptions),
    codeBlocks: lightened.codeBlocks,
    active,
    cacheable: initial && idleInitial(payload),
  };
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.operation === "parse") {
      self.postMessage({ id: request.id, ok: true, value: parseRequestJson(request) });
      return;
    }

    if (request.operation === "optimize-legacy") {
      const payload = parseRequestJson(request) as ConversationPayload;
      const result = optimizeConversationPayload(payload, request.legacyOptions);
      self.postMessage({
        id: request.id,
        ok: true,
        value: {
          payload: result.payload,
          stats: result.stats,
        },
      });
      return;
    }

    if (request.operation === "start-paginated-job") {
      const payload = parseRequestJson(request) as PaginatedConversationPayload;
      const token = `page-${nextPageJobId++}`;
      const job = { payload, requireFinal: request.requireFinal === true };
      pageJobs.set(token, job);
      self.postMessage({ id: request.id, ok: true, value: pageProbe(token, job) });
      return;
    }

    if (request.operation === "prepend-paginated-job") {
      const token = request.token ?? "";
      const job = pageJobs.get(token);
      if (!job) throw new Error("Unknown paginated job");
      const older = parseRequestJson(request) as PaginatedConversationPayload;
      job.payload = mergePagePayload(job.payload, older);
      self.postMessage({ id: request.id, ok: true, value: pageProbe(token, job) });
      return;
    }

    if (request.operation === "finish-paginated-job") {
      const token = request.token ?? "";
      const job = pageJobs.get(token);
      if (!job) throw new Error("Unknown paginated job");
      pageJobs.delete(token);
      self.postMessage({
        id: request.id,
        ok: true,
        value: optimizePaginatedPayload(job.payload, request),
      });
      return;
    }

    if (request.operation === "cancel-paginated-job") {
      pageJobs.delete(request.token ?? "");
      self.postMessage({ id: request.id, ok: true, value: null });
      return;
    }

    const payload = parseRequestJson(request) as PaginatedConversationPayload;
    self.postMessage({
      id: request.id,
      ok: true,
      value: optimizePaginatedPayload(payload, request),
    });
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
