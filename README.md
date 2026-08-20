# ChatGPT Performance Fix

用于改善 ChatGPT 长会话性能和滚动体验的 Tampermonkey 用户脚本。

## 功能

- 长会话按需加载，减少首次打开时的卡顿。
- 历史消息手动加载，避免滚动时自动触发大量渲染。
- 保持完整的用户消息与 AI 回复。
- 优化 Markdown、代码块和富文本较多时的滚动与渲染。
- 大型会话数据在后台处理，减少页面和侧边栏卡死。
- 代码较多的历史回复使用轻量代码显示，保留复制和展开。
- 提供完整加载和模式切换，方便处理兼容性问题。

## 安装

先安装 [Tampermonkey](https://www.tampermonkey.net/)，然后点击：

### [一键安装 ChatGPT Performance Fix](https://raw.githubusercontent.com/canxin121/chatgpt-web-performance-fix/main/dist/chatgpt-performance-fix.user.js)

Tampermonkey 会自动打开脚本安装页面。安装完成后刷新 `https://chatgpt.com/` 即可。

## 使用

正常浏览 ChatGPT 即可。

长会话需要继续查看历史时，点击顶部的 **加载更多**。

Tampermonkey 菜单提供：

- **完整加载一次**：临时使用 ChatGPT 原始完整加载方式。
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
