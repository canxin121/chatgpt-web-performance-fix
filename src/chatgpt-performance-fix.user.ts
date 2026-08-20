import {
  clampPaginatedNumTurns,
  convertNativeInitialToLazyConversation,
  DEFAULT_OPTIMIZER_OPTIONS,
  matchConversationApiUrl,
  optimizeConversationPayload,
  optimizePaginatedConversationPayload,
  splitPaginatedMessagesNewestFirst,
  type ConversationApiKind,
  type ConversationMessage,
  type PaginatedConversationPayload,
  type OptimizationStats,
  type PaginatedOptimizationStats,
} from "./optimizer";

declare const unsafeWindow: (Window & typeof globalThis) | undefined;
declare const GM_registerMenuCommand:
  | ((label: string, callback: () => void) => void)
  | undefined;

declare const __CHATGPT_OPTIMIZER_WORKER_SOURCE__: string;

type Mode = "off" | "balanced" | "aggressive";
type TurnLoadSetting = number | "all";

interface StoredSettings {
  mode: Mode;
  /** Visible user turns rendered when opening a conversation. */
  initialTurns: TurnLoadSetting;
  /** Visible user turns loaded by one manual history action. */
  historyBatchTurns: TurnLoadSetting;
}

interface StaticCodeBlock {
  token: string;
  language: string;
  code: string;
  lineCount: number;
}

interface MaterializedResponse {
  body: string;
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  type: ResponseType;
  optimized: boolean;
  cacheable: boolean;
  /** True while the server snapshot still contains streaming/async work. */
  activeConversation?: boolean;
  stats?: OptimizationStats | PaginatedOptimizationStats;
  apiKind?: ConversationApiKind;
  localPages?: Array<{ cursor: string; response: MaterializedResponse }>;
  lazyInitial?: boolean;
}

interface InitialConversationSnapshot {
  response: MaterializedResponse;
  /** Successful snapshots live for the page session; 429 snapshots expire here. */
  expiresAt: number;
  rateLimited: boolean;
}

const SCRIPT_NAME = "ChatGPT Long Conversation Performance Fix";
const SETTINGS_KEY = "chatgpt-performance-fix:settings:v1";
const FULL_ONCE_PREFIX = "chatgpt-performance-fix:full-once:";
const CACHE_TTL_MS = 20_000;
const HISTORY_CACHE_TTL_MS = 5 * 60_000;
const SIDEBAR_RATE_LIMIT_BACKOFF_MS = 2 * 60_000;
const INITIAL_RATE_LIMIT_BACKOFF_MS = 2 * 60_000;
const MAX_INITIAL_CONVERSATION_SNAPSHOTS = 32;
const MAX_CONFIGURED_TURNS = 500;
const ALL_INITIAL_FIRST_PAGE_TURNS = 32;
const INTERNAL_RESPONSE_READS = new WeakSet<Response>();

function retryAfterBackoffMs(
  headers: Headers,
  minimumMs: number,
  now = Date.now(),
): number {
  const raw = headers.get("retry-after")?.trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(minimumMs, seconds * 1_000);
    }
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt)) {
      return Math.max(minimumMs, retryAt - now);
    }
  }
  return minimumMs;
}

const DEFAULT_SETTINGS: Readonly<StoredSettings> = {
  mode: "balanced",
  initialTurns: 2,
  historyBatchTurns: 2,
};

const MODE_OPTIONS: Record<
  Exclude<Mode, "off">,
  {
    minNodeCount: number;
    recentFullTurns: number;
    lazyInitialTurns: number;
    paginatedMaxTurns: number;
    paginatedRenderTurns: number;
    richTextWarmDistancePx: number;
    codeEditorWarmDistancePx: number;
  }
> = {
  balanced: {
    minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
    recentFullTurns: 1,
    lazyInitialTurns: 2,
    paginatedMaxTurns: 2,
    paginatedRenderTurns: 1,
    richTextWarmDistancePx: 8_000,
    codeEditorWarmDistancePx: 3_000,
  },
  aggressive: {
    minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
    recentFullTurns: 0,
    lazyInitialTurns: 2,
    paginatedMaxTurns: 2,
    paginatedRenderTurns: 1,
    richTextWarmDistancePx: 5_000,
    codeEditorWarmDistancePx: 1_800,
  },
};

function legacyOptimizerOptions(mode: Exclude<Mode, "off">) {
  return {
    minNodeCount: MODE_OPTIONS[mode].minNodeCount,
    // A legacy full response may contain hundreds of live tool nodes in the
    // newest turn. Keep only visible transcript plus the current dependency pair.
    recentFullTurns: 0,
    preserveCurrentParent: true,
    collapseTurnsToQuestionAnswer: true,
  };
}

