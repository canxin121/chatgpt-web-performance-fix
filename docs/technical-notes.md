# ChatGPT Web 超长会话、向上分页与富文本卡顿分析报告

## 结论

录制版本的卡顿来自三条不同但相互放大的路径。

### 打开会话

1. 分页实验参数 `num_turns` 为 `0` 时，前端回退到旧版全量 `/backend-api/conversation/{id}`。
2. 单次解码后的 JSON 为 11,398,475 B，包含 5,405 个映射节点。
3. 前端先对 `Object.values(mapping)` 中的全部节点执行客户端树水合，包括 1,685 个不在当前活动分支中的节点。
4. 当前活动分支仍有 3,720 个节点，其中 3,460 个左右是工具调用、工具结果或内部思考。
5. 每次页面捕获还会请求两遍结构相同的全量会话，重复网络、解压和 JSON 处理。

### 向上滚动加载历史

1. 分页 sentinel 只提前 80px 触发，用户几乎滚到硬顶端时才开始加载。
2. 一个分页响应可以包含数百条工具节点；录制中的最重单回合含 773 条消息、约 1.40 MB。
3. 响应到达后，前端逐条 `prependNode` 修改会话树。
4. 整页前插被包在一次 `ReactDOM.flushSync` 中。
5. `flushSync` 后立即读取新的 `scrollHeight`，强制浏览器完成 React commit、样式计算和布局，再同步修正 `scrollTop`。
6. 前插结束后又更新分页状态，触发额外订阅和渲染工作。

### 单条消息包含大量代码块 / 富文本

1. 录制中的可见最终回复已经包含真实压力样本：最重一条有 **36 个 fenced code blocks**；第二重一条有 **30 个代码块和 24 行 Markdown table**。
2. `SmoothedMarkdown` 不直接显示当前完整文本，而是以 16ms 为基础周期通过 `requestAnimationFrame` 推进少量字符，每次都重新进入 Markdown 渲染。
3. 每个 `SmoothedCodeBlock` 在 CSS `@starting-style` 中从 `height:0; opacity:0` 开始，因此用户先看到空的薄横条。
4. 平滑阶段每个代码块还单独创建 `ResizeObserver`，测量高度/宽度并维护 `SmoothingOverlay` 与高度动画状态。
5. 普通内联代码块会懒加载 `CodeBlockEditorPane`；即便最终是只读模式，仍继续加载 `CodeBlockEditor` 并创建独立的 CodeMirror `EditorState` 和 `EditorView`。共享 chunk 完成后，大量 Suspense 边界会集中恢复。

这解释了第三类现象：很多代码块先只剩薄横条，随后主线程被 Markdown 重解析、几十个 ResizeObserver、CodeMirror 状态/语法扩展、布局和绘制共同占满，最后整批内容突然出现。

这正好解释了用户观察到的现象：网络可能很快，但每次旧消息出现之前主线程会停顿数秒；页面不是边滚动边自然出现内容，而是在接近顶端后执行一次大规模同步提交。

版本 0.1.0 保留真正会话懒加载，并进一步绕过“先拿全量再压缩”这条路径：当页面准备请求旧版 `/conversation/{id}` 时，脚本优先改道到 ChatGPT 自己的原生分页 `/conversations/{id}?num_turns=2`，把返回值转换成前端原生分页状态。因此正常支持分页的会话首次打开只取最新一个回合，更早历史保留 cursor，但只有用户点击“加载更多”后才请求。

### 后续 WACZ + Chrome Trace 复核

第二组独立抓包进一步确认了卡死的真实传播链：

- 五分钟 WACZ 中，主会话旧版全量接口被请求 **15 次**，每次解码约 **9.16 MB / 4000 个 mapping 节点**，累计解码约 **131 MB**；多次响应内容完全相同。
- Chrome Trace 中，两次完整全量请求分别耗时约 **6.2 秒**和 **7.3 秒**。第一次响应结束后约 **22 ms** 就进入一次 **24.85 秒**的 renderer 主线程任务。
- 最重调用落在 React reconciler / commit 主循环；另一次 **6.4 秒**任务落在 React scheduler。侧边栏和消息区共享同一个 renderer 主线程，所以消息提交会让整个界面一起冻结。
- Trace 中 `UpdateLayoutTree` 累计约 **39.5 秒**、`Layout` 约 **5.76 秒**。CodeMirror 相关函数在最重任务样本中可归因约 **9.8 秒**。
- Adobe Acrobat 浏览器扩展也向 ChatGPT 注入了脚本，在最重任务样本中可归因约 **5.6 秒**，多次读取分享按钮位置并强制布局。该部分不属于页面脚本可安全控制的范围。

这组证据还说明仅包装 `window.fetch` 不够：ChatGPT 可能在用户脚本完成安装前保存原生 fetch 引用，后续请求绕过包装。0.1.0 因而增加第二道 `Response.prototype.json/text` 兜底；即使网络请求绕过 `window.fetch`，完整会话在进入 React 前仍会被压缩。

## 录制文件概况

本地文件：

```text
.private/captures/chatgpt_session.wacz
```

WACZ 由 ArchiveWeb.page 0.16.2 创建，包含同一会话的两次页面捕获。WACZ 压缩包约 43 MB，请求索引共 919 条记录、741 个唯一 URL。

| MIME | 记录数 | WARC 压缩体积 |
|---|---:|---:|
| JavaScript | 634 | 20.49 MiB |
| JSON | 97 | 11.81 MiB |
| HTML | 2 | 解码后每页约 536 KB |

分析所用的格式化会话 Bundle：

```text
.private/extracted/conversation-small.pretty.js
```

