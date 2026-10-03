# 待处理卡片（授权/问题）+ 指示器 waiting 态 — 设计文档

> **v2 迁移修订（2026-09-29，M6a）**：question 体系整体换绑 v2 form
> （`POST /api/session/:id/form/:formID/reply`、`form.created/replied/cancelled`
> 事件、frm_* id、fields 字段模型）；权限应答换 `POST /api/session/:id/
> permission/:requestID/reply`（body `{decision}`，无 directory 路由参数）。
> 契约事实表与应答动作节已按 v2 改写，v1 原始记录见 git 历史。渲染/状态/
> 合并语义（键控、waiting 投影、权威覆盖）不变。
>
> 参考移动端同类实现（AGENTS.md 设计前置约定）：
> - `../openbuilder/docs/docs/design/design-agent-status-indicator.md` — 状态归一与显示投影（waiting 优先于 busy、琥珀静态、底层事实独立保留）
> - `../openbuilder/docs/docs/design/v1/design-question-card-reply.md` — question reply 的 404 语义（directory 路由是 v1 史，v2 已无）
> - `../openbuilder/docs/docs/review/review-permissions.md`、`review-question-cards.md`、`review-73dcfa6.md` — backfill 失败保留、ValueKey 键控、提交校验等已踩坑清单
> - `conversation_screen.dart` `_FooterPanel`/`_PermissionCard`/`_FormCard` — 单卡队列 + 计数、卡片视觉与交互结构

## 问题

agent 运行中会请求人工介入，两类：

1. **授权（permission）**——agent 要执行受限操作（bash 命令、访问项目外目录等），server 挂起等待 `once / always / reject` 应答
2. **问题（question）**——agent 用 question 工具向用户提问（单选/多选/多子问），server 挂起等待 answers 或 reject

v0.1 此前只有事件占位（spec 范围外），用户在桌面端无法应答，agent 永久挂起。同时左栏/Tab/会话列表指示器只有 busy/idle 两态，表达不了"在等我"。

## 契约事实（openapi v2 + server 2.0.18 实测，M6a 改写）

| 端点/事件 | 事实 |
|---|---|
| 权限应答 | `POST /api/session/{sid}/permission/{requestID}/reply`；body `{decision: "once"\|"always"\|"reject"}`；**无 directory 路由参数**（请求 id 全局寻址）——v1「pending 按 directory 隔离、reply 须带 directory」的约束随实例模型消亡 |
| 表单应答 | `POST /api/session/{sid}/form/{formID}/reply`；body `{answer}`（键 = field.key，值按字段类型：select→option **value**、multiselect→value[]、boolean→bool、number→数值、text→string）；取消 `DELETE .../form/{formID}`——取代 v1 question 的 `answers: string[][]`（label 数组） |
| SSE 事件 | `permission.asked`（平铺，v2 字段 `action`/`resources`/`save`）/ `permission.replied`（**id 在 `requestID` 字段**）；`form.created`（**表单嵌套在 `form` 字段**）/ `form.replied` / `form.cancelled`（id 在 `id` 字段）——v1 `question.*` 与 `permission.v2.*` 事件名不存在，case 已删 |
| 事件只推一次 | SSE 只在 asked/created 时推送；断线期间的请求靠 REST 回填（v2 端点 `GET /api/permission/request` + `GET /api/form`，**M6c 接回**——v1 回填端点已退役，中间态 questions 回填缺位由 SSE 事件与 404 语义兜底） |
| 表单字段模型 | `Form.Field` 六型：string（有 options = 单选）/multiselect/boolean/number/integer/external + `hidden` 条件隐藏；UI 投影见 pending-requests.ts `toField`（hidden/external 剔除，type 归一化 kind） |
| 权限负载 | `action`（类型，如 `bash`/`external_directory`/`edit`）+ `resources`（命令模式/路径）+ `metadata`（bash 带 `command` 全文、external_directory 带 `parentDir`/`command`）；`save` = v2 的 always patterns 候选 |

## 设计

### 状态层（app-store.ts，与移动端 ServerStore 同构）

