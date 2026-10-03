# 文件 Tab HTML 预览 — 设计文档

> **（v0.3 已废弃）** HTML 预览已迁移至浏览器 Tab（[design-browser-tab.md](design-browser-tab.md) §1.4）：文件树点击 `.html` 默认开浏览器 Tab（file:// 全能力渲染），右键「查看源码」在文件 Tab 打开源码。本文保留为历史决策记录——sandboxed iframe + CSP 注入方案在桌面端被 WebContentsView 取代（无脚本执行限制不再适用：浏览器 Tab 本就是"执行网页"的语境；本地相对资源加载无需 CSP 放行）。`html-preview.ts` 扫描器与用例已删除。

> 目标：`.html` / `.htm` 文件默认渲染预览（sandboxed iframe），工具条「预览 / 源码」二态与 markdown 预览对齐；源码态走 CodeMirror（lang-html，已具备）。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-html-preview.md` —— CSP meta 注入（`default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:`）、原样渲染不注入主题、不设 baseUrl、raw-text/注释/模板区段跳过的**严格单调单趟扫描器**规格
> - 本仓库 `design-markdown-preview.md` —— 预览/源码二态与工具条（markdown 已落地，html 复用同一交互）

## 1. 问题

`.html` 文件目前与代码文件同路（CodeMirror 源码态），无渲染态。HTML 的首要消费方式是渲染查看。

## 2. 安全模型（与移动端的关键差异）

移动端 WebView 有 JS 桥（文件/滚动），CSP 是唯一执行面防线，注入扫描的严谨性是 P0。桌面端 Electron 用 **`<iframe sandbox srcdoc>`** 渲染：

- `sandbox=""`（全沙箱）：**脚本彻底禁用**（无 `allow-scripts`）、无 `allow-same-origin`（opaque origin，触不到父页面/preload 桥——Electron 默认 `nodeIntegrationInSubFrames: false`，preload 仅主帧加载，iframe 本就无 `window.desktop`）、无 `allow-top-navigation`/`allow-popups`。
- **iframe 自身导航被主进程拦截**（review P2 修复）：sandbox 只拦顶层导航，frame 自身导航（`<a>` 点击、`<meta http-equiv=refresh>`——新文档不携带注入的 CSP，主动外发即绕过）由 `will-frame-navigate`（`!isMainFrame` → `preventDefault`）在主进程禁止（src/main/index.ts）；`will-navigate` 只覆盖主帧，不够。
- **CSP meta 注入仍保留**（纵深防御）：sandbox 不拦子资源加载，注入 CSP 屏蔽外部网络请求（外链图片的跟踪像素/泄露 IP），`img-src data:/blob:` 保内联。
- `referrerpolicy="no-referrer"` 再加一层。

因此注入扫描的残余盲区（属性值内字面 `<head>`、嵌套 `<template>` 早闭后模板剩余内容中的字面标签等——移动端同列）在桌面端后果= CSP 失效 → 外链资源可加载，但脚本仍被 sandbox 禁死——可接受（移动端同盲区标注"影响有限"）。

## 3. 设计

### 3.1 文档构建（`html-preview.ts`）

`buildHtmlPreviewDocument(html): string` —— 单趟线性扫描定位注入点，注入 CSP meta：

- 扫描器移植移动端规格（简化：桌面不注入 viewport——无移动端缩放问题）：
  - 注释 `<!--…-->`（含 `--!>` 变体与 `<!-->`/`<!--->` 突闭）、bogus comment（`<?…>` / 非注释 `<!…>`，止于首个 `>`）跳过；
  - raw text 元素（`script/style/textarea/title/noscript/xmp/noembed/noframes` 与 `template` 内容——模板惰性，其内标签不活跃）整体跳过；闭合判定带终止符校验（`</tag` 后随 `>`/空白/斜杠——`</scriptx` 不闭合、`</script/>` 合法自闭合），未闭合吞到文档尾；
  - `plaintext` 吞到文档尾；
  - 普通标签体以首个 `>` 为界（属性值内字面标签因此不误报——残余盲区见 §2）。
- **解析器忽略语义对齐**：`</head>` 闭合、`<body>` 开标签、或标签间出现非空白文本（隐式 body 已开始）之后的 `<head>` 开标签是被解析器忽略的假标签——不注入；非文档头部（之前已有真实标签/文本）的 `<html>` 同样不作注入点。宁走兜底。
- 注入点优先级：命中真实 `<head…>` 开标签 → 紧随其后；只有文档头部 `<html…>` → 其后补 `<head><meta…></head>`（该位置先于任何 body，恒有效）；其余（片段/假 head）→ 文档首前置（前置 meta 必为 head 子节点，CSP 恒生效，代价仅可能 quirks mode）。
- 文档自带 CSP meta 时不移除（多条 CSP 取交集，更严者生效）。
- 原 HTML **原样渲染**（不注入主题样式）；大小上限 8 MiB（超过跳过扫描直接前置注入，对齐移动端）。

### 3.2 FileView 集成

- 分发：`isHtmlPath`（`.html`/`.htm`，与 isMarkdownPath 同解析规则）→ 预览默认 + 工具条二态（与 markdown 共用 `previewable` 分支与 `mode` state）。
- 预览态：`<iframe className="html-preview" sandbox="" referrerpolicy="no-referrer" srcdoc={doc} title={文件名}/>`；容器 `overflow: hidden`（iframe 自管滚动）。
- 源码态：`CodeView`（lang-html 已映射）。
- markdown 分支逻辑不变。

### 3.3 交互边界（不做的事）

| 项 | 原因 |
|---|---|
| 预览内链接跳转（相对路径开文件 / 外链开浏览器） | 移动端靠 JS 桥；桌面 sandbox 禁脚本 + 主进程拦 frame 导航，链接点击自然失效。需要交互内容看源码态 |
| HTML→净化重排 | CSP + sandbox + 导航拦截已覆盖执行面；重排破坏文档自身样式 |
| 主题适配（暗色兜底） | 文档自带背景 |
| iframe/外链资源放行 | 同 CSP 决策：无 baseUrl、无认证透传，放行即泄露面 |

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/html-preview.ts` | 新：CSP 注入扫描器 |
| `src/renderer/src/components/html-preview.test.ts` | 新：注入点用例（真实 head / 仅 html / 片段 / 注释诱饵 / script 诱饵 / 未闭合 / template / plaintext / 大小上限） |
| `src/renderer/src/components/workspace.tsx` | `isHtmlPath` + previewable 分支（iframe 渲染） |
| `src/renderer/src/components/file-view.test.tsx` | html 分发与二态用例 |
| `src/renderer/src/styles/app.css` | `.html-preview` |

## 5. 验收

- 打开 `.html`：默认渲染预览（无脚本执行、无外部网络请求）；切源码为高亮代码；
- 注入器单测全绿；`npm run test` / `npm run typecheck` 全绿。