## 全量会话响应规模

旧版会话接口每次返回：

| 指标 | 数值 |
|---|---:|
| 解码后的 JSON | 11,398,475 B |
| `mapping` 节点 | 5,405 |
| 有消息节点 | 5,404 |
| 当前活动链 | 3,720 |
| 非活动分支节点 | 1,685 |
| 活动用户消息 | 16 |

活动链主要类型：

| 类型 | 节点数 | 序列化消息体积 |
|---|---:|---:|
| `assistant/code` | 1,785 | 约 4.42 MB |
| `tool/code` | 1,675 | 约 1.88 MB |
| `assistant/thoughts` | 101 | 约 248 KB |
| `tool/text` | 62 | 约 229 KB |
| `assistant/text` | 62 | 约 156 KB |
| `user/text` | 16 | 约 19 KB |

多数 `assistant/code` 是工具调用参数，多数 `tool/code` 是工具返回。它们对模型上下文有意义，但服务器已经保存；作为很久以前的浏览器历史记录，没有必要全部重新水合和渲染。

## 重复请求证据

两次页面捕获各出现两次全量会话 GET，总计四次：

- 第一次捕获：约 00:52:37 与 00:52:48。
- 第二次捕获：约 00:55:14 与 00:55:27。

四次响应均为 11,398,475 B；`mapping` SHA-256 完全一致。移除 `safe_urls` 和 `blocked_urls` 后的稳定载荷哈希也完全一致；URL 集合相同，只是顺序不同。

准确结论是：**每次页面打开或捕获发生两次相同会话树请求，WACZ 的两次捕获共记录四次**。

证据文件：

```text
analysis/output/duplicate-requests.json
```

## 前端代码路径

### 原生分页已经存在

格式化 Bundle 中：

- `24765` 行附近：初始分页请求 `/conversations/{conversation_id}`，带 `num_turns`。
- `24823` 行附近：历史分页请求 `/conversations/{conversation_id}/messages`，带 `before` cursor 和 `num_turns`。
- 分页响应被转换成线性树并附加 `__paginatedConversationPage` 状态。

分页实验开关位于：

- `24911` 行：`pl("2605344799").get("num_turns", 0)`。
- 只有值大于 0 才走分页。
- `24940` 行：否则回退到旧版全量 `/conversation/{conversation_id}`。

带 `message` 或 `messageId` 的深链接会主动禁用分页；0.1.0 脚本保留了这一保护，并对带 `include_message_id` 的原生请求也不做压缩。

### 全量映射被立即水合

- `23935` 行：`tv(e)` 开始把服务端会话转换为客户端树。
- `23947` 行：直接执行 `Object.values(e.mapping).map(...)`。

因此 1,685 个非活动分支节点也会创建客户端对象、复制消息、合并 moderation 元数据。随后：

- `31010` 行：`trt(e)` 再次取得客户端树。
- `31013` 行：`getBranch().map(...)` 扁平化完整活动链。

录制中的活动链长度是 3,720，后续消息分组、React 元素构造和 DOM 工作都以它为输入。

### 向上分页的同步卡顿点

最关键代码位于 `236708–236753` 行：

```js
let oldHeight = scrollContainer.scrollHeight;
let oldTop = scrollContainer.scrollTop;
flushSync(prependWholePage);
let restoredTop = oldTop + scrollContainer.scrollHeight - oldHeight;
scrollContainer.scrollTop = restoredTop;
updatePaginationState(...);
```

具体行为：

- `236714–236720`：等待整个历史页网络响应。
- `236729–236736`：准备调用 `W$e`，它会逐条把本页消息前插进树。
- `236739–236740`：读取旧 `scrollHeight` 和 `scrollTop`。
- `236741`：`flushSync(l)`，强迫 React 同步完成整页提交。
- `236742–236744`：立即读取新 `scrollHeight`，强制布局，再同步写入 `scrollTop`。
- `236748–236753`：另行更新 cursor、loading 和 URL 集合等分页状态。

即使网络响应已经在后台准备好，React、消息分组、Markdown/代码组件构造、样式计算和布局仍会集中在这一同步区间。工具密集型页面越大，停顿越明显。

### 分页触发得过晚

分页 sentinel 位于 `236788–236873` 行：

```js
new IntersectionObserver(callback, {
  root: scrollContainer,
  rootMargin: "80px 0px 0px",
});
```

顶部只预留 80px，几乎没有足够时间在用户抵达顶端前完成网络和渲染。大页 `flushSync` 因而直接出现在活跃滚动期间。

### 未发现消息列表虚拟化

对 Bundle 搜索：

| 标记 | 出现次数 |
|---|---:|
| `react-virtuoso` | 0 |
| `useVirtualizer` | 0 |
| `@tanstack/virtual` | 0 |
| `VariableSizeList` | 0 |
| `FixedSizeList` | 0 |
| `content-visibility` | 1 |

唯一的 `content-visibility` 位于广告拦截检测函数，不是消息渲染优化。搜索不到标记不能形式化证明不存在任何自研窗口化，但结合全量树水合、完整活动链和 DOM 行为，可以确认录制构建没有使用这些常见方案，也没有给消息节点应用浏览器原生屏外跳过。

## 0.1.0 修复设计

### 富文本 / 代码块渲染修复

#### 1. 关闭 16ms 的合成 Markdown 平滑循环

`.private/extracted/richtext/core-pretty/2afb55f3-lofadpw8ciylwivb.js` 中：