function readSettings(storage: Storage): StoredSettings {
  try {
    const value = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "null") as
      | Partial<StoredSettings>
      | null;
    const mode: Mode =
      value?.mode === "off" || value?.mode === "aggressive"
        ? value.mode
        : "balanced";
    return {
      mode,
      initialTurns: normalizeTurnLoadSetting(
        value?.initialTurns,
        DEFAULT_SETTINGS.initialTurns,
      ),
      historyBatchTurns: normalizeTurnLoadSetting(
        value?.historyBatchTurns,
        DEFAULT_SETTINGS.historyBatchTurns,
      ),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function isConversationStatusUpdate(
  rawUrl: string,
  method: string,
  baseUrl: string,
): boolean {
  return conversationStatusUpdateId(rawUrl, method, baseUrl) != null;
}

function conversationStatusUpdateId(
  rawUrl: string,
  method: string,
  baseUrl: string,
): string | null {
  if (method !== "POST") return null;
  try {
    const pathname = new URL(rawUrl, baseUrl).pathname.replace(/\/+$/, "");
    const match = pathname.match(
      /^\/backend-api\/conversation\/([0-9a-f-]{36})\/async-status$/i,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

interface AsyncStatusProbe {
  found: boolean;
  value: unknown;
}

function parseAsyncStatusBody(body: BodyInit | null | undefined): AsyncStatusProbe {
  if (typeof body !== "string") return { found: false, value: undefined };

  const parseJson = (): AsyncStatusProbe => {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Object.hasOwn(parsed, "status")
      ) {
        return { found: false, value: undefined };
      }
      return {
        found: true,
        value: (parsed as Record<string, unknown>).status,
      };
    } catch {
      return { found: false, value: undefined };
    }
  };

  // JSON bodies are valid input for this endpoint. URLSearchParams accepts a
  // JSON string without throwing, so the old form-first parser returned early
  // and silently missed every JSON status transition.
  if (body.trimStart().startsWith("{")) {
    const json = parseJson();
    if (json.found) return json;
  }

  try {
    const params = new URLSearchParams(body);
    if (params.has("status")) {
      const raw = params.get("status");
      if (raw == null || raw === "null") return { found: true, value: null };
      const numeric = Number(raw);
      return {
        found: true,
        value: Number.isFinite(numeric) ? numeric : raw,
      };
    }
  } catch {
    // Fall through to the JSON parser below.
  }
  return parseJson();
}

async function inspectAsyncStatusRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<AsyncStatusProbe> {
  const direct = parseAsyncStatusBody(init?.body);
  if (direct.found) return direct;
  const requestLike = input as unknown as { clone?: () => Request };
  if (typeof requestLike.clone !== "function") return direct;
  try {
    return parseAsyncStatusBody(await requestLike.clone().text());
  } catch {
    return direct;
  }
}

async function inspectOutgoingRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<OutgoingMessageProbe> {
  const direct = inspectOutgoingBody(init?.body);
  if (direct.conversationId || direct.messageId || direct.text) return direct;
  const requestLike = input as unknown as { clone?: () => Request };
  if (typeof requestLike.clone !== "function") return direct;
  try {
    const text = await requestLike.clone().text();
    return inspectOutgoingBody(text);
  } catch {
    return direct;
  }
}

function normalizeTurnLoadSetting(
  value: unknown,
  fallback: TurnLoadSetting,
): TurnLoadSetting {
  if (value === "all") return "all";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(MAX_CONFIGURED_TURNS, Math.max(1, Math.floor(numeric)));
}

function formatTurnLoadSetting(value: TurnLoadSetting): string {
  return value === "all" ? "全部" : `${value} 轮`;
}

let activeTurnLoadDialog: Promise<TurnLoadSetting | null> | null = null;

function showTurnLoadSettingDialog(
  pageWindow: Window & typeof globalThis,
  label: string,
  current: TurnLoadSetting,
): Promise<TurnLoadSetting | null> {
  if (activeTurnLoadDialog) return activeTurnLoadDialog;

  activeTurnLoadDialog = new Promise((resolve) => {
    const existing = pageWindow.document.getElementById(
      "chatgpt-turn-load-setting-dialog",
    );
    existing?.remove();

    const host = pageWindow.document.createElement("div");
    host.id = "chatgpt-turn-load-setting-dialog";
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:rgba(0,0,0,.38)",
      "padding:20px",
    ].join(";");

    const panel = pageWindow.document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.style.cssText = [
      "width:min(420px,100%)",
      "border:1px solid var(--border-light,rgba(127,127,127,.28))",
      "border-radius:14px",
      "background:var(--main-surface-primary,#fff)",
      "color:var(--text-primary,#111)",
      "box-shadow:0 18px 60px rgba(0,0,0,.28)",
      "padding:18px",
      "font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    ].join(";");

    const title = pageWindow.document.createElement("div");
    title.textContent = label;
    title.style.cssText = "font-size:15px;font-weight:650;margin-bottom:10px";

    const hint = pageWindow.document.createElement("div");
    hint.textContent = "输入大于 0 的整数，或输入 all / 全部。";
    hint.style.cssText = "opacity:.72;margin-bottom:10px";

    const input = pageWindow.document.createElement("input");
    input.type = "text";
    input.value = current === "all" ? "all" : String(current);
    input.autocomplete = "off";
    input.style.cssText = [
      "box-sizing:border-box",
      "width:100%",
      "border:1px solid var(--border-light,rgba(127,127,127,.35))",
      "border-radius:9px",
      "padding:9px 10px",
      "background:var(--main-surface-secondary,rgba(127,127,127,.08))",
      "color:inherit",
      "outline:none",
    ].join(";");

    const error = pageWindow.document.createElement("div");
    error.style.cssText = "min-height:20px;margin-top:6px;font-size:12px;color:#c33";

    const actions = pageWindow.document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px";
    const cancel = pageWindow.document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    const save = pageWindow.document.createElement("button");
    save.type = "button";
    save.textContent = "保存";
    for (const button of [cancel, save]) {
      button.style.cssText = [
        "border:1px solid var(--border-light,rgba(127,127,127,.35))",
        "border-radius:8px",
        "padding:6px 12px",
        "background:var(--main-surface-secondary,rgba(127,127,127,.08))",
        "color:inherit",
        "cursor:pointer",
      ].join(";");
    }
    actions.append(cancel, save);
    panel.append(title, hint, input, error, actions);
    host.append(panel);
    pageWindow.document.documentElement.append(host);

    let closed = false;
    const finish = (value: TurnLoadSetting | null) => {
      if (closed) return;
      closed = true;
      pageWindow.removeEventListener("keydown", onKeyDown, true);
      host.remove();
      activeTurnLoadDialog = null;
      resolve(value);
    };
    const parse = (): TurnLoadSetting | null => {
      const trimmed = input.value.trim().toLowerCase();
      if (trimmed === "all" || trimmed === "全部") return "all";
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      return normalizeTurnLoadSetting(numeric, current);
    };
    const submit = () => {
      const value = parse();
      if (value == null) {
        error.textContent = "请输入大于 0 的整数，或 all / 全部。";
        input.focus();
        input.select();
        return;
      }
      finish(value);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    };
    cancel.addEventListener("click", () => finish(null));
    save.addEventListener("click", submit);
    host.addEventListener("mousedown", (event) => {
      if (event.target === host) finish(null);
    });
    pageWindow.addEventListener("keydown", onKeyDown, true);
    pageWindow.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });

  return activeTurnLoadDialog;
}

function yieldUntilInteractionIdle(
  pageWindow: Window & typeof globalThis,
): Promise<void> {
  const startedAt = pageWindow.performance.now();
  let settled = false;
  let fallbackTimer: number | undefined;
  const finish = (forced = false, resolve?: () => void) => {
    if (settled) return;
    settled = true;
    if (fallbackTimer != null) pageWindow.clearTimeout(fallbackTimer);
    if (forced) {
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptHistoryIdleForced = String(
        Number(root.dataset.chatgptHistoryIdleForced ?? "0") + 1,
      );
    }
    try {
      pageWindow.performance.measure("chatgpt-perf:history-idle-wait", {
        start: startedAt,
        end: pageWindow.performance.now(),
      });
    } catch {
      // Ignore unavailable User Timing options.
    }
    resolve?.();
  };
  return new Promise((resolve) => {
    // History responses must never be held indefinitely after the network has
    // already completed. A busy long conversation may never expose a 12ms idle
    // slice, so force delivery after a short grace period.
    fallbackTimer = pageWindow.setTimeout(() => finish(true, resolve), 250);
    const afterPaint = () => {
      pageWindow.setTimeout(() => {
        if (settled) return;
        if (typeof pageWindow.requestIdleCallback !== "function") {
          finish(false, resolve);
          return;
        }
        const waitForUsefulIdleBudget = () => {
          if (settled) return;
          pageWindow.requestIdleCallback((deadline) => {
            if (settled) return;
            if (deadline.timeRemaining() >= 12) {
              finish(false, resolve);
              return;
            }
            waitForUsefulIdleBudget();
          }, { timeout: 50 });
        };
        waitForUsefulIdleBudget();
      }, 0);
    };
    if (
      pageWindow.document.visibilityState === "hidden" ||
      typeof pageWindow.requestAnimationFrame !== "function"
    ) {
      afterPaint();
    } else {
      pageWindow.requestAnimationFrame(afterPaint);
    }
  });
}

interface JsonWorkerReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

let jsonWorkerState:
  | {
      worker: Worker;
      nextId: number;
      pending: Map<
        number,
        {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
          startedAt: number;
          operation: string;
        }
      >;
    }
  | null
  | undefined;

function ensureJsonWorker(
  pageWindow: Window & typeof globalThis,
): Exclude<typeof jsonWorkerState, null | undefined> | null {
  if (jsonWorkerState !== undefined) return jsonWorkerState;
  if (typeof pageWindow.Worker !== "function") {
    jsonWorkerState = null;
    return null;
  }
  try {
    const source = __CHATGPT_OPTIMIZER_WORKER_SOURCE__;;
    const url = pageWindow.URL.createObjectURL(
      new pageWindow.Blob([source], { type: "application/javascript" }),
    );
    const worker = new pageWindow.Worker(url, {
      name: "chatgpt-performance-json",
    });
    pageWindow.URL.revokeObjectURL(url);
    const state = {
      worker,
      nextId: 1,
      pending: new Map<
        number,
        {
          resolve: (value: unknown) => void;
          reject: (error: Error) => void;
          startedAt: number;
          operation: string;
        }
      >(),
    };
    worker.addEventListener("message", (event: MessageEvent<JsonWorkerReply>) => {
      const reply = event.data;
      const pending = state.pending.get(reply.id);
      if (!pending) return;
      state.pending.delete(reply.id);
      const finishedAt = pageWindow.performance.now();
      const elapsed = finishedAt - pending.startedAt;
      try {
        pageWindow.performance.measure(
          `chatgpt-perf:worker:${pending.operation}`,
          {
            start: pending.startedAt,
            end: finishedAt,
            detail: { durationMs: elapsed },
          },
        );
      } catch {
        // Older browsers may not support PerformanceMeasureOptions.
      }
      const root = pageWindow.document.documentElement;
      const count = Number(root.dataset.chatgptJsonWorkerParses ?? "0");
      const total = Number(root.dataset.chatgptJsonWorkerTotalMs ?? "0");
      root.dataset.chatgptJsonWorkerParses = String(count + 1);
      root.dataset.chatgptJsonWorkerTotalMs = String(Math.round(total + elapsed));
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new Error(reply.error ?? "Worker JSON parse failed"));
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

async function runOptimizerWorker<T>(
  pageWindow: Window & typeof globalThis,
  request: Record<string, unknown> & { text?: string; buffer?: ArrayBuffer },
  transfer: Transferable[] = [],
): Promise<T> {
  const state = ensureJsonWorker(pageWindow);
  if (!state) throw new Error("Optimizer worker is unavailable");
  const id = state.nextId++;
  return await new Promise<T>((resolve, reject) => {
    state.pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      startedAt: pageWindow.performance.now(),
      operation: String(request.operation ?? "unknown"),
    });
    state.worker.postMessage({ id, ...request }, transfer);
  });
}

interface LegacyWorkerResult {
  payload: Record<string, unknown>;
  stats: OptimizationStats;
}

interface PaginatedWorkerResult {
  payload: PaginatedConversationPayload;
  stats: PaginatedOptimizationStats;
  chunks: ConversationMessage[][];
  codeBlocks?: StaticCodeBlock[];
  active: boolean;
  cacheable: boolean;
}

async function optimizeLegacyOffMain(
  pageWindow: Window & typeof globalThis,
  text: string,
  options: Parameters<typeof optimizeConversationPayload>[1],
): Promise<LegacyWorkerResult> {
  try {
    return await runOptimizerWorker<LegacyWorkerResult>(pageWindow, {
      operation: "optimize-legacy",
      text,
      legacyOptions: options,
    });
  } catch (error) {
    console.warn(`[${SCRIPT_NAME}] Worker legacy optimization fell back`, error);
    const payload = JSON.parse(text) as Record<string, unknown>;
    return optimizeConversationPayload(payload, options) as LegacyWorkerResult;
  }
}

async function optimizePaginatedOffMain(
  pageWindow: Window & typeof globalThis,
  text: string,
  apiKind: "paginated-initial" | "paginated-messages",
  mode: Exclude<Mode, "off">,
  renderTurns = MODE_OPTIONS[mode].paginatedRenderTurns,
): Promise<PaginatedWorkerResult> {
  try {
    return await runOptimizerWorker<PaginatedWorkerResult>(pageWindow, {
      operation: "optimize-paginated",
      text,
      apiKind,
      recentFullTurns: MODE_OPTIONS[mode].recentFullTurns,
      lightweightCodeBlocks: true,
      chunkOptions: {
        maxTurns: renderTurns,
        maxMessages: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
        allowSplitTurns: false,
      },
    });
  } catch (error) {
    console.warn(`[${SCRIPT_NAME}] Worker paginated optimization fell back`, error);
    const payload = JSON.parse(text) as PaginatedConversationPayload;
    const initial = apiKind === "paginated-initial";
    // Historical /messages pages do not carry current_node. Treating that
    // missing field as live work disabled code-block lightening for every
    // historical page.
    const active = initial ? hasActivePaginatedWork(payload) : false;
    const result = optimizePaginatedConversationPayload(payload, {
      recentFullTurns: initial && active ? MODE_OPTIONS[mode].recentFullTurns : 0,
      forceKeepMessageIds: initial ? requiredInitialMessageIds(payload) : [],
      collapseTurnsToQuestionAnswer:
        apiKind === "paginated-messages" || (initial && !active),
    });
    return {
      payload: result.payload,
      stats: result.stats,
      chunks: splitPaginatedMessagesNewestFirst(result.payload.messages ?? [], {
        maxTurns: renderTurns,
        maxMessages: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
        allowSplitTurns: false,
      }),
      active,
      cacheable: initial && isIdlePaginatedConversation(payload),
    };
  }
}

interface PaginatedJobProbe {
  token: string;
  complete: boolean;
  cursor: string | null;
  messageCount: number;
}

interface PreparedPaginatedResponse {
  response: Response;
  workerJobToken?: string;
}

async function startPaginatedWorkerJob(
  pageWindow: Window & typeof globalThis,
  buffer: ArrayBuffer,
  requireFinal: boolean,
): Promise<PaginatedJobProbe> {
  return runOptimizerWorker<PaginatedJobProbe>(
    pageWindow,
    {
      operation: "start-paginated-job",
      buffer,
      requireFinal,
    },
    [buffer],
  );
}

async function prependPaginatedWorkerJob(
  pageWindow: Window & typeof globalThis,
  token: string,
  buffer: ArrayBuffer,
): Promise<PaginatedJobProbe> {
  return runOptimizerWorker<PaginatedJobProbe>(
    pageWindow,
    {
      operation: "prepend-paginated-job",
      token,
      buffer,
    },
    [buffer],
  );
}

async function finishPaginatedWorkerJob(
  pageWindow: Window & typeof globalThis,
  token: string,
  apiKind: "paginated-initial" | "paginated-messages",
  mode: Exclude<Mode, "off">,
  renderTurns = MODE_OPTIONS[mode].paginatedRenderTurns,
): Promise<PaginatedWorkerResult> {
  return runOptimizerWorker<PaginatedWorkerResult>(pageWindow, {
    operation: "finish-paginated-job",
    token,
    apiKind,
    recentFullTurns: MODE_OPTIONS[mode].recentFullTurns,
    lightweightCodeBlocks: true,
    chunkOptions: {
      maxTurns: renderTurns,
      maxMessages: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
      allowSplitTurns: false,
    },
  });
}

async function cancelPaginatedWorkerJob(
  pageWindow: Window & typeof globalThis,
  token: string,
): Promise<void> {
  try {
    await runOptimizerWorker(pageWindow, {
      operation: "cancel-paginated-job",
      token,
    });
  } catch {
    // The worker may already have failed/terminated.
  }
}

async function parseJsonOffMain<T>(
  pageWindow: Window & typeof globalThis,
  text: string,
): Promise<T> {
  // Small payloads are faster locally; large conversation pages must not block
  // the same main thread that owns the sidebar and all input handling.
  if (text.length < 128 * 1024) return JSON.parse(text) as T;
  const state = ensureJsonWorker(pageWindow);
  if (!state) return JSON.parse(text) as T;
  const id = state.nextId++;
  try {
    return await new Promise<T>((resolve, reject) => {
      state.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        startedAt: pageWindow.performance.now(),
        operation: "parse",
      });
      state.worker.postMessage({ id, operation: "parse", text });
    });
  } catch (error) {
    console.warn(`[${SCRIPT_NAME}] Worker parse fell back to main thread`, error);
    return JSON.parse(text) as T;
  }
}

async function responseJsonOffMain<T>(
  pageWindow: Window & typeof globalThis,
  response: Response,
): Promise<T> {
  return parseJsonOffMain<T>(pageWindow, await response.text());
}

function rewriteGetRequest(
  pageWindow: Window & typeof globalThis,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  rewrittenUrl: string,
): [RequestInfo | URL, RequestInit | undefined] {
  const requestLike = input as unknown as {
    method?: unknown;
    headers?: HeadersInit;
    credentials?: RequestCredentials;
    cache?: RequestCache;
    redirect?: RequestRedirect;
    referrer?: string;
    referrerPolicy?: ReferrerPolicy;
    integrity?: string;
    keepalive?: boolean;
    mode?: RequestMode;
    signal?: AbortSignal;
  };

  if (typeof requestLike.method !== "string" || requestLike.headers == null) {
    return [rewrittenUrl, init];
  }

  // Pagination requests are GET-only, so recreating the request does not consume
  // or clone a body. Preserve all observable transport options and caller overrides.
  const rewrittenInit: RequestInit = {
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
    ...init,
  };
  return [new pageWindow.URL(rewrittenUrl).href, rewrittenInit];
}

function findConversationCodeMirrorContainer(
  pageWindow: Window & typeof globalThis,
  target: Element,
): Element | null {
  if (!(target instanceof pageWindow.Element)) return null;
  const container = target.closest('[class*="_codemirror"]');
  if (!container) return null;
  return container.closest(
    '[data-message-id], .markdown, [class*="MarkdownContent"], [class*="SmoothedMarkdown"]',
  )
    ? container
    : null;
}

function dispatchHistorySettledAfterCommit(
  pageWindow: Window & typeof globalThis,
  ok = true,
): void {
  const dispatch = () => {
    const root = pageWindow.document.documentElement;
    root.dataset.chatgptHistorySettledSignals = String(
      Number(root.dataset.chatgptHistorySettledSignals ?? "0") + 1,
    );
    pageWindow.dispatchEvent(
      new pageWindow.CustomEvent("chatgpt-performance-fix:history-page-settled", {
        detail: { ok },
      }),
    );
  };
  if (
    pageWindow.document.visibilityState === "hidden" ||
    typeof pageWindow.requestAnimationFrame !== "function"
  ) {
    pageWindow.setTimeout(dispatch, 50);
    return;
  }
  // Let the application consume Response.json(), commit the new cursor/sentinel,
  // and restore scroll position before the next explicit batch step begins.
  pageWindow.requestAnimationFrame(() => {
    pageWindow.requestAnimationFrame(() => pageWindow.setTimeout(dispatch, 0));
  });
}

function installManualPaginationObserver(
  pageWindow: Window & typeof globalThis,
  settings: StoredSettings,
): void {
  const marker = "__chatgptPerformanceFixIntersectionObserver";
  if (Reflect.get(pageWindow, marker)) return;

  const NativeIntersectionObserver = pageWindow.IntersectionObserver;
  if (typeof NativeIntersectionObserver !== "function") return;

  const HISTORY_SETTLED_EVENT = "chatgpt-performance-fix:history-page-settled";
  const HISTORY_FINITE_PLAN_EVENT =
    "chatgpt-performance-fix:history-finite-plan";
  const PAGINATION_SENTINEL_TEST_ID = "conversation-pagination-sentinel";
  const isPaginationSentinelElement = (target: unknown): target is Element => {
    if (!(target instanceof pageWindow.Element)) return false;
    const testId = target.getAttribute("data-testid");
    return typeof testId === "string" && testId.includes(PAGINATION_SENTINEL_TEST_ID);
  };
  const mutationNodeContainsPaginationUi = (node: Node): boolean => {
    if (!(node instanceof pageWindow.Element)) return false;
    if (
      isPaginationSentinelElement(node) ||
      node.getAttribute("data-chatgpt-history-load-control") === "true"
    ) {
      return true;
    }
    return Boolean(
      node.querySelector(
        `[data-testid*="${PAGINATION_SENTINEL_TEST_ID}"],` +
          '[data-chatgpt-history-load-control="true"]',
      ),
    );
  };

  interface HistoryPaginationDriver {
    canStartHistoryBatch(): boolean;
    canContinueHistoryBatch(): boolean;
    driveHistoryBatchPage(): boolean;
    refreshHistoryBatchUi(): void;
    historyBatchGeneration(): number;
  }
  const paginationDrivers = new Set<HistoryPaginationDriver>();
  const paginationReconcilers = new Set<() => void>();
  let nextPaginationGeneration = 0;
  let paginationReconcileScheduled = false;
  const schedulePaginationDomReconcile = () => {
    if (paginationReconcileScheduled) return;
    paginationReconcileScheduled = true;
    const run = () => {
      paginationReconcileScheduled = false;
      for (const reconcile of paginationReconcilers) reconcile();
    };
    if (
      pageWindow.document.visibilityState === "hidden" ||
      typeof pageWindow.requestAnimationFrame !== "function"
    ) {
      pageWindow.setTimeout(run, 0);
    } else {
      pageWindow.requestAnimationFrame(run);
    }
  };
  const batchState = {
    active: false,
    all: false,
    requestedTurns: 0,
    remaining: 0,
    inFlight: false,
    misses: 0,
    lastDrivenGeneration: 0,
  };
  let batchResumeTimer: number | undefined;
  let batchWatchdogTimer: number | undefined;

  const refreshBatchUi = () => {
    for (const driver of paginationDrivers) driver.refreshHistoryBatchUi();
    const root = pageWindow.document.documentElement;
    root.dataset.chatgptHistoryBatchActive = batchState.active ? "true" : "false";
    root.dataset.chatgptHistoryBatchMode = batchState.active
      ? batchState.all
        ? "all"
        : "count"
      : "idle";
  };

  const syncFiniteBatchRequestState = () => {
    const root = pageWindow.document.documentElement;
    if (!batchState.active || batchState.all) {
      delete root.dataset.chatgptHistoryFiniteRequestedTurns;
      delete root.dataset.chatgptHistoryFiniteServerRequestPending;
      return;
    }
    root.dataset.chatgptHistoryFiniteRequestedTurns = String(batchState.requestedTurns);
    if (root.dataset.chatgptHistoryFiniteServerRequestPending !== "false") {
      root.dataset.chatgptHistoryFiniteServerRequestPending = "true";
    }
  };

  const stopBatch = () => {
    batchState.active = false;
    batchState.all = false;
    batchState.requestedTurns = 0;
    batchState.remaining = 0;
    batchState.inFlight = false;
    batchState.misses = 0;
    batchState.lastDrivenGeneration = 0;
    const root = pageWindow.document.documentElement;
    delete root.dataset.chatgptHistoryFiniteRequestedTurns;
    delete root.dataset.chatgptHistoryFiniteServerRequestPending;
    if (batchResumeTimer != null) {
      pageWindow.clearTimeout(batchResumeTimer);
      batchResumeTimer = undefined;
    }
    if (batchWatchdogTimer != null) {
      pageWindow.clearTimeout(batchWatchdogTimer);
      batchWatchdogTimer = undefined;
    }
    refreshBatchUi();
  };

  const runNextBatchStep = () => {
    batchResumeTimer = undefined;
    if (!batchState.active || batchState.inFlight) return;
    if (!batchState.all && batchState.remaining <= 0) {
      stopBatch();
      return;
    }
    const driver = [...paginationDrivers]
      .reverse()
      .find(
        (candidate) =>
          candidate.canContinueHistoryBatch() &&
          candidate.historyBatchGeneration() > batchState.lastDrivenGeneration,
      );
    if (!driver) {
      batchState.misses += 1;
      // Sentinel replacement is normally completed within a couple of frames.
      // If no pagination driver exists for one second, there is no older page.
      if (batchState.misses >= 20) {
        stopBatch();
        return;
      }
      batchResumeTimer = pageWindow.setTimeout(runNextBatchStep, 50);
      return;
    }
    batchState.misses = 0;
    if (!driver.driveHistoryBatchPage()) {
      batchResumeTimer = pageWindow.setTimeout(runNextBatchStep, 50);
    }
  };

  const scheduleNextBatchStep = (delay = 0) => {
    if (!batchState.active || batchState.inFlight || batchResumeTimer != null) return;
    batchResumeTimer = pageWindow.setTimeout(runNextBatchStep, delay);
  };

  const startBatch = (driver: HistoryPaginationDriver, value: TurnLoadSetting) => {
    if (batchState.active || !driver.canStartHistoryBatch()) return;
    batchState.active = true;
    batchState.all = value === "all";
    batchState.requestedTurns = value === "all" ? 0 : value;
    batchState.remaining = value === "all" ? Number.POSITIVE_INFINITY : value;
    batchState.inFlight = false;
    batchState.misses = 0;
    batchState.lastDrivenGeneration = 0;
    const root = pageWindow.document.documentElement;
    if (batchState.all) {
      delete root.dataset.chatgptHistoryFiniteRequestedTurns;
      delete root.dataset.chatgptHistoryFiniteServerRequestPending;
    } else {
      root.dataset.chatgptHistoryFiniteRequestedTurns = String(value);
      root.dataset.chatgptHistoryFiniteServerRequestPending = "true";
    }
    refreshBatchUi();
    scheduleNextBatchStep();
  };

  const onHistorySettled = (event: Event) => {
    if (!batchState.active || !batchState.inFlight) return;
    batchState.inFlight = false;
    if (batchWatchdogTimer != null) {
      pageWindow.clearTimeout(batchWatchdogTimer);
      batchWatchdogTimer = undefined;
    }
    const detail = event instanceof pageWindow.CustomEvent
      ? event.detail as { ok?: unknown } | undefined
      : undefined;
    if (detail?.ok === false) {
      stopBatch();
      return;
    }
    if (!batchState.all && batchState.remaining <= 0) {
      stopBatch();
      return;
    }
    refreshBatchUi();
    scheduleNextBatchStep(20);
  };

  const onFiniteHistoryPlan = (event: Event) => {
    if (!batchState.active || batchState.all) return;
    const detail = event instanceof pageWindow.CustomEvent
      ? event.detail as { localPages?: unknown } | undefined
      : undefined;
    const localPages = Number(detail?.localPages);
    if (!Number.isFinite(localPages) || localPages < 0) return;
    // The first visible chunk has already consumed one unit before the fetch
    // begins. Only the locally materialized follow-up chunks may satisfy the
    // rest of a finite batch; never spill into a second server cursor.
    batchState.remaining = Math.min(
      batchState.remaining,
      Math.max(0, Math.floor(localPages)),
    );
    syncFiniteBatchRequestState();
  };

  class TunedIntersectionObserver implements IntersectionObserver {
    private readonly callback: IntersectionObserverCallback;
    private readonly options?: IntersectionObserverInit;
    private observer?: IntersectionObserver;
    private lastPaginationEntries?: IntersectionObserverEntry[];
    private paginationTarget?: Element;
    private readonly observedTargets = new Set<Element>();
    private readonly paginationTargets = new Set<Element>();
    private paginationGeneration = 0;
    private control?: HTMLDivElement;
    private button?: HTMLButtonElement;
    private allButton?: HTMLButtonElement;
    private batchSelect?: HTMLSelectElement;
    private readonly deferredCodeMirrorTargets = new Map<
      Element,
      MutationObserver
    >();
    private paginationTargetObserver?: MutationObserver;

    constructor(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      this.callback = callback;
      this.options = options;
    }

    refreshHistoryBatchUi(): void {
      if (!this.button) return;
      const canLoad = this.canStartHistoryBatch();
      this.button.disabled = batchState.active || !canLoad;
      this.button.textContent = batchState.active
        ? batchState.all
          ? "正在加载全部…"
          : "加载中…"
        : `加载 ${formatTurnLoadSetting(settings.historyBatchTurns)}`;
      this.button.setAttribute("aria-busy", batchState.active ? "true" : "false");
      this.button.title = canLoad
        ? `加载 ${formatTurnLoadSetting(settings.historyBatchTurns)}历史消息`
        : "滚到顶部后可加载更多";
      if (this.allButton) {
        this.allButton.disabled = batchState.active || !canLoad;
        this.allButton.setAttribute("aria-busy", batchState.active ? "true" : "false");
      }
    }

    private paginationTargetIsVisible(): boolean {
      const target = this.paginationTarget;
      if (!target?.isConnected) return false;
      const targetRect = target.getBoundingClientRect();
      const root = this.root;
      const rootTop = root instanceof pageWindow.Element
        ? root.getBoundingClientRect().top
        : 0;
      const rootBottom = root instanceof pageWindow.Element
        ? root.getBoundingClientRect().bottom
        : pageWindow.innerHeight;
      // This is only an enablement fallback for a user-controlled button. It
      // never invokes the pagination callback on its own.
      return targetRect.bottom >= rootTop - 2 && targetRect.top <= rootBottom + 2;
    }

    private syntheticPaginationEntry(): IntersectionObserverEntry | null {
      const target = this.paginationTarget;
      if (!target?.isConnected || !this.paginationTargetIsVisible()) return null;
      const targetRect = target.getBoundingClientRect();
      const root = this.root;
      const rootBounds = root instanceof pageWindow.Element
        ? root.getBoundingClientRect()
        : new pageWindow.DOMRect(0, 0, pageWindow.innerWidth, pageWindow.innerHeight);
      return {
        time: pageWindow.performance.now(),
        target,
        rootBounds,
        boundingClientRect: targetRect,
        intersectionRect: targetRect,
        isIntersecting: true,
        intersectionRatio: 1,
      };
    }

    private currentPaginationEntries(): IntersectionObserverEntry[] {
      const target = this.paginationTarget;
      if (!target) return [];
      const current = this.lastPaginationEntries?.filter(
        (entry) => entry.target === target,
      ) ?? [];
      if (current.length > 0) return current;
      const synthetic = this.syntheticPaginationEntry();
      return synthetic ? [synthetic] : [];
    }

    canStartHistoryBatch(): boolean {
      if (!this.paginationTarget?.isConnected) return false;
      return (
        this.currentPaginationEntries().some((entry) => entry.isIntersecting) ||
        this.paginationTargetIsVisible()
      );
    }

    historyBatchGeneration(): number {
      return this.paginationGeneration;
    }

    canContinueHistoryBatch(): boolean {
      return Boolean(
        this.paginationTarget?.isConnected &&
        this.currentPaginationEntries().length,
      );
    }

    driveHistoryBatchPage(): boolean {
      const entries = this.currentPaginationEntries();
      if (
        !batchState.active ||
        batchState.inFlight ||
        !this.paginationTarget?.isConnected ||
        entries.length === 0
      ) {
        return false;
      }
      if (!batchState.all) {
        if (batchState.remaining <= 0) return false;
        batchState.remaining -= 1;
        syncFiniteBatchRequestState();
      }
      const forcedEntries = entries.map((entry) => {
        if (entry.isIntersecting) return entry;
        const forced = Object.create(entry) as IntersectionObserverEntry;
        Object.defineProperty(forced, "isIntersecting", { value: true });
        Object.defineProperty(forced, "intersectionRatio", {
          value: Math.max(0.01, entry.intersectionRatio),
        });
        return forced;
      });
      batchState.inFlight = true;
      batchState.lastDrivenGeneration = this.paginationGeneration;
      refreshBatchUi();
      const root = pageWindow.document.documentElement;
      const clicks = Number(root.dataset.chatgptManualHistoryClicks ?? "0");
      root.dataset.chatgptManualHistoryClicks = String(clicks + 1);
      try {
        this.callback(forcedEntries, this);
      } catch (error) {
        batchState.inFlight = false;
        console.warn(`[${SCRIPT_NAME}] Manual history callback failed`, error);
        return false;
      }
      // Network failures should not leave the global batch permanently active.
      if (batchWatchdogTimer != null) pageWindow.clearTimeout(batchWatchdogTimer);
      batchWatchdogTimer = pageWindow.setTimeout(stopBatch, 12_000);
      return true;
    }

    private beginBatch = (value: TurnLoadSetting): void => {
      startBatch(this, value);
    };

    private triggerManualLoad = (): void => {
      this.beginBatch(settings.historyBatchTurns);
    };

    private triggerLoadAll = (): void => {
      this.beginBatch("all");
    };

    private syncBatchSelect(): void {
      if (!this.batchSelect) return;
      const value = settings.historyBatchTurns === "all"
        ? "all"
        : String(settings.historyBatchTurns);
      if (![...this.batchSelect.options].some((option) => option.value === value)) {
        const option = pageWindow.document.createElement("option");
        option.value = value;
        option.textContent = `${value} 轮`;
        this.batchSelect.insertBefore(option, this.batchSelect.lastElementChild);
      }
      this.batchSelect.value = value;
    }

    private onBatchSelectChange = async (): Promise<void> => {
      if (!this.batchSelect) return;
      let next: TurnLoadSetting | null;
      if (this.batchSelect.value === "custom") {
        next = await showTurnLoadSettingDialog(
          pageWindow,
          "每次“加载更多”默认加载多少轮？",
          settings.historyBatchTurns,
        );
      } else {
        next = normalizeTurnLoadSetting(
          this.batchSelect.value,
          settings.historyBatchTurns,
        );
      }
      if (next != null) {
        settings.historyBatchTurns = next;
        writeSettings(pageWindow.localStorage, settings);
      }
      this.syncBatchSelect();
      this.refreshHistoryBatchUi();
    };

    private placeControl(target: Element, control: HTMLDivElement): boolean {
      if (!target.isConnected) return false;
      try {
        const inserted = target.insertAdjacentElement("afterend", control);
        if (inserted === control && control.isConnected) return true;
      } catch {
        // Some transient React DOM states do not support insertAdjacentElement.
      }
      const parent = target.parentElement;
      if (!parent) return false;
      try {
        parent.insertBefore(control, target.nextSibling);
      } catch {
        return false;
      }
      return control.isConnected;
    }

    private forgetDetachedControl(): void {
      if (!this.control || this.control.isConnected) return;
      this.button?.removeEventListener("click", this.triggerManualLoad);
      this.allButton?.removeEventListener("click", this.triggerLoadAll);
      this.batchSelect?.removeEventListener("change", this.onBatchSelectChange);
      this.control = undefined;
      this.button = undefined;
      this.allButton = undefined;
      this.batchSelect = undefined;
    }

    private installControl(target: Element): void {
      if (!target.isConnected) return;
      if (this.control?.isConnected) {
        if (this.control.previousElementSibling !== target) {
          if (!this.placeControl(target, this.control)) return;
        }
        this.paginationTarget = target;
        this.refreshHistoryBatchUi();
        return;
      }
      this.forgetDetachedControl();
      const control = pageWindow.document.createElement("div");
      control.dataset.chatgptHistoryLoadControl = "true";
      control.style.cssText = [
        "display:flex",
        "justify-content:center",
        "align-items:center",
        "gap:7px",
        "flex-wrap:wrap",
        "padding:10px 0 14px",
        "min-height:48px",
        "position:relative",
        "z-index:2",
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
        "box-shadow:0 1px 2px rgba(0,0,0,.06)",
      ].join(";");
      button.addEventListener("click", this.triggerManualLoad);

      const select = pageWindow.document.createElement("select");
      select.dataset.chatgptHistoryBatchSelect = "true";
      select.title = "每次加载的历史轮数";
      select.style.cssText = [
        "border:1px solid var(--border-light,rgba(127,127,127,.24))",
        "border-radius:999px",
        "padding:6px 9px",
        "font:500 12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        "background:var(--main-surface-primary,var(--main-surface-secondary,inherit))",
        "color:var(--text-primary,inherit)",
      ].join(";");
      for (const [value, label] of [
        ["1", "1 轮"],
        ["2", "2 轮"],
        ["5", "5 轮"],
        ["10", "10 轮"],
        ["20", "20 轮"],
        ["50", "50 轮"],
        ["all", "全部"],
        ["custom", "自定义…"],
      ] as const) {
        const option = pageWindow.document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.append(option);
      }
      select.addEventListener("change", this.onBatchSelectChange);

      const allButton = button.cloneNode(false) as HTMLButtonElement;
      allButton.dataset.chatgptHistoryLoadAllButton = "true";
      allButton.textContent = "全部加载";
      allButton.title = "持续加载直到没有更早的历史消息";
      allButton.addEventListener("click", this.triggerLoadAll);

      control.append(select, button, allButton);
      if (!this.placeControl(target, control)) {
        button.removeEventListener("click", this.triggerManualLoad);
        allButton.removeEventListener("click", this.triggerLoadAll);
        select.removeEventListener("change", this.onBatchSelectChange);
        return;
      }
      this.control = control;
      this.button = button;
      this.allButton = allButton;
      this.batchSelect = select;
      this.paginationTarget = target;
      this.syncBatchSelect();
      this.refreshHistoryBatchUi();
    }

    private reconcilePaginationUi = (): void => {
      const connectedTarget = [...this.paginationTargets]
        .reverse()
        .find((candidate) => candidate.isConnected);
      if (!connectedTarget) {
        this.paginationTarget = undefined;
        this.control?.remove();
        return;
      }
      this.paginationTarget = connectedTarget;
      this.installControl(connectedTarget);
    };

    private registerPaginationTarget(target: Element, rearmed: boolean): void {
      const known = this.paginationTargets.has(target);
      this.paginationTargets.delete(target);
      this.paginationTargets.add(target);
      this.paginationTarget = target;
      if (!known || rearmed) {
        this.paginationGeneration = ++nextPaginationGeneration;
      }
      paginationDrivers.add(this);
      paginationReconcilers.add(this.reconcilePaginationUi);
      this.reconcilePaginationUi();
      if (batchState.active) scheduleNextBatchStep();
    }

    private resetPaginationTargetObserver(newTarget?: Element): void {
      this.paginationTargetObserver ??= new pageWindow.MutationObserver((records) => {
        for (const record of records) {
          const target = record.target;
          if (
            target instanceof pageWindow.Element &&
            this.observedTargets.has(target) &&
            isPaginationSentinelElement(target)
          ) {
            this.registerPaginationTarget(target, false);
          }
        }
      });
      if (newTarget) {
        this.paginationTargetObserver.observe(newTarget, {
          attributes: true,
          attributeFilter: ["data-testid"],
        });
        return;
      }

      // MutationObserver has no per-target unobserve API. Rebuild only when a
      // target is removed; doing this on every observe would become O(n²) for a
      // shared observer with many ordinary targets.
      this.paginationTargetObserver.disconnect();
      for (const target of this.observedTargets) {
        this.paginationTargetObserver.observe(target, {
          attributes: true,
          attributeFilter: ["data-testid"],
        });
      }
    }

    private isPaginationEntry(entry: IntersectionObserverEntry): boolean {
      return (
        this.paginationTargets.has(entry.target) ||
        isPaginationSentinelElement(entry.target)
      );
    }

    private noteSuppressedPagination(count: number, kind: "callback" | "record"): void {
      if (count <= 0) return;
      const root = pageWindow.document.documentElement;
      const key = kind === "callback"
        ? "chatgptSuppressedAutoPaginationCallbacks"
        : "chatgptSuppressedAutoPaginationRecords";
      root.dataset[key] = String(Number(root.dataset[key] ?? "0") + count);
    }

    private dispatchNative(entries: IntersectionObserverEntry[]): void {
      for (const entry of entries) {
        if (isPaginationSentinelElement(entry.target)) {
          this.registerPaginationTarget(entry.target, false);
        }
      }
      const paginationEntries = entries.filter((entry) => this.isPaginationEntry(entry));
      if (paginationEntries.length === 0) {
        this.callback(entries, this);
        return;
      }

      this.lastPaginationEntries = paginationEntries;
      this.refreshHistoryBatchUi();
      if (batchState.active) scheduleNextBatchStep();

      // Suppress every intersecting pagination-sentinel entry, even when this
      // native observer instance is shared with unrelated targets. The old
      // observer-level classification missed that case when a non-pagination
      // target happened to be observed first.
      const forwarded = entries.filter(
        (entry) => !this.isPaginationEntry(entry) || !entry.isIntersecting,
      );
      this.noteSuppressedPagination(entries.length - forwarded.length, "callback");
      if (forwarded.length > 0) this.callback(forwarded, this);
    }

    private ensureObserver(target: Element): IntersectionObserver {
      if (this.observer) return this.observer;
      this.observer = new NativeIntersectionObserver(
        (entries) => this.dispatchNative(entries),
        this.options,
      );
      return this.observer;
    }

    observe(target: Element): void {
      const observer = this.ensureObserver(target);
      this.observedTargets.add(target);
      this.resetPaginationTargetObserver(target);
      const isPaginationTarget = isPaginationSentinelElement(target);
      if (isPaginationTarget) {
        this.registerPaginationTarget(target, true);
      }
      const container = findConversationCodeMirrorContainer(pageWindow, target);
      if (
        container &&
        container.getAttribute("data-chatgpt-rich-editor-state") !== "hot"
      ) {
        if (this.deferredCodeMirrorTargets.has(target)) return;
        const attributeObserver = new pageWindow.MutationObserver(() => {
          if (
            container.getAttribute("data-chatgpt-rich-editor-state") !== "hot"
          ) {
            return;
          }
          attributeObserver.disconnect();
          this.deferredCodeMirrorTargets.delete(target);
          observer.observe(target);
          const root = pageWindow.document.documentElement;
          const count = Number(root.dataset.chatgptCodeMirrorIoResumed ?? "0");
          root.dataset.chatgptCodeMirrorIoResumed = String(count + 1);
        });
        attributeObserver.observe(container, {
          attributes: true,
          attributeFilter: ["data-chatgpt-rich-editor-state"],
        });
        this.deferredCodeMirrorTargets.set(target, attributeObserver);
        const root = pageWindow.document.documentElement;
        const count = Number(root.dataset.chatgptCodeMirrorIoDeferred ?? "0");
        root.dataset.chatgptCodeMirrorIoDeferred = String(count + 1);
        return;
      }
      observer.observe(target);
      if (isPaginationTarget && batchState.active) scheduleNextBatchStep();
    }

    unobserve(target: Element): void {
      this.deferredCodeMirrorTargets.get(target)?.disconnect();
      this.deferredCodeMirrorTargets.delete(target);
      this.observedTargets.delete(target);
      this.resetPaginationTargetObserver();
      this.observer?.unobserve(target);
      if (this.paginationTargets.delete(target) && this.paginationTarget === target) {
        this.paginationTarget = [...this.paginationTargets]
          .reverse()
          .find((candidate) => candidate.isConnected);
      }
      if (this.paginationTargets.size === 0) {
        paginationDrivers.delete(this);
        paginationReconcilers.delete(this.reconcilePaginationUi);
        this.control?.remove();
      } else {
        this.reconcilePaginationUi();
      }
    }

    disconnect(): void {
      this.observer?.disconnect();
      paginationDrivers.delete(this);
      paginationReconcilers.delete(this.reconcilePaginationUi);
      this.observedTargets.clear();
      this.paginationTargets.clear();
      this.paginationTargetObserver?.disconnect();
      for (const observer of this.deferredCodeMirrorTargets.values()) {
        observer.disconnect();
      }
      this.deferredCodeMirrorTargets.clear();
      this.button?.removeEventListener("click", this.triggerManualLoad);
      this.allButton?.removeEventListener("click", this.triggerLoadAll);
      this.batchSelect?.removeEventListener("change", this.onBatchSelectChange);
      this.control?.remove();
      this.control = undefined;
      this.button = undefined;
      this.allButton = undefined;
      this.batchSelect = undefined;
      this.paginationTarget = undefined;
      this.lastPaginationEntries = undefined;
      if (batchState.active) scheduleNextBatchStep();
    }

    takeRecords(): IntersectionObserverEntry[] {
      const records = this.observer?.takeRecords() ?? [];
      if (records.length === 0) return records;
      for (const entry of records) {
        if (isPaginationSentinelElement(entry.target)) {
          this.registerPaginationTarget(entry.target, false);
        }
      }
      const paginationRecords = records.filter((entry) => this.isPaginationEntry(entry));
      if (paginationRecords.length > 0) {
        this.lastPaginationEntries = paginationRecords;
        this.refreshHistoryBatchUi();
        if (batchState.active) scheduleNextBatchStep();
      }
      const filtered = records.filter(
        (entry) => !this.isPaginationEntry(entry) || !entry.isIntersecting,
      );
      this.noteSuppressedPagination(records.length - filtered.length, "record");
      return filtered;
    }

    get root(): Element | Document | null {
      return this.observer?.root ?? this.options?.root ?? null;
    }

    get rootMargin(): string {
      return (
        this.observer?.rootMargin ??
        this.options?.rootMargin ??
        "0px 0px 0px 0px"
      );
    }

    get thresholds(): readonly number[] {
      if (this.observer) return this.observer.thresholds;
      const threshold = this.options?.threshold;
      if (Array.isArray(threshold)) return [...threshold].sort((a, b) => a - b);
      return [typeof threshold === "number" ? threshold : 0];
    }
  }

  try {
    Object.setPrototypeOf(
      TunedIntersectionObserver.prototype,
      NativeIntersectionObserver.prototype,
    );
    Object.setPrototypeOf(TunedIntersectionObserver, NativeIntersectionObserver);
    Object.defineProperty(TunedIntersectionObserver, "name", {
      value: "IntersectionObserver",
    });
    Object.defineProperty(pageWindow, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: TunedIntersectionObserver,
    });
    pageWindow.addEventListener(HISTORY_SETTLED_EVENT, onHistorySettled);
    pageWindow.addEventListener(HISTORY_FINITE_PLAN_EVENT, onFiniteHistoryPlan);
    const paginationDomObserver = new pageWindow.MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (record.type === "attributes") {
          return isPaginationSentinelElement(record.target);
        }
        return [...record.addedNodes, ...record.removedNodes].some(
          mutationNodeContainsPaginationUi,
        );
      });
      if (relevant) schedulePaginationDomReconcile();
    });
    paginationDomObserver.observe(pageWindow.document.documentElement, {
      attributes: true,
      attributeFilter: ["data-testid"],
      childList: true,
      subtree: true,
    });
    Reflect.set(pageWindow, marker, true);
    pageWindow.document.documentElement.dataset.chatgptHistoryLoadingMode = "manual";
  } catch (error) {
    console.warn(`[${SCRIPT_NAME}] Could not install manual history loading`, error);
  }
}

