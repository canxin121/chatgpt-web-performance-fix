# ChatGPT Performance Fix

用于改善 ChatGPT 长会话性能和滚动体验的 Tampermonkey 用户脚本。

## 功能

- 长会话按需加载，减少首次打开时的卡顿。
- 首次打开默认加载最近 2 轮，可改成任意轮数或“全部”。
- 历史消息手动批量加载，可选择 1/2/5/10/20/50 轮、自定义轮数或“全部加载”。
- 保持完整的用户消息与 AI 回复。
- 优化 Markdown、代码块和富文本较多时的滚动与渲染。
- 大型会话数据在后台处理，减少页面和侧边栏卡死。
- 代码较多的历史回复使用轻量代码显示，保留复制和展开。
- 在每条可见用户消息和 AI 回复下方，以低干扰的小徽标显示消息时间和实际使用的模型；历史消息使用服务器时间，新发送消息在服务器回传前使用本地发送时间，并通过模型响应自动校正。
- 脚本自身不做后台网络轮询；已完成会话和侧边栏只手动刷新，正在生成的会话则允许 ChatGPT 自己的状态读取取得最新回复进度。
- 只有检测到真实用户消息请求时才显示发送状态；状态直接附着在该用户消息下方，发送过程中转圈，服务器接受请求后立即显示“✓ 已发送”，不再额外轮询确认持久化。
- 提供完整加载、默认历史数量和模式切换，方便处理兼容性问题。

## 安装

