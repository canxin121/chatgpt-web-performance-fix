import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { readCdx, readWarcResponse, type CdxRecord } from "./lib/wacz";

const pathsFile = process.env.CHATGPT_PERF_WACZ_PATHS ??
  ".private/analysis/new-session/wacz-paths.txt";
const [indexPath, archivePath] = (await Bun.file(pathsFile).text())
  .split(/\r?\n/)
  .filter(Boolean);
if (!indexPath || !archivePath) {
  throw new Error(`Could not locate WACZ index/archive from ${pathsFile}`);
}

const publicOutput = process.env.CHATGPT_PERF_WACZ_OUTPUT ??
  "analysis/output/session-network-summary.json";
const privateOutput = process.env.CHATGPT_PERF_WACZ_PRIVATE_OUTPUT ??
  ".private/analysis/new-session/session-network-detail.json";

function endpointKind(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (/^\/backend-api\/conversation\/[0-9a-f-]{36}\/?$/i.test(url.pathname)) {
    return "legacy-full";
  }
  if (/^\/backend-api\/conversations\/[0-9a-f-]{36}\/messages\/?$/i.test(url.pathname)) {
    return "paginated-messages";
  }
  if (/^\/backend-api\/conversations\/[0-9a-f-]{36}\/?$/i.test(url.pathname)) {
    return "paginated-initial";
  }
  if (/^\/backend-api\/conversation\/?$/i.test(url.pathname)) {
    return "conversation-stream";
  }
  if (url.pathname.includes("/backend-api/")) return "backend-other";
  if (url.pathname.includes("/cdn/assets/") || url.pathname.includes("/assets/")) {
    return "asset";
  }
  return "other";
}

function sanitizedResource(rawUrl: string): string {
  const url = new URL(rawUrl);
  const kind = endpointKind(rawUrl);
  if (kind === "legacy-full") return "/backend-api/conversation/:id";
  if (kind === "paginated-initial") return "/backend-api/conversations/:id";
  if (kind === "paginated-messages") return "/backend-api/conversations/:id/messages";
  if (kind === "conversation-stream") return "/backend-api/conversation";
  if (kind === "asset") return basename(url.pathname);
  if (kind === "backend-other") {
    return url.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
      .replace(/[A-Za-z0-9_-]{24,}/g, ":id")
      .slice(0, 180);
  }
  return url.origin;
}

function queryShape(rawUrl: string) {
  const url = new URL(rawUrl);
  return {
    numTurns: url.searchParams.get("num_turns"),
    hasBefore: url.searchParams.has("before"),
    beforeKind: url.searchParams.has("before")
      ? (url.searchParams.get("before")?.startsWith("cgptperf-") ? "local" : "server")
      : null,
    includeMessageId: url.searchParams.has("include_message_id"),
    includeHasVersions: url.searchParams.get("include_has_versions"),
  };
}

function timestampMs(value: string): number | null {
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3,6})$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction] = match;
  const millis = Number(fraction.slice(0, 3).padEnd(3, "0"));
  return Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute),
    Number(second), millis,
  );
}

function contentKind(message: any): string {
  return `${message?.author?.role ?? "unknown"}/${message?.content?.content_type ?? "unknown"}`;
}

function visibleAssistant(message: any): boolean {
  if (message?.author?.role !== "assistant") return false;
  if (message?.metadata?.is_visually_hidden_from_conversation === true) return false;
  if (message?.recipient != null && message.recipient !== "all") return false;
  return !["code", "execution_output", "thoughts", "reasoning_recap"].includes(
    String(message?.content?.content_type ?? ""),
  );
}

function activePathLength(payload: any): number | null {
  if (!payload?.mapping || typeof payload.current_node !== "string") return null;
  const seen = new Set<string>();
  let id: string | null | undefined = payload.current_node;
  let count = 0;
  while (id != null) {
    if (seen.has(id) || !payload.mapping[id]) return null;
    seen.add(id);
    count += 1;
    id = payload.mapping[id].parent;
  }
  return count;
}

