# 会话任务列表展示 — 设计文档

> 参考移动端同类实现（AGENTS.md 设计前置约定）：
> - `../openbuilder/lib/features/conversation/conversation_screen.dart` `_FooterPanel`/`_TodoCard` — 收起/展开、完成计数、进度条、逐条状态图标的视觉与交互结构，以及「有待处理人机交互时不渲染任务卡」的共存规则
> - `../openbuilder/lib/core/session/conversation_store.dart` — todos 快照（打开会话时 `GET /session/:id/todo`）+ `todo.updated` 事件全量替换
> - 本仓库 `design-pending-cards.md` — ChatFooter 的卡片排队/键控/事件闸门体系，任务卡是该面板的第三类卡片

## 问题

agent 执行中会用 todowrite 工具维护任务清单（server 按 session 存储全量列表），桌面端 v0.3.1 完全没有消费该数据——长任务的用户看不到 agent 的计划与进度拆解，只能从消息流里翻工具调用。

## 契约事实（openbuilder opencode_openapi.json，与移动端同源）

| 端点/事件 | 事实 |
|---|---|
| `GET /session/{sessionID}/todo?directory=` | 返回 `Todo[]`；`Todo = {content, status, priority}`，**无 id 字段**（additionalProperties:false）；status：`pending \| in_progress \| completed \| cancelled` |
| SSE `todo.updated` | `properties: {sessionID, todos: Todo[]}`——**全量替换语义**（每次携带整个列表，非增量补丁），事件在所在目录的流上推送 |
| 派生语义 | 移动端 `Todo.done = status == completed \|\| cancelled`（cancelled 视作不再占用「未完成」）；active = in_progress |

## 设计

### 状态层（app-store.ts）

- `sessionTodos = new Map<sessionID, Todo[]>`，**store 级、按 sessionID 键**。与 pendingPermissions 不同：todos 无应答交互、纯展示，生命周期随会话运行时（关 Tab/删会话走 `cleanupSessionState` 卸载，teardown 全清），不做跨 Tab 存活设计（重开 Tab 时激活回填补齐）
- SSE `todo.updated` → `normalizeTodoList` 防御式归一化后整表 set（事件闸门沿用 handleEvent 前置的 openedDirectories 过滤——关闭项目的事件直接丢弃）
- 归一化收敛在 `shared/session-todos.ts`（对齐 pending-requests.ts 惯例）：非对象/缺 content 条目丢弃，status/priority 缺省回退 `pending`/`medium`
- **无合并语义**：全量替换让 stale-entry 问题不存在，不需要 pending 的按目录权威覆盖合并

### 回填（SSE 断线窗口的补齐）

- `loadSessionTodos(sessionID, directory)`：ChatView 激活 effect 与 `loadSessionMessages` 同挂点（切回 Tab 重拉，design-layout §5 同语义）；client 同一性守卫 + 失败静默（空窗由下一次 todo.updated 自愈）
- **不进 reconciler**：todos 是进度展示而非阻塞状态（对齐移动端——重连对账不拉 todos）；陈旧窗口 = 断线期间变更且切 Tab 前不再变更，激活重拉已覆盖
- 200 空数组 = 权威清空（清掉本地陈旧列表）；404/失败 = 保留

### UI：ChatFooter 第三类卡片（消息流与输入区之间）

对齐移动端 `_FooterPanel` 共存规则：

- **渲染优先级：授权 > 问题 > 任务**；有待处理人机交互（queueTotal > 0）时任务卡**不渲染**——授权/问题阻塞执行且需用户动作，任务卡不得挤占或推高它们的呈现（用户需求「不应遮挡授权和选择弹窗」，移动端 `totalPending == 0` 分支同源）
- **全部完成即整卡隐藏**（`todosActive` = 存在非 completed/cancelled 条目；移动端 showFooter 的 `todos.any((t) => !t.done)` 投影同源）——completed 瞬间卡片消失，无需手动关
- **默认收起**：头部一行 = 图标 + 标题「任务」+ 完成计数 `done/total` + 展开箭头；点击头部切换展开态（组件本地 state，会话切换/卡片隐藏重置为收起）
- 展开体：进度条（完成比例，primary 填充）+ 逐条任务行；行图标按 status：pending 空圆 / in_progress 圆点（呼吸动画）/ completed 实勾 / cancelled 叉；completed/cancelled 行删除线 + 弱化色
- 卡片复用 `.pending-card` 结构（键控不需要——无 id、无内部提交态，列表整体重渲染即正确）；配色用中性 surface-container 系（区别于授权 primary / 问题 tertiary，移动端 surfaceContainerHighest 同判）

## 与移动端的差异（桌面习惯）

- 展开体最大高度走 `.pending-card-body` 既有 320px 上限（移动端按屏高百分比），滚动同现有卡片
- 计数在头部 sub 槽位（`{done}/{total}`），不额外做百分比文本；进度条 aria-valuenow 供无障碍
- 无 ValueKey 键控需求：mobile 键控是为防队列推进复用提交态，任务卡无提交态

## Review 记录（2026-08-28）

首轮 review 无阻塞发现；2 个 low 项处置如下：

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟢 | 在途 `loadSessionTodos` 跨越关 Tab/删会话后仍写回 map（stale 复活）——仅 client 同一性守卫，无会话存活守卫 | 记入已知限制：与 `loadSessionMessages` 既有模式一致（不加不对称守卫）；纯展示态、无渲染方、重开 Tab 由激活回填覆盖 |
| 2 | 🟢 | 畸形 `todo.updated`（todos 缺失/非数组）被当作权威清空，与 REST 失败路径的「失败保留」不对称 | 已修：非数组 todos 忽略保留本地（openapi todos 必填，仅坏 server 触发），显式 `[]` 才清空；补回归用例 |

## 已知限制

- agent 完成全部任务后列表隐藏，历史任务不可回看（server 侧 todo 会被下一轮 todowrite 覆盖，历史本就不可靠；移动端同判）
- 无 id 字段 → React 列表 key 用内容签名（content+status+index），同轮同名任务重排不保证 DOM 复用——纯展示无状态，可接受
- 归档会话不预取 todos（打开会话才拉，同移动端）
- 在途 `loadSessionTodos` 跨越关 Tab/删会话的迟到结果会短暂写回 map（无渲染方消费，重开 Tab 激活回填覆盖；与 `loadSessionMessages` 既有模式一致，见 Review #1）

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/api-types.ts` | `Todo` 类型 + `todo.updated` 事件成员 |
| `src/shared/session-todos.ts`（新） | 归一化 + done/active 投影 |
| `src/shared/session-todos.test.ts`（新） | 归一化/投影用例 |
| `src/shared/rest-client.ts` | `listSessionTodos`（GET，带 directory） |
| `src/renderer/src/store/app-store.ts` | `sessionTodos`、事件处理、`loadSessionTodos`/`todosForSession`、清理挂点 |
| `src/renderer/src/components/workspace.tsx` | ChatFooter 门控 + TodoCard |
| `src/renderer/src/styles/app.css` | 任务卡/进度条/任务行样式 |
| `src/renderer/src/i18n/index.ts` | 文案（中/英） |