- `18168–18181` 行的 `vP()` 只通过 `document.visibilityState` 判断是否启用 smoothing。
- `18187–18225` 行的 `xP()` 使用递归 `requestAnimationFrame`。
- `18276` 行明确设置 `TP = 16`。
- 当 `vP()` 返回 false 时，`18211–18213` 直接执行 `i(e.length), o([])`，也就是立即显示当前收到的完整文本，而不是继续人工逐字符推进。

0.1.0 在 `document-start` 时包装 `visibilityState` getter，但只在调用栈来自稳定模块前缀 `/2afb55f3-` 时返回 `hidden`。因此 SmoothedMarkdown 会走它自己的原生快速分支；页面其他代码仍读取到真实的 `visible`。Chrome 探针验证为：普通读取=`visible`，同名 SmoothedMarkdown chunk 读取=`hidden`。

#### 2. 移除“薄横条”阶段

SmoothedMarkdown CSS 的 `@starting-style` 对 `SmoothedCodeBlock[data-animate-height]` 设置 `opacity:0; height:0`。0.1.0 对代码块动画期强制：

```css
height: auto !important;
min-height: 3.25rem;
opacity: 1 !important;
transition: none !important;
```

同时覆盖 `ClipText` 的内联高度并隐藏 `SmoothingOverlay` / `FixedSmoothingOverlay`。Chrome 中人工设置 `height:0;opacity:0` 的代码块最终得到正常高度、opacity=1，ClipText 展开、overlay=`display:none`。

#### 3. 取消每代码块的平滑 ResizeObserver

`18442–18490` 行的 `IP()` 在 smoothing 时为每个代码块创建一个 `ResizeObserver`，根据内容尺寸不断写 React state 并生成遮罩动画。0.1.0 只识别：

```text
SmoothedCodeBlock > ClipText > span.block
```

这一特定观察目标并跳过 `observe()`；所有其他 ResizeObserver 仍透传原生实现。Chrome 按录制中真实最重消息的 **36 个代码块**规模验证：36 次平滑观察全部被跳过，随后观察普通元素时原生调用计数正常从 0 变成 1。

#### 4. 拆散 CodeMirror 批量布局 / 绘制

`.private/extracted/richtext/core-pretty/18e7d84e-j91l5tlq8s5au97e.js`：

- `1485–1493` 行懒加载 `CodeBlockEditorPane`。
- `2630–2653` 行显示普通 code view 也会挂载这个 pane，`isReadOnly` 并不会阻止组件本身创建。

进一步取得的 `CodeBlockEditor` chunk 中，每个实例都会创建 CodeMirror state、语言 compartment，并在 effect 中创建/销毁 `EditorView`。因此几十个 Suspense 边界同时恢复时，会集中创建几十个编辑器 state/view，并进一步触发大量 DOM、测量、布局和绘制。

0.1.0 在 React DOM commit 后通过 `MutationObserver` 捕获代码块、CodeMirror、table、KaTeX 和 preview pane，并用统一的 `requestAnimationFrame` 距离扫描主动预热：

- 新重型节点先标记 `cold`，使用 `content-visibility:auto` 和类型相关 intrinsic size，保留可观察几何但允许浏览器跳过远端内容。
- 普通富文本块的主动预热距离保持 **8000px**；CodeMirror 根据新 Trace 的布局开销单独收紧到 **3000px**。
- 已经在真实视野中的节点立即切成 `hot`；视野外节点按离视口的距离排序。
- 每个 animation frame 最多切换 **3 个普通富文本块 + 1 个 CodeMirror**，避免一次性物化几十个重型节点。
- 冷态 CodeMirror 不再启动自身的 `IntersectionObserver` 和 `ResizeObserver`。只有容器进入 3000px 预热范围并切成 `hot` 后，这两个原生观察器才各恢复一次。
- `hot` 节点使用 `content-visibility:visible` 并保持 hot，不会滚出再滚回时重新从 intrinsic 占位切换成真实内容。
- 这层不能阻止 React effect 创建 CodeMirror 的 JS `EditorState`；它针对的是新 Trace 中最明显的重复几何测量、布局和 paint 峰值。

#### 5. 富文本子块级虚拟化

消息级 `content-visibility` 无法处理“一个可见消息内部有 36 个代码块”的场景。0.1.0 对这些重型子块建立显式 cold/hot 状态：

- `SmoothedCodeBlock`
- CodeMirror 容器
- Markdown table
- KaTeX display math
- `data-code-block-preview-pane`

因此普通富文本块可在 8000px 外逐帧物化；CodeMirror 则只在 3000px 内恢复自己的可见性和尺寸观察，减少不必要的提前布局。

### 首次打开真正懒加载

旧构建在分页实验值为 0 时会直接请求：

```text
/backend-api/conversation/{id}
```

0.1.0 继续使用网络级懒加载，在 `document-start` 的 fetch 边界识别这个请求；若调用方没有显式要求 `include_full_conversation=true`，则先改道到：

```text
/backend-api/conversations/{id}?include_has_versions=true&num_turns=2
```

请求仍保留原有 headers、credentials、cache、redirect、referrer、mode 和 AbortSignal，因此项目会话需要的 `chatgpt-project-id`、会话 owner 等头也不会丢失。

原生响应随后按 Bundle 中 `n1e()` 的实际算法转换：

1. 保留服务器 `current_node`；若当前叶节点是已完成工具结果，再保留它直接依赖的调用消息。
2. 对完成态最新回合删除已经结束且不会显示为正文的工具轨迹。
3. 建立 `paginated-root:{conversationId}` 合成根节点和线性 `mapping`。
4. 将 `messages` 反转为 `messagesLeafToRoot`。
5. 保留 `page_info.start_cursor`，写入 `__paginatedConversationPage.cursor`。
6. 写入 `oldestMessageId`、`safeUrls`、`blockedUrls`、moderation 和 `serverCurrentLeafId`。

