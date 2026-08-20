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

type Mode = "off" | "balanced" | "aggressive";

interface StoredSettings {
  mode: Mode;
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
  stats?: OptimizationStats | PaginatedOptimizationStats;
  apiKind?: ConversationApiKind;
  localPages?: Array<{ cursor: string; response: MaterializedResponse }>;
  lazyInitial?: boolean;
}

const SCRIPT_NAME = "ChatGPT Long Conversation Performance Fix";
const SETTINGS_KEY = "chatgpt-performance-fix:settings:v1";
const FULL_ONCE_PREFIX = "chatgpt-performance-fix:full-once:";
const CACHE_TTL_MS = 20_000;

const MODE_OPTIONS: Record<
  Exclude<Mode, "off">,
  {
    minNodeCount: number;
    recentFullTurns: number;
    lazyInitialTurns: number;
    paginatedMaxTurns: number;
    paginatedRenderTurns: number;
    richTextWarmDistancePx: number;
  }
> = {
  balanced: {
    minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
    recentFullTurns: 1,
    lazyInitialTurns: 2,
    paginatedMaxTurns: 2,
    paginatedRenderTurns: 1,
    richTextWarmDistancePx: 8_000,
  },
  aggressive: {
    minNodeCount: DEFAULT_OPTIMIZER_OPTIONS.minNodeCount,
    recentFullTurns: 0,
    lazyInitialTurns: 2,
    paginatedMaxTurns: 2,
    paginatedRenderTurns: 1,
    richTextWarmDistancePx: 5_000,
  },
};

function readSettings(storage: Storage): StoredSettings {
  try {
    const value = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "null") as
      | Partial<StoredSettings>
      | null;
    if (value?.mode === "off" || value?.mode === "aggressive") {
      return { mode: value.mode };
    }
    return { mode: "balanced" };
  } catch {
    return { mode: "balanced" };
  }
}