function isFinishedMessageStatus(status: unknown): boolean {
  return (
    status === "finished_successfully" ||
    status === "finished" ||
    status === "complete"
  );
}

function isIdleConversation(payload: Record<string, unknown>): boolean {
  // Do not let the short response cache hide server-side async progress.
  if (payload.async_status != null) return false;
  if (
    typeof payload.current_node !== "string" ||
    typeof payload.mapping !== "object" ||
    payload.mapping === null
  ) {
    return false;
  }

  const current = (payload.mapping as Record<string, unknown>)[
    payload.current_node
  ] as { message?: { status?: unknown } } | undefined;
  return isFinishedMessageStatus(current?.message?.status);
}

function currentPaginatedMessage(
  payload: Record<string, unknown>,
): ConversationMessage | undefined {
  if (typeof payload.current_node !== "string" || !Array.isArray(payload.messages)) {
    return undefined;
  }
  return (payload.messages as ConversationMessage[]).find(
    (message) => message.id === payload.current_node,
  );
}

function hasActivePaginatedWork(payload: Record<string, unknown>): boolean {
  if (payload.async_status != null) return true;
  if (!Array.isArray(payload.messages)) return true;
  const messages = payload.messages as ConversationMessage[];
  if (
    messages.some((message) =>
      ["in_progress", "streaming", "pending"].includes(String(message.status)),
    )
  ) {
    return true;
  }
  const current = currentPaginatedMessage(payload);
  return !current || !isFinishedMessageStatus(current.status);
}

function isIdlePaginatedConversation(payload: Record<string, unknown>): boolean {
  // A finished tool leaf is also an idle server snapshot. Requiring the current
  // leaf to be an assistant final made completed tool-heavy conversations refetch
  // the same initial page repeatedly even though async_status was already clear.
  return !hasActivePaginatedWork(payload);
}

function requiredInitialMessageIds(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.messages) || typeof payload.current_node !== "string") {
    return [];
  }
  const messages = payload.messages as ConversationMessage[];
  const byId = new Map(
    messages
      .filter((message): message is ConversationMessage & { id: string } =>
        typeof message.id === "string",
      )
      .map((message) => [message.id, message]),
  );
  const ids = new Set<string>([payload.current_node]);
  const current = byId.get(payload.current_node);

  // A tool result needs its immediately preceding invocation to remain a valid
  // render group. Do not keep the entire tool-heavy turn merely for this pair.
  if (current?.author?.role === "tool") {
    const parentId = current.metadata?.parent_id;
    if (typeof parentId === "string" && byId.has(parentId)) ids.add(parentId);
  }
  return [...ids];
}

function isRenderableAssistantMessage(message: ConversationMessage): boolean {
  if (message.author?.role !== "assistant") return false;
  if (message.metadata?.is_visually_hidden_from_conversation === true) return false;
  if (message.recipient != null && message.recipient !== "all") return false;
  if (message.channel === "final") return true;
  const contentType = message.content?.content_type;
  return !["code", "execution_output", "thoughts", "reasoning_recap"].includes(
    String(contentType ?? ""),
  );
}