这样虽然原调用栈认为自己走的是 legacy loader，`vv()` 随后仍会因为 `__paginatedConversationPage` 存在而执行 `E$e(...)`，启用 ChatGPT 自己的历史分页状态。后续仍使用 `/conversations/{id}/messages?before=...` cursor 链，但 sentinel 的自动相交回调被 0.1.0 截住，只有手动按钮点击才放行一次历史请求。

真实录制会话对比：

| 指标 | 旧版首次打开 | 0.1.0 首次打开 |
|---|---:|---:|
| 会被请求的旧版 JSON | 11,398,475 B | 0 B |
| 会被构建的旧版 mapping | 5,405 节点 | 不构建 |
| 首次网络窗口 | 全部历史 | `num_turns=2` 起步；最终只显示 1 组问答 |
| 最新真实回合服务器消息 | - | 53 |
| 过滤后首屏消息 | - | 4（2 可见 + 2 隐藏 current state） |
| 合成初始 mapping | - | 5 节点；可见角色 `[user, assistant]` |

Chrome 页面级测试同时确认，在原生分页可用时，页面虽然调用了旧版 URL，真正到达服务器的旧版 `/conversation/{id}` GET 次数为 **0**。

### 旧版全量响应压缩仅作为兼容兜底

旧版全量兜底采用更严格的紧急压缩：

1. 从 `current_node` 沿 `parent` 追踪当前活动分支，并移除全部非活动分支。
2. 每个历史回合只保留用户消息和对应的 AI 回复。
3. 当前未完成回合只保留最后一条可见回复、`current_node` 和它的直接父节点，避免把数百个工具调用一起提交给 React。
4. 移除历史 `assistant/code`、`tool/*`、`assistant/thoughts` 和视觉隐藏消息。
5. 按保留顺序重建合法 `parent` / `children`，保持原始 `current_node`。
6. 对完全相同的重复响应计算指纹并复用已经优化的结果，避免再次 JSON.parse 和树压缩。
7. 该兜底同时安装在 `Response.prototype.json/text`，不依赖请求一定经过已包装的 `window.fetch`。

旧压力样本从 5405 节点压到 **35 节点**；新 Trace 对应的 4011 节点样本压到 **39 节点 / 574 KiB**，保留 current_node 及直接父节点。

若原生初始页为空或只包含 turn 碎片但仍给出 cursor，脚本会沿 `/conversations/{id}/messages` 最多继续 9 次，检测 cursor 是否前进，并按 4/8/16/... 逐步扩大窗口；只有确认同一 turn 同时包含 user 与可见 assistant 后才构造首屏。只有原生分页接口返回错误、cursor 无法前进、响应结构无法转换，或用户显式选择“完整加载当前会话一次”时，才会回退旧路径。服务器原始会话完全不变，压缩只影响本次浏览器收到的副本。

### 原生分页服务器批次限制

脚本识别：

```text
/backend-api/conversations/{id}
/backend-api/conversations/{id}/messages
```

0.1.0 不再把 `num_turns=1` 当成完整问答边界。首次页和历史页都从 `num_turns=2` 开始；若返回值仍不包含完整 user + assistant turn，就沿 cursor 按 4/8/16/... 小步扩大窗口，最多到 512，直到补齐同一回合。保留 `before`、`include_has_versions` 等其他查询参数。若调用方使用跨 Realm `Request` 对象，脚本重建 GET 时会保留 headers、credentials、cache、redirect、referrer、mode 和 signal。

限制服务器批次本身还不够，因为单个工具密集型回合仍可能包含数百个节点。因此响应还必须继续压缩和微分页。

### 原生分页历史过滤

对分页 `messages` 数组：

- 正在进行中的初始页完整保留最新回合；完成态初始页只保留可见内容、`current_node` 以及当前工具结果所需的直接依赖。
- 历史页保留用户消息、系统/开发者消息和助手可见正文。
- 删除工具角色消息、发往工具的助手调用、`code`、`execution_output`、`thoughts` 和视觉隐藏消息。
- 保持数组中的时间顺序和服务器 `page_info`。
- 极端情况下若一页全是内部节点，保留一个桥接消息，避免前端无法得到 `oldestMessageId`。

真实最重历史回合：

| 指标 | 原始 | 过滤后 |
|---|---:|---:|
| 消息数 | 773 | **2（user + assistant final）** |
| 序列化消息体积 | 1,399,888 B | 20,444 B |
| 体积下降 |  | 98.54% |

0.1.0 不再按消息条数拆这个回合。过滤器会去掉 6 条 AI 过程性 commentary / recap，只保留该用户问题和最后的 assistant final，因此整个回合一次点击原子提交。

### 浏览器内存微分页

ChatGPT 会把一个 HTTP 响应作为一次 `flushSync` 提交。为了进一步限制单次同步提交，脚本将过滤后的服务器页按时间顺序拆成本地微页：

- 历史分页的唯一切分边界是**用户回合**，不再使用消息条数或字节阈值拆分同一回合。
- 一个完成的历史回合先做语义压缩：保留该 turn 的用户消息，并优先选择最后一个 `assistant channel=final` 作为对应 AI 回复；没有 final 时才保守使用最后一个可见 assistant。
- 过程性 assistant commentary、reasoning recap、工具调用/结果不会单独成为历史 UI 消息。
- 如果后端一次异常返回多个用户回合，本地 cursor 可以把不同回合分开，但每个页始终保持 `user + assistant answer` 原子性。
- 正在进行的初始活动回合不应用这项历史一问一答压缩，避免破坏 live tool state。