- `pendingPermissions: Map<sessionID, PendingPermission>`——**按 sessionID 为 key**（一会话同时在队首的最多一张，同移动端）
- `pendingQuestions: Map<questionID, PendingQuestion>`——按问题 id 为 key（一个会话可多张排队）
- 两份 Map 是 **store 级、跨 Tab 存活**：关 Tab（=归档）不清除（server 侧仍挂起）；仅 session 删除、项目关闭、worktree 删除、连接拆除时清理
- `directory` 在归一化时**捕获**（SSE 事件取订阅目录、回填取查询目录）——移动端踩过的 directory 空竞态（design-question-card-reply M-1）在桌面端从源头消除
- 归一化收敛在 `shared/pending-requests.ts`（防御式解析 + v1/v2 字段兼容：`permission ?? action`、`patterns ?? resources`、`save ?? always`）

### 应答动作（404 = 已被他端处理，静默移除；其余错误保留卡片由 UI 内联提示）

- `respondPermission(sessionID, response)` → v2 reply 端点（`decision`），无 directory
- `replyQuestion(questionID, input)` → v2 `replyForm`（answer 由 `buildFormAnswer` 从 UI 原始输入构造，见 pending-requests.ts）；`rejectQuestion(questionID)` → `cancelForm`
- 成功（204）即本地移除；SSE replied/cancelled 事件到达再删一次（幂等）

### 事件与对账（M6a 修订）

- SSE `permission.asked` / `form.created` → 归一化入 Map；`permission.replied`（按 `requestID`）/ `form.replied`/`form.cancelled`（按 `id`）→ 移除
- 回填两条路径，同一合并函数 `mergePendingSnapshot(dir, perms, questions)`（questions 已是归一化形态）：
  1. **reconciler**（SSE 重连对账）每目录附拉 permissions（v2 端点 M6c 接回；v1 端点在 v2 server 404 → null 保留本地）
  2. **store.backfillPending()**（connect / 开项目 / 切工作区）按订阅目录限并发拉取（同上）
- 合并语义（review-permissions R-Perm-2/R-Perm-4 + R-Perm-3 跨目录教训）：**成功目录权威覆盖**（不在快照中的同目录本地条目视为已在他端处理，删除）；**失败目录/类别保留本地**（不误清 SSE 已送达条目）；**只审判同目录条目**（跨目录不动）

### UI：会话底部待处理面板（ChatView footer，消息流与输入区之间）

对齐移动端 `_FooterPanel`：

- **一次渲染一张卡：授权优先于问题**（授权通常阻塞执行），队列 >1 时头部计数 `1/N 待处理`
- 卡片按 id **键控**（review-73dcfa6：队列推进时复用组件 State 导致选中/提交态残留）
- **授权卡**（primary 系配色）：盾牌图标 + "授权请求" + 类型标题（bash→执行命令 / external_directory→访问外部目录 / 兜底 type 原文，同移动端 permissionTitle 映射）+ mono 详情行（metadata.command > patterns > 派生路径）；按钮 拒绝 / 总是允许 / 允许一次；可折叠
- **问题卡**（tertiary 系配色，v2 form 投影 M6a）：图标 + 表单 title + 步进 `i/N` + 队列计数；正文当前字段文本 + 描述小字；选项式字段（select/multiselect/boolean——boolean 合成是/否两项，value "true"/"false" 提交时还原布尔）渲染选项列表（radio/checkbox 视觉，label + description，**选中即 option.value**）；输入式字段（text/number）渲染输入框（占位提示，number 输入模式）；逐字段步进（下一步/提交）；**当前步未答不得前进**（review-question-cards Q-7——选项步未选恒禁，输入步 required 非空门控）；拒绝常驻；可折叠
- 回复中全按钮禁用；失败在卡内右侧内联红字（桌面无 SnackBar）
- **卡片快捷键（2026-09-28 增）**：授权卡 Ctrl+N/A/Y = 拒绝/总是允许/允许一次；问题卡 Ctrl+1..9 切换选项、Ctrl+0 拒绝、Ctrl+Enter 下一步/提交；Ctrl 按住期间按钮/选项显键位角标——键位守卫与冲突核查见 [design-keyboard-shortcuts §1.1b](../design-keyboard-shortcuts.md)

### 指示器 waiting 态（三处联动）

投影规则取自 design-agent-status-indicator（移动端已锁定语义）：**有 pending = waiting（琥珀 `--status-waiting`，静态无闪烁），优先级高于 running；busy 底层事实不覆写**——应答后 pending 清零自动回落 running/idle。

