# ChatGPT Performance Fix

一个用于改善 ChatGPT 长会话性能的 Tampermonkey 用户脚本。

当前版本固定为 **0.1.0**。

## 功能

- 更快打开长会话，避免一次性加载全部历史。
- 历史消息改为手动“加载更多”，避免滚动时自动卡顿。
- 每次加载保持完整的用户消息和 AI 回复。
- 优化大量 Markdown、代码块和富文本的滚动体验。
- 保留安全回退方式，需要时可完整加载当前会话。

## 安装

1. 安装 Tampermonkey。
2. 打开 `dist/chatgpt-performance-fix.user.js`。
3. 在 Tampermonkey 中安装并刷新 `https://chatgpt.com/`。

## 使用

会话顶部出现 **加载更多** 时，点击后继续加载历史。

Tampermonkey 菜单提供：

- **完整加载一次**：临时使用 ChatGPT 原始完整加载方式。
- **切换模式**：在 `balanced`、`aggressive`、`off` 之间切换。

默认推荐 `balanced`。

## 开发

需要 Bun。

```bash
bun run build
bun test
```

浏览器回归：

```bash
bun run test:browser
```

如果本机没有私有抓包数据，依赖抓包的测试和浏览器回归会自动跳过。

## 私有数据

真实会话抓包、WACZ/WARC、登录态资源和解包后的前端文件只保存在本机 `.private/` 中，并被 Git 完全忽略。

本地目录约定：

```text
.private/
  captures/   原始 WACZ
  wacz/       解包后的 WARC / index
  extracted/  从抓包中提取的前端资源
```

这些文件不应提交或公开分享。公开仓库只包含源码、测试逻辑、构建产物和已经脱敏的聚合分析结果。

## 目录

```text
src/             核心代码
scripts/         构建脚本
tests/           单元测试和浏览器回归
analysis/        分析工具与脱敏输出
bench/           基准脚本
docs/            技术说明
dist/            可安装用户脚本
.private/        本地私有数据（不进入 Git）
```

更详细的实现记录见 `docs/technical-notes.md`。

## License

MIT