微页通过不透明本地 cursor 串联，例如：

```text
cgptperf-<session>-<counter>
```

流程：

1. 第一个响应交付最新微页，并把 `page_info.start_cursor` 替换成本地 cursor。
2. ChatGPT 按原有分页逻辑请求这个 cursor。
3. 脚本从内存返回下一微页，不访问服务器。
4. 最后一个本地微页恢复服务器原始 cursor。
5. 下一次才继续访问服务器历史页。

这不伪造或修改服务器会话，也不会增加网络请求。cursor 页面保留在内存中以支持重试，发生会话写操作时清空。

若服务器异常返回了两个回合，录制数据的完成态初始页：

| 指标 | 原始 | 过滤/微分页后 |
|---|---:|---:|
| 消息数 | 618 | 6 |
| 消息体积 | 1,261,917 B | 50,831 B |
| 本地提交 | 一次提交全部 | 4 + 2，按 user turn 切分 |

### 历史改为严格手动按钮

0.1.0 仍包装 ChatGPT 的分页 `IntersectionObserver`，但**不再自动转发任何 `isIntersecting=true` 的 sentinel 回调**。sentinel 附近插入一个：

```text
加载 N 轮 / 全部加载
```

按钮。行为是：

1. 页面打开、滚轮上滑、触摸、键盘、程序化 `scrollTop` 都不会加载历史。
2. sentinel 已进入原生 80px 观察范围时按钮可点击；若浏览器遗漏初始 IO entry，但 sentinel 几何位置已经位于滚动容器顶部，按钮也会启用。
3. 一次点击只放行一次原始分页 callback，并进入 `aria-busy=true`。
4. 一页历史完成提交后按钮恢复；如果本页还有本地 cursor，下一次点击只读取下一小页。
5. 几何后备只用于按钮可用性和构造一次点击 entry，从不自行调用 callback。
6. observer disconnect 时按钮一起移除，不留下悬空控件。

另有一个只做 UI reconcile 的 MutationObserver：它没有任何 fetch 路径，只处理 sentinel 和控制条的 DOM 生命周期。即使 React 先 `observe(target)` 后补 `data-testid`、先注册 detached target 后接入 DOM、替换 sentinel，或删除脚本插入的控制条，下一帧都会迁移/恢复按钮。sentinel 识别兼容 exact testid 以及包含稳定 `conversation-pagination-sentinel` 片段的变体。

Chrome 验证：自动滚动前=0、程序化滚动后=0、真实滚轮后=0、按钮点击后=1；后补 testid、detached→connected、控制条被删除三种场景均恢复，且用户点击前 callback 始终为 0。

### 空闲预算后再提交历史

服务器历史页和内存微页准备好后，0.1.0 不再仅仅 `requestAnimationFrame` 一次就立即交给 ChatGPT。现在流程是：

```text
paint
  → next task
  → requestIdleCallback
  → timeRemaining() >= 12ms
  → 才 resolve fetch
  → ChatGPT 执行自身 flushSync
```

等待有 12ms idle budget，但设置了 250ms 硬上限：正常情况下用户滚动、点击等任务会先执行；长会话如果持续拿不到足够的 idle slice，也不会让一个已完成的网络响应永远停在“正在加载”。Chrome 对**纯内存本地历史页**同时验证了普通 `setTimeout` 用户任务先于历史 response 完成，以及零 idle budget 时会在 250ms 附近强制交付。

这不能删除 ChatGPT 内部的 `flushSync`，但历史提交现在是用户明确点击后、等待 idle budget、一次只提交一个完整一问一答回合。

### 请求去重和缓存

- 抓包中的 ChatGPT 前端会重复读取当前会话：`session-network-summary.json` 在约 339.5 秒内记录了 17 次旧版会话 GET，后段相同响应的间隔约为 10–22 秒。脚本会把每一次旧版读取改写成 `/backend-api/conversations/{id}?include_has_versions=true&num_turns=2`；旧实现又把合成 lazy 响应标成不可缓存，因此前端的周期重校验会等价地变成用户看到的频繁 `num_turns=2` 网络请求。
- 同一首次请求的并发调用仍共用一个 Promise。只有 Worker 明确证明 `async_status == null`、没有 `in_progress / streaming / pending` 消息且 `current_node` 已完成的 2xx 结果，才按“接口语义 + 会话 ID + 首屏轮数”保存页面会话级内存快照。旧版改写入口和原生 `paginated-initial` 入口分别缓存。
- 初始空闲快照没有时间 TTL，最多按 LRU 保留 32 个会话。生成中、流式、异步运行中以及结构未知的响应不保存长期快照；它们只享受并发 Promise 去重，下一次顺序 GET 必须到服务器取得最新回复进度。第一次读到明确完成态后才固定空闲快照，因此完成会话的后台重校验仍全部变成本地 Response clone。
- 发送消息、编辑会话、恢复流时立即删除对应会话的成功快照；`/async-status` 从 active→inactive 或 inactive→active 时也只失效一次。每个会话有独立请求 epoch，发送前已经在途的旧 GET 即使更晚完成，也不能把过时内容写回快照。状态 POST 不删除本地 `cgptperf-*` 历史微页。
- `/async-status` 同时支持 JSON 和 form-urlencoded body。旧解析器先用 `URLSearchParams` 读取 JSON 字符串且不抛异常，导致 JSON fallback 永远不可达；现在会按正文格式正确解析状态转换。
- 脚本不创建任何当前会话定时轮询。运行态允许 ChatGPT 自身已经发起的状态读取穿透，是为了保持回复实时；空闲态、侧边栏和更早历史仍不自动访问网络。浏览器刷新会创建新页面会话并取得一次新快照，脚本不再提供功能重复的当前会话刷新按钮。
- 若首次轻量分页请求返回 429，脚本不会立即回退请求旧版全量会话；它按 `Retry-After`（最少 2 分钟）暂存该 429，退避期内的重复读取也只克隆本地响应。
- 历史 cursor 页仍使用独立的 5 分钟短期缓存，而且只有手动历史按钮可以开始服务器请求。Response 兜底则按完整响应指纹复用优化结果，内容变化时自动重新处理。
- 重建 Response 时保留 status、headers、`url`、`redirected` 和 `type`。