| 位置 | 表现 |
|---|---|
| Tab 条 | waiting/running 状态点（idle 不显示，原行为） |
| 中栏会话列表卡 | 同上；归档卡保持不显示 running 的历史行为，但 waiting 仍显示（server 仍挂起） |
| 左栏项目/工作区行指示器 | 逐会话点 waiting > running(blink) > idle；>4 收数字时前置 waiting 点（优先于 running 点）；title 计数增加"待输入 N" |

新令牌：`--status-waiting`（dark `#fbbf24` / light `#92400E`，同移动端 paused 色）、`--tertiary-container`/`--on-tertiary-container`（问题卡用，tokens.css 唯一权威落点）。

## 场景验证（GNOME/Wayland 实机，CDP 驱动，server 1.18.20 @15120）

- [x] store 注入 bash 授权 → 卡片渲染（标题"执行命令"+ 命令全文 + 三按钮）；Tab/左栏 waiting 点、title"待输入 1"
- [x] `respondPermission`（伪造 per_id）→ server 404 → 静默移除、卡片消失、指示器回落
- [x] 注入双子问问题卡 → 步进 1/2、radio 单选排他、checkbox 多选、未选禁用前进；提交（伪造 que_id）→ 404 → 移除
- [x] **真实链路**：新会话 prompt 让 agent 调 question 工具 → SSE `question.asked` 实时到达 → 卡片渲染（header/options 正确、busy 底层保留）→ UI 选择 "Yes" 提交 → `POST /question/{qid}/reply?directory=/` 200 → server `GET /question` 已清空 → 会话恢复运行至完成（busy 回落 idle）
- [x] typecheck 双侧 + vitest 40/40（新增 pending-requests 12 用例：归一化/标题派生/投影/合并语义含跨目录误删回归、同数量换血变化检测）+ build 全绿

## Review 修复（2026-08-24）

首轮流评审 4 项发现，全部处理：

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | 🟡 | 在途回填跨越 teardown/关项目后写回已清空的 map（stale 复活；sessions 快照有闸门、pending 漏配） | `backfillPending` 与 `onPendingSnapshot` 双路径加在途闸门：client 同一性 + 目录仍在订阅集合 |
| 2 | 🟡 | 变化检测仅比 size：他端答掉一张 + server 新发一张（同数量换血）不触发 emit，卡片滞留旧 id | `mergePendingSnapshot` 改按内容签名（权限 sessionID+id 对、问题 id 集）比对；补 2 用例回归 |
| 3 | ℹ️ | 权限应答端点 openapi 标记 deprecated；若未来下线，其 404 与"已被他端处理"不可区分（卡片消失但 agent 挂起） | 记入已知限制监测项（对齐移动端 design-question-card-reply I-5 惯例），届时迁移全局端点 + directory |
| 4 | 🟢 | reconciler pending 拉取随 sessions 并行扇出（5 目录 × 3 请求），放大 REST 池排队风险 | pending 拉取改逐目录串行（sessions 并行为既有行为，新增请求不再放大扇出） |

## Review 第二轮修复（2026-08-24）

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | 🟡 | `respondPermission` await 后无条件按 sessionID 删 key：in-flight 期间他端应答 + agent 立即发出同会话新卡落入同 key，新卡被误删（waiting 指示静默消失至下次回填） | 移除前按 id 守卫（`get(sessionID)?.id === p.id`），对齐移动端 `removeWhere(p.id == pid)` |
| 2 | 🟡 | `onPendingSnapshot` 闸门只查 client 非空不查同一性：跨越切 profile 的 in-flight reconcile 在新 client 装好后仍写回旧 server 的 pending | reconciler 捕获开跑时的 client，mid-run `client()` 变化即丢弃剩余结果（sessions/pending/messages 三阶段统一 stale 闸门） |
| 3 | ℹ️ | `backfillPending` 每任务两类别并行（3×2=6 在途），与 reconciler 串行路径对同一预算约束给了不同答案 | 每任务内两类别串行（在途 ≤1 × 并发 3） |
| 4 | ⚪ | 文档"涉及文件"表用例数 10 与实际 12 不符 | 更正 |

