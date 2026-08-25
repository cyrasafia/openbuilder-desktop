# 文件 Tab markdown 预览 — 设计文档

> 目标：文件 Tab 打开 `.md` / `.markdown` 文件时默认渲染 markdown 预览，工具条可切换「预览 / 源码」二态；预览态左侧提供可折叠 TOC 大纲（§2.4）；非 markdown 文件行为不变。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-file-view.md` —— FileView 按文件类型分发 Render Mode 的总设计（Markdown Mode：默认预览态、AppBar 源码/预览切换、渲染范围、不支持 mermaid）
> - 本仓库 `markdown.tsx` —— 消息流 markdown 渲染组件（streamdown + tokens.css 语义令牌覆写），直接复用为预览渲染器（桌面端无 webview 一说，`design-markdown-webview.md` 的动机不适用）
> - TOC 无移动端先例（检索 openbuilder docs 未见大纲/TOC 设计），§2.4 为桌面端新设计

## 1. 问题

`FileView`（workspace.tsx）目前对所有文本文件渲染 `<pre>` 源码。`.md` 文件在桌面端只能看源码，阅读体验差——仓库内大量设计文档/README 的首要消费方式就是渲染阅读。

## 2. 设计

### 2.1 渲染分发（dispatch）

| 扩展名（大小写不敏感） | Render Mode |
|---|---|
| `.md` / `.markdown` | **markdown**：默认预览态 + 工具条二态切换 |
| 其他（现状） | 纯文本源码（v0.2 后续功能再引入代码高亮） |

- 扩展名取 basename 最后一个**非前导**点的后缀：无扩展名、点文件（名字恰为 `.md`）不命中；`.mdx` 不识别（openbuilder 同决策）。
- 分发只按扩展名，不嗅探内容（`GET /file/content` 返回 `{type:"text", content}` 包装，服务端已判定文本性）。

### 2.2 markdown mode

- **默认预览态**；`<FileView key={tabKey}>` 隔离——Tab 切换/重开、同实例换文件均重置（与 ChatView 草稿隔离同模式），模式为组件局部 state，不持久化（与移动端 peek 封存模式不同，桌面端文件 Tab 生命周期短，重开成本为零）。
- **工具条**：FileView 顶部右对齐的分段开关（预览 / 源码），markdown 文件**常驻渲染**（含 loading/error 态——避免内容落地时工具条弹入的布局跳动）。分段控件复用 `.ms-segmented`/`.ms-seg`（单一来源）；语义用 `role="group"` + `aria-pressed` 分组按钮，不冒充 tabs（无方向键导航）。预览体复用消息流 `Markdown` 组件渲染。
- **源码态**：沿用现有 `<pre className="file-content mono">`（后续「代码浏览行号+语法高亮」功能覆盖文本文件后自然升级）。
- **布局**：FileView 根改为列 flex（工具条 + 滚动层）；预览体限宽居中（`max-width 820px`，与聊天区 `--chat-max: 800px` 同一阅读度量级）；覆写 `.md-pre` 高度上限（消息流 300px 内滚在文档预览中放开——渲染阅读优先，长代码块不套内滚）。

### 2.3 渲染范围与链接行为

- streamdown 解析集：标题/表格/列表/任务列表/代码块/链接等（同消息流，无额外配置）。
- 链接 → 系统浏览器（`Markdown` 组件既有 `target="_blank"` + main 进程 `shell.openExternal`）。
- **相对路径图片不支持**（`<img src>` 相对路径无 base URL 可解析，openbuilder 亦未支持）——坏图即 broken icon，不在本功能内解决。

### 2.4 TOC 大纲列（2026-08-25 增补）

预览态内容左侧增加目录侧栏（此前在 §3「不做」中标注"无用户诉求"，诉求出现后纳入）。

- **布局**：`.file-md-layout` 行 flex = TOC 列 + 内容滚动列。TOC 整列占据左侧（固定宽 240px、列内自滚、全高始终可见）——「吸顶」语义由全高列满足，**不用 sticky + 视口高度魔法值**（工具条/标题栏高度会随版本漂移，calc 补偿是脆弱契约）。内容列限宽居中不变。
- **数据来源**：预览体落地后 DOM 扫描 `h1–h6`（`collectHeadings`），不解析源文本、不侵入消息流共享的 streamdown 管道——标题元素即锚定目标，无 id 注入（streamdown 块级 memo 下渲染期注入序号 id 不可靠）。代码块内的 `#` 行不会被解析为标题元素，天然排除。若扫描时渲染未完成（streamdown 内部延迟），MutationObserver 观察 DOM 变更补扫。
- **章节树**：扁平标题按「更浅的最近前驱」归并为树（栈式，支持跳级：h1 后直接 h3 挂 h1 下）。有子节点的条目带折叠 chevron（默认全展开），叶子条目占位对齐。内容更换后折叠态重置（旧元素引用失效）。
- **整栏收起/展开**：收起为 40px 窄轨（单个展开按钮），展开恢复；状态为组件局部 state（随 Tab key 隔离，不持久化，同预览/源码模式）。无标题的文档不渲染 TOC，布局回落单列。
- **锚定**：点击条目 `scrollIntoView({ behavior: "smooth", block: "start" })`；标题 `scroll-margin-top: 8px` 留白。
- **不做滚动位置高亮（scrollspy）**：锚点是消费主体，active 追踪是增量收益，等真实诉求。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| mermaid 图表渲染 | openbuilder 同决策；引入 mermaid 运行时收益低 |
| 模式偏好持久化（记住上次源码/预览） | 文件 Tab 生命周期短；需要时再加 per-profile 偏好 |
| 内部相对链接跳转（md → md 导航） | nice-to-have（openbuilder 同标注），等真实需求 |
| TOC 滚动位置高亮（scrollspy） | 见 §2.4：锚点是消费主体，增量收益有限 |
| 预览内容键盘可达（放开链接/复制按钮 tabIndex） | 复用 `Markdown` 继承消息流「内容不入焦点序列」决策（review P3 备注）；后续需要时给组件加 interactive 变体 |

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/workspace.tsx` | FileView：扩展名分发 + markdown mode（工具条 + 预览/源码）+ TOC 标题扫描与布局 |
| `src/renderer/src/components/md-toc.tsx` | TOC 侧栏：标题收集/章节树/按章节折叠/整栏收起/点击锚定 |
| `src/renderer/src/i18n/index.ts` | `preview` / `source` / TOC 文案 |
| `src/renderer/src/styles/app.css` | `.file-view-wrap` / `.file-toolbar` / `.file-seg*` / `.file-md` / `.file-md-layout` / `.md-toc*` |
| `src/renderer/src/components/file-view.test.tsx` / `md-toc.test.tsx` | FileView 分发与二态切换 + TOC 行为测试 |

## 5. 验收

- 打开 `.md` 文件默认渲染预览；切换源码显示原文；非 md 文件无工具条、行为不变；
- 有标题的 `.md` 预览左侧出现 TOC：可按章节收起/展开、整栏可收起为窄轨并恢复、点击条目平滑滚动锚定到对应标题；无标题文档无 TOC；源码态无 TOC；
- `npm run test` / `npm run typecheck` 全绿。