### 消息本体保持真实，只有富文本子块预热

0.1.0 **移除了旧版脚本对整条 `[data-message-id]` 使用 `content-visibility:auto` 的策略**。原因是现在首次只加载一个回合、历史又严格手动且每次只有一个完整一问一答回合，整个消息列表已经足够小；继续虚拟化整条消息反而会造成用户看到 message intrinsic placeholder 后再跳成真实高度。

现在大型会话明确覆盖为：

```css
[data-message-id] {
  content-visibility: visible;
  contain-intrinsic-size: none;
}
```

真正昂贵的代码块、CodeMirror、table、KaTeX 和 preview pane 才使用 cold/hot 子块调度：cold=`content-visibility:auto`，进入 8000px 预热范围后逐帧切成 hot=`content-visibility:visible`，并保持 hot。Chrome 验证 `richMessageContentVisibility="visible"`，同时 2200px 外的 CodeMirror 已经完成 hot 预热。

## 安全保护

- 正常首次打开优先走原生 `num_turns=2` 作为传输窗口，并验证/补齐 user + assistant turn 边界；不依赖旧版节点数量阈值。
- 原生分页不可用而回退旧版时，小于 250 节点的普通会话不压缩。
- 无法识别 `mapping`、`current_node`、活动链断裂或循环时返回原响应。
- 页面 URL 带 `message` 或 `messageId` 时绕过会话分页/压缩改写，但富文本性能修复仍保留。
- 原生请求带 `include_message_id` 时完全绕过。
- 正在生成或异步执行时完整保留最新回合；完成态只保留可见内容、`current_node` 及当前工具结果所需的直接调用依赖。
- 本地微页保持消息顺序，最终恢复原始服务器 cursor。
- 合成 lazy 初始页只有在明确完成时才使用页面会话级只读快照；正在运行的异步任务不进入成功快照，后续顺序读取可取得最新进度。
- 侧边栏只提供手动“刷新侧栏”，不添加运行状态或其他自定义徽标；当前会话直接使用浏览器刷新，页面菜单仍可“完整加载当前会话一次”。
- 可在 `balanced`、`aggressive` 和 `off` 间切换。
- 不增加第三方网络目标，不上传数据。

## 验证结果

### 结构与体积

| 指标 | 原始 | 平衡模式 |
|---|---:|---:|
| 首次旧版 JSON 网络 | 11,398,475 | **不请求** |
| 首次旧版 `mapping` | 5,405 | **不构建** |
| 首次懒加载消息 | 全历史 | 6 条最新消息 |
| 首次懒加载 mapping | 5,405 | 7 |
| 旧版兜底 `mapping` | 5,405 | 35 |
| 非活动节点移除 |  | 1,685 |
| 历史内部节点移除 |  | 3,583 |
| 新 Trace 兜底 `mapping` | 4,011 | 39 |
| 新 Trace 兜底 JSON | 9.18 MB | 574 KiB |
| 最重历史分页消息 | 773 | 2 |
| 最重历史分页字节 | 1,399,888 | 20,444 |

### Bun 测试

```text
18 pass
0 fail
478 expect() calls
```

覆盖内容：

- 真实 WACZ 的全量压缩节点数和体积。
- 父子链、无悬空引用、原 `current_node` 不变。
- 最新回合和历史可见内容保留。
- 非活动分支及历史工具轨迹移除。
- 小会话、原生分页标记和循环树的安全退出。
- 773 → 2 的真实历史回合一问一答压缩，并验证角色严格为 user + assistant final。
- 618 → 6 的完成态异常初始页压缩；按 user turn 拆成 4 + 2，当前可见页保持一组问答。
- 4 + 2 的 turn 原子分页顺序和重组不变。
- 原生初始响应转换成 legacy-shaped lazy envelope 的父子链、cursor、`current_node` 和 `serverCurrentLeafId`。
- 重复或缺失 message id 时转换失败关闭。
- 全内部异常页的桥接节点。
- 三类 API URL 分类和 `num_turns` 参数重写。

### Bun 基准

已有 30 轮全量路径基准：

| 操作 | 中位数 | 平均值 | P95 |
|---|---:|---:|---:|
| 原始 JSON 解析 | 31.294 ms | 31.377 ms | 36.328 ms |
| 优化后 JSON 解析 | 0.695 ms | 0.696 ms | 1.144 ms |
| 原始树水合模拟 | 3.452 ms | 3.806 ms | 8.039 ms |
| 优化后树水合模拟 | 0.028 ms | 0.030 ms | 0.036 ms |
| 解析、压缩并重新序列化 | 37.393 ms | 37.883 ms | 45.497 ms |

绝对耗时会随系统负载和垃圾回收变化；重要的是数据量和后续工作集下降约两个数量级。真实浏览器还包括 React、Markdown、样式和布局，因此用户可感知收益不等同于纯 JSON 基准。

原始数据：

```text
analysis/output/benchmark.json
analysis/output/pagination-analysis.json
analysis/output/richtext-analysis.json
```