## Review 第三轮修复（2026-08-24，收敛轮）

无阻塞发现；2 个 low 项已修：

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | 🟢 | reconciler `listSessions` 单目录失败 reject 会中断整个 reconcileOnce——pending 回填阶段不执行，离线卡片要等下次重连才可见（与注释"单目录失败不拖垮"矛盾；messages 阶段同暴露为既有行为） | sessions 拉取 `.catch(() => null)`，失败目录跳过快照、其余阶段照跑 |
| 2 | 🟢 | `QuestionCard` 以 `questions[step]` 裸索引：同 id 载荷重归一化后子问题变短会越界抛错（当前 server 不变更已排队问题，纯 hardening） | 步进钳制 `stepIdx = min(step, totalSub-1)`，渲染/toggle/前进统一用 stepIdx |

## Rebase main 适配（2026-08-24）

main 演进后按其新架构重新适配（语义不变）：

| main 侧变化 | 适配 |
|---|---|
| `busySessions: Set` → `sessionStatus: Map`（design-typing-indicator §4 单一事实源，busy/retry） | `dotStateFor` 改消费 `isSessionActive()`（busy/retry 均投影 running）；`respondPermission` 等不再触碰 busy 集 |
| 运行点动效 blink → **光晕呼吸**（`session-running` 双层圆点） | waiting 仍为琥珀静态点；running 态渲染 `session-running`（Tab/左栏一致） |
| SessionList → 新 Tab 引导页（guide-view，无会话卡片菜单） | SessionCard/waiting 点随旧列表移除；waiting 提示保留在 Tab 条与左栏指示器；归档恢复走引导页（打开会话即见卡） |
| openScopeSessionTabs → **worktree 级 Tab 记忆**（restoreScopeTabs，先切换后加载） | backfillPending 挂点不变（connect / switchProjectContext / setCurrentWorkspace），记忆恢复与 pending 回填互不影响 |
| reconciler 增状态快照阶段（runLimited 2）+ 消息快照改 runLimited 3 | pending 阶段插在 sessions 与状态快照之间（逐目录串行）；stale 闸门统一覆盖四阶段 |
| renameSession/deleteSession 移除（无 UI 入口） | dropPendingForSession 的两处调用随方法删除；session.deleted 事件路径的清理保留 |

## 已知限制

- v2 `Form.Field` 的 `external` 型字段（浏览器授权流）与 `hidden` 字段不呈现（归一化剔除，M6a——external 属浏览器 tab 能力扩展，按需另行 design）
- 表单字段 `default` 值不做预填（与移动端一致；required 已门控，空提交风险收敛）
- 权限卡 `always` 选项恒显示（v2 `save` patterns 为空时本应只给 once/reject——待真实权限卡联调后按需隐藏）
- 归档会话的 pending 卡不主动弹出入口（仅左/中栏 waiting 点提示，打开会话才见卡）
- **[M6c 待接] pending 回填**：v1 回填端点已退役（v2 server 404 → null 保留本地），重连窗口内错过的事件要等 M6c 接 `GET /api/permission/request` + `GET /api/form` 后恢复；期间他端已处理的旧卡由 reply 404 静默移除语义兜底

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/pending-requests.ts`（新） | 归一化、标题/命令派生、dot 投影、按目录合并 |
| `src/shared/pending-requests.test.ts`（新） | 12 用例 |
| `src/shared/api-types.ts` | permission/question SSE 事件类型（防御式 properties） |
| `src/shared/rest-client.ts` | list/respond/reply/reject 五端点（均带 directory） |
| `src/shared/reconciler.ts` | `onPendingSnapshot` 回填钩子（失败传 null） |
| `src/renderer/src/store/app-store.ts` | pending 状态、事件处理、backfill、应答动作、`dotStateFor`、生命周期清理 |
| `src/renderer/src/components/workspace.tsx` | ChatFooter/PermissionCard/QuestionCard；Tab/会话卡指示器 waiting |
| `src/renderer/src/components/sidebar.tsx` | SessionIndicator waiting 投影 |
| `src/renderer/src/styles/tokens.css`、`app.css` | waiting/tertiary-container 令牌；卡片与选项样式 |
| `src/renderer/src/i18n/index.ts` | 卡片文案（中/英） |