function hasRenderableQuestionAnswerTurn(
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

function mergeChronologicalMessages(
  older: ConversationMessage[],
  newer: ConversationMessage[],
): ConversationMessage[] {
  const seen = new Set<string>();
  const merged: ConversationMessage[] = [];
  for (const message of [...older, ...newer]) {
    const id = message.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    merged.push(message);
  }
  return merged;
}

function writeSettings(storage: Storage, settings: StoredSettings): void {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

function requestUrl(
  pageWindow: Window & typeof globalThis,
  input: RequestInfo | URL,
  baseUrl: string,
): string {
  if (typeof input === "string") return new pageWindow.URL(input, baseUrl).href;

  // Tampermonkey objects and page objects may come from different JS realms, so
  // `instanceof Request/URL` is intentionally avoided here.
  const requestLike = input as unknown as { url?: unknown; href?: unknown };
  if (typeof requestLike.url === "string") {
    return new pageWindow.URL(requestLike.url, baseUrl).href;
  }
  if (typeof requestLike.href === "string") {
    return new pageWindow.URL(requestLike.href, baseUrl).href;
  }
  return new pageWindow.URL(String(input), baseUrl).href;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  const method = (input as unknown as { method?: unknown })?.method;
  if (typeof method === "string") {
    return method.toUpperCase();
  }
  return "GET";
}

interface BackendRequestContext {
  capture: (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    rawUrl: string,
  ) => boolean;
  ready: () => boolean;
  createInit: (overrides?: RequestInit) => RequestInit | null;
}

function createBackendRequestContext(
  pageWindow: Window & typeof globalThis,
): BackendRequestContext {
  let capturedHeaders: Headers | null = null;
  let capturedCredentials: RequestCredentials = "same-origin";

  const capture = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    rawUrl: string,
  ): boolean => {
    try {
      const url = new pageWindow.URL(rawUrl, pageWindow.location.href);
      if (
        url.origin !== pageWindow.location.origin ||
        !url.pathname.startsWith("/backend-api/")
      ) {
        return false;
      }

      const merged = new pageWindow.Headers();
      const requestLike = input as unknown as {
        headers?: HeadersInit;
        credentials?: RequestCredentials;
      };
      if (requestLike.headers != null) {
        new pageWindow.Headers(requestLike.headers).forEach((value, name) => {
          merged.set(name, value);
        });
      }
      if (init?.headers != null) {
        new pageWindow.Headers(init.headers).forEach((value, name) => {
          merged.set(name, value);
        });
      }

      // Only authenticated native backend requests may refresh the template.
      // Checking header presence is enough; the credential value itself stays
      // opaque and is never read, logged, or persisted by this userscript.
      if (!merged.has("authorization")) return false;
      // Keep ChatGPT's own request context opaque. We never read or persist
      // individual credential values; later probes simply clone these headers.
      // Remove headers whose values describe the original endpoint/body rather
      // than authentication/session context.
      const firstCapture = capturedHeaders == null;
      merged.delete("content-length");
      merged.delete("content-type");
      merged.delete("x-openai-target-path");
      merged.delete("x-openai-target-route");
      capturedHeaders = merged;
      capturedCredentials =
        init?.credentials ?? requestLike.credentials ?? "same-origin";

      const root = pageWindow.document.documentElement;
      root.dataset.chatgptBackendRequestContextReady = "true";
      root.dataset.chatgptBackendRequestContextCaptures = String(
        Number(root.dataset.chatgptBackendRequestContextCaptures ?? "0") + 1,
      );
      return firstCapture;
    } catch {
      return false;
    }
  };

  return {
    capture,
    ready: () => capturedHeaders != null,
    createInit: (overrides: RequestInit = {}) => {
      if (!capturedHeaders) return null;
      const headers = new pageWindow.Headers(capturedHeaders);
      if (overrides.headers != null) {
        new pageWindow.Headers(overrides.headers).forEach((value, name) => {
          headers.set(name, value);
        });
      }
      return {
        ...overrides,
        headers,
        credentials: overrides.credentials ?? capturedCredentials,
      };
    },
  };
}

type ConversationMutationKind = "send" | "resume" | "content" | null;

function conversationMutationKind(
  rawUrl: string,
  method: string,
  baseUrl: string,
): ConversationMutationKind {
  if (method === "GET" || method === "HEAD") return null;
  try {
    const url = new URL(rawUrl, baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (
      method === "POST" &&
      (pathname === "/backend-api/conversation" ||
        pathname === "/backend-api/f/conversation")
    ) {
      return "send";
    }
    if (method === "POST" && pathname.endsWith("/conversation/resume")) {
      // ChatGPT's own turn analytics treats /f/conversation/resume as a
      // distinct transport-recovery request. It can happen repeatedly while a
      // single assistant turn is streaming and must never start a new delivery
      // verification cycle for the original user message.
      return "resume";
    }
    if (
      /^\/backend-api\/conversation\/[0-9a-f-]{36}$/i.test(pathname) &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(method)
    ) {
      return "content";
    }
    // async-status, stream_status, init and prepare are transport/status helpers.
    // Treating them as transcript mutations used to delete synthetic history
    // cursors while a conversation was still open.
    return null;
  } catch {
    return null;
  }
}

function currentConversationId(
  pageWindow: Window & typeof globalThis,
): string | null {
  const match = pageWindow.location.pathname.match(
    /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
  );
  return match?.[1] ?? null;
}

function isActiveAsyncStatus(value: unknown): boolean {
  if (typeof value === "number") return [1, 3, 5, 6].includes(value);
  const normalized = String(value ?? "").trim().toLowerCase();
  return [
    "pending",
    "running",
    "streaming",
    "in_progress",
    "in-progress",
    "realtime",
    "realtime_busy",
    "busy",
  ].includes(normalized);
}

interface SidebarConversationSnapshot {
  id: string;
  title?: string | null;
  update_time?: unknown;
  async_status?: unknown;
}

function conversationIdFromAnchor(
  pageWindow: Window & typeof globalThis,
  anchor: HTMLAnchorElement,
): string | null {
  try {
    const pathname = new pageWindow.URL(anchor.href, pageWindow.location.href).pathname;
    const match = pathname.match(
      /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function findSidebarTitleElement(
  pageWindow: Window & typeof globalThis,
  anchor: HTMLAnchorElement,
): HTMLElement | null {
  const preferred = anchor.querySelector<HTMLElement>(
    '[data-testid*="conversation-title"], [data-testid*="history-item-title"], .truncate, [class*="truncate"], [class*="line-clamp"]',
  );
  if (preferred && !preferred.closest("button")) return preferred;

  const leaves = [...anchor.querySelectorAll<HTMLElement>("span,div")].filter((element) => {
    if (element.closest("button") || element.dataset.chatgptSidebarSyncStatus === "true") {
      return false;
    }
    const text = element.textContent?.trim() ?? "";
    return element.children.length === 0 && text.length > 0 && text.length <= 240;
  });
  return leaves[0] ?? null;
}

function installSidebarFreshness(
  pageWindow: Window & typeof globalThis,
  originalFetch: typeof pageWindow.fetch,
  requestContext: BackendRequestContext,
  refreshCurrentConversation: () => void,
): {
  requestContextChanged: () => void;
  noteConversationStatus: (conversationId: string, value: unknown) => void;
} {
  const snapshots = new Map<string, SidebarConversationSnapshot>();
  let refreshing = false;
  let domSyncScheduled = false;
  let probeBackoffUntil = 0;
  let refreshButton: HTMLButtonElement | undefined;
  let conversationRefreshButton: HTMLButtonElement | undefined;

  const updateRefreshButton = (label = "刷新侧栏") => {
    if (!refreshButton) return;
    const ready = requestContext.ready();
    refreshButton.disabled = refreshing || !ready;
    refreshButton.textContent = refreshing ? "刷新中…" : label;
    refreshButton.setAttribute("aria-busy", refreshing ? "true" : "false");
    refreshButton.title = !ready
      ? "等待 ChatGPT 初始化请求上下文"
      : Date.now() < probeBackoffUntil
        ? "最近请求过于频繁，暂时不会发起新的刷新请求"
        : "手动刷新侧边栏标题与运行状态";
  };

  const ensureRefreshButton = () => {
    const existing = pageWindow.document.querySelector<HTMLButtonElement>(
      '[data-chatgpt-sidebar-refresh-button="true"]',
    );
    if (existing) {
      refreshButton = existing;
      conversationRefreshButton = pageWindow.document.querySelector<HTMLButtonElement>(
        '[data-chatgpt-conversation-refresh-button="true"]',
      ) ?? undefined;
      if (conversationRefreshButton) {
        conversationRefreshButton.disabled = currentConversationId(pageWindow) == null;
      }
      updateRefreshButton();
      return;
    }

    const firstConversationAnchor = pageWindow.document.querySelector<HTMLAnchorElement>(
      'a[href*="/c/"]',
    );
    if (!firstConversationAnchor) return;
    const row = firstConversationAnchor.parentElement ?? firstConversationAnchor;
    const container = row.parentElement ?? firstConversationAnchor.closest("nav,aside");
    if (!container) return;

    const control = pageWindow.document.createElement("div");
    control.dataset.chatgptSidebarRefreshControl = "true";
    control.style.cssText = [
      "display:flex",
      "justify-content:flex-end",
      "align-items:center",
      "gap:6px",
      "padding:4px 8px 6px",
    ].join(";");

    const button = pageWindow.document.createElement("button");
    button.type = "button";
    button.dataset.chatgptSidebarRefreshButton = "true";
    button.textContent = "刷新侧栏";
    button.style.cssText = [
      "appearance:none",
      "border:1px solid var(--border-light,rgba(127,127,127,.24))",
      "border-radius:8px",
      "padding:4px 8px",
      "background:var(--main-surface-secondary,rgba(127,127,127,.08))",
      "color:var(--text-secondary,var(--text-primary,inherit))",
      "font:500 11px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "cursor:pointer",
    ].join(";");
    button.addEventListener("click", () => void refreshManually());

    const conversationButton = button.cloneNode(false) as HTMLButtonElement;
    delete conversationButton.dataset.chatgptSidebarRefreshButton;
    conversationButton.dataset.chatgptConversationRefreshButton = "true";
    conversationButton.textContent = "刷新会话";
    conversationButton.title = "仅在点击后重新加载当前会话；后台重复请求只读取本地快照";
    conversationButton.disabled = currentConversationId(pageWindow) == null;
    conversationButton.addEventListener("click", refreshCurrentConversation);

    control.append(button, conversationButton);
    container.insertBefore(control, row);
    refreshButton = button;
    conversationRefreshButton = conversationButton;
    updateRefreshButton();
  };

  const syncDom = () => {
    domSyncScheduled = false;
    ensureRefreshButton();
    const anchors = pageWindow.document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]');
    for (const anchor of anchors) {
      const id = conversationIdFromAnchor(pageWindow, anchor);
      const snapshot = id ? snapshots.get(id) : undefined;
      if (!snapshot) continue;
      const titleElement = findSidebarTitleElement(pageWindow, anchor);
      if (titleElement && typeof snapshot.title === "string" && snapshot.title.trim()) {
        if (titleElement.textContent?.trim() !== snapshot.title.trim()) {
          titleElement.textContent = snapshot.title.trim();
        }
        anchor.dataset.chatgptServerTitle = snapshot.title.trim();
      }

      const existing = anchor.querySelector<HTMLElement>(
        '[data-chatgpt-sidebar-sync-status="true"]',
      );
      if (!isActiveAsyncStatus(snapshot.async_status)) {
        existing?.remove();
        anchor.dataset.chatgptAsyncActive = "false";
        continue;
      }
      anchor.dataset.chatgptAsyncActive = "true";
      if (existing || !titleElement) continue;
      const badge = pageWindow.document.createElement("span");
      badge.dataset.chatgptSidebarSyncStatus = "true";
      badge.textContent = "运行中";
      badge.setAttribute("aria-label", "此会话仍在运行");
      badge.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "flex:0 0 auto",
        "margin-left:6px",
        "padding:1px 5px",
        "border:1px solid currentColor",
        "border-radius:999px",
        "font-size:10px",
        "line-height:1.4",
        "opacity:.75",
      ].join(";");
      titleElement.insertAdjacentElement("afterend", badge);
    }
  };

  const scheduleDomSync = () => {
    if (domSyncScheduled) return;
    domSyncScheduled = true;
    pageWindow.requestAnimationFrame(syncDom);
  };

  const ingest = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === "string"
      ? row.id
      : typeof row.conversation_id === "string"
        ? row.conversation_id
        : null;
    if (!id) return;
    const previous = snapshots.get(id);
    snapshots.set(id, {
      id,
      title:
        typeof row.title === "string" || row.title === null
          ? row.title
          : previous?.title,
      update_time: row.update_time ?? previous?.update_time,
      async_status:
        Object.hasOwn(row, "async_status")
          ? row.async_status
          : previous?.async_status,
    });
  };

  const noteConversationStatus = (conversationId: string, value: unknown) => {
    ingest({ conversation_id: conversationId, async_status: value });
    const root = pageWindow.document.documentElement;
    root.dataset.chatgptSidebarStatusSignals = String(
      Number(root.dataset.chatgptSidebarStatusSignals ?? "0") + 1,
    );
    scheduleDomSync();
  };

  const noteRateLimit = (response: Response) => {
    if (response.status !== 429) return;
    probeBackoffUntil = Math.max(
      probeBackoffUntil,
      Date.now() + retryAfterBackoffMs(
        response.headers,
        SIDEBAR_RATE_LIMIT_BACKOFF_MS,
      ),
    );
    const root = pageWindow.document.documentElement;
    root.dataset.chatgptSidebarProbeBackoff = "true";
    root.dataset.chatgptSidebarProbeBackoffUntil = String(probeBackoffUntil);
  };

  const refreshManually = async () => {
    if (refreshing || !requestContext.ready()) return;
    if (Date.now() < probeBackoffUntil) {
      updateRefreshButton("稍后刷新");
      pageWindow.setTimeout(() => updateRefreshButton(), 1_500);
      return;
    }
    refreshing = true;
    updateRefreshButton();
    const root = pageWindow.document.documentElement;
    try {
      const listUrl = new pageWindow.URL("/backend-api/conversations", pageWindow.location.href);
      listUrl.searchParams.set("offset", "0");
      listUrl.searchParams.set("limit", "28");
      listUrl.searchParams.set("order", "updated");
      listUrl.searchParams.set("is_archived", "false");
      listUrl.searchParams.set("is_starred", "false");

      const id = currentConversationId(pageWindow);
      const listIds = new Set<string>();
      try {
        const authenticatedInit = requestContext.createInit({
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!authenticatedInit) return;
        const response = await originalFetch(listUrl.href, authenticatedInit);
        noteRateLimit(response);
        if (response.status === 429) return;
        if (response.ok) {
          const payload = await response.json() as { items?: unknown[] };
          for (const item of payload.items ?? []) {
            if (item && typeof item === "object") {
              const itemId = (item as Record<string, unknown>).id;
              if (typeof itemId === "string") listIds.add(itemId);
            }
            ingest(item);
          }
        }
      } catch {
        // A current-conversation detail probe below can still refresh the active row.
      }
      if (id && !listIds.has(id) && Date.now() >= probeBackoffUntil) {
        root.dataset.chatgptSidebarDetailProbeAttempts = String(
          Number(root.dataset.chatgptSidebarDetailProbeAttempts ?? "0") + 1,
        );
        const detailUrl = new pageWindow.URL(
          `/backend-api/conversations/${id}`,
          pageWindow.location.href,
        );
        detailUrl.searchParams.set("num_turns", "1");
        detailUrl.searchParams.set("include_has_versions", "true");
        try {
          const authenticatedInit = requestContext.createInit({
            cache: "no-store",
            headers: { accept: "application/json" },
          });
          if (!authenticatedInit) return;
          const response = await originalFetch(detailUrl.href, authenticatedInit);
          noteRateLimit(response);
          if (response.status === 429) return;
          if (response.ok) {
            const payload = await response.json() as Record<string, unknown>;
            ingest({ ...payload, conversation_id: payload.conversation_id ?? id });
            root.dataset.chatgptSidebarDetailProbeSuccesses = String(
              Number(root.dataset.chatgptSidebarDetailProbeSuccesses ?? "0") + 1,
            );
          }
        } catch {
          // The list result is still useful even if this one row cannot be probed.
        }
      }
      root.dataset.chatgptSidebarFreshnessRefreshes = String(
        Number(root.dataset.chatgptSidebarFreshnessRefreshes ?? "0") + 1,
      );
      scheduleDomSync();
    } catch (error) {
      console.debug(`[${SCRIPT_NAME}] Sidebar freshness refresh skipped`, error);
    } finally {
      refreshing = false;
      updateRefreshButton("已刷新");
      pageWindow.setTimeout(() => updateRefreshButton(), 900);
    }
  };

  const observer = new pageWindow.MutationObserver(scheduleDomSync);
  const observeTarget = pageWindow.document.body ?? pageWindow.document.documentElement;
  if (observeTarget) observer.observe(observeTarget, { childList: true, subtree: true });
  scheduleDomSync();

  return {
    requestContextChanged: () => {
      updateRefreshButton();
      scheduleDomSync();
    },
    noteConversationStatus,
  };
}

interface OutgoingMessageProbe {
  conversationId: string | null;
  messageId: string | null;
  text: string | null;
  hasUserMessage: boolean;
}

function textFromOutgoingMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  const content = value.content;
  if (!content || typeof content !== "object") return null;
  const parts = (content as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.filter((part): part is string => typeof part === "string").join("\n");
  return text || null;
}

function inspectOutgoingBody(body: BodyInit | null | undefined): OutgoingMessageProbe {
  const empty = {
    conversationId: null,
    messageId: null,
    text: null,
    hasUserMessage: false,
  };
  if (typeof body !== "string") return empty;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const message = [...messages].reverse().find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const author = (candidate as Record<string, unknown>).author;
      return Boolean(
        author &&
        typeof author === "object" &&
        (author as Record<string, unknown>).role === "user",
      );
    }) as Record<string, unknown> | undefined;
    return {
      conversationId:
        typeof parsed.conversation_id === "string" ? parsed.conversation_id : null,
      messageId: typeof message?.id === "string" ? message.id : null,
      text: textFromOutgoingMessage(message),
      hasUserMessage: Boolean(message),
    };
  } catch {
    try {
      const params = new URLSearchParams(body);
      const messageId = params.get("message_id");
      const text = params.get("text") ?? params.get("prompt");
      return {
        conversationId: params.get("conversation_id"),
        messageId,
        text,
        hasUserMessage: Boolean(messageId || text?.trim()),
      };
    } catch {
      return empty;
    }
  }
}