### Chrome 151 页面级联调

最终打包的用户脚本通过 Chrome DevTools 协议运行，服务器返回真实录制会话构造的全量和分页响应。关键结果：

```json
{
  "normalVisibilityState": "visible",
  "smoothedVisibilityState": "hidden",
  "smoothedMarkdownBypass": "enabled",
  "fallbackResponseHook": "enabled",
  "fallbackFirstNodes": 35,
  "fallbackSecondNodes": 35,
  "fallbackCacheHits": 2,
  "fallbackOriginalNodes": 5405,
  "fallbackKeptNodes": 35,
  "firstNodes": 5,
  "lazyInitialVisibleRoles": ["user", "assistant"],
  "nativeInitialVisibleRoles": ["user", "assistant", "user", "assistant"],
  "lazyPaginationEnabled": true,
  "legacyFullGetsBeforeMutation": 0,
  "postMutationSnapshotRefreshed": true,
  "activeSequentialProgressFresh": true,
  "activeResponsesNotSnapshotted": true,
  "completedActiveConversationPinned": true,
  "asyncSequentialNetworkGets": 3,
  "lazyOlderMessages": 2,
  "lazyOlderRoles": ["user", "assistant"],
  "lazyOlderAnswerChannel": "final",
  "lazyOlderOptimizationHeader": "565->2",
  "nativeOlderMessages": 2,
  "nativeOlderRoles": ["user", "assistant"],
  "nativeOlderAnswerChannel": "final",
  "nativeOlderHasNoLocalCursor": true,
  "nativeOlderOptimizationHeader": "773->2",
  "userTaskRanBeforeLocalHistory": true,
  "nativeInitialNumTurns": ["2"],
  "nativeMessagesNumTurns": ["2", "4"],
  "historyButtonExists": true,
  "historyButtonEnabledBeforeClick": true,
  "historyButtonBusyAfterClick": true,
  "historyButtonBusyAfterSettled": false,
  "paginationCallsBeforeUserScroll": 0,
  "paginationCallsAfterProgrammaticScroll": 0,
  "paginationCallsAfterUserScroll": 0,
  "paginationCallsAfterManualClick": 1,
  "missingInitialEntryUsesManualFallback": true,
  "lateIdButtonAppeared": true,
  "removedControlWasRestored": true,
  "detachedControlAppearedAfterConnect": true,
  "manualHistoryClicks": 8,
  "richMessageContentVisibility": "visible",
  "richPrewarmEditorState": "hot",
  "richPrewarmEditorTop": 2200,
  "richColdEditorState": "cold",
  "richTextWarmDistancePx": 8000,
  "codeEditorWarmDistancePx": 3000,
  "codeMirrorIoStayedDeferred": true,
  "codeMirrorIoResumedOnce": true,
  "codeMirrorRoStayedDeferred": true,
  "codeMirrorRoResumedOnce": true,
  "currentNodePreserved": true,
  "responseUrlPreserved": true
}
```

这验证了：

- 普通页面读取 `document.visibilityState` 仍为 `visible`，而从 SmoothedMarkdown 同模块前缀发起的读取为 `hidden`，证明 16ms smoothing bypass 没有全局伪造页面可见性。
- 模拟旧 CSS 的 `height:0;opacity:0` 代码块被直接展开，ClipText 非零高度，SmoothingOverlay 被隐藏，不再出现“薄横条等待”。
- 按录制中最重的 36 代码块规模创建平滑 `ResizeObserver`：原生 observe 计数在这 36 次后仍为 0；对普通元素 observe 后变成 1，证明 wrapper 只过滤目标代码块测量。
- 普通富文本块预热距离为 8000px，CodeMirror 单独收紧到 3000px；冷态 CodeMirror 的 IO/RO 原生 observe 均保持不变，切 hot 后才各增加一次。
- 页面发起旧版 URL 时成功改道到原生初始分页，旧版全量 GET 为 0。
- 首次接口被故意切成回合末尾碎片后，脚本仍补齐到可见 `[user, assistant]`；录制样本最终 mapping 5 节点，其中 2 个不可见节点只为保留 current tool state。
- 首次传输窗口从 `num_turns=2` 开始；若仍只是 turn 碎片，会沿 cursor 补齐当前回合。明确完成的响应固定为本页面会话的内存快照；运行态响应不固定，下一次顺序读取可获得新的服务端进度。
- 即使调用脚本注入前保存的原生 fetch，`Response.json()` / `Response.text()` 兜底仍将 5,405 节点压到 35；三次真实网络响应只优化一次，后两次命中指纹缓存。
- 跨 Realm `Request` URL 重写正确。
- 首次和历史网络都从 `num_turns=2` 起步；碎片压力测试会继续用 4 等更大窗口补齐同一回合，而不是把单条碎片交付 UI。
- 历史完成回合会压缩成严格 `[user, assistant]` 两条，assistant 优先为 `channel=final`；真实 565 消息页和 773 消息页都通过该断言。
- 历史页从 `num_turns=2` 开始，但只有确认得到完整 user + assistant turn 后才交付；同一回合不会生成本地拆分页 cursor，异常超量返回多个回合时本地 cursor 只切在不同 user turn 之间。
- 最后一回合恢复服务器 cursor。
- 消息总顺序不变。
- 历史响应在浏览器绘制后继续等待 `requestIdleCallback` 至少 12ms 空闲预算；纯内存微页也确认普通用户 task 先执行。
- 分页观察器保留原生 80px rootMargin，但所有自动 `isIntersecting=true` 回调都被拦截。页面打开、程序化滚动和真实滚轮后 callback 都保持 0；只有“加载 N 轮”按钮点击后才变为 1。浏览器还覆盖了初始 entry 缺失、后补 testid、detached sentinel 接入和控制条被 React 删除后的恢复。
- 按钮加载时 `aria-busy=true`，历史提交完成后恢复，下一次点击才继续下一本地/服务器微页。
- 空闲会话的并发两次和随后顺序重校验共用同一次服务器初始读取，一小时后仍命中本地快照；transcript mutation 后服务器计数增加到 2，并返回新的 revision，证明旧快照已失效。运行中异步会话前两次读取分别返回 progress 1 与 progress 2，第三次网络读取返回完成态；第四次客户端读取命中刚建立的完成快照，服务器计数保持 3。这同时证明实时进度没有被缓存吞掉，完成后也不会继续穿透网络。
- 429 压力用例中，两次客户端读取都得到 429，但轻量初始接口服务器计数为 1、旧版全量接口为 0，第二次响应带 `x-chatgpt-performance-fix-initial-snapshot: rate-limit-backoff`。
- Response 元数据、手动刷新按钮、缓存隔离和异步会话行为正确。

