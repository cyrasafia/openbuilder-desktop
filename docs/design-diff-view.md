# Diff 详情页（上一轮 / 未提交 / 分支改动）— 设计文档

> 目标：从新 Tab 引导页进入当前作用域的改动详情——三种来源：**上一轮**（最近会话最后一轮的改动）、**未提交**（工作区 vs HEAD）、**分支**（当前分支 vs 默认分支）。**三种来源集成于单个 diff Tab，页内 segment control 切换**（2026-08-25 修订，原为三入口三 Tab，见 §2 修订说明）。统一 unified diff 渲染：行号 + 语法高亮 + 增删底色，按文件分段、按 hunk 分节。
>
> 参考来源（按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-diff-view.md` —— diff 详情页渲染总设计：`parseDiffHunks` 解析规则（第一个 `@@` 切文件头、内容行只做单字符前缀判定、多文件兜底停止）、**双路重建高亮**（new/old 各整段 tokenize 再映射回行）、底色为主标识 + token 保留语法色、单 gutter 行号策略、hunk 头部（序号 + 行范围 + 增删统计）
> - `openbuilder/lib/features/files/diff_list_screen.dart` —— **移动端正是单页 + `SegmentedButton<DiffMode>` 切换三来源**（默认 `uncommitted`、切换即重拉、重复点击不动作）；本修订（2026-08-25）即对齐该实证形态
> - `openbuilder/docs/design-file-browsing-container.md` —— 移动端 diff 入口与文件浏览容器的关系（桌面端以 Tab 体系对应）
> - 本仓库 `design-code-view.md` —— CodeMirror 6 基础设施（cm-lang 语言映射 / cm-theme class 化 HighlightStyle / --syntax-* 令牌），diff 行高亮直接复用
> - `../openchamber` 的 `@pierre/diffs`（AGENTS.md 实证选型来源）**评估后不采用**：其接口要求整文件 original/modified 内容（本项目只有 patch），且 Shadow DOM 主题桥接成本高（openchamber 为此写了两层注入 CSS）；自研 DOM 渲染 + CM 生态 headless 高亮更薄

## 1. 服务端契约（openapi + 源码 + 本机实测）

| 端点 | 语义 | 返回 |
|---|---|---|
| `GET /vcs/diff?directory=X&mode=git&context=<n>` | 工作区未提交改动 | `SnapshotFileDiff[]` |
| `GET /vcs/diff?directory=X&mode=branch&context=<n>` | 当前分支 vs 默认分支 | 同上 |
| `GET /session/{id}/diff?directory=X&messageID=<user msg>` | **该 user 消息发起的一轮**所做改动（server 侧 `SessionSummary.diff`：读该消息 `summary.diffs`；messageID 缺省或非 user 消息返回 `[]`） | 同上 |

`SnapshotFileDiff = { file, patch, additions, deletions, status: added|deleted|modified }`。

**context 恒显式传值（2026-08-26 修订）**：`/vcs/diff` 的 `context`（hunk 周边保留的未变更上下文行数）**省略时 server 内部默认值大到等价"整文件作 context"**——无论两处改动相距多远都合并成单 hunk、patch 恒为整文件，即"hunk 展示全量文件内容"的根因（移动端先踩过，见 openbuilder 提交 `086e32d` / design-diff-view §DV-CX1：同一症状"展示的总是完整文件内容，而非仅变更部分"，根因不在客户端渲染）。客户端决策：`listVcsDiff` 内缺省 `context = VCS_DIFF_CONTEXT = 3`（对齐 `git diff --unified=3`），调用点不写字面量；`/session/:id/diff` 无 `context` 参数，不受影响。

实测 patch 头两种形态：session diff 为 `Index: f\n====…\n--- f\t\n+++ f\t`（git 无 --git 前缀风格），vcs diff 为 `diff --git a/f b/f\n[new file mode…]\nindex…\n--- /dev/null\n+++ b/f`。hunk 体均为标准 unified。**上一轮的消息定位**：客户端取当前作用域最近会话（updated 降序首个）的最后一条 user 消息 id 作 messageID。

## 2. Tab 模型

**2026-08-25 修订（单 Tab + segment）**：原设计按来源拆三个 Tab（key = `diff\0{type}\0{directory}`），实测形态与移动端 `DiffListScreen` 背离——移动端是单页 + `SegmentedButton` 切换。修订为：

- `TabKind` 含 `diff`；key = `diff\0{directory}`——**每作用域单 Tab**，同作用域重复打开复用。
- 来源类型（`DiffTabType = round|uncommitted|branch`）是 Tab 的**选中状态**而非 Tab 身份：`store.diffSelectedTypes: Map<tabKey, DiffTabType>`（内存，缺省 `uncommitted`，同移动端默认）；`diffTypeFor(tabKey)` 读取、`switchDiffType(tabKey, type)` 切换（重复点击不动作，同移动端 `_onModeChanged` 守卫）。选中跨 Tab 切换存活（store 级），关闭 Tab 清除。
- Tab 标题固定「改动 / Changes」（不随 segment 变，同移动端 AppBar 恒 "Diff"）；segment 用短标签「上一轮 / 未提交 / 分支」（移动端 `diffMode*` 同源）。
- project-scoped：Tab 条按 `directory === scopeDir` 过滤显示（同 chat）；关闭项目/删工作区/关 global 目录时关闭其 diff Tab（不归档——归档语义仅 chat）。Tab 记忆（scope-tab-memory）只收 chat，diff 不入记忆（每次按需打开）。

## 3. 数据流

- store：`diffData: Map<dataKey, { files: SnapshotFileDiff[]; error?: string; loading?: boolean }>`，**dataKey = `diff\0{type}\0{directory}`**（`diffDataKey`）——三种来源独立缓存，segment 切换互不丢数据，切回已加载来源以缓存作首帧；`openDiffTab()`（开/复用 Tab + 激活 + 按选中来源触发加载）；`switchDiffType`（更新选中 + 加载该来源）；`loadDiffTab(type, directory)`：
  - `uncommitted|branch` → `listVcsDiff`；
  - `round` → 作用域最近会话 → `listMessagesPage(limit 100)` 取最后一条 user → 无 user 消息或无会话 = 空态；有则 `listSessionDiff(messageID)`。
- **激活即重拉当前选中来源**（同 FileView）；segment 切换即拉对应来源（同移动端）；失败显示错误 + 重试按钮；空 diff 显示「无改动」（`round` 且作用域无会话时显示「当前作用域暂无会话」——2026-08-25 修订前该文案只作禁用入口 tooltip）。
- 关闭 Tab 卸载该目录全部三来源缓存与选中（重开走 `loadDiffTab`）。

## 4. 渲染（`diff-view.tsx`）

### 4.1 解析层（`src/shared/diff-parse.ts`，纯函数）

移植移动端 `parseDiffHunks` 规则：

- 以第一个 `@@` 为文件头/内容分界（`diff --git`/`Index:`/`---`/`+++` 全部丢弃——根治 `+++` 误判为增行）；
- hunk 内只做单字符 `+`/`-`/空格 判定（**绝不**再判 `+++`/`---`——added `++i`（raw `+++i`）是合法内容行）；
- `@@ -o,ol +n,nl @@` 解析出 old/new 起始行号，行号随 kind 推进（oldNo/newNo）；
- 多文件兜底：内容行产不出 `diff `/`Index: ` 前缀，遇之即停（防御 patch 意外含多文件）；
- `\ No newline at end of file` 丢弃（机读噪声，移动端同决策）；
- 产物：`{ oldStart, newStart, additions, deletions, lines: [{ kind, text, oldNo?, newNo? }] }[]`。

### 4.2 高亮层（双路重建，headless CodeMirror）

- 每 hunk 重建 new 路（context + added，按序）与 old 路（context + removed）两份完整代码；
- `EditorState.create({ doc, extensions: [languageForPath(file)] })` + `ensureSyntaxTree(state, doc.length, budget)` → `highlightCode(code, tree, classHighlighter, putText, putBreak)`（`@lezer/highlight` 官方编辑器外高亮 API，classHighlighter 即 cm-theme 的 class 化 HighlightStyle——**同一张 tag→class 表**，零复制）；
- 产物按行收集 `{text, cls}[]`，双游标映射回 hunk 行（context 取 new 路）；
- 未知语言 / 高亮超时 → plain mono（底色与行号照常）；
- 大文件防护：单文件 patch > 512 KiB 跳过高亮（纯文本渲染）；`useMemo` 按 patch 缓存。

### 4.3 视图层

- **顶部 segment 工具条（2026-08-25 修订）**：`.diff-toolbar` 常驻渲染（同 `.file-toolbar` 决策——loading/error 态也渲染，避免内容落地时工具条弹入的布局跳动）；分段控件复用 `.ms-segmented`/`.ms-seg`（单一来源，不另起一套，同 FileView 预览/源码切换）；`role="group"` + `aria-pressed` 分组按钮（不冒充 tabs，无方向键导航）。三段 = `round|uncommitted|branch`，短标签。
- 文件块（可折叠，chip 头部模式）：状态图标（added +/deleted −/modified M）+ 文件路径（mono）+ `+N −N` 统计；折叠只渲染头部。
- **查看文件（2026-08-27 增补）**：文件块展开时，头部下方右对齐「查看文件」按钮（`btn-tonal` + ExternalLink 图标），点击在新 Tab 打开该文件的 CodeView，并锚定至首个 hunk 的 `newStart` 行（1-based）。实现链：`store.openFileTab(absolutePath, revealLine)` → `TabEntity.revealLine` → `FileView` → `CodeView.revealLine` → CodeMirror `EditorView.scrollIntoView(pos, { y: "center" })`。路径拼接 = `directory + "/" + file.file`（file.file 为相对路径）；无 hunk（二进制）时 revealLine = undefined（仅打开文件、不锚定）。复用已开同路径 Tab 时更新 revealLine（重新激活后 FileView 消费）；revealLine 携带时 FileView 强制源码模式（行锚定仅对 CodeView 有意义）。
- **hunk 右键菜单（2026-08-27 增补）**：hunk header 与 hunk body 绑定 `onContextMenu`，右键弹出 `DiffHunkContextMenu`（复用 `FileContextMenu` 模式：createPortal + 首帧隐藏测量钳制 + capture 四触发关闭 + 浮层计数），单项「查看文件」→ `openFileTab(abs, hunk.newStart)` 锚定至该 hunk 首行。与文件块「查看文件」按钮的区别：按钮锚定首个 hunk，右键锚定所点击的 hunk。
- hunk 头：`第 N 段 · L{newStart}–{newEnd} · +a −d`。
- **折叠体系（2026-08-27 修订）**：原设计含 hunk 级 + 文件级两级折叠，**已移除 hunk 级折叠**（实际使用中文件级折叠已足够，hunk 折叠增加交互复杂度且与文件折叠语义重叠），仅保留文件级折叠——
  - **hunk 级**：~~可折叠~~ **改为静态分节头**（`<div>`，非 `<button>`，无 chevron/`aria-expanded`/点击），仅展示段号、行范围、增删统计。
  - **文件级 + 全局**：文件块头部（`<button>` + chevron，`aria-expanded`）点击收起/展开本文件；工具条右侧「全部折叠 / 全部展开」（`btn-tonal` chip，仅渲染于有文件且非错误态；右对齐，与 segment 同高）。实现为**意图信号** `foldOpen: boolean`（DiffView state → DiffBody → FileDiffBlock `useLayoutEffect` 应用 `setOpen`，免首帧闪现）：折叠 = 关闭所有文件块；展开 = 全部打开。意图只表达按钮交替方向、不追踪各块本地状态（手动折叠不改变按钮标签）；deps 仅 `foldOpen`——**数据刷新（激活即重拉）不重置手动状态**，但意图切换后新挂载的文件块继承当前意图。
  - **视图状态持久化（2026-08-27 增补）**：切 Tab 卸载前落 store（`diffViewStates`，design-tab-state-memory §2.5），重挂载恢复——`foldOpen`（全局折叠意图）、`closedFiles`（手动折叠的文件路径集）、`scrollTop`（滚动偏移）。卸载经 ref 读最新值 + 复活闸门（Tab 仍在才写）；恢复 foldOpen/closedFiles 经 `useState` 初始化值、scrollTop 经 `useLayoutEffect` 在内容落地后应用。首次挂载跳过 foldOpen 覆盖（`firstMount` ref），避免全局意图覆盖从 closedFiles 恢复的逐文件状态。
- 行：双 gutter（oldNo | newNo，等宽两列——桌面宽裕，信息全）+ marker（+/−）+ 内容；added 绿底 tint / removed 红底 tint / context 透明，token 色 = `--syntax-*`（GitHub 风格与代码视图一致）；`diffAddBg/diffDelBg/diffAddFg/diffDelFg` 令牌进 tokens.css 双主题。
- 永不换行：整页唯一横滚（外层容器），各文件/hunk 宽度统一（移动端同决策——换行破坏对齐）。
- 大 diff 性能：**hunk 级** `content-visibility: auto` + `contain-intrinsic-size`——文件展开时屏外 hunk 仍可跳过渲染（粒度优于文件块级，零 JS 等价虚拟化）；解析/高亮全在 useMemo。
- 底色三重标识对齐移动端：背景为主、marker/gutter 色为辅，不整行染字。

### 4.4 入口（GuidePage）

**2026-08-25 修订（单入口）**：原为三个来源入口 chip，修订为**单个「改动」入口**，与预留的终端/网页入口平级（同一行 `.guide-actions`）：

- 点「改动」= `openDiffTab()`——开/复用作用域唯一 diff Tab；来源类型在页内 segment 切换，入口不再暴露三来源；
- 终端（`terminal`，v0.2）/ 网页（`browser`，v0.3+）为禁用态预留（`title` = 「即将支持」），与 design-layout §4 一致；
- 入口不因作用域状态禁用：`round` 无会话的提示下沉到页内空态文案（「当前作用域暂无会话」）；非 git 作用域 vcs 两来源由错误态呈现（与原设计一致，不禁用）。

## 5. 不做的事

| 项 | 原因 |
|---|---|
| split 并排视图 | v0.2 统一 unified 单栏（移动端同决策）；split 待用户诉求 |
| 行内字符级 diff | 移动端同不做 |
| commit/stage 等写操作 | 只读详情页；写操作是独立功能 |
| diff against 任意 ref | server 只支持 git/branch 两 mode（契约冻结，移动端同标注） |
| Tab 记忆持久化 | 按需打开的瞬时视图 |

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/api-types.ts` | `SnapshotFileDiff` 类型 |
| `src/shared/rest-client.ts` | `listVcsDiff` / `listSessionDiff` |
| `src/shared/diff-parse.ts` + `.test.ts` | 解析层（新） |
| `src/renderer/src/components/diff-view.tsx` + `.test.tsx` | 渲染层（segment 工具条 + 来源内容 + 查看文件按钮） |
| `src/renderer/src/store/app-store.ts` | TabKind diff / `diffTabKey(directory)` / `diffDataKey(type,directory)` / `diffSelectedTypes`+`diffTypeFor`+`switchDiffType` / openDiffTab / loadDiffTab / `openFileTab` revealLine 参数 / 清理挂点（closeProject/closeGlobalDirectory/removeWorkspace/closeTab/teardown） |
| `src/renderer/src/components/workspace.tsx` | GuidePage 单入口 + 预留终端/网页 + Tab 条过滤/关闭 + Workspace 渲染分支 + FileView revealLine 传递 |
| `src/renderer/src/components/code-view.tsx` | `revealLine` prop（CM scrollIntoView 行锚定） |
| `src/renderer/src/i18n/index.ts` | diff 文案（标题「改动」+ 短标签 + 「查看文件」） |
| `src/renderer/src/styles/tokens.css` + `app.css` | diff 令牌与样式（`.diff-view-wrap`/`.diff-toolbar`/`.guide-actions`/`.guide-action`） |

## 7. 验收

- GuidePage 单「改动」入口开/复用作用域唯一 diff Tab，与终端/网页预留入口同行平级（后两者禁用、`title`=即将支持）；
- 页内 segment 切换三来源：默认未提交；切换即拉对应来源、缓存作首帧、重复点击不动作；选中跨 Tab 切换存活、关 Tab 清除；
- 上一轮无会话 → 「当前作用域暂无会话」；无 user 消息/无改动 → 「无改动」；vcs 空 → 「无改动」；非 git 目录 → 错误态可重试；
- 文件块折叠/展开、工具条「全部折叠/全部展开」一键切换（折叠后手动开文件 → hunk 头与行恢复）、行号、增删底色、语法高亮（ts/md 等已映射语言）、长行横滚；
- 文件块展开时「查看文件」按钮 → 新 Tab 打开文件 CodeView 并锚定首个 hunk 行（center）；复用已开 Tab 更新锚定行；无 hunk 仅打开不锚定；revealLine 强制源码模式；
- hunk header / body 右键菜单 → 「查看文件」锚定至该 hunk 首行；
- 解析器单测（含 `+++i` 内容行、多文件兜底、`\ No newline`）；
- `npm run test` / `npm run typecheck` 全绿；本机 15120 实测三端点。