function installDeliveryVerifier(
  pageWindow: Window & typeof globalThis,
): {
  begin: (probe: OutgoingMessageProbe) => void;
  accepted: (probe: OutgoingMessageProbe) => void;
  failed: (probe: OutgoingMessageProbe, message: string) => void;
} {
  let sequence = 0;
  let hideTimer: number | undefined;
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  type DeliveryStage = "sending" | "verifying" | "sent" | "saved" | "failed";
  interface DeliveryVisualState {
    probe: OutgoingMessageProbe;
    stage: DeliveryStage;
    label: string;
    title: string;
    copy: boolean;
  }
  let visualState: DeliveryVisualState | null = null;

  const ensureStyles = () => {
    const id = "chatgpt-delivery-status-style";
    if (pageWindow.document.getElementById(id)) return;
    const style = pageWindow.document.createElement("style");
    style.id = id;
    style.textContent = `
@keyframes chatgptDeliverySpin { to { transform: rotate(360deg); } }
[data-chatgpt-delivery-status="true"] {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  min-height: 16px;
  font: 500 11px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  color: var(--text-secondary, currentColor);
  opacity: .72;
}
[data-chatgpt-delivery-status="true"] .chatgpt-delivery-spinner {
  width: 11px;
  height: 11px;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 999px;
  animation: chatgptDeliverySpin .75s linear infinite;
}
[data-chatgpt-delivery-status="true"] button {
  margin-left: 3px;
  padding: 1px 5px;
  border: 1px solid currentColor;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}`;
    (pageWindow.document.head ?? pageWindow.document.documentElement).append(style);
  };

  const findMessageElement = (probe: OutgoingMessageProbe): HTMLElement | null => {
    const userMessages = [
      ...pageWindow.document.querySelectorAll<HTMLElement>(
        '[data-message-author-role="user"]',
      ),
    ];
    if (probe.messageId) {
      const exact = userMessages.find(
        (element) => element.getAttribute("data-message-id") === probe.messageId,
      );
      if (exact) return exact;
    }
    if (!probe.text) return null;
    const expected = normalize(probe.text);
    if (!expected) return null;
    for (let index = userMessages.length - 1; index >= 0; index -= 1) {
      const text = normalize(userMessages[index].textContent ?? "");
      if (text === expected || text.includes(expected)) return userMessages[index];
    }
    return null;
  };

  const turnContainerFor = (message: HTMLElement): HTMLElement => {
    return (
      message.closest<HTMLElement>('[data-turn="user"], [data-testid^="conversation-turn-"]') ??
      message
    );
  };

  const renderVisualState = () => {
    const state = visualState;
    if (!state) return;
    const message = findMessageElement(state.probe);
    if (!message) return;
    ensureStyles();
    let host = message.querySelector<HTMLElement>(
      '[data-chatgpt-delivery-status="true"]',
    );
    if (!host) {
      host = pageWindow.document.createElement("div");
      host.dataset.chatgptDeliveryStatus = "true";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      message.append(host);
    }
    if (
      host.dataset.chatgptDeliveryStage === state.stage &&
      host.dataset.chatgptDeliveryLabel === state.label
    ) {
      return;
    }
    host.dataset.chatgptDeliveryStage = state.stage;
    host.dataset.chatgptDeliveryLabel = state.label;
    host.title = state.title;
    host.replaceChildren();

    const icon = pageWindow.document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    if (state.stage === "sending" || state.stage === "verifying") {
      icon.className = "chatgpt-delivery-spinner";
    } else {
      icon.textContent = state.stage === "saved" || state.stage === "sent" ? "✓" : "!";
      icon.style.cssText = "font-weight:700;line-height:1";
    }
    const label = pageWindow.document.createElement("span");
    label.textContent = state.label;
    host.append(icon, label);

    if (state.copy && state.probe.text) {
      const button = pageWindow.document.createElement("button");
      button.type = "button";
      button.textContent = "复制原消息";
      button.addEventListener("click", () => {
        void pageWindow.navigator.clipboard?.writeText(state.probe.text ?? "");
      });
      host.append(button);
    }
  };

  const setVisualState = (
    probe: OutgoingMessageProbe,
    stage: DeliveryStage,
    label: string,
    title: string,
    copy = false,
    autoHideMs = 0,
  ) => {
    if (hideTimer != null) {
      pageWindow.clearTimeout(hideTimer);
      hideTimer = undefined;
    }
    visualState = { probe, stage, label, title, copy };
    renderVisualState();
    if (autoHideMs > 0) {
      const expectedMessageId = probe.messageId;
      hideTimer = pageWindow.setTimeout(() => {
        const current = visualState;
        if (!current || current.probe.messageId !== expectedMessageId) return;
        const message = findMessageElement(current.probe);
        message
          ?.querySelector<HTMLElement>('[data-chatgpt-delivery-status="true"]')
          ?.remove();
        visualState = null;
      }, autoHideMs);
    }
  };

  const hasAssistantResponseAfter = (probe: OutgoingMessageProbe): boolean => {
    const message = findMessageElement(probe);
    if (!message) return false;
    const anchor = turnContainerFor(message);
    const assistants = pageWindow.document.querySelectorAll<HTMLElement>(
      '[data-turn="assistant"], .agent-turn, [data-message-author-role="assistant"]',
    );
    for (const assistant of assistants) {
      if (anchor.contains(assistant)) continue;
      if (
        (anchor.compareDocumentPosition(assistant) &
          pageWindow.Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      ) {
        return true;
      }
    }
    return false;
  };

  const confirmFromAssistantResponse = (
    probe: OutgoingMessageProbe,
    token: number,
  ): boolean => {
    if (token !== sequence || !hasAssistantResponseAfter(probe)) return false;
    const root = pageWindow.document.documentElement;
    root.dataset.chatgptLastSendVerified = "true";
    if (root.dataset.chatgptLastSendEvidence !== "assistant-turn") {
      root.dataset.chatgptLastSendEvidence = "assistant-turn";
      setVisualState(
        probe,
        "sent",
        "已发送",
        "AI 已开始回复，这条消息已成功发送",
        false,
        2_500,
      );
    }
    return true;
  };

  const domObserver = new pageWindow.MutationObserver(() => {
    renderVisualState();
    const state = visualState;
    if (
      state &&
      (state.stage === "sending" ||
        state.stage === "verifying" ||
        state.stage === "sent")
    ) {
      confirmFromAssistantResponse(state.probe, sequence);
    }
  });
  const observeTarget = pageWindow.document.body ?? pageWindow.document.documentElement;
  if (observeTarget) {
    domObserver.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-turn", "data-message-author-role"],
    });
  }

  return {
    begin: (probe) => {
      if (!probe.hasUserMessage) return;
      sequence += 1;
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptLastSendVerified = "pending";
      root.dataset.chatgptLastSendEvidence = "request-started";
      root.dataset.chatgptDeliveryTrackedSends = String(
        Number(root.dataset.chatgptDeliveryTrackedSends ?? "0") + 1,
      );
      setVisualState(probe, "sending", "发送中", "正在发送消息");
    },
    accepted: (probe) => {
      if (!probe.hasUserMessage) return;
      const token = sequence;
      const root = pageWindow.document.documentElement;
      root.dataset.chatgptLastSendVerified = "true";
      root.dataset.chatgptLastSendEvidence = "http-accepted";
      setVisualState(
        probe,
        "sent",
        "已发送",
        "发送请求已被服务器接受",
        false,
        2_500,
      );
      confirmFromAssistantResponse(probe, token);
    },
    failed: (probe, message) => {
      if (!probe.hasUserMessage) return;
      sequence += 1;
      pageWindow.document.documentElement.dataset.chatgptLastSendVerified = "false";
      setVisualState(
        probe,
        "failed",
        "发送失败",
        `发送失败：${message}`,
        Boolean(probe.text),
      );
    },
  };
}

function addVirtualizationCss(pageWindow: Window & typeof globalThis): void {
  const id = "chatgpt-performance-fix-style";
  if (pageWindow.document.getElementById(id)) return;

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


const staticCodeBlocks = new Map<string, StaticCodeBlock>();
const staticCodeHydrated = new WeakSet<Element>();
const staticCodeFillQueue: Array<{
  block: StaticCodeBlock;
  container: HTMLElement;
  code: HTMLElement;
  copy: HTMLButtonElement;
}> = [];
let staticCodeFillHandle: number | null = null;
let staticCodeHydratorInstalled = false;

function scheduleStaticCodeFill(pageWindow: Window & typeof globalThis): void {
  if (staticCodeFillHandle != null) return;
  const drain = (deadline?: IdleDeadline) => {
    staticCodeFillHandle = null;
    let filled = 0;
    while (staticCodeFillQueue.length > 0 && filled < 2) {
      if (deadline && deadline.timeRemaining() < 8) break;
      const item = staticCodeFillQueue.shift()!;
      if (!item.container.isConnected) continue;
      item.code.textContent = item.block.code;
      item.copy.disabled = false;
      item.container.dataset.chatgptStaticCodeState = "ready";
      filled += 1;
    }
    if (staticCodeFillQueue.length > 0) scheduleStaticCodeFill(pageWindow);
  };
  if (typeof pageWindow.requestIdleCallback === "function") {
    staticCodeFillHandle = pageWindow.requestIdleCallback(drain);
  } else {
    staticCodeFillHandle = pageWindow.requestAnimationFrame(() => drain());
  }
}

function staticCodeToken(anchor: HTMLAnchorElement): string | null {
  try {
    const url = new URL(anchor.href);
    if (url.origin !== "https://chatgpt.com") return null;
    const params = new URLSearchParams(url.hash.slice(1));
    return params.get("cgptperf-code");
  } catch {
    return null;
  }
}

const STATIC_CODE_MARKER_RE =
  /\[代码块\]\(https:\/\/chatgpt\.com\/#cgptperf-code=([^&\s)]+)&lines=\d+\)/g;

function restoreStaticCodeMarkdown(text: string): string {
  if (!text.includes("#cgptperf-code=")) return text;
  return text.replace(STATIC_CODE_MARKER_RE, (full, token: string) => {
    const block = staticCodeBlocks.get(token);
    if (!block) return full;
    const fence = block.code.includes("```") ? "````" : "```";
    const language = block.language ? block.language : "";
    return `${fence}${language}\n${block.code}\n${fence}`;
  });
}

function restoreStaticCodeTextarea(
  pageWindow: Window & typeof globalThis,
  textarea: HTMLTextAreaElement,
): void {
  if (!textarea.value.includes("#cgptperf-code=")) return;
  const restored = restoreStaticCodeMarkdown(textarea.value);
  if (restored === textarea.value) return;
  const setter = Object.getOwnPropertyDescriptor(
    pageWindow.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, restored);
  textarea.dispatchEvent(
    new pageWindow.InputEvent("input", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: null,
    }),
  );
}

function restoreStaticCodeRequestInit(init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== "string" || !init.body.includes("#cgptperf-code=")) {
    return init;
  }
  const body = restoreStaticCodeMarkdown(init.body);
  return body === init.body ? init : { ...init, body };
}

function hydrateStaticCodeAnchor(
  pageWindow: Window & typeof globalThis,
  anchor: HTMLAnchorElement,
): void {
  if (staticCodeHydrated.has(anchor)) return;
  const token = staticCodeToken(anchor);
  const block = token ? staticCodeBlocks.get(token) : undefined;
  if (!token || !block) return;
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
      pageWindow.setTimeout(() => (copy.textContent = "复制"), 1_200);
    } catch {
      copy.textContent = "复制失败";
      pageWindow.setTimeout(() => (copy.textContent = "复制"), 1_200);
    }
  });
  actions.append(expand, copy);
  header.append(label, actions);

  const pre = pageWindow.document.createElement("pre");
  const code = pageWindow.document.createElement("code");
  code.textContent = "";
  pre.append(code);
  container.append(header, pre);

  const replaceTarget =
    anchor.parentElement?.tagName === "P" && anchor.parentElement.childNodes.length === 1
      ? anchor.parentElement
      : anchor;
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

function scanStaticCodeMarkers(
  pageWindow: Window & typeof globalThis,
  node: Node,
): void {
  if (!(node instanceof pageWindow.Element)) return;
  const messageScope =
    node.matches('[data-message-id]') || node.closest('[data-message-id]')
      ? node
      : node.querySelector('[data-message-id]');
  if (!messageScope) return;
  if (node instanceof pageWindow.HTMLTextAreaElement) {
    restoreStaticCodeTextarea(pageWindow, node);
  }
  if (node instanceof pageWindow.HTMLAnchorElement) {
    hydrateStaticCodeAnchor(pageWindow, node);
  }
  for (const textarea of node.querySelectorAll<HTMLTextAreaElement>("textarea")) {
    restoreStaticCodeTextarea(pageWindow, textarea);
  }
  for (const anchor of node.querySelectorAll<HTMLAnchorElement>(
    'a[href^="https://chatgpt.com/#cgptperf-code="]',
  )) {
    hydrateStaticCodeAnchor(pageWindow, anchor);
  }
}

function installStaticCodeHydrator(
  pageWindow: Window & typeof globalThis,
): void {
  if (staticCodeHydratorInstalled) return;
  staticCodeHydratorInstalled = true;
  const root = pageWindow.document.documentElement;
  if (!root) return;
  scanStaticCodeMarkers(pageWindow, root);
  const observer = new pageWindow.MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) scanStaticCodeMarkers(pageWindow, node);
    }
  });
  observer.observe(root, { childList: true, subtree: true });
}

function registerStaticCodeBlocks(
  pageWindow: Window & typeof globalThis,
  blocks: StaticCodeBlock[] | undefined,
): void {
  if (!blocks?.length) return;
  for (const block of blocks) staticCodeBlocks.set(block.token, block);
  while (staticCodeBlocks.size > 1_024) {
    const oldest = staticCodeBlocks.keys().next().value;
    if (typeof oldest !== "string") break;
    staticCodeBlocks.delete(oldest);
  }
  installStaticCodeHydrator(pageWindow);
  scanStaticCodeMarkers(pageWindow, pageWindow.document.documentElement);
}