先安装 [Tampermonkey](https://www.tampermonkey.net/)，然后点击：

### [一键安装 ChatGPT Performance Fix](https://raw.githubusercontent.com/canxin121/chatgpt-web-performance-fix/main/dist/chatgpt-performance-fix.user.js)

Tampermonkey 会自动打开脚本安装页面。安装完成后刷新 `https://chatgpt.com/` 即可。

## 使用

正常浏览 ChatGPT 即可。

长会话需要继续查看历史时，顶部会出现历史控制条：

- 下拉框选择每次加载多少轮，支持 `1 / 2 / 5 / 10 / 20 / 50 / 全部 / 自定义`。
- **加载 N 轮**：严格按所选 N 轮加载。第一次服务器历史请求会改成 `num_turns=N`，随后把这 N 轮拆成 1 轮一个的本地 `cgptperf-*` micro-page 依次提交给页面。因此例如“加载 2 轮”只会产生 1 次 `num_turns=2` 的服务器请求，第二轮从内存提交，不会再因为触发两次 pagination callback 变成 4 轮；如果服务器实际返回不足 N 轮，本次有限批次会提前结束，而不会继续请求第二个服务器 cursor 来凑数。
- **全部加载**：持续沿 cursor 加载，直到没有更早的消息。

历史分页的自动触发会被严格拦截：脚本按 `IntersectionObserverEntry.target` 逐项识别 `conversation-pagination-sentinel`，不会再因为 observer 同时复用了其他普通 target 而漏掉分页 sentinel。即使加载 N 轮完成后立即快速上滑，新的 sentinel 进入视口也只会更新“可手动加载”状态，不会自动继续请求；`IntersectionObserver.takeRecords()` 中的分页交叉记录也会同步过滤。

控制条还会自愈 React 的 DOM 时序：sentinel 在 `observe()` 之后才补 `data-testid`、先以 detached 状态注册后再接入页面、被新 sentinel 替换，或控制条本身被 React 清除时，都会重新识别和挂载。若浏览器漏掉初始 IntersectionObserver entry，但 sentinel 的几何位置已经在顶部可见，按钮仍可点击；这个几何后备只改变按钮状态，绝不会自动调用分页 callback 或发请求。

发送新消息时，状态直接显示在这条用户消息的 UI 下方：请求发出时以转圈图标显示 **发送中**；真正的 `/f/conversation` POST 返回 2xx 后立即停止转圈并显示 **✓ 已发送**。流式阶段会识别 ChatGPT 真实的 `section[data-turn="assistant"]` / `.agent-turn` 结构作为额外成功证据。`/f/conversation/resume` 是流式恢复请求，不会再被误当成一次新的用户发送。为了避免额外请求和限流，脚本不再主动轮询 `include_message_id` 或其他详情接口来升级成“已保存”。

消息下方的元信息徽标只消费 ChatGPT 已经返回的会话/流式响应，不会为查找时间或模型再发请求。模型名称优先使用响应中的 `resolved_model_slug`，其次使用消息记录或发送请求中的模型字段；用户消息会从其后对应的可见 AI 回复推断模型。徽标跟随消息角色对齐，悬浮可查看完整字段，打印时自动隐藏。若不需要显示，可在 Tampermonkey 菜单中选择 **隐藏消息时间与模型**。

当前会话的初始数据也不再自动从网络刷新。第一次打开会请求一次类似：

```text
/backend-api/conversations/{id}?include_has_versions=true&num_turns=2
```

这个接口用于读取指定会话的初始/最新消息窗口：`num_turns=2` 要求最近 2 个用户回合，`include_has_versions=true` 让响应保留消息版本信息。它不是发送消息接口。ChatGPT 会用它打开会话，也可能用它重新校验当前会话状态。

脚本只把**明确已完成且空闲**的 2xx 响应保存在当前页面会话的内存快照中。对这种稳定会话，ChatGPT 后续即使每隔十几秒重新校验也只会取得本地副本，不再次访问服务器；快照没有时间 TTL，最多按 LRU 保留 32 个会话。

正在生成、流式输出、异步任务运行中，或无法确认完成状态的响应不会进入长期快照。此时脚本仍会合并同一时刻的并发重复请求，但下一次顺序读取会到服务器取得最新回复进度；一旦读到完成态，才固定新的空闲快照并停止后续周期请求穿透。脚本本身没有添加定时器或轮询器。发送、编辑、恢复流以及 `/async-status` 活跃/完成状态转换会使对应会话的旧成功快照失效，而且用请求世代号阻止“发送前已经在途的旧响应”稍后重新写回缓存。

切换更早历史仍由上面的手动加载按钮控制。若会话是在另一设备或标签页被修改，直接刷新浏览器页面即可重新加载当前会话并取得一次服务器快照；脚本不再提供功能重复的“刷新会话”按钮。

侧边栏列表同样不做自动网络刷新。侧边栏只增加一个 **刷新侧栏** 按钮，只有点击时才请求一次最近会话列表；当前会话不在列表中时，最多再补一个 `num_turns=1` 详情请求。脚本不会在侧边栏添加“运行中”等状态徽标或其他状态展示。

如果会话初始请求或手动侧边栏刷新返回 `429 Too Many Requests`，脚本会遵守 `Retry-After`，并至少退避 2 分钟。会话初始请求在退避期内会直接复用本地的 429 响应，也不会因分页接口 429 而立刻回退请求更重的旧版全量接口。

手动侧边栏刷新不会使用裸 `window.fetch`。ChatGPT 原生 `/backend-api/...` 请求带有自己的认证/会话请求上下文；脚本只在内存里克隆最近一次原生认证 Request 的 Headers 与 credentials，用于手动刷新。脚本不会把认证值写入 localStorage、DOM 或日志。

历史分页响应在网络完成后会短暂让出主线程，但这个等待现在有 **250ms 硬上限**。即使长会话一直拿不到足够的 `requestIdleCallback` 空闲预算，响应也会强制交回 ChatGPT，不会出现“F12 里请求早已结束但 UI 永久转圈”。缓存命中和错误路径也都会显式结束当前手动批次；加载下一页前还会等待 ChatGPT 重新建立新的分页 observer/cursor 世代，避免拿旧 sentinel 抢跑。

Tampermonkey 菜单提供：

- **加载全部消息**：临时使用 ChatGPT 原始完整加载方式，重新打开当前会话并加载全部消息。
- **默认打开：N 轮 / 全部**：设置打开会话时默认渲染的历史量。默认是最近 2 轮；选择“全部”会增加首次渲染开销。
- **历史批量：N 轮 / 全部**：设置“加载更多”的默认批量大小。
- **隐藏/显示消息时间与模型**：切换每条消息下方的元信息徽标。
- **切换模式**：在 `balanced`、`aggressive`、`off` 之间切换。

默认使用 `balanced`。

## 开发

需要 [Bun](https://bun.sh/)。

```bash
bun test
bun run build
```

浏览器回归：

```bash
bun run test:browser
```

部分分析和回归测试依赖本地抓包数据；缺少这些数据时会自动跳过，不影响正常构建和基础测试。

## 隐私

仓库不包含真实用户会话、Cookie、Token 或其他登录信息。

本地分析所需的 WACZ/WARC、会话抓包和提取资源应放在 `.private/` 下，该目录已被 Git 忽略。

## 项目结构

```text
src/       核心源码
scripts/   构建脚本
tests/     测试与浏览器回归
analysis/  分析工具和脱敏结果
bench/     基准测试
docs/      技术说明
dist/      可安装用户脚本
```

技术细节见 [`docs/technical-notes.md`](docs/technical-notes.md)。

## License

[MIT](LICENSE)