完整结果：

```text
analysis/output/browser-harness.json
```

## 文件说明

```text
dist/chatgpt-performance-fix.user.js       最终 Tampermonkey 脚本
src/optimizer.ts                           全量、分页过滤和微分页算法
src/chatgpt-performance-fix.user.ts       fetch、手动历史按钮、idle 提交、富文本预热、缓存和 CSS
tests/optimizer.test.ts                    真实 WACZ 结构和顺序测试
tests/browser-harness.ts                   Chrome 页面级测试
analysis/output/benchmark.json             全量基准
analysis/output/pagination-analysis.json   分页压缩指标
analysis/output/richtext-analysis.json     富文本/代码块分析指标
analysis/output/browser-harness.json       Chrome 联调结果
analysis/output/duplicate-requests.json    重复请求聚合证据
analysis/analyze-chrome-trace.py            流式 Chrome Trace 分析器
```

## 已知边界

- 脚本没有修改 ChatGPT Bundle 本身，也没有直接移除内部 `flushSync`；这类运行时猴子补丁很容易破坏 React 一致性。0.1.0 通过严格手动触发、一问一答原子回合、等待 12ms idle budget，以及富文本视野外预热来规避其最昂贵行为。
- 历史工具调用详情和非活动分支默认不进入浏览器副本，可用“完整加载当前会话一次”查看。
- Chrome 联调覆盖数据、网络、cursor 和调度时序，但没有使用用户真实生产登录态进行自动滚动，避免触碰私密会话；真实流畅度仍受具体消息正文、扩展、硬件和后续 ChatGPT 构建影响。
- ChatGPT 是持续更新的闭源应用。接口或 DOM 标记变化时，脚本会尽量失败关闭；仍需通过新的 WACZ 或浏览器 Profile 持续回归。
- 浏览器扩展与 ChatGPT 共用 renderer 主线程。新 Trace 中 Adobe Acrobat 扩展造成约 5.6 秒可归因工作和多次强制布局；脚本无法安全修改其他扩展的隔离世界，建议对 `chatgpt.com` 禁用此类 PDF/网页解析扩展后再比较。

## 隐私说明

WACZ 含有页面正文、接口响应及可能的认证信息。所有分析和测试均在本机完成。不要公开或提交：

```text
.private/captures/chatgpt_session.wacz
.private/wacz/
.private/extracted/
```

## 新抓包中的主线程问题

新的网络抓包和 Chrome Performance Trace 说明，偶发卡顿并不只是网络慢：当页面线程执行大 JSON 解析、历史回合合并、富文本 DOM 测量或代码编辑器初始化时，侧边栏、输入和滚动都会一起停止响应。

这轮修复包括：

- 分页响应以 transferable `ArrayBuffer` 转移到 Worker；JSON 解码、cursor 片段合并、回合压缩和分块均在 Worker 内完成，主线程只接收最终的小型结果，减少临时字符串/对象和 GC。
- 历史 cursor 页面增加短期缓存，避免前端重试时重复下载和处理。
- 移除捕获阶段的全页面 `scroll` 监听；富文本预热改用浏览器 `IntersectionObserver` 和 idle 队列，因此滚动侧边栏不会扫描会话内容。
- 富文本 MutationObserver 只处理消息区域，代码编辑器内部和侧边栏的 DOM 变化不会触发全局查询。
- 对含有大量 fenced code blocks 的空闲首屏/历史回复（包括用户和 AI 消息），Worker 将代码围栏替换为轻量标记；页面使用固定高度的静态 `<pre>` 分批填充，保留复制和展开，不再同步初始化大量 CodeMirror。编辑或发送前会还原原始 fenced Markdown。
- 用户消息中的重型代码也可轻量显示；进入编辑框或发回服务器前会恢复原始 fenced Markdown。
- SmoothedMarkdown 的模块来源从实际代码块测量调用栈动态学习，不再依赖单个固定的前端 chunk 哈希。

脱敏分析结果：

- [`analysis/output/trace-summary.json`](../analysis/output/trace-summary.json)
- [`analysis/output/session-network-summary.json`](../analysis/output/session-network-summary.json)
- [`analysis/output/diagnosis.md`](../analysis/output/diagnosis.md)（修复前诊断）
- [`analysis/output/fix-validation.json`](../analysis/output/fix-validation.json)（修复后自动回归）

这些文件不包含会话正文、Cookie、Token、会话 ID 或绝对抓包时间。原始 Trace/WACZ 始终保存在 `.private/`。