function parseJsonRecord(record: CdxRecord) {
  const response = readWarcResponse(archivePath, record);
  const text = response.body.toString("utf8");
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return {
      bodyBytes: response.body.length,
      parseable: false,
      headers: Object.fromEntries(response.httpHeaders),
    };
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const mappingValues = payload.mapping && typeof payload.mapping === "object"
    ? Object.values(payload.mapping) as any[]
    : [];
  const mappingMessages = mappingValues
    .map((node) => node?.message)
    .filter(Boolean);
  const allMessages = messages.length ? messages : mappingMessages;
  const kinds: Record<string, number> = {};
  for (const message of allMessages) {
    const kind = contentKind(message);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return {
    bodyBytes: response.body.length,
    parseable: true,
    topLevelKeys: Object.keys(payload).sort(),
    mappingNodes: mappingValues.length || null,
    activePathNodes: activePathLength(payload),
    messages: messages.length || null,
    users: allMessages.filter((message) => message?.author?.role === "user").length,
    assistantVisible: allMessages.filter(visibleAssistant).length,
    assistantFinal: allMessages.filter(
      (message) => message?.author?.role === "assistant" && message?.channel === "final",
    ).length,
    toolMessages: allMessages.filter((message) => message?.author?.role === "tool").length,
    messageKinds: kinds,
    hasPreviousPage: payload?.page_info?.has_previous_page ?? null,
    hasStartCursor: typeof payload?.page_info?.start_cursor === "string",
    currentRole: payload?.mapping?.[payload?.current_node]?.message?.author?.role ??
      allMessages.find((message) => message?.id === payload?.current_node)?.author?.role ?? null,
    currentStatus: payload?.mapping?.[payload?.current_node]?.message?.status ??
      allMessages.find((message) => message?.id === payload?.current_node)?.status ?? null,
    asyncActive: payload?.async_status != null,
    safeUrlCount: Array.isArray(payload?.safe_urls) ? payload.safe_urls.length : 0,
    blockedUrlCount: Array.isArray(payload?.blocked_urls) ? payload.blocked_urls.length : 0,
    headers: Object.fromEntries(response.httpHeaders),
  };
}

const records = await readCdx(indexPath);
const firstTimestamp = Math.min(
  ...records.map((record) => timestampMs(record.timestamp)).filter((value): value is number => value != null),
);

const endpointRows: any[] = [];
const jsonRows: any[] = [];
const kindCounts: Record<string, number> = {};
const mimeCounts: Record<string, { count: number; compressedBytes: number }> = {};
const assetBytes: Record<string, number> = {};

for (const record of records) {
  const kind = endpointKind(record.url);
  kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
  const mime = record.mime || "unknown";
  mimeCounts[mime] ??= { count: 0, compressedBytes: 0 };
  mimeCounts[mime].count += 1;
  mimeCounts[mime].compressedBytes += record.length;
  if (kind === "asset") assetBytes[sanitizedResource(record.url)] = record.length;

  if (["legacy-full", "paginated-initial", "paginated-messages", "conversation-stream"].includes(kind)) {
    const time = timestampMs(record.timestamp);
    const row: any = {
      relativeMs: time == null ? null : time - firstTimestamp,
      kind,
      resource: sanitizedResource(record.url),
      query: queryShape(record.url),
      mime: record.mime,
      compressedBytes: record.length,
    };
    if (record.mime === "application/json") {
      const parsed = parseJsonRecord(record);
      row.response = parsed;
      jsonRows.push(row);
    }
    endpointRows.push(row);
  }
}

const endpointGroups = new Map<string, any[]>();
for (const row of endpointRows) {
  const key = JSON.stringify({ kind: row.kind, query: row.query });
  const group = endpointGroups.get(key) ?? [];
  group.push(row);
  endpointGroups.set(key, group);
}

const requestBursts: any[] = [];
const sortedEndpoints = [...endpointRows].sort((a, b) => (a.relativeMs ?? 0) - (b.relativeMs ?? 0));
let burst: any[] = [];
for (const row of sortedEndpoints) {
  const previous = burst.at(-1);
  if (!previous || (row.relativeMs ?? 0) - (previous.relativeMs ?? 0) <= 750) {
    burst.push(row);
  } else {
    if (burst.length > 1) requestBursts.push(burst);
    burst = [row];
  }
}
if (burst.length > 1) requestBursts.push(burst);

const safeSummary = {
  recordCount: records.length,
  durationMs: Math.max(
    ...records.map((record) => timestampMs(record.timestamp)).filter((value): value is number => value != null),
  ) - firstTimestamp,
  kindCounts,
  mimeCounts,
  conversationRequests: endpointRows.map((row) => ({
    relativeMs: row.relativeMs,
    kind: row.kind,
    query: row.query,
    compressedBytes: row.compressedBytes,
    response: row.response
      ? {
          bodyBytes: row.response.bodyBytes,
          mappingNodes: row.response.mappingNodes,
          activePathNodes: row.response.activePathNodes,
          messages: row.response.messages,
          users: row.response.users,
          assistantVisible: row.response.assistantVisible,
          assistantFinal: row.response.assistantFinal,
          toolMessages: row.response.toolMessages,
          messageKinds: row.response.messageKinds,
          hasPreviousPage: row.response.hasPreviousPage,
          hasStartCursor: row.response.hasStartCursor,
          currentRole: row.response.currentRole,
          currentStatus: row.response.currentStatus,
          asyncActive: row.response.asyncActive,
        }
      : null,
  })),
  requestGroups: [...endpointGroups.values()].map((rows) => ({
    kind: rows[0].kind,
    query: rows[0].query,
    count: rows.length,
    responseBodyBytes: [...new Set(rows.map((row) => row.response?.bodyBytes).filter(Boolean))],
    responseMessageCounts: [...new Set(rows.map((row) => row.response?.messages).filter(Boolean))],
  })),
  requestBursts: requestBursts.map((rows) => ({
    startMs: rows[0].relativeMs,
    spanMs: (rows.at(-1).relativeMs ?? 0) - (rows[0].relativeMs ?? 0),
    requests: rows.map((row) => ({ kind: row.kind, query: row.query })),
  })),
  largestJsonResponses: [...jsonRows]
    .sort((a, b) => (b.response?.bodyBytes ?? 0) - (a.response?.bodyBytes ?? 0))
    .slice(0, 20)
    .map((row) => ({
      relativeMs: row.relativeMs,
      kind: row.kind,
      query: row.query,
      bodyBytes: row.response?.bodyBytes,
      mappingNodes: row.response?.mappingNodes,
      messages: row.response?.messages,
      users: row.response?.users,
      assistantVisible: row.response?.assistantVisible,
      toolMessages: row.response?.toolMessages,
    })),
  largestAssets: Object.entries(assetBytes)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 30)
    .map(([asset, compressedBytes]) => ({ asset, compressedBytes })),
};

const privateDetail = {
  ...safeSummary,
  conversationRequestsDetailed: endpointRows,
};

mkdirSync("analysis/output", { recursive: true });
mkdirSync(".private/analysis/new-session", { recursive: true });
await Bun.write(publicOutput, `${JSON.stringify(safeSummary, null, 2)}\n`);
await Bun.write(privateOutput, `${JSON.stringify(privateDetail, null, 2)}\n`);
console.log(JSON.stringify(safeSummary, null, 2));