function yieldUntilInteractionIdle(
  pageWindow: Window & typeof globalThis,
): Promise<void> {
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

function installManualPaginationObserver(
  pageWindow: Window & typeof globalThis,
): void {
  const marker = "__chatgptPerformanceFixIntersectionObserver";
  if (Reflect.get(pageWindow, marker)) return;

  const NativeIntersectionObserver = pageWindow.IntersectionObserver;
  if (typeof NativeIntersectionObserver !== "function") return;

  const HISTORY_SETTLED_EVENT = "chatgpt-performance-fix:history-page-settled";

  class TunedIntersectionObserver implements IntersectionObserver {
    private readonly callback: IntersectionObserverCallback;
    private readonly options?: IntersectionObserverInit;
    private observer?: IntersectionObserver;
    private isPaginationObserver = false;
    private lastPaginationEntries?: IntersectionObserverEntry[];
    private control?: HTMLDivElement;
    private button?: HTMLButtonElement;
    private loading = false;
    private fallbackResetTimer?: number;

    constructor(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      this.callback = callback;
      this.options = options;
    }

    private updateButton(): void {
      if (!this.button) return;
      const canLoad = Boolean(
        this.lastPaginationEntries?.some((entry) => entry.isIntersecting),
      );
      this.button.disabled = this.loading || !canLoad;
      this.button.textContent = this.loading ? "加载中…" : "加载更多";
      this.button.setAttribute("aria-busy", this.loading ? "true" : "false");
      this.button.title = canLoad
        ? "加载更多历史消息"
        : "滚到顶部后可加载更多";
    }

    private resetLoading = (): void => {
      this.loading = false;
      if (this.fallbackResetTimer != null) {
        pageWindow.clearTimeout(this.fallbackResetTimer);
        this.fallbackResetTimer = undefined;
      }
      this.updateButton();
    };

    private onHistorySettled = (): void => {
      if (!this.loading) return;
      this.resetLoading();
    };

    private triggerManualLoad = (): void => {
      const entries = this.lastPaginationEntries;
      if (
        this.loading ||
        !entries?.some((entry) => entry.isIntersecting)
      ) {
        return;
      }
      this.loading = true;
      this.updateButton();
      const root = pageWindow.document.documentElement;
      const clicks = Number(root.dataset.chatgptManualHistoryClicks ?? "0");
      root.dataset.chatgptManualHistoryClicks = String(clicks + 1);
      this.callback(entries, this);
      // Network failures should not leave the manual control permanently disabled.
      this.fallbackResetTimer = pageWindow.setTimeout(this.resetLoading, 8_000);
    };

    private installControl(target: Element): void {
      if (this.control?.isConnected) return;
      const control = pageWindow.document.createElement("div");
      control.dataset.chatgptHistoryLoadControl = "true";
      control.style.cssText = [
        "display:flex",
        "justify-content:center",
        "align-items:center",
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
      control.append(button);
      target.insertAdjacentElement("afterend", control);
      this.control = control;
      this.button = button;
      pageWindow.addEventListener(HISTORY_SETTLED_EVENT, this.onHistorySettled);
      this.updateButton();
    }

    private dispatchNative(entries: IntersectionObserverEntry[]): void {
      if (!this.isPaginationObserver) {
        this.callback(entries, this);
        return;
      }
      this.lastPaginationEntries = entries;
      this.updateButton();
      // Deliberately never forward an intersecting pagination entry automatically.
      // The user explicitly owns every history-page commit through the button.
      if (!entries.some((entry) => entry.isIntersecting)) {
        this.callback(entries, this);
      }
    }

    private ensureObserver(target: Element): IntersectionObserver {
      if (this.observer) return this.observer;
      this.isPaginationObserver =
        target instanceof pageWindow.Element &&
        target.matches('[data-testid="conversation-pagination-sentinel"]');
      if (this.isPaginationObserver) this.installControl(target);
      this.observer = new NativeIntersectionObserver(
        (entries) => this.dispatchNative(entries),
        this.options,
      );
      return this.observer;
    }

    observe(target: Element): void {
      this.ensureObserver(target).observe(target);
    }

    unobserve(target: Element): void {
      this.observer?.unobserve(target);
    }

    disconnect(): void {
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

    takeRecords(): IntersectionObserverEntry[] {
      return this.observer?.takeRecords() ?? [];
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

function isConversationMutation(rawUrl: string, method: string, baseUrl: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  try {
    const url = new URL(rawUrl, baseUrl);
    return url.pathname.includes("/conversation");
  } catch {
    return false;
  }
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


function installRichTextPerformanceFix(
  pageWindow: Window & typeof globalThis,
  warmDistancePx: number,
): void {
  const marker = "__chatgptRichTextPerformanceFixInstalled";
  if (Reflect.get(pageWindow, marker)) return;
  Reflect.set(pageWindow, marker, true);

  // SmoothedMarkdown's module (stable chunk id 2afb55f3 in both captured page
  // loads) uses document.visibilityState only to decide whether to synthesize its
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
            if (stack.includes("/2afb55f3-")) {
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

    constructor(callback: ResizeObserverCallback) {
      this.native = new NativeResizeObserver((entries) => callback(entries, this));
    }

    observe(target: Element, options?: ResizeObserverOptions): void {
      if (isSmoothedCodeMeasurement(target)) {
        this.skipped.add(target);
        const root = pageWindow.document.documentElement;
        const count = Number(root.dataset.chatgptRichTextSkippedResizeObservers ?? "0");
        root.dataset.chatgptRichTextSkippedResizeObservers = String(count + 1);
        return;
      }
      this.native.observe(target, options);
    }

    unobserve(target: Element): void {
      if (this.skipped.delete(target)) return;
      this.native.unobserve(target);
    }

    disconnect(): void {
      this.skipped.clear();
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
      if (
        rect.bottom < -effectiveWarmDistance ||
        rect.top > pageWindow.innerHeight + effectiveWarmDistance
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

async function materializeAndOptimize(
  pageWindow: Window & typeof globalThis,
  response: Response,
  mode: Exclude<Mode, "off">,
  exposedUrl: string = response.url,
): Promise<MaterializedResponse> {
  const originalBody = await response.text();
  let body = originalBody;
  let optimized = false;
  let cacheable = false;
  let stats: OptimizationStats | undefined;

  if (response.ok) {
    try {
      const parsed = JSON.parse(originalBody) as Record<string, unknown>;
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
): Promise<MaterializedResponse> {
  const originalBody = await response.text();
  let body = originalBody;
  let optimized = requestWasClamped;
  let stats: PaginatedOptimizationStats | undefined;
  let optimizedPayload: PaginatedConversationPayload | undefined;
  let cacheable = false;
  let localPagePayloads: Array<{ cursor: string; payload: PaginatedConversationPayload }> = [];

  if (response.ok) {
    try {
      const parsed = JSON.parse(originalBody) as Record<string, unknown>;
      const activeInitial =
        apiKind === "paginated-initial" && hasActivePaginatedWork(parsed);
      cacheable =
        apiKind === "paginated-initial" && isIdlePaginatedConversation(parsed);
      const result = optimizePaginatedConversationPayload(parsed, {
        // Preserve the whole newest turn only while the server reports live work.
        // A finished tool leaf keeps just its invocation/result dependency pair.
        recentFullTurns:
          apiKind === "paginated-initial" && activeInitial
            ? MODE_OPTIONS[mode].recentFullTurns
            : 0,
        forceKeepMessageIds:
          apiKind === "paginated-initial" ? requiredInitialMessageIds(parsed) : [],
        collapseTurnsToQuestionAnswer:
          apiKind === "paginated-messages" ||
          (apiKind === "paginated-initial" && !activeInitial),
      });
      stats = result.stats;
      optimizedPayload = result.payload;
      if (result.stats.changed) {
        optimized = true;
      }

      const messages = Array.isArray(result.payload.messages)
        ? result.payload.messages
        : [];
      const chunksNewestFirst = splitPaginatedMessagesNewestFirst(messages, {
        maxTurns: MODE_OPTIONS[mode].paginatedRenderTurns,
        // Turn atomicity is the only historical chunk boundary. Large AI answers
        // remain attached to their user question instead of being message-sliced.
        maxMessages: Number.MAX_SAFE_INTEGER,
        maxBytes: Number.MAX_SAFE_INTEGER,
        // Every manual history click represents one semantic conversation turn.
        // Never split a user question away from its corresponding AI reply.
        allowSplitTurns: false,
      });

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

async function fetchCompleteInitialPage(
  pageWindow: Window & typeof globalThis,
  originalFetch: typeof pageWindow.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  rewrittenUrl: string,
  conversationId: string,
): Promise<Response> {
  const [firstInput, firstInit] = rewriteGetRequest(
    pageWindow,
    input,
    init,
    rewrittenUrl,
  );
  const firstResponse = await originalFetch(firstInput, firstInit);
  if (!firstResponse.ok) return firstResponse;

  let payload = (await firstResponse.clone().json()) as PaginatedConversationPayload;
  const seenCursors = new Set<string>();
  let combined = false;

  for (let attempt = 0; attempt < 9; attempt += 1) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (hasRenderableQuestionAnswerTurn(messages, false)) break;
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
    const olderPayload = (await olderResponse.json()) as PaginatedConversationPayload;
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
): Promise<Response> {
  const [firstInput, firstInit] = rewriteGetRequest(
    pageWindow,
    input,
    init,
    rewrittenUrl,
  );
  const firstResponse = await originalFetch(firstInput, firstInit);
  if (!firstResponse.ok) return firstResponse;

  let payload = (await firstResponse.clone().json()) as PaginatedConversationPayload;
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
    const olderPayload = (await olderResponse.json()) as PaginatedConversationPayload;
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
  createLocalCursor: () => string,
): Promise<MaterializedResponse> {
  const lazyUrl = new pageWindow.URL(
    `/backend-api/conversations/${conversationId}`,
    legacyUrl,
  );
  lazyUrl.searchParams.set("include_has_versions", "true");
  lazyUrl.searchParams.set(
    "num_turns",
    String(MODE_OPTIONS[mode].lazyInitialTurns),
  );
  const [lazyInput, lazyInit] = rewriteGetRequest(
    pageWindow,
    input,
    init,
    lazyUrl.href,
  );

  try {
    const nativeResponse = await originalFetch(lazyInput, {
      ...lazyInit,
      cache: "no-store",
    });
    if (!nativeResponse.ok) {
      throw new Error(`Native pagination returned HTTP ${nativeResponse.status}`);
    }

    let nativePayload = (await nativeResponse.clone().json()) as PaginatedConversationPayload;
    let fetchedOlderPage = false;
    const seenCursors = new Set<string>();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const collected = Array.isArray(nativePayload.messages) ? nativePayload.messages : [];
      if (hasRenderableQuestionAnswerTurn(collected, false)) break;

      const cursor =
        nativePayload.page_info?.has_previous_page === true &&
        typeof nativePayload.page_info.start_cursor === "string"
          ? nativePayload.page_info.start_cursor
          : null;
      if (!cursor) break;
      if (seenCursors.has(cursor)) {
        throw new Error("Native pagination cursor did not advance");
      }
      seenCursors.add(cursor);

      const olderUrl = new pageWindow.URL(
        `/backend-api/conversations/${conversationId}/messages`,
        legacyUrl,
      );
      olderUrl.searchParams.set("before", cursor);
      olderUrl.searchParams.set("include_has_versions", "true");
      // If the backend interprets num_turns as a low-level message window rather
      // than a semantic user turn, grow only as needed to recover the current
      // question boundary. Normal backends stop on the first 2-unit request.
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
      const olderResponse = await originalFetch(olderInput, {
        ...olderInit,
        cache: "no-store",
      });
      if (!olderResponse.ok) {
        throw new Error(`Native history pagination returned HTTP ${olderResponse.status}`);
      }
      const olderPayload = (await olderResponse.json()) as PaginatedConversationPayload;
      nativePayload = {
        ...nativePayload,
        messages: mergeChronologicalMessages(
          Array.isArray(olderPayload.messages) ? olderPayload.messages : [],
          collected,
        ),
        page_info: olderPayload.page_info,
        safe_urls: olderPayload.safe_urls ?? nativePayload.safe_urls ?? [],
        blocked_urls: olderPayload.blocked_urls ?? nativePayload.blocked_urls ?? [],
      };
      fetchedOlderPage = true;
    }
    if (!Array.isArray(nativePayload.messages) || nativePayload.messages.length === 0) {
      throw new Error("Native pagination returned no messages");
    }

    const preparedNativeResponse = fetchedOlderPage
      ? new pageWindow.Response(JSON.stringify(nativePayload), {
          status: nativeResponse.status,
          statusText: nativeResponse.statusText,
          headers: nativeResponse.headers,
        })
      : nativeResponse;

    const nativeMaterialized = await materializeAndOptimizePaginated(
      pageWindow,
      preparedNativeResponse,
      "paginated-initial",
      mode,
      legacyUrl,
      true,
      createLocalCursor,
    );
    const optimizedNativePayload = JSON.parse(
      nativeMaterialized.body,
    ) as PaginatedConversationPayload;
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
      String(MODE_OPTIONS[mode].lazyInitialTurns),
    );
    // The server may append a final assistant message shortly after a finished
    // tool result. Keep only concurrent de-duplication for synthetic lazy opens;
    // never hide that transition behind the 20-second legacy response cache.
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

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("完整加载一次", loadCurrentConversationFully);
    GM_registerMenuCommand(
      `切换模式（${settings.mode}）`,
      () => {
        const nextMode: Mode =
          settings.mode === "balanced"
            ? "aggressive"
            : settings.mode === "aggressive"
              ? "off"
              : "balanced";
        writeSettings(pageWindow.localStorage, { mode: nextMode });
        pageWindow.location.reload();
      },
    );
  }

  addVirtualizationCss(pageWindow);
  if (settings.mode !== "off") {
    installRichTextPerformanceFix(
      pageWindow,
      MODE_OPTIONS[settings.mode].richTextWarmDistancePx,
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
  installManualPaginationObserver(pageWindow);

  const originalFetch = pageWindow.fetch.bind(pageWindow);
  const cache = new Map<
    string,
    { expiresAt: number; response: MaterializedResponse }
  >();
  const inFlight = new Map<string, Promise<MaterializedResponse>>();
  const notifiedKeys = new Set<string>();
  const localPages = new Map<string, MaterializedResponse>();
  const localCursorSession =
    pageWindow.crypto?.randomUUID?.().replaceAll("-", "") ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  let localCursorCounter = 0;
  const createLocalCursor = () =>
    `cgptperf-${localCursorSession}-${(++localCursorCounter).toString(36)}`;

  const clearConversationCache = () => {
    cache.clear();
    inFlight.clear();
    localPages.clear();
  };

  const wrappedFetch: typeof pageWindow.fetch = async (input, init) => {
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
        pageWindow.setTimeout(() => {
          pageWindow.dispatchEvent(
            new pageWindow.CustomEvent(
              "chatgpt-performance-fix:history-page-settled",
            ),
          );
        }, 0);
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

    if (apiMatch.kind === "legacy-full") {
      const explicitlyFull = ["true", "1"].includes(
        requestUrlObject.searchParams.get("include_full_conversation") ?? "",
      );
      if (explicitlyFull) return originalFetch(input, init);

      key = `lazy:${normalizedRawUrl}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return cloneMaterializedResponse(pageWindow, cached.response);
      }
      if (cached) cache.delete(key);

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
          createLocalCursor,
        );
        inFlight.set(key, task);
      }
    } else {
      const maxTurns =
        apiMatch.kind === "paginated-initial"
          ? MODE_OPTIONS[activeMode].lazyInitialTurns
          : MODE_OPTIONS[activeMode].paginatedMaxTurns;
      const rewrittenUrl = clampPaginatedNumTurns(
        normalizedRawUrl,
        pageWindow.location.href,
        maxTurns,
      );
      const requestWasClamped = rewrittenUrl !== normalizedRawUrl;
      const [rewrittenInput, rewrittenInit] = rewriteGetRequest(
        pageWindow,
        input,
        init,
        rewrittenUrl,
      );
      key = `paginated:${rewrittenUrl}`;
      task = inFlight.get(key);
      if (!task) {
        const responseTask =
          apiMatch.kind === "paginated-messages"
            ? fetchCompleteHistoryPage(
                pageWindow,
                originalFetch,
                input,
                init,
                rewrittenUrl,
              )
            : fetchCompleteInitialPage(
                pageWindow,
                originalFetch,
                input,
                init,
                rewrittenUrl,
                apiMatch.conversationId,
              );
        task = responseTask.then((response) =>
          materializeAndOptimizePaginated(
            pageWindow,
            response,
            apiMatch.kind,
            activeMode,
            normalizedRawUrl,
            requestWasClamped,
            createLocalCursor,
          ),
        );
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
        if (typeof oldest !== "string") break;
        localPages.delete(oldest);
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
        pageWindow.setTimeout(() => {
          pageWindow.dispatchEvent(
            new pageWindow.CustomEvent(
              "chatgpt-performance-fix:history-page-settled",
            ),
          );
        }, 0);
        return cloned;
      }
      return cloneMaterializedResponse(pageWindow, materialized);
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