function installRichTextPerformanceFix(
  pageWindow: Window & typeof globalThis,
  warmDistancePx: number,
  editorWarmDistancePx: number,
): void {
  const marker = "__chatgptRichTextPerformanceFixInstalled";
  if (Reflect.get(pageWindow, marker)) return;
  Reflect.set(pageWindow, marker, true);

  const smoothedMarkdownSourceHints = new Set<string>(["/2afb55f3-"]);

  // SmoothedMarkdown uses document.visibilityState only to decide whether to synthesize its
  // 16ms character-by-character markdown reparse loop. Return "hidden" only to
  // that module so it takes its own fast path and renders the current full text.
  try {
    let visibilityOwner: object | null = pageWindow.Document?.prototype ?? null;
    let visibilityDescriptor: PropertyDescriptor | undefined;
    while (visibilityOwner) {
      visibilityDescriptor = Object.getOwnPropertyDescriptor(
        visibilityOwner,
        "visibilityState",
      );
      if (visibilityDescriptor) break;
      visibilityOwner = Object.getPrototypeOf(visibilityOwner) as object | null;
    }
    const nativeVisibilityGet = visibilityDescriptor?.get;
    if (
      visibilityOwner &&
      nativeVisibilityGet &&
      visibilityDescriptor?.configurable !== false
    ) {
      Object.defineProperty(visibilityOwner, "visibilityState", {
        configurable: true,
        enumerable: visibilityDescriptor.enumerable ?? true,
        get() {
          const actual = nativeVisibilityGet.call(this) as DocumentVisibilityState;
          if (this === pageWindow.document && actual !== "hidden") {
            const stack = new Error().stack ?? "";
            if (
              [...smoothedMarkdownSourceHints].some((hint) => stack.includes(hint))
            ) {
              pageWindow.document.documentElement.dataset.chatgptSmoothedMarkdownBypass =
                "enabled";
              return "hidden";
            }
          }
          return actual;
        },
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
  if (typeof NativeResizeObserver !== "function") return;

  const isSmoothedCodeMeasurement = (target: Element): boolean => {
    if (!(target instanceof pageWindow.Element)) return false;
    if (target.tagName !== "SPAN" || !target.classList.contains("block")) {
      return false;
    }
    const clip = target.parentElement;
    return Boolean(
      clip &&
        Array.from(clip.classList).some((name) => name.includes("ClipText")) &&
        clip.closest('[class*="SmoothedCodeBlock"]'),
    );
  };

  class RichTextResizeObserver implements ResizeObserver {
    private readonly native: ResizeObserver;
    private readonly skipped = new Set<Element>();
    private readonly deferredCodeMirrorTargets = new Map<
      Element,
      MutationObserver
    >();

    constructor(callback: ResizeObserverCallback) {
      this.native = new NativeResizeObserver((entries) => callback(entries, this));
    }

    observe(target: Element, options?: ResizeObserverOptions): void {
      if (isSmoothedCodeMeasurement(target)) {
        this.skipped.add(target);
        const stack = new Error().stack ?? "";
        for (const match of stack.matchAll(
          /https:\/\/[^/]+\/(?:cdn\/)?assets\/([^/:]+\.js)/g,
        )) {
          const filename = match[1];
          if (!filename || filename.includes("performance-fix")) continue;
          const hint = `/${filename.split("-")[0]}-`;
          smoothedMarkdownSourceHints.add(hint);
        }
        const root = pageWindow.document.documentElement;
        root.dataset.chatgptSmoothedMarkdownSourceCount = String(
          smoothedMarkdownSourceHints.size,
        );
        const count = Number(root.dataset.chatgptRichTextSkippedResizeObservers ?? "0");
        root.dataset.chatgptRichTextSkippedResizeObservers = String(count + 1);
        return;
      }

      const container = findConversationCodeMirrorContainer(pageWindow, target);
      if (
        container &&
        container.getAttribute("data-chatgpt-rich-editor-state") !== "hot"
      ) {
        if (this.deferredCodeMirrorTargets.has(target)) return;
        const attributeObserver = new pageWindow.MutationObserver(() => {
          if (
            container.getAttribute("data-chatgpt-rich-editor-state") !== "hot"
          ) {
            return;
          }
          attributeObserver.disconnect();
          this.deferredCodeMirrorTargets.delete(target);
          this.native.observe(target, options);
          const root = pageWindow.document.documentElement;
          const count = Number(root.dataset.chatgptCodeMirrorRoResumed ?? "0");
          root.dataset.chatgptCodeMirrorRoResumed = String(count + 1);
        });
        attributeObserver.observe(container, {
          attributes: true,
          attributeFilter: ["data-chatgpt-rich-editor-state"],
        });
        this.deferredCodeMirrorTargets.set(target, attributeObserver);
        const root = pageWindow.document.documentElement;
        const count = Number(root.dataset.chatgptCodeMirrorRoDeferred ?? "0");
        root.dataset.chatgptCodeMirrorRoDeferred = String(count + 1);
        return;
      }
      this.native.observe(target, options);
    }

    unobserve(target: Element): void {
      if (this.skipped.delete(target)) return;
      this.deferredCodeMirrorTargets.get(target)?.disconnect();
      this.deferredCodeMirrorTargets.delete(target);
      this.native.unobserve(target);
    }

    disconnect(): void {
      this.skipped.clear();
      for (const observer of this.deferredCodeMirrorTargets.values()) {
        observer.disconnect();
      }
      this.deferredCodeMirrorTargets.clear();
      this.native.disconnect();
    }
  }

  try {
    Object.setPrototypeOf(
      RichTextResizeObserver.prototype,
      NativeResizeObserver.prototype,
    );
    Object.setPrototypeOf(RichTextResizeObserver, NativeResizeObserver);
    Object.defineProperty(RichTextResizeObserver, "name", {
      value: "ResizeObserver",
    });
    Object.defineProperty(pageWindow, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: RichTextResizeObserver,
    });
    pageWindow.document.documentElement.dataset.chatgptRichTextPerformanceFix =
      "enabled";
  } catch (error) {
    console.warn(`[${SCRIPT_NAME}] Could not tune rich-text rendering`, error);
  }

  const isConversationCodeEditor = (element: Element): boolean =>
    Array.from(element.classList).some((name) => name.includes("_codemirror")) &&
    Boolean(
      element.closest(
        '[data-message-id], .markdown, [class*="MarkdownContent"], [class*="SmoothedMarkdown"]',
      ),
    );

  const RICH_BLOCK_SELECTOR = [
    '[class*="SmoothedCodeBlock"]',
    '.markdown table',
    '[class*="MarkdownContent"] table',
    '.katex-display',
    '[data-code-block-preview-pane]',
  ].join(',');

  const isRichBlock = (element: Element): boolean =>
    element.matches(RICH_BLOCK_SELECTOR) &&
    Boolean(
      element.closest(
        '[data-message-id], .markdown, [class*="MarkdownContent"], [class*="SmoothedMarkdown"]',
      ),
    );

  const intrinsicSizeFor = (element: Element): number => {
    if (Array.from(element.classList).some((name) => name.includes("SmoothedCodeBlock"))) {
      return 220;
    }
    if (element.matches('table')) return 240;
    if (element.matches('.katex-display')) return 96;
    if (element.matches('[data-code-block-preview-pane]')) return 360;
    return 180;
  };

  interface RichActivation {
    element: Element;
    attribute: "data-chatgpt-rich-editor-state" | "data-chatgpt-rich-block-state";
    metric: "chatgptRichTextEditorsActivated" | "chatgptRichTextBlocksActivated";
    distance?: number;
  }

  const activationQueue: RichActivation[] = [];
  const queued = new WeakSet<Element>();
  const coldElements = new Set<Element>();
  let activationFrame: number | null = null;
  let warmScanFrame: number | null = null;

  const incrementMetric = (name: string): void => {
    const root = pageWindow.document.documentElement;
    const current = Number(root.dataset[name] ?? "0");
    root.dataset[name] = String(current + 1);
  };

  const activate = (item: RichActivation): void => {
    if (!item.element.isConnected) {
      coldElements.delete(item.element);
      return;
    }
    if (item.element.getAttribute(item.attribute) === "hot") return;
    item.element.setAttribute(item.attribute, "hot");
    coldElements.delete(item.element);
    incrementMetric(item.metric);
  };

  const drainActivationQueue = () => {
    activationFrame = null;
    let editorsActivated = 0;
    let blocksActivated = 0;
    for (let index = 0; index < activationQueue.length;) {
      const item = activationQueue[index];
      const isEditor = item.attribute === "data-chatgpt-rich-editor-state";
      const allowed = isEditor ? editorsActivated < 1 : blocksActivated < 3;
      if (!allowed) {
        index += 1;
        continue;
      }
      activationQueue.splice(index, 1);
      activate(item);
      if (isEditor) editorsActivated += 1;
      else blocksActivated += 1;
      if (editorsActivated >= 1 && blocksActivated >= 3) break;
    }
    if (activationQueue.length > 0) {
      activationFrame = pageWindow.requestAnimationFrame(drainActivationQueue);
    }
  };

  const enqueueActivation = (item: RichActivation, distance = Number.POSITIVE_INFINITY) => {
    if (item.element.getAttribute(item.attribute) === "hot") return;
    if (queued.has(item.element)) return;
    queued.add(item.element);
    activationQueue.push({ ...item, distance });
    activationQueue.sort(
      (left, right) =>
        (left.distance ?? Number.POSITIVE_INFINITY) -
        (right.distance ?? Number.POSITIVE_INFINITY),
    );
    if (activationFrame == null) {
      activationFrame = pageWindow.requestAnimationFrame(drainActivationQueue);
    }
  };

  const activationFor = (element: Element): RichActivation | null => {
    if (isConversationCodeEditor(element)) {
      return {
        element,
        attribute: "data-chatgpt-rich-editor-state",
        metric: "chatgptRichTextEditorsActivated",
      };
    }
    if (isRichBlock(element)) {
      return {
        element,
        attribute: "data-chatgpt-rich-block-state",
        metric: "chatgptRichTextBlocksActivated",
      };
    }
    return null;
  };

  const effectiveWarmDistance = Math.max(1_500, Math.floor(warmDistancePx));
  const effectiveEditorWarmDistance = Math.max(
    800,
    Math.floor(editorWarmDistancePx),
  );

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
      const itemWarmDistance =
        item.attribute === "data-chatgpt-rich-editor-state"
          ? effectiveEditorWarmDistance
          : effectiveWarmDistance;
      if (
        rect.bottom < -itemWarmDistance ||
        rect.top > pageWindow.innerHeight + itemWarmDistance
      ) {
        continue;
      }
      const visibleNow = rect.bottom >= 0 && rect.top <= pageWindow.innerHeight;
      if (visibleNow) {
        activate(item);
      } else {
        const distance =
          rect.top > pageWindow.innerHeight
            ? rect.top - pageWindow.innerHeight
            : Math.max(0, -rect.bottom);
        enqueueActivation(item, distance);
      }
    }
  };

  const scheduleWarmScan = () => {
    if (warmScanFrame != null) return;
    warmScanFrame = pageWindow.requestAnimationFrame(scanWarmDistance);
  };

  const registerHeavyElement = (element: Element) => {
    const item = activationFor(element);
    if (!item || element.hasAttribute(item.attribute)) return;
    const size = intrinsicSizeFor(element);
    (element as HTMLElement).style.setProperty(
      "--chatgpt-rich-intrinsic-size",
      `${size}px`,
    );
    element.setAttribute(item.attribute, "cold");
    coldElements.add(element);
    if (item.attribute === "data-chatgpt-rich-editor-state") {
      incrementMetric("chatgptRichTextEditorsCold");
    } else {
      incrementMetric("chatgptRichTextBlocksCold");
    }
    scheduleWarmScan();
  };

  const scanForHeavyElements = (node: Node) => {
    if (!(node instanceof pageWindow.Element)) return;
    registerHeavyElement(node);
    for (const element of node.querySelectorAll(
      `${RICH_BLOCK_SELECTOR},[class*="_codemirror"]`,
    )) {
      registerHeavyElement(element);
    }
  };

  const root = pageWindow.document.documentElement;
  if (root) {
    root.dataset.chatgptRichTextWarmDistancePx = String(effectiveWarmDistance);
    root.dataset.chatgptCodeEditorWarmDistancePx = String(
      effectiveEditorWarmDistance,
    );
    scanForHeavyElements(root);
    pageWindow.addEventListener("scroll", scheduleWarmScan, {
      capture: true,
      passive: true,
    });
    pageWindow.addEventListener("resize", scheduleWarmScan, { passive: true });
    const mutationObserver = new pageWindow.MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) scanForHeavyElements(added);
      }
      scheduleWarmScan();
    });
    mutationObserver.observe(root, { childList: true, subtree: true });
    scheduleWarmScan();
  }
}

function showOptimizationToast(
  pageWindow: Window & typeof globalThis,
  message: string,
  onLoadFull: () => void,
): void {
  const id = "chatgpt-performance-fix-toast";
  const render = () => {
    if (!pageWindow.document.body || pageWindow.document.getElementById(id)) return;

    const host = pageWindow.document.createElement("div");
    host.id = id;
    host.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
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
      "backdrop-filter:blur(12px)",
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
      "cursor:pointer",
    ].join(";");
    button.addEventListener("click", onLoadFull);

    panel.append(text, button);
    shadow.append(panel);
    pageWindow.document.body.append(host);
    pageWindow.setTimeout(() => host.remove(), 8_000);
  };

  if (pageWindow.document.body) render();
  else pageWindow.document.addEventListener("DOMContentLoaded", render, { once: true });
}

function cloneMaterializedResponse(
  pageWindow: Window & typeof globalThis,
  response: MaterializedResponse,
): Response {
  const clone = new pageWindow.Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  // A constructed Response otherwise has an empty URL and default type. Preserve
  // observable fetch metadata because application wrappers may inspect it.
  for (const [key, value] of [
    ["url", response.url],
    ["redirected", response.redirected],
    ["type", response.type],
  ] as const) {
    try {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: false,
        value,
      });
    } catch {
      // The body and status remain valid even if a browser locks these fields.
    }
  }

  return clone;
}

async function readResponseText(response: Response): Promise<string> {
  INTERNAL_RESPONSE_READS.add(response);
  try {
    return await response.text();
  } finally {
    INTERNAL_RESPONSE_READS.delete(response);
  }
}

interface LegacyResponseFallbackValue {
  body: string;
  payload: Record<string, unknown>;
  fingerprint: string;
  stats?: OptimizationStats;
}

async function fingerprintResponseBody(
  pageWindow: Window & typeof globalThis,
  body: string,
): Promise<string> {
  try {
    const encoded = new pageWindow.TextEncoder().encode(body);
    const digest = await pageWindow.crypto.subtle.digest("SHA-256", encoded);
    return `${body.length}:${Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")}`;
  } catch {
    // The body length plus stable server fields is enough for a conservative
    // fallback when SubtleCrypto is unavailable.
    const updateTime = body.match(/"update_time"\s*:\s*([^,}\n]+)/)?.[1] ?? "";
    const currentNode = body.match(/"current_node"\s*:\s*"([^"]+)"/)?.[1] ?? "";
    return `${body.length}:${updateTime}:${currentNode}:${body.slice(-256)}`;
  }
}

function cloneJsonPayload<T>(
  pageWindow: Window & typeof globalThis,
  payload: T,
  body: string,
): T {
  try {
    return pageWindow.structuredClone(payload);
  } catch {
    return JSON.parse(body) as T;
  }
}

function installLegacyResponseFallback(
  pageWindow: Window & typeof globalThis,
  mode: Exclude<Mode, "off">,
): { clear: () => void } {
  const marker = "__chatgptPerformanceFixResponseFallback";
  const existing = Reflect.get(pageWindow, marker) as
    | { clear?: () => void }
    | undefined;
  if (existing?.clear) return { clear: existing.clear };

  const prototype = pageWindow.Response?.prototype;
  if (!prototype) return { clear: () => undefined };

  const nativeJson = prototype.json;
  const nativeText = prototype.text;
  const perResponse = new WeakMap<Response, Promise<LegacyResponseFallbackValue>>();
  const byUrl = new Map<string, LegacyResponseFallbackValue>();

  const incrementMetric = (name: string): void => {
    const root = pageWindow.document.documentElement;
    const current = Number(root.dataset[name] ?? "0");
    root.dataset[name] = String(current + 1);
  };

  const shouldHandle = (response: Response): boolean => {
    if (INTERNAL_RESPONSE_READS.has(response) || !response.ok || response.bodyUsed) {
      return false;
    }
    const match = matchConversationApiUrl(response.url, pageWindow.location.href);
    if (match?.kind !== "legacy-full") return false;
    try {
      const url = new pageWindow.URL(response.url, pageWindow.location.href);
      return !["1", "true"].includes(
        url.searchParams.get("include_full_conversation") ?? "",
      );
    } catch {
      return false;
    }
  };

  const process = (response: Response): Promise<LegacyResponseFallbackValue> => {
    const previous = perResponse.get(response);
    if (previous) return previous;

    const task = (async () => {
      const originalBody = await nativeText.call(response);
      const fingerprint = await fingerprintResponseBody(pageWindow, originalBody);
      const cached = byUrl.get(response.url);
      if (cached?.fingerprint === fingerprint) {
        incrementMetric("chatgptLegacyFallbackCacheHits");
        return cached;
      }

      let parsed = JSON.parse(originalBody) as Record<string, unknown>;
      let body = originalBody;
      let stats: OptimizationStats | undefined;
      try {
        const result = optimizeConversationPayload(
          parsed,
          legacyOptimizerOptions(mode),
        );
        stats = result.stats;
        if (result.stats.changed) {
          parsed = result.payload;
          body = JSON.stringify(result.payload);
          incrementMetric("chatgptLegacyFallbackOptimized");
          const root = pageWindow.document.documentElement;
          root.dataset.chatgptLegacyFallbackOriginalNodes = String(
            result.stats.originalNodes,
          );
          root.dataset.chatgptLegacyFallbackKeptNodes = String(
            result.stats.keptNodes,
          );
          root.dataset.chatgptPerformanceFix = "large";
        }
      } catch (error) {
        console.warn(`[${SCRIPT_NAME}] Legacy response fallback failed`, error);
      }

      const value = { body, payload: parsed, fingerprint, stats };
      byUrl.set(response.url, value);
      while (byUrl.size > 8) {
        const oldest = byUrl.keys().next().value;
        if (typeof oldest !== "string") break;
        byUrl.delete(oldest);
      }
      return value;
    })();
    perResponse.set(response, task);
    return task;
  };

  const patchedJson = function (this: Response): Promise<unknown> {
    if (!shouldHandle(this)) return nativeJson.call(this);
    return process(this).then((value) =>
      cloneJsonPayload(pageWindow, value.payload, value.body)
    );
  };
  const patchedText = function (this: Response): Promise<string> {
    if (!shouldHandle(this)) return nativeText.call(this);
    return process(this).then((value) => value.body);
  };

  try {
    Object.defineProperty(patchedJson, "name", { value: "json" });
    Object.defineProperty(patchedText, "name", { value: "text" });
    Object.defineProperty(prototype, "json", {
      configurable: true,
      writable: true,
      value: patchedJson,
    });
    Object.defineProperty(prototype, "text", {
      configurable: true,
      writable: true,
      value: patchedText,
    });
  } catch (error) {
    console.warn(`[${SCRIPT_NAME}] Could not install response fallback`, error);
    return { clear: () => undefined };
  }

  const controller = {
    clear: () => {
      byUrl.clear();
    },
  };
  Reflect.set(pageWindow, marker, controller);
  pageWindow.document.documentElement.dataset.chatgptResponseFallback = "enabled";
  return controller;
}

