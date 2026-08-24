# 文件 Tab markdown 预览 — 设计文档

> 目标：文件 Tab 打开 `.md` / `.markdown` 文件时默认渲染 markdown 预览，工具条可切换「预览 / 源码」二态；非 markdown 文件行为不变。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-file-view.md` —— FileView 按文件类型分发 Render Mode 的总设计（Markdown Mode：默认预览态、AppBar 源码/预览切换、渲染范围、不支持 mermaid）
> - 本仓库 `markdown.tsx` —— 消息流 markdown 渲染组件（streamdown + tokens.css 语义令牌覆写），直接复用为预览渲染器（桌面端无 webview 一说，`design-markdown-webview.md` 的动机不适用）

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

## 3. 不做的事

| 项 | 原因 |
|---|---|
| mermaid 图表渲染 | openbuilder 同决策；引入 mermaid 运行时收益低 |
| 模式偏好持久化（记住上次源码/预览） | 文件 Tab 生命周期短；需要时再加 per-profile 偏好 |
| 内部相对链接跳转（md → md 导航） | nice-to-have（openbuilder 同标注），等真实需求 |
| TOC 大纲面板 | 无用户诉求 |
| 预览内容键盘可达（放开链接/复制按钮 tabIndex） | 复用 `Markdown` 继承消息流「内容不入焦点序列」决策（review P3 备注）；后续需要时给组件加 interactive 变体 |

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/workspace.tsx` | FileView：扩展名分发 + markdown mode（工具条 + 预览/源码） |
| `src/renderer/src/i18n/index.ts` | `preview` / `source` 文案 |
| `src/renderer/src/styles/app.css` | `.file-view-wrap` / `.file-toolbar` / `.file-seg*` / `.file-md` |
| `src/renderer/src/components/markdown.test.tsx` 或新测试 | FileView 分发与二态切换组件测试 |

## 5. 验收

- 打开 `.md` 文件默认渲染预览；切换源码显示原文；非 md 文件无工具条、行为不变；
- `npm run test` / `npm run typecheck` 全绿。
