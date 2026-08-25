# Diff 详情页（上一轮 / 未提交 / 分支改动）— 设计文档

> 目标：从新 Tab 引导页进入当前作用域的改动详情——三种来源：**上一轮**（最近会话最后一轮的改动）、**未提交**（工作区 vs HEAD）、**分支**（当前分支 vs 默认分支）。统一 unified diff 渲染：行号 + 语法高亮 + 增删底色，按文件分段、按 hunk 分节。
>
> 参考来源（按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-diff-view.md` —— diff 详情页渲染总设计：`parseDiffHunks` 解析规则（第一个 `@@` 切文件头、内容行只做单字符前缀判定、多文件兜底停止）、**双路重建高亮**（new/old 各整段 tokenize 再映射回行）、底色为主标识 + token 保留语法色、单 gutter 行号策略、hunk 头部（序号 + 行范围 + 增删统计）
> - `openbuilder/docs/design-file-browsing-container.md` —— 移动端 diff 入口与文件浏览容器的关系（桌面端以 Tab 体系对应）
> - 本仓库 `design-code-view.md` —— CodeMirror 6 基础设施（cm-lang 语言映射 / cm-theme class 化 HighlightStyle / --syntax-* 令牌），diff 行高亮直接复用
> - `../openchamber` 的 `@pierre/diffs`（AGENTS.md 实证选型来源）**评估后不采用**：其接口要求整文件 original/modified 内容（本项目只有 patch），且 Shadow DOM 主题桥接成本高（openchamber 为此写了两层注入 CSS）；自研 DOM 渲染 + CM 生态 headless 高亮更薄

## 1. 服务端契约（openapi + 源码 + 本机实测）

| 端点 | 语义 | 返回 |
|---|---|---|
| `GET /vcs/diff?directory=X&mode=git[&context]` | 工作区未提交改动 | `SnapshotFileDiff[]` |
| `GET /vcs/diff?directory=X&mode=branch[&context]` | 当前分支 vs 默认分支 | 同上 |
| `GET /session/{id}/diff?directory=X&messageID=<user msg>` | **该 user 消息发起的一轮**所做改动（server 侧 `SessionSummary.diff`：读该消息 `summary.diffs`；messageID 缺省或非 user 消息返回 `[]`） | 同上 |

`SnapshotFileDiff = { file, patch, additions, deletions, status: added|deleted|modified }`。

实测 patch 头两种形态：session diff 为 `Index: f\n====…\n--- f\t\n+++ f\t`（git 无 --git 前缀风格），vcs diff 为 `diff --git a/f b/f\n[new file mode…]\nindex…\n--- /dev/null\n+++ b/f`。hunk 体均为标准 unified。**上一轮的消息定位**：客户端取当前作用域最近会话（updated 降序首个）的最后一条 user 消息 id 作 messageID。

## 2. Tab 模型

- `TabKind` 增 `diff`；key = `diff\0{type}\0{directory}`（type ∈ `round|uncommitted|branch`；\0 分隔沿用 global entry 先例）——同作用域同类型复用 Tab。
- project-scoped：Tab 条按 `directory === scopeDir` 过滤显示（同 chat）；关闭项目/删工作区/关 global 目录时关闭其 diff Tab（不归档——归档语义仅 chat）。Tab 记忆（scope-tab-memory）只收 chat，diff 不入记忆（每次按需打开）。
- 标题：`上一轮改动 / 未提交改动 / 分支改动`（+作用域切换后同 key 不复用——directory 在 key 内）。

## 3. 数据流

- store：`diffsByTab: Map<key, { files: SnapshotFileDiff[]; error?: string }>`；`openDiffTab(type)`（开 Tab + 激活 + 触发加载）；`loadDiffTab(type, directory)`：
  - `uncommitted|branch` → `listVcsDiff`；
  - `round` → 作用域最近会话 → `listMessagesPage(limit 100)` 取最后一条 user → 无 user 消息或无会话 = 空态；有则 `listSessionDiff(messageID)`。
- 激活即重拉（同 FileView）；失败显示错误 + 重试按钮；空 diff 显示「无改动」。

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

- 文件块（可折叠，chip 头部模式）：状态图标（added +/deleted −/modified M）+ 文件路径（mono）+ `+N −N` 统计；折叠只渲染头部。
- hunk 头：`第 N 段 · L{newStart}–{newEnd} · +a −d`。
- 行：双 gutter（oldNo | newNo，等宽两列——桌面宽裕，信息全）+ marker（+/−）+ 内容；added 绿底 tint / removed 红底 tint / context 透明，token 色 = `--syntax-*`（GitHub 风格与代码视图一致）；`diffAddBg/diffDelBg/diffAddFg/diffDelFg` 令牌进 tokens.css 双主题。
- 永不换行：整页唯一横滚（外层容器），各文件/hunk 宽度统一（移动端同决策——换行破坏对齐）。
- 大 diff 性能：**hunk 级** `content-visibility: auto` + `contain-intrinsic-size`——文件展开时屏外 hunk 仍可跳过渲染（粒度优于文件块级，零 JS 等价虚拟化）；解析/高亮全在 useMemo。
- 底色三重标识对齐移动端：背景为主、marker/gutter 色为辅，不整行染字。

### 4.4 入口（GuidePage）

- hero/composer 下方一行三个入口 chip：上一轮改动 / 未提交改动 / 分支改动；
- `round` 在作用域无会话时禁用（title 提示）；非 git 作用域（global 根目录等）vcs 两种禁用——server 对非 git 目录返回错误，UI 以错误态呈现亦可接受（简化：不禁用，靠错误态）。

## 5. 不做的事

| 项 | 原因 |
|---|---|
| split 并排视图 | v0.2 统一 unified 单栏（移动端同决策）；split 待用户诉求 |
| 行内字符级 diff | 移动端同不做 |
| hunk 折叠 | 文件级折叠已够；hunk 粒度需求未出现 |
| commit/stage 等写操作 | 只读详情页；写操作是独立功能 |
| diff against 任意 ref | server 只支持 git/branch 两 mode（契约冻结，移动端同标注） |
| Tab 记忆持久化 | 按需打开的瞬时视图 |

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/api-types.ts` | `SnapshotFileDiff` 类型 |
| `src/shared/rest-client.ts` | `listVcsDiff` / `listSessionDiff` |
| `src/shared/diff-parse.ts` + `.test.ts` | 解析层（新） |
| `src/renderer/src/components/diff-view.tsx` + `.test.tsx` | 渲染层（新） |
| `src/renderer/src/store/app-store.ts` | TabKind diff / diffsByTab / openDiffTab / loadDiffTab / 清理挂点（closeProject/closeGlobalDirectory/removeWorkspace/closeTab） |
| `src/renderer/src/components/workspace.tsx` | GuidePage 入口 + Tab 条过滤/关闭 + Workspace 渲染分支 |
| `src/renderer/src/i18n/index.ts` | diff 文案 |
| `src/renderer/src/styles/tokens.css` + `app.css` | diff 令牌与样式 |

## 7. 验收

- 三种入口分别打开对应 Tab（同作用域同类型复用）；上一轮无会话/无 user 消息 → 空态；vcs 空 → 「无改动」；非 git 目录 → 错误态可重试；
- 文件块折叠/展开、hunk 头、行号、增删底色、语法高亮（ts/md 等已映射语言）、长行横滚；
- 解析器单测（含 `+++i` 内容行、多文件兜底、`\ No newline`）；
- `npm run test` / `npm run typecheck` 全绿；本机 15120 实测三端点。