async function materializeAndOptimize(
  pageWindow: Window & typeof globalThis,
  response: Response,
  mode: Exclude<Mode, "off">,
  exposedUrl: string = response.url,
): Promise<MaterializedResponse> {
  const originalBody = await readResponseText(response);
  let body = originalBody;
  let optimized = false;
  let cacheable = false;
  let activeConversation: boolean | undefined;
  let stats: OptimizationStats | undefined;

  if (response.ok) {
    try {
      const result = await optimizeLegacyOffMain(
        pageWindow,
        originalBody,
        MODE_OPTIONS[mode],
      );
      stats = result.stats;
      activeConversation = !isIdleConversation(result.payload);
      if (result.stats.changed) {
        body = JSON.stringify(result.payload);
        optimized = true;
        cacheable = !activeConversation;
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
  if (activeConversation != null) {
    headers.set(
      "x-chatgpt-performance-fix-active",
      activeConversation ? "1" : "0",
    );
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
    activeConversation,
    stats,
    apiKind: "legacy-full",
  };
}

async function materializeAndOptimizePaginated(
  pageWindow: Window & typeof globalThis,
  response: Response,
  apiKind: "paginated-initial" | "paginated-messages",
  mode: Exclude<Mode, "off">,
  exposedUrl: string,
  requestWasClamped: boolean,
  createLocalCursor: () => string,
  workerJobToken?: string,
  renderTurns = MODE_OPTIONS[mode].paginatedRenderTurns,
): Promise<MaterializedResponse> {
  const originalBody = await readResponseText(response);
  let body = originalBody;
  let optimized = requestWasClamped;
  let stats: PaginatedOptimizationStats | undefined;
  let optimizedPayload: PaginatedConversationPayload | undefined;
  let cacheable = false;
  let activeConversation: boolean | undefined;
  let localPagePayloads: Array<{ cursor: string; payload: PaginatedConversationPayload }> = [];

  if (response.ok) {
    try {
      const result = workerJobToken
        ? await finishPaginatedWorkerJob(
            pageWindow,
            workerJobToken,
            apiKind,
            mode,
            renderTurns,
          )
        : await optimizePaginatedOffMain(
            pageWindow,
            originalBody,
            apiKind,
            mode,
            renderTurns,
          );
      stats = result.stats;
      cacheable = result.cacheable;
      activeConversation = result.active;
      optimizedPayload = result.payload;
      registerStaticCodeBlocks(pageWindow, result.codeBlocks);
      if (result.stats.changed || workerJobToken) optimized = true;
      const chunksNewestFirst = result.chunks;

      if (chunksNewestFirst.length > 1) {
        const originalPageInfo =
          result.payload.page_info && typeof result.payload.page_info === "object"
            ? { ...result.payload.page_info }
            : { has_previous_page: false, start_cursor: null };
        const localCursors = chunksNewestFirst
          .slice(1)
          .map(() => createLocalCursor());

        optimizedPayload = {
          ...result.payload,
          messages: chunksNewestFirst[0],
          page_info: {
            ...originalPageInfo,
            has_previous_page: true,
            start_cursor: localCursors[0],
          },
        };

        localPagePayloads = chunksNewestFirst.slice(1).map((messages, index) => {
          const hasAnotherLocalPage = index + 1 < localCursors.length;
          return {
            cursor: localCursors[index],
            payload: {
              messages,
              page_info: hasAnotherLocalPage
                ? {
                    ...originalPageInfo,
                    has_previous_page: true,
                    start_cursor: localCursors[index + 1],
                  }
                : originalPageInfo,
              safe_urls: result.payload.safe_urls ?? [],
              blocked_urls: result.payload.blocked_urls ?? [],
            },
          };
        });
        optimized = true;
      }

      if (optimizedPayload) body = JSON.stringify(optimizedPayload);
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Paginated response was not optimized`, error);
    }
  }

  const headers = new pageWindow.Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (stats) {
    headers.set(
      "x-chatgpt-performance-fix-page",
      `${stats.originalMessages}->${stats.keptMessages}`,
    );
  }
  headers.set(
    "x-chatgpt-performance-fix-cacheable",
    cacheable ? "1" : "0",
  );
  if (activeConversation != null) {
    headers.set(
      "x-chatgpt-performance-fix-active",
      activeConversation ? "1" : "0",
    );
  }

  const responseHeaders = [...headers.entries()] as Array<[string, string]>;
  const localPages = localPagePayloads.map(({ cursor, payload }, index) => {
    const localHeaders = new pageWindow.Headers(responseHeaders);
    localHeaders.set(
      "x-chatgpt-performance-fix-local-page",
      `${index + 1}/${localPagePayloads.length}`,
    );
    return {
      cursor,
      response: {
        body: JSON.stringify(payload),
        headers: [...localHeaders.entries()] as Array<[string, string]>,
        status: response.status,
        statusText: response.statusText,
        url: "",
        redirected: false,
        type: response.type,
        optimized: true,
        cacheable: false,
        activeConversation: false,
        apiKind: "paginated-messages" as const,
      },
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
    activeConversation,
    stats,
    apiKind,
    localPages,
  };
}


function requestSignal(
  input: RequestInfo | URL,
  init?: RequestInit,
): AbortSignal | undefined {
  if (init?.signal) return init.signal;
  const signal = (input as unknown as { signal?: unknown })?.signal;
  return signal != null && typeof (signal as { aborted?: unknown }).aborted === "boolean"
    ? (signal as AbortSignal)
    : undefined;
}

async function prepareCompletePaginatedResponse(
  pageWindow: Window & typeof globalThis,
  originalFetch: typeof pageWindow.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  rewrittenUrl: string,
  apiKind: "paginated-initial" | "paginated-messages",
  conversationId: string,
  completeAll = false,
): Promise<PreparedPaginatedResponse> {
  const [firstInput, firstInit] = rewriteGetRequest(
    pageWindow,
    input,
    init,
    rewrittenUrl,
  );
  const firstResponse = await originalFetch(firstInput, firstInit);
  if (!firstResponse.ok) {
    return { response: firstResponse };
  }
  if (!ensureJsonWorker(pageWindow)) {
    return {
      response:
        apiKind === "paginated-messages"
          ? await fetchCompleteHistoryPage(
              pageWindow,
              originalFetch,
              input,
              init,
              rewrittenUrl,
              firstResponse,
            )
          : await fetchCompleteInitialPage(
              pageWindow,
              originalFetch,
              input,
              init,
              rewrittenUrl,
              conversationId,
              completeAll,
              firstResponse,
            ),
    };
  }

  let probe: PaginatedJobProbe | undefined;
  try {
    probe = await startPaginatedWorkerJob(
      pageWindow,
      await firstResponse.clone().arrayBuffer(),
      apiKind === "paginated-messages",
    );
    const seenCursors = new Set<string>();
    for (let attempt = 0; attempt < (completeAll ? 64 : 9); attempt += 1) {
      if (!completeAll && probe.complete) break;
      const cursor = probe.cursor;
      if (!cursor || seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
      const olderUrl =
        apiKind === "paginated-initial"
          ? new pageWindow.URL(
              `/backend-api/conversations/${conversationId}/messages`,
              rewrittenUrl,
            )
          : new pageWindow.URL(rewrittenUrl);
      olderUrl.searchParams.set("before", cursor);
      olderUrl.searchParams.set("include_has_versions", "true");
      olderUrl.searchParams.set(
        "num_turns",
        String(Math.min(512, 2 ** Math.min(9, attempt + 2))),
      );
      const [olderInput, olderInit] = rewriteGetRequest(
        pageWindow,
        input,
        init,
        olderUrl.href,
      );
      const olderResponse = await originalFetch(olderInput, olderInit);
      if (!olderResponse.ok) break;
      probe = await prependPaginatedWorkerJob(
        pageWindow,
        probe.token,
        await olderResponse.arrayBuffer(),
      );
    }
    return { response: firstResponse, workerJobToken: probe.token };
  } catch (error) {
    if (probe?.token) await cancelPaginatedWorkerJob(pageWindow, probe.token);
    console.warn(`[${SCRIPT_NAME}] Worker page assembly fell back`, error);
    return {
      response:
        apiKind === "paginated-messages"
          ? await fetchCompleteHistoryPage(
              pageWindow,
              originalFetch,
              input,
              init,
              rewrittenUrl,
              firstResponse,
            )
          : await fetchCompleteInitialPage(
              pageWindow,
              originalFetch,
              input,
              init,
              rewrittenUrl,
              conversationId,
              completeAll,
              firstResponse,
            ),
    };
  }
}

async function fetchCompleteInitialPage(
  pageWindow: Window & typeof globalThis,
  originalFetch: typeof pageWindow.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  rewrittenUrl: string,
  conversationId: string,
  completeAll = false,
  existingFirstResponse?: Response,
): Promise<Response> {
  const firstResponse = existingFirstResponse ?? await (async () => {
    const [firstInput, firstInit] = rewriteGetRequest(
      pageWindow,
      input,
      init,
      rewrittenUrl,
    );
    return originalFetch(firstInput, firstInit);
  })();
  if (!firstResponse.ok) return firstResponse;

  let payload = await responseJsonOffMain<PaginatedConversationPayload>(
    pageWindow,
    firstResponse.clone(),
  );
  const seenCursors = new Set<string>();
  let combined = false;

  for (let attempt = 0; attempt < (completeAll ? 64 : 9); attempt += 1) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (!completeAll && hasRenderableQuestionAnswerTurn(messages, false)) break;
    const cursor =
      payload.page_info?.has_previous_page === true &&
      typeof payload.page_info.start_cursor === "string"
        ? payload.page_info.start_cursor
        : null;
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);

    const olderUrl = new pageWindow.URL(
      `/backend-api/conversations/${conversationId}/messages`,
      rewrittenUrl,
    );
    olderUrl.searchParams.set("before", cursor);
    olderUrl.searchParams.set("include_has_versions", "true");
    olderUrl.searchParams.set(
      "num_turns",
      String(Math.min(512, 2 ** Math.min(9, attempt + 2))),
    );
    const [olderInput, olderInit] = rewriteGetRequest(
      pageWindow,
      input,
      init,
      olderUrl.href,
    );
    const olderResponse = await originalFetch(olderInput, olderInit);
    if (!olderResponse.ok) break;
    const olderPayload = await responseJsonOffMain<PaginatedConversationPayload>(
      pageWindow,
      olderResponse,
    );
    payload = {
      ...payload,
      messages: mergeChronologicalMessages(
        Array.isArray(olderPayload.messages) ? olderPayload.messages : [],
        messages,
      ),
      page_info: olderPayload.page_info,
      safe_urls: [...new Set([
        ...(olderPayload.safe_urls ?? []),
        ...(payload.safe_urls ?? []),
      ])],
      blocked_urls: [...new Set([
        ...(olderPayload.blocked_urls ?? []),
        ...(payload.blocked_urls ?? []),
      ])],
    };
    combined = true;
  }

  if (!combined) return firstResponse;
  return new pageWindow.Response(JSON.stringify(payload), {
    status: firstResponse.status,
    statusText: firstResponse.statusText,
    headers: firstResponse.headers,
  });
}

async function fetchCompleteHistoryPage(
  pageWindow: Window & typeof globalThis,
  originalFetch: typeof pageWindow.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  rewrittenUrl: string,
  existingFirstResponse?: Response,
): Promise<Response> {
  const firstResponse = existingFirstResponse ?? await (async () => {
    const [firstInput, firstInit] = rewriteGetRequest(
      pageWindow,
      input,
      init,
      rewrittenUrl,
    );
    return originalFetch(firstInput, firstInit);
  })();
  if (!firstResponse.ok) return firstResponse;

  let payload = await responseJsonOffMain<PaginatedConversationPayload>(
    pageWindow,
    firstResponse.clone(),
  );
  const seenCursors = new Set<string>();
  let combined = false;

  for (let attempt = 0; attempt < 9; attempt += 1) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (hasRenderableQuestionAnswerTurn(messages, true)) break;
    const cursor =
      payload.page_info?.has_previous_page === true &&
      typeof payload.page_info.start_cursor === "string"
        ? payload.page_info.start_cursor
        : null;
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);

    const olderUrl = new pageWindow.URL(rewrittenUrl);
    olderUrl.searchParams.set("before", cursor);
    olderUrl.searchParams.set(
      "num_turns",
      String(Math.min(512, 2 ** Math.min(9, attempt + 2))),
    );
    const [olderInput, olderInit] = rewriteGetRequest(
      pageWindow,
      input,
      init,
      olderUrl.href,
    );
    const olderResponse = await originalFetch(olderInput, olderInit);
    if (!olderResponse.ok) break;
    const olderPayload = await responseJsonOffMain<PaginatedConversationPayload>(
      pageWindow,
      olderResponse,
    );
    payload = {
      ...payload,
      messages: mergeChronologicalMessages(
        Array.isArray(olderPayload.messages) ? olderPayload.messages : [],
        messages,
      ),
      page_info: olderPayload.page_info,
      safe_urls: [...new Set([
        ...(olderPayload.safe_urls ?? []),
        ...(payload.safe_urls ?? []),
      ])],
      blocked_urls: [...new Set([
        ...(olderPayload.blocked_urls ?? []),
        ...(payload.blocked_urls ?? []),
      ])],
    };
    combined = true;
  }

  if (!combined) return firstResponse;
  return new pageWindow.Response(JSON.stringify(payload), {
    status: firstResponse.status,
    statusText: firstResponse.statusText,
    headers: firstResponse.headers,
  });
}

async function materializeLegacyRequestLazily(
  pageWindow: Window & typeof globalThis,
  originalFetch: typeof pageWindow.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  legacyUrl: string,
  conversationId: string,
  mode: Exclude<Mode, "off">,
  settings: StoredSettings,
  createLocalCursor: () => string,
): Promise<MaterializedResponse> {
  if (settings.initialTurns === "all") {
    const legacyResponse = await originalFetch(input, { ...init, cache: "no-store" });
    const materialized = await materializeAndOptimize(
      pageWindow,
      legacyResponse,
      mode,
      legacyUrl,
    );
    const headers = new pageWindow.Headers(materialized.headers);
    headers.set("x-chatgpt-performance-fix-initial-turns", "all");
    headers.set("x-chatgpt-performance-fix-cacheable", "0");
    return {
      ...materialized,
      headers: [...headers.entries()] as Array<[string, string]>,
      cacheable: false,
    };
  }

  const initialTurns = settings.initialTurns;
  const lazyUrl = new pageWindow.URL(
    `/backend-api/conversations/${conversationId}`,
    legacyUrl,
  );
  lazyUrl.searchParams.set("include_has_versions", "true");
  lazyUrl.searchParams.set(
    "num_turns",
    String(initialTurns),
  );
  try {
    const prepared = await prepareCompletePaginatedResponse(
      pageWindow,
      originalFetch,
      input,
      { ...init, cache: "no-store" },
      lazyUrl.href,
      "paginated-initial",
      conversationId,
    );
    const nativeResponse = prepared.response;
    if (!nativeResponse.ok) {
      // A rate limit on the lightweight endpoint must not immediately fall back
      // to the much heavier legacy endpoint. The outer request layer retains
      // this 429 for Retry-After so ChatGPT's revalidation loop cannot hammer
      // either endpoint while the server is asking us to stop.
      if (nativeResponse.status === 429) {
        const rateLimited = await materializeAndOptimizePaginated(
          pageWindow,
          nativeResponse,
          "paginated-initial",
          mode,
          legacyUrl,
          false,
          createLocalCursor,
        );
        const headers = new pageWindow.Headers(rateLimited.headers);
        headers.set("x-chatgpt-performance-fix-lazy", "rate-limited");
        return {
          ...rateLimited,
          headers: [...headers.entries()] as Array<[string, string]>,
          url: legacyUrl,
          cacheable: false,
          lazyInitial: true,
        };
      }
      throw new Error(`Native pagination returned HTTP ${nativeResponse.status}`);
    }

    const nativeMaterialized = await materializeAndOptimizePaginated(
      pageWindow,
      nativeResponse,
      "paginated-initial",
      mode,
      legacyUrl,
      true,
      createLocalCursor,
      prepared.workerJobToken,
      initialTurns,
    );
    const optimizedNativePayload = await parseJsonOffMain<PaginatedConversationPayload>(
      pageWindow,
      nativeMaterialized.body,
    );
    const lazyPayload = convertNativeInitialToLazyConversation(
      optimizedNativePayload,
      conversationId,
      MODE_OPTIONS[mode].paginatedMaxTurns,
    );
    if (!lazyPayload) {
      throw new Error("Native pagination response could not form a lazy conversation");
    }

    const headers = new pageWindow.Headers(nativeMaterialized.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("x-chatgpt-performance-fix-lazy", "native-pagination");
    headers.set(
      "x-chatgpt-performance-fix-initial-turns",
      String(initialTurns),
    );
    // Keep this out of the old 20-second freshness cache. The outer request
    // layer instead pins one session snapshot and only replaces it after the
    // user explicitly clicks "刷新会话" (a page reload).
    headers.set("x-chatgpt-performance-fix-cacheable", "0");

    return {
      ...nativeMaterialized,
      body: JSON.stringify(lazyPayload),
      headers: [...headers.entries()] as Array<[string, string]>,
      url: legacyUrl,
      optimized: true,
      cacheable: false,
      lazyInitial: true,
    };
  } catch (error) {
    if (requestSignal(input, init)?.aborted) throw error;
    console.warn(
      `[${SCRIPT_NAME}] Native lazy loading was unavailable; falling back to the legacy response`,
      error,
    );
    const legacyResponse = await originalFetch(input, init);
    return materializeAndOptimize(pageWindow, legacyResponse, mode, legacyUrl);
  }
}

function install(pageWindow: Window & typeof globalThis): void {
  if (!pageWindow.fetch || Reflect.get(pageWindow, "__chatgptPerformanceFixInstalled")) {
    return;
  }
  Reflect.set(pageWindow, "__chatgptPerformanceFixInstalled", true);

  const settings = readSettings(pageWindow.localStorage);
  const fullOnceKey = `${FULL_ONCE_PREFIX}${pageWindow.location.pathname}`;
  let bypassThisPageLoad = false;
  try {
    bypassThisPageLoad = pageWindow.sessionStorage.getItem(fullOnceKey) === "1";
    if (bypassThisPageLoad) pageWindow.sessionStorage.removeItem(fullOnceKey);
  } catch {
    // Ignore unavailable session storage.
  }

  const loadCurrentConversationFully = () => {
    try {
      pageWindow.sessionStorage.setItem(
        `${FULL_ONCE_PREFIX}${pageWindow.location.pathname}`,
        "1",
      );
    } catch {
      // Reload still works; it simply may not bypass on locked-down storage.
    }
    pageWindow.location.reload();
  };

  const refreshCurrentConversation = () => {
    const root = pageWindow.document.documentElement;
    root.dataset.chatgptManualConversationRefreshes = String(
      Number(root.dataset.chatgptManualConversationRefreshes ?? "0") + 1,
    );
    const shouldReload = pageWindow.dispatchEvent(
      new pageWindow.CustomEvent(
        "chatgpt-performance-fix:manual-conversation-refresh",
        { cancelable: true },
      ),
    );
    if (shouldReload) pageWindow.location.reload();
  };

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("刷新当前会话", refreshCurrentConversation);
    GM_registerMenuCommand("加载全部消息", loadCurrentConversationFully);
    GM_registerMenuCommand(
      `默认打开：${formatTurnLoadSetting(settings.initialTurns)}`,
      () => {
        void (async () => {
        const next = await showTurnLoadSettingDialog(
          pageWindow,
          "打开会话时默认加载多少轮？选择“全部”会增加首次渲染开销。",
          settings.initialTurns,
        );
        if (next == null) return;
        settings.initialTurns = next;
        writeSettings(pageWindow.localStorage, settings);
        })();
      },
    );
    GM_registerMenuCommand(
      `历史批量：${formatTurnLoadSetting(settings.historyBatchTurns)}`,
      () => {
        void (async () => {
        const next = await showTurnLoadSettingDialog(
          pageWindow,
          "每次“加载更多”默认加载多少轮？",
          settings.historyBatchTurns,
        );
        if (next == null) return;
        settings.historyBatchTurns = next;
        writeSettings(pageWindow.localStorage, settings);
        })();
      },
    );
    GM_registerMenuCommand(
      `切换模式（${settings.mode}）`,
      () => {
        const nextMode: Mode =
          settings.mode === "balanced"
            ? "aggressive"
            : settings.mode === "aggressive"
              ? "off"
              : "balanced";
        writeSettings(pageWindow.localStorage, { ...settings, mode: nextMode });
        pageWindow.location.reload();
      },
    );
  }

  addVirtualizationCss(pageWindow);
  if (settings.mode !== "off") {
    installRichTextPerformanceFix(
      pageWindow,
      MODE_OPTIONS[settings.mode].richTextWarmDistancePx,
      MODE_OPTIONS[settings.mode].codeEditorWarmDistancePx,
    );
  }

  const deepLink = new pageWindow.URLSearchParams(pageWindow.location.search);
  if (
    settings.mode === "off" ||
    bypassThisPageLoad ||
    deepLink.has("message") ||
    deepLink.has("messageId")
  ) {
    return;
  }

  const activeMode = settings.mode as Exclude<Mode, "off">;
  const responseFallback = installLegacyResponseFallback(pageWindow, activeMode);
  installManualPaginationObserver(pageWindow, settings);

  const originalFetch = pageWindow.fetch.bind(pageWindow);
  const backendRequestContext = createBackendRequestContext(pageWindow);
  const sidebarFreshness = installSidebarFreshness(
    pageWindow,
    originalFetch,
    backendRequestContext,
    refreshCurrentConversation,
  );
  const deliveryVerifier = installDeliveryVerifier(
    pageWindow,
  );
  const cache = new Map<
    string,
    { expiresAt: number; response: MaterializedResponse }
  >();
  // ChatGPT revalidates an open conversation in the background (the captured
  // build did so roughly every 10–22 seconds). Keep the first explicitly idle
  // initial response for this page session so those fetches are local reads.
  // Active responses must pass through until the server reports completion.
  const initialSnapshots = new Map<string, InitialConversationSnapshot>();
  const initialSnapshotEpochs = new Map<string, number>();
  const asyncStatusActivity = new Map<string, boolean>();
  let globalInitialSnapshotEpoch = 0;
  const inFlight = new Map<string, Promise<MaterializedResponse>>();
  const notifiedKeys = new Set<string>();
  const localPages = new Map<string, MaterializedResponse>();
  const localCursorSession =
    pageWindow.crypto?.randomUUID?.().replaceAll("-", "") ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  let localCursorCounter = 0;
  const createLocalCursor = () =>
    `cgptperf-${localCursorSession}-${(++localCursorCounter).toString(36)}`;

  const initialSnapshotKey = (
    kind: "legacy-full" | "paginated-initial",
    conversationId: string,
  ) => `${kind}:${conversationId}:${String(settings.initialTurns)}`;

  const initialSnapshotEpoch = (conversationId: string): string =>
    `${globalInitialSnapshotEpoch}:${initialSnapshotEpochs.get(conversationId) ?? 0}`;

  const invalidateInitialSnapshots = (conversationId: string | null): void => {
    if (conversationId) {
      initialSnapshotEpochs.set(
        conversationId,
        (initialSnapshotEpochs.get(conversationId) ?? 0) + 1,
      );
    } else {
      globalInitialSnapshotEpoch += 1;
    }

    for (const [key, snapshot] of initialSnapshots) {
      if (snapshot.rateLimited) continue;
      if (!conversationId || key.includes(`:${conversationId}:`)) {
        initialSnapshots.delete(key);
      }
    }
    const root = pageWindow.document.documentElement;
    root.dataset.chatgptInitialSnapshotInvalidations = String(
      Number(root.dataset.chatgptInitialSnapshotInvalidations ?? "0") + 1,
    );
  };

  const readInitialSnapshot = (
    key: string,
    exposedUrl: string,
  ): Response | null => {
    const snapshot = initialSnapshots.get(key);
    if (!snapshot) return null;
    if (snapshot.expiresAt <= Date.now()) {
      initialSnapshots.delete(key);
      return null;
    }

    // Refresh insertion order so the bounded map behaves as a small LRU.
    initialSnapshots.delete(key);
    initialSnapshots.set(key, snapshot);
    const root = pageWindow.document.documentElement;
    root.dataset.chatgptInitialSnapshotHits = String(
      Number(root.dataset.chatgptInitialSnapshotHits ?? "0") + 1,
    );
    if (snapshot.rateLimited) {
      root.dataset.chatgptInitialRateLimitSuppressions = String(
        Number(root.dataset.chatgptInitialRateLimitSuppressions ?? "0") + 1,
      );
    }

    const headers = new pageWindow.Headers(snapshot.response.headers);
    headers.set(
      "x-chatgpt-performance-fix-initial-snapshot",
      snapshot.rateLimited ? "rate-limit-backoff" : "hit",
    );
    return cloneMaterializedResponse(pageWindow, {
      ...snapshot.response,
      headers: [...headers.entries()] as Array<[string, string]>,
      url: exposedUrl,
    });
  };

  const storeInitialSnapshot = (
    key: string,
    response: MaterializedResponse,
    conversationId: string,
    requestEpoch: string,
  ): void => {
    const successful = response.status >= 200 && response.status < 300;
    const rateLimited = response.status === 429;
    if (!successful && !rateLimited) return;

    const epochIsCurrent = requestEpoch === initialSnapshotEpoch(conversationId);
    if (
      successful &&
      epochIsCurrent &&
      response.activeConversation != null
    ) {
      asyncStatusActivity.set(conversationId, response.activeConversation);
    }
    if (
      successful &&
      (
        response.activeConversation !== false ||
        !epochIsCurrent
      )
    ) {
      // Only an explicitly finished response may become a page-session
      // snapshot. Active/unknown responses still share their in-flight Promise,
      // but the next sequential GET must be allowed to observe new progress.
      const existing = initialSnapshots.get(key);
      if (existing && !existing.rateLimited) initialSnapshots.delete(key);
      const root = pageWindow.document.documentElement;
      const reason = response.activeConversation === true ? "Active" : "StaleOrUnknown";
      const datasetKey = `chatgptInitialSnapshotSkipped${reason}`;
      root.dataset[datasetKey] = String(Number(root.dataset[datasetKey] ?? "0") + 1);
      return;
    }

    const now = Date.now();
    const expiresAt = rateLimited
      ? now + retryAfterBackoffMs(
          new pageWindow.Headers(response.headers),
          INITIAL_RATE_LIMIT_BACKOFF_MS,
          now,
        )
      : Number.POSITIVE_INFINITY;
    initialSnapshots.delete(key);
    initialSnapshots.set(key, { response, expiresAt, rateLimited });
    while (initialSnapshots.size > MAX_INITIAL_CONVERSATION_SNAPSHOTS) {
      const oldest = initialSnapshots.keys().next().value;
      if (typeof oldest !== "string") break;
      initialSnapshots.delete(oldest);
    }

    const root = pageWindow.document.documentElement;
    root.dataset.chatgptInitialSnapshotsStored = String(
      Number(root.dataset.chatgptInitialSnapshotsStored ?? "0") + 1,
    );
    if (rateLimited) {
      root.dataset.chatgptInitialRateLimitBackoffUntil = String(expiresAt);
    }
  };

  const clearLiveConversationCache = (conversationId: string | null) => {
    // A send/edit/resume makes any prior finished snapshot stale immediately.
    // Retry-After snapshots remain intact so a mutation cannot restart a 429
    // request loop while the server is explicitly asking the client to wait.
    invalidateInitialSnapshots(conversationId);
    cache.clear();
    inFlight.clear();
    responseFallback.clear();
  };

  const wrappedFetch: typeof pageWindow.fetch = async (input, init) => {
    const rawUrl = requestUrl(pageWindow, input, pageWindow.location.href);
    const method = requestMethod(input, init);
    const capturedBackendContext = backendRequestContext.capture(input, init, rawUrl);
    if (capturedBackendContext) sidebarFreshness.requestContextChanged();
    const apiMatch = matchConversationApiUrl(rawUrl, pageWindow.location.href);
    const mutationKind = conversationMutationKind(
      rawUrl,
      method,
      pageWindow.location.href,
    );

    if (mutationKind) {
      const restoredInit = restoreStaticCodeRequestInit(init);
      const fallbackProbe: OutgoingMessageProbe = {
        conversationId: currentConversationId(pageWindow),
        messageId: null,
        text: null,
        hasUserMessage: false,
      };
      const inspected = mutationKind === "send"
        ? await inspectOutgoingRequest(input, restoredInit)
        : fallbackProbe;
      const probe: OutgoingMessageProbe = {
        ...inspected,
        conversationId:
          inspected.conversationId ?? fallbackProbe.conversationId,
      };
      const trackUserSend = mutationKind === "send" && probe.hasUserMessage;
      if (trackUserSend) deliveryVerifier.begin(probe);
      const mutationConversationId = mutationKind === "content"
        ? apiMatch?.conversationId ?? probe.conversationId
        : probe.conversationId ?? apiMatch?.conversationId ?? currentConversationId(pageWindow);
      if (
        mutationConversationId &&
        (mutationKind === "send" || mutationKind === "resume")
      ) {
        asyncStatusActivity.set(mutationConversationId, true);
      }
      clearLiveConversationCache(mutationConversationId);
      try {
        const response = await originalFetch(input, restoredInit);
        if (trackUserSend) {
          if (response.ok) {
            deliveryVerifier.accepted(probe);
          } else {
            deliveryVerifier.failed(probe, `HTTP ${response.status}`);
          }
        }
        return response;
      } catch (error) {
        if (trackUserSend) {
          deliveryVerifier.failed(
            probe,
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }
    }

    const statusConversationId = conversationStatusUpdateId(
      rawUrl,
      method,
      pageWindow.location.href,
    );
    if (statusConversationId) {
      const statusProbePromise = inspectAsyncStatusRequest(input, init);
      const response = await originalFetch(input, init);
      if (response.ok) {
        const statusProbe = await statusProbePromise;
        if (statusProbe.found) {
          const active = isActiveAsyncStatus(statusProbe.value);
          const hadPrevious = asyncStatusActivity.has(statusConversationId);
          const previous = asyncStatusActivity.get(statusConversationId);
          asyncStatusActivity.set(statusConversationId, active);
          if (!hadPrevious || previous !== active) {
            // Invalidate once per state transition. Repeated status heartbeats do
            // not churn the cache, and status-only updates never delete local
            // synthetic history pages.
            invalidateInitialSnapshots(statusConversationId);
          }
          sidebarFreshness.noteConversationStatus(
            statusConversationId,
            statusProbe.value,
          );
        }
      }
      return response;
    }

    if (method !== "GET" || !apiMatch) {
      return originalFetch(input, init);
    }

    const normalizedRawUrl = new pageWindow.URL(
      rawUrl,
      pageWindow.location.href,
    ).href;

    // Exact-message deep links need the stock pagination semantics because the
    // requested target may live inside a tool-heavy turn that we would compact.
    const requestUrlObject = new pageWindow.URL(normalizedRawUrl);
    if (apiMatch.kind === "paginated-messages") {
      const before = requestUrlObject.searchParams.get("before");
      const localPage = before == null ? undefined : localPages.get(before);
      if (localPage) {
        await yieldUntilInteractionIdle(pageWindow);
        const cloned = cloneMaterializedResponse(pageWindow, {
          ...localPage,
          url: normalizedRawUrl,
        });
        dispatchHistorySettledAfterCommit(pageWindow);
        return cloned;
      }
    }

    if (
      apiMatch.kind !== "legacy-full" &&
      requestUrlObject.searchParams.has("include_message_id")
    ) {
      return originalFetch(input, init);
    }

    let key: string;
    let task: Promise<MaterializedResponse> | undefined;
    let finiteBatchServerRequest = false;
    let requestInitialSnapshotEpoch: string | undefined;

    if (apiMatch.kind === "legacy-full") {
      const explicitlyFull = ["true", "1"].includes(
        requestUrlObject.searchParams.get("include_full_conversation") ?? "",
      );
      if (explicitlyFull) return originalFetch(input, init);

      key = initialSnapshotKey("legacy-full", apiMatch.conversationId);
      const snapshot = readInitialSnapshot(key, normalizedRawUrl);
      if (snapshot) return snapshot;
      requestInitialSnapshotEpoch = initialSnapshotEpoch(apiMatch.conversationId);

      task = inFlight.get(key);
      if (!task) {
        task = materializeLegacyRequestLazily(
          pageWindow,
          originalFetch,
          input,
          init,
          normalizedRawUrl,
          apiMatch.conversationId,
          activeMode,
          settings,
          createLocalCursor,
        );
        inFlight.set(key, task);
      }
    } else {
      const completeAll =
        apiMatch.kind === "paginated-initial" && settings.initialTurns === "all";
      let renderTurns = MODE_OPTIONS[activeMode].paginatedRenderTurns;
      let rewrittenUrl: string;
      if (apiMatch.kind === "paginated-initial") {
        const initialTurns = completeAll
          ? ALL_INITIAL_FIRST_PAGE_TURNS
          : settings.initialTurns as number;
        const url = new pageWindow.URL(normalizedRawUrl);
        url.searchParams.set("num_turns", String(initialTurns));
        rewrittenUrl = url.href;
        renderTurns = completeAll ? Number.MAX_SAFE_INTEGER : initialTurns;
      } else {
        const root = pageWindow.document.documentElement;
        const before = requestUrlObject.searchParams.get("before");
        const requestedTurns = Number(
          root.dataset.chatgptHistoryFiniteRequestedTurns ?? "0",
        );
        const finiteServerRequestPending =
          root.dataset.chatgptHistoryBatchActive === "true" &&
          root.dataset.chatgptHistoryBatchMode === "count" &&
          root.dataset.chatgptHistoryFiniteServerRequestPending === "true" &&
          Number.isFinite(requestedTurns) &&
          requestedTurns > 0 &&
          before != null &&
          !before.startsWith("cgptperf-");
        if (finiteServerRequestPending) {
          const url = new pageWindow.URL(normalizedRawUrl);
          url.searchParams.set("num_turns", String(Math.floor(requestedTurns)));
          rewrittenUrl = url.href;
          // Fetch the requested N turns once, but still hand them to ChatGPT one
          // turn at a time through local micro-pages. This makes the UI label
          // "加载 N 轮" exact while avoiding N separate server page requests.
          renderTurns = 1;
          root.dataset.chatgptHistoryFiniteServerRequestPending = "false";
          root.dataset.chatgptHistoryFiniteServerRequestTurns = String(
            Math.floor(requestedTurns),
          );
          finiteBatchServerRequest = true;
        } else {
          rewrittenUrl = clampPaginatedNumTurns(
            normalizedRawUrl,
            pageWindow.location.href,
            MODE_OPTIONS[activeMode].paginatedMaxTurns,
          );
        }
      }
      const requestWasClamped = rewrittenUrl !== normalizedRawUrl;
      if (apiMatch.kind === "paginated-initial") {
        key = initialSnapshotKey("paginated-initial", apiMatch.conversationId);
        const snapshot = readInitialSnapshot(key, normalizedRawUrl);
        if (snapshot) return snapshot;
        requestInitialSnapshotEpoch = initialSnapshotEpoch(apiMatch.conversationId);
      } else {
        key = `paginated:${rewrittenUrl}`;
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
          const root = pageWindow.document.documentElement;
          const hits = Number(root.dataset.chatgptHistoryCacheHits ?? "0");
          root.dataset.chatgptHistoryCacheHits = String(hits + 1);
          await yieldUntilInteractionIdle(pageWindow);
          const cloned = cloneMaterializedResponse(pageWindow, cached.response);
          if (finiteBatchServerRequest) {
            pageWindow.dispatchEvent(
              new pageWindow.CustomEvent(
                "chatgpt-performance-fix:history-finite-plan",
                {
                  detail: {
                    localPages: cached.response.localPages?.length ?? 0,
                  },
                },
              ),
            );
          }
          dispatchHistorySettledAfterCommit(pageWindow);
          return cloned;
        }
        if (cached) cache.delete(key);
      }
      task = inFlight.get(key);
      if (!task) {
        const responseTask = prepareCompletePaginatedResponse(
          pageWindow,
          originalFetch,
          input,
          init,
          rewrittenUrl,
          apiMatch.kind,
          apiMatch.conversationId,
          completeAll,
        );
        task = responseTask.then((prepared) =>
          materializeAndOptimizePaginated(
            pageWindow,
            prepared.response,
            apiMatch.kind,
            activeMode,
            normalizedRawUrl,
            requestWasClamped,
            createLocalCursor,
            prepared.workerJobToken,
            renderTurns,
          ),
        );
        inFlight.set(key, task);
      }
    }

    try {
      const materialized = await task;
      if (
        apiMatch.kind === "legacy-full" ||
        apiMatch.kind === "paginated-initial"
      ) {
        storeInitialSnapshot(
          key,
          materialized,
          apiMatch.conversationId,
          requestInitialSnapshotEpoch ?? initialSnapshotEpoch(apiMatch.conversationId),
        );
      }
      if (finiteBatchServerRequest) {
        pageWindow.dispatchEvent(
          new pageWindow.CustomEvent(
            "chatgpt-performance-fix:history-finite-plan",
            {
              detail: {
                localPages: materialized.localPages?.length ?? 0,
              },
            },
          ),
        );
      }
      for (const localPage of materialized.localPages ?? []) {
        localPages.set(localPage.cursor, localPage.response);
      }
      while (localPages.size > 256) {
        const oldest = localPages.keys().next().value;
        if (typeof oldest !== "string") break;
        localPages.delete(oldest);
      }

      if (
        materialized.apiKind === "paginated-messages" &&
        materialized.optimized
      ) {
        cache.set(key, {
          expiresAt: Date.now() + HISTORY_CACHE_TTL_MS,
          response: materialized,
        });
      }

      if (
        (materialized.apiKind === "legacy-full" || materialized.lazyInitial) &&
        materialized.optimized &&
        materialized.cacheable
      ) {
        cache.set(key, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          response: materialized,
        });
      }

      if (materialized.optimized) {
        const stats = materialized.stats;
        pageWindow.document.documentElement.dataset.chatgptPerformanceFix = "large";

        const notificationKind = materialized.lazyInitial
          ? "lazy-initial"
          : materialized.apiKind;
        const notificationKey = `${apiMatch.conversationId}:${notificationKind}`;
        if (stats && !notifiedKeys.has(notificationKey)) {
          notifiedKeys.add(notificationKey);
          console.info(`[${SCRIPT_NAME}]`, {
            apiKind: materialized.apiKind,
            ...stats,
            paginatedMaxTurns: MODE_OPTIONS[activeMode].paginatedMaxTurns,
            manualHistoryLoading: true,
            responseCacheTtlMs: materialized.cacheable ? CACHE_TTL_MS : 0,
          });

          if (
            materialized.lazyInitial &&
            "originalMessages" in stats
          ) {
            showOptimizationToast(
              pageWindow,
              `已启用长会话加速`,
              loadCurrentConversationFully,
            );
          } else if (
            materialized.apiKind === "legacy-full" &&
            "originalNodes" in stats
          ) {
            showOptimizationToast(
              pageWindow,
              `长会话已加速`,
              loadCurrentConversationFully,
            );
          } else if (
            materialized.apiKind === "paginated-initial" &&
            "originalMessages" in stats
          ) {
            showOptimizationToast(
              pageWindow,
              `历史按需加载`,
              loadCurrentConversationFully,
            );
          }
        }
      }

      if (materialized.apiKind === "paginated-messages") {
        await yieldUntilInteractionIdle(pageWindow);
        const cloned = cloneMaterializedResponse(pageWindow, materialized);
        dispatchHistorySettledAfterCommit(pageWindow);
        return cloned;
      }
      return cloneMaterializedResponse(pageWindow, materialized);
    } catch (error) {
      if (apiMatch.kind === "paginated-messages") {
        dispatchHistorySettledAfterCommit(pageWindow, false);
      }
      throw error;
    } finally {
      if (inFlight.get(key) === task) inFlight.delete(key);
    }
  };

  try {
    Object.defineProperty(wrappedFetch, "name", { value: "fetch" });
    Object.defineProperty(pageWindow, "fetch", {
      configurable: true,
      writable: true,
      value: wrappedFetch,
    });
  } catch {
    pageWindow.fetch = wrappedFetch;
  }
}

const pageWindow =
  typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
install(pageWindow);
