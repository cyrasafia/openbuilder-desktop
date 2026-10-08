# 用户后台任务条 + 系统提示

> 参考移动端 `../openbuilder/docs/design/v2/design-subagent-background.md`。
> 本文覆盖**用户后台任务**——异步建立的子会话，含三路径（识别见下）：
> 命令型 `subagent: true`、工具型 `subagent` tool `background: true`、
> 工具型前台运行中转后台（`POST /api/session/{id}/background`）。
> 工具型**前台**（同步阻塞）的呈现基本不变，仍按
> [`design-subagent-status.md`](design-subagent-status.md)；其中 `subagent`
> tool part 的**现状缺口**一并补正（见「范围」表下注）。
>
> 移动端把后台任务做成「按子会话启动注入消息流的 chip」后废弃并改为
> 「常驻任务条 + 系统提示」；桌面端**从未实现过 chip**，本次是首次实现，
> 直接采用任务条方案。桌面与移动端的主要结构差异见文末「与移动端的差异」。

## 背景与问题

命令型 `subagent: true` 会建立异步子会话：父会话不被阻塞、用户可继续对话
（服务端路径见移动端 `../openbuilder/docs/ref/ref-opencode-review-subagent.md` §3.4；
`subagent` tool 的存在与语义见同文 §3.4/§5）。工具型 `subagent` tool 的
`background: true` 与「前台转后台」同样建立异步子会话（服务端语义见契约表）。

桌面端当前只处理**工具型前台**子会话（`task` tool part → `SubagentPanel`，
`workspace.tsx` 第 2597 行）。异步子会话**三处不可见**（原命令型的缺口，
工具型 `background:true` 同样命中——其 tool part 派发即完成，承载不了运行态）：

- **消息流无指示**：没有 tool part，也没有任何 chip，父会话流里看不出任务在跑。
- **状态不点亮**：`dotStateFor` 只看本会话 `sessionStatus`，父会话 idle 时
  Tab/左栏/项目指示器的 **running 不点亮**（子会话待授权的 waiting 仍会亮，
  见 `pendingCountFor`），看不出后台有任务。
- **完成不可见**：服务端完成回执走 `session.inbox.enqueued`（`item.type ==
  "synthetic"`）或 REST 快照的 `synthetic` 消息。桌面端前者在
  `item.type !== "user"` 处直接 `break`（`app-store.ts` 第 1687 行）；后者
  `toInternalMessages` 把 synthetic 转成 `synthetic:true` 的 text part
  （`v2-adapter.ts` 第 169 行），随后被 `mergeSnapshotIntoMessages` 的 part
  过滤（`message-merge.ts` 第 113 行）滤空，再由空消息守卫隐藏
  （`app-store.ts` 第 6260 行）——两头都丢。
- **不可停止**：无停止入口；中断父会话对后台子会话是 no-op。

工具型没有这些问题：它是前台阻塞调用，tool part 天然停在消息流尾部、伴随
主会话 `running`、composer 的停止会连带取消。因此新交互**只服务用户后台任务**。

## 契约事实（桌面 v2 翻译层实测口径）

| 来源 | 事实 | 桌面落点 |
|---|---|---|
| `session.created`（v2） | 携带 `sessionID/projectID/parentID/...`；子会话 `parentID` 指向父会话，与父同 `directory`，过目录闸门 | `applyV2SessionEvent` `session.created`（`app-store.ts` 第 1470 行） → `applySessionEvent`；`parentID` 非空时不开 Tab |
| `session.execution.started/succeeded/failed/interrupted` | **旁路目录闸门**（信封无 location），目录按 `sessionID` 解析；驱动 `sessionStatus` | `handleEvent` 第 1584 行 —— 后台子会话的 busy/idle 事实源 |
| `session.inbox.enqueued` | `item.type` ∈ `user/synthetic/compaction/move`；`Synthetic` 的 `item.payload` = `{text, description, metadata}`，`metadata` = `{source:"subagent", childID, agent, state}`，`state` 主枚举 `completed/error/cancelled`（wire 兼容别名见 D4），`item.time.created` 可信 | 现只消费 `user`（第 1677 行）；本次新增 `synthetic` 分支 |
| `POST /api/session/{id}/interrupt` | 停止子会话 = 中断该子会话 | `abortSession(childID)`（`app-store.ts` 第 3889 行） |
| `GET /api/session/{id}/message` | `synthetic` 条目的 `metadata` 同 inbox payload；`toInternalMessages` 现丢弃 `metadata` | `v2-adapter.ts` / `rest-client.ts#listMessagesPage` |
| **完成 synthetic 的发件方**（2026-10-06 源码核实，tag v2.0.18） | `SubagentCompletion.deliver`（`packages/core/src/session/subagent-completion.ts`）统一产出 `metadata {source:"subagent", childID, agent, state}` + `<subagent …>` 文本。调用方：① 命令型 `subagent: true`（`config/plugin/command.ts` → `subagents.background`，恒发）；② 工具型 `subagent` tool `background:true`（`tool/plugin/subagent.ts` 同走 `subagents.background`，**也发**）；③ 工具型前台被"backgrounded"时经 `subagents.notify` 补发。工具型前台**正常完成不发**——结果内联在 tool part content | 桌面/移动端同判：一切 `source=subagent` synthetic 都渲染完成通知，不按工具型排除（移动端 `_noticeMessage` 同款） |
| **v2 无 `task` tool**（2026-10-06 核实） | v2.0.18 工具名只有 `subagent`；`task` 是 v1 遗留。桌面 `task` 路由保留为存量数据兼容，新事件恒为 `subagent` | `MessageBlock` 分发 / `toolFormChildIds` 双认 |
| `Session.parentID` | 子会话非空；`sessionsByProject` 保留全量（无移动端 64 条 LRU） | `findSession` / `findChildSession`（第 3718 / 3731 行） |
| **② `background:true` 派发即完成**（2026-10-07 活体抓包） | 事件序：`tool.called`（parsed input，含 `background:true`）→ `session.created`（晚 ~44ms，title==description）→ `tool.progress`（`metadata:{sessionID,status:"running"}`）→ `tool.success`（created 后 ~30ms，part 转 completed，**事件与 REST 持久化都带 `metadata:{sessionID,status:"running",truncated:false}`**——源码初读会误判为不带，系框架层并入） | ②的后台运行态 = part completed + 子会话运行中；`input.background` 在 `session.created` 前即可读 |
| **③ 前台转后台**（源码核实 v2.0.18） | `POST /api/session/{父}/background` → `Session.background` → `jobs.backgroundAll`：阻塞中的 tool 返回 `{type:"backgrounded"}` → `backgroundResult` 同②；父会话另发一条 synthetic（「User requested that active blocking work be moved to the background…」，**无 `source:subagent`**，不渲染为通知）。TUI/CLI 动作，桌面端未接该端点 | 转换信号 = 认领 part 转 completed + 子会话继续跑；完成 synthetic 经 `subagents.notify` 补发 |
| **SSE volatile 缺口的时序影响**（2026-10-07 现场病灶） | v2 事件流断线丢事件、慢消费者被断流；远程客户端缺口可吞掉 `tool.called`（与 `session.created` 仅隔 ~44ms）或整个派发 part——`session.created` 到达时认领数据（metadata 未写、input 为流式字符串）缺席 | 缺口误插的纠正依赖对账（REST 快照可靠带 `metadata.sessionID`）；判据须区分「前台认领」（撤）与「后台派生」（不撤），见识别节 |

## 范围

| | 命令型 `subagent: true` | 工具型 `background: true` / 前台转后台 | 工具型前台（同步） |
|---|---|---|---|
| 消息流呈现 | 启动/完成各一条**系统提示** | 启动（②）/ 转后台（③）+ 完成各一条**系统提示** + 派发 tool part 留存（SubagentPanel 呈现派发记录） | 保持 `SubagentPanel`（tool part 运行态），无系统提示 |
| 进行中指示 | **常驻任务条** | **常驻任务条**（②派发完成后进入；③转换后进入） | tool part 自身（运行态） |
| 停止入口 | 任务列表内 | 任务列表内 | composer 停止（中断父会话连带取消） |

即：**按「异步」统一**（2026-10-08 升格裁定，见 Review 第五轮；同日对齐
补裁定：③转后台也合成转后台提示，三路径呈现一致——启动（或转后台）/
完成/任务条），不再按「命令型/工具型」划分前台之外的呈现；
`design-subagent-status.md` 只剩工具型前台不动。

> 桌面补正：工具型判据与渲染都须同时认 `task` **与** `subagent` 两个 tool
> （现存代码只把 `task` 路由到 `SubagentPanel`，`subagent` tool 落 `ToolChip`
> ——见「实现影响」）。依据：v2 存在 `subagent` 工具（移动端 ref §3.4/§5），
> 移动端把二者统一走 `_SubagentPanel`（`conversation_screen.dart:2006`），读同一
> 组字段 `input.description` / `input.subagent_type` / `metadata.sessionId`——
> 载荷同构，可复用桌面现有 `SubagentPanel`。

## 识别：哪些子会话算「后台任务」

- 候选 = 当前会话的直系子会话（`parentID == 当前会话`）。
- **认领**（claim）= 消息流里某 `task`/`subagent` tool part 引用了该子会话：
  - 优先 `metadata.sessionId`（兼容 `sessionID`）；任意 part 状态可判
    （progress 写入、success 持久化、REST 快照同带，见契约表）；
  - part 尚在 `pending/running`、metadata 未写入窗口时，用
    description ↔ title 前缀启发式兜底（`findChildSession` 同款）。
- **两个判据集**（2026-10-08 升格修订，刻意不同、各司其职）：
  - `foregroundClaimedChildIds`（启动通知插入闸门 + 撤回）：认领 part 未声明
    `input.background === true`——被**前台** part 认领的子会话不插启动提示、
    误插的撤回；后台派生（②的 `background:true`、③转换后 completed 认领）
    不在集内，启动提示保留。
  - `activeClaimedChildIds`（任务条排除）：被 **pending/running** part 认领——
    前台阻塞运行中不进任务条；completed part 的认领不排除（②派发完成与
    ③转换后的后台运行态正是 part completed + 子会话运行中）。
- 取运行中：子会话 `sessionActivity(childID) !== "idle"`（即 busy/retry）。

```
claim(part, child) =
    part.tool ∈ {task, subagent}
      ├─ metadata.sessionId / metadata.sessionID（权威，任意状态）
      └─ part pending/running ∧ input.description ↔ child.title 前缀（兜底）

foregroundClaimedChildIds(parent) =
    { child | ∃part: claim(part, child) ∧ part.input.background ≠ true }

activeClaimedChildIds(parent) =
    { child | ∃part: claim(part, child) ∧ part pending/running }

runningBackgroundTasks(parent) =
    childSessionsOf(parent)
      ∩ sessionActivity(child) ≠ idle
      ∩ child ∉ activeClaimedChildIds(parent)

任务条可见 = runningBackgroundTasks(parent).length > 0
```

`childSessionsOf` 由 D6 的 `childrenByParent` 惰性缓存提供（源 = `sessionsByProject`
全量，同 `findChildSession` 口径）；`sessionActivity` 见 D6。

## 设计

### D1 常驻任务条

- 位置：`ChatView` 的 `.composer` 顶行（与 `RevertBar` 同层，见
  `workspace.tsx` 第 1674 行），不遮消息区、贴近输入区。
- 形态：单行 pill「N 个后台任务运行中」+ 展开箭头 + 运行图标。
- 可见性：**仅当 `runningBackgroundTasks(sessionID)` 非空时显示；全部完成后
  自动消失**。覆盖三路径：①无 part、②派发完成（part completed）、③转换后
  （part completed）；前台阻塞（part running）不进（2026-10-08 升格修订）。
- 点击 → 打开任务列表浮层（D2）。
- 组件：`BackgroundTaskBar`，消费 `store.runningBackgroundTasks`。
- **不做**批量停止、不在任务条上直接放停止钮（停止入口只在列表内，防误触）。

### D2 任务列表（锚定浮层：查看 + 停止）

桌面无 bottom sheet；沿用 composer 锚定浮层约定（`CommandHints` 的
`.command-hints-slot` 同款），浮层出现在 composer 上沿、悬浮于消息流不占布局。

- 列表逐项：agent 名 + `title` 描述 + 已运行时长。
- 每项操作：
  - **查看** → 浮层内切换到**嵌入**该子会话消息流（独立滚动），不开独立 Tab/
    路由。复用从 `SubagentPanel` 抽出的 `SubagentBody`（逐条 `MessageBlock` +
    独立滚动 + 贴底跟随），避免重复实现。
  - **停止** → `store.abortSession(childID)`（= `interrupt`）；请求在途禁用该钮。
    停止后子会话 `session.execution.interrupted` → `sessionStatus` 归 idle →
    任务条移除该项；子会话消息流仍可查看。
- 已运行时长：取子会话 `time.created`（或首次观察到 busy 的时刻），列表/详情
  打开期间用 1s ticker 刷新；关闭即停。
- **不做「停止全部」**：绝大多数情况只有一个后台任务，单条停止足够。

### D3 启动系统提示（客户端本地合成）

- 触发：v2 `session.created` 且 `parentID` 命中某个**已加载/已开 Tab** 的
  会话时，在 `applyV2SessionEvent` 内调用 `onChildSessionCreated(child)`。
- 判定（2026-10-08 升格修订）：未被 `foregroundClaimedChildIds` 认领即合成
  一条系统提示「已启动后台任务：<label>」，`label = child.title || child.id`。
  三路径在此刻的可见性：①无 part → 插；②派发 part（`tool.called` 先于
  `session.created`，`input.background:true`）→ 非前台认领 → 插；③前台
  running part → 不插（转换后由任务条呈现，不补启动提示）。
- 存放：**独立通知表** `noticesBySession: Map<sessionID, SessionNotice[]>`，
  不写入 `messagesBySession`（**桌面关键取舍**，见「与移动端的差异」）：
  通知 id 为 `bg-start:<childID>`，`created = child.time.created`。
- **已知边界**：仅当父会话消息流已加载或父会话有打开 Tab 时合成（用户正在/
  曾打开该会话）；应用重启/对账拉起的历史会话不补启动提示（完成提示经 REST
  仍在，任务条也不受影响）。关 Tab = 归档经 `cleanupSessionState` 清
  `noticesBySession`（与消息容器同清理），重开 Tab 也不补启动提示。
- **误插纠正（判据缩窄）**：SSE volatile 缺口可吞掉 `tool.called`（与
  `session.created` 仅隔 ~44ms）或整个派发 part——`session.created` 到达时
  认领数据缺席会误插**前台**子会话的启动提示；`message.part.updated` 落
  `task`/`subagent` tool part、`mergeMessagePage` / `onMessagesSnapshot` REST
  合并后，按 `foregroundClaimedChildIds`（含 description 兜底）撤回。**后台
  派生不撤**（旧判据按任意认领撤回，completed part 的认领把②的合法启动提示
  一起撤掉——「启动通知过一会消失」现场病灶的根因，2026-10-07）。代价 =
  description 前缀误匹配的并发**前台**任务可能被误撤（已接受，风险面收窄）。
- **对账持久性**：启动提示本就不进 `messagesBySession`，天然不受
  `mergeSnapshotIntoMessages` 的窗口删除影响（移动端需显式保留 metadata，
  桌面结构上免疫）。

### D3b 转后台系统提示（③，客户端本地合成，2026-10-08 对齐补裁定）

- 触发：`reconcileConvertedNotices`——前台认领 part（`input.background` 缺省）
  转 **completed**，且其子会话 `sessionActivity !== "idle"`。挂点与 D3 撤回
  一致：task/subagent part 事件（live）+ `mergeMessagePage` /
  `onMessagesSnapshot`（REST 对账，SSE 缺口恢复）。
- 判据语义：前台正常完成时子会话**先于** part 归 idle（`jobs.block` 语义，
  服务端顺序 execution.succeeded → tool.success），「part completed + 子会话
  仍在跑」唯一对应③转换（`tool.success` 携带 `backgroundResult`）。`error`
  part 不算（失败/中断非转换）。
- 形态：`kind: "background-converted"`，id `bg-convert:<childID>`（幂等，已
  存在不重插）；`created` 取合成时刻（服务端不暴露转换时间；live 路径与
  转换仅隔毫秒）。文案「已转后台任务：<label>」，图标 `CornerUpRight`。
- ③的子会话出生时无启动提示（D3 前台认领闸门），转后台提示是其对应的
  「入列」消息——三路径呈现对齐：启动（或转后台）/ 完成 / 任务条。
- **已知边界**：与启动提示同为客户端瞬态——重启/关 Tab 后不补（任务条与
  完成提示不受影响）；转换后瞬间完成（子会话在合成闸门检查前归 idle）则
  只有完成提示，接受。

### D4 完成系统提示（服务端 synthetic）

- 实时：`session.inbox.enqueued` 且 `item.type == "synthetic"` 且
  `item.payload.metadata.source == "subagent"` 时，读
  `{childID, agent, state, text}`，合成通知
  `{ id: inboxID, kind: "background-finished", state, childID }`。
- 重启/对账：REST 快照的 `synthetic` 条目携带同一 `metadata`（本次令
  `toInternalMessages` 保留它），在 `mergeMessagePage` / `onMessagesSnapshot`
  抽取同一通知；**按 id 去重**——`inboxID` 即消息 id（移动端 ref §7 实测），
  与 REST `msg_…` 同 id 空间，SSE 与 REST 不会重复。
- 文案：「后台任务完成 / 失败 / 取消：<label>」。`state` 主枚举
  `completed` / `error` / `cancelled`；防御性接受 wire 别名 `failed`→error、
  `interrupted`→cancelled，未知值归 `completed` 样式。`label` 优先解析
  synthetic `text` 里的 `description`，回退 `payload.description` / `agent`。
- 可附「查看结果」：点击通知 → `store.requestTaskDetail(childID)`，由
  `ChatView` 消费并打开 D2 的嵌入详情浮层（消费后即清，模式同
  `consumeFileReveal`）。任务已结束时任务条已消失，详情仍可按 childID 打开。
- **留在原始接收位置**，不与任何任务条条目合并。
- **三路径统一渲染**（2026-10-06 裁定「不按工具型排除」；2026-10-08 升格后
  与「按异步统一」的模型自洽）：`background:true` / 前台被 backgrounded 的
  完成 synthetic 与命令型同源（`SubagentCompletion.deliver`），一并渲染为
  完成通知——移动端同款；派发 tool part 呈现不变，通知是流内历史。
  工具型前台正常完成无 synthetic（结果在 tool part content），不受影响。

### D5 系统提示样式（统一）

新增一种低强调行式系统提示，`ChatEntry` 增加 `kind: "notice"`，与消息一起
按 `created` 排序渲染。

| kind | 触发 | 图标（lucide，14px） |
|---|---|---|
| 后台任务启动 | D3 | `Rocket` |
| 转后台任务 | D3b（③） | `CornerUpRight` |
| 后台任务完成 | D4（completed） | `CircleCheck` |
| 后台任务失败 | D4（error/failed） | `CircleX` |
| 后台任务取消 | D4（cancelled/interrupted） | `CircleStop` |

- **排序与并列 tie-break**：通知与消息按 `created` 混排；`created` 并列时按
  kind 秩 `message < notice < optimistic` 稳定排序——现有 `message-merge.ts:79`
  是二值比较器，加入第三种 kind 后会变成非反对称（`sort` 结果未定义），必须显式
  定义三 kind 秩；同 kind 再按 id 字典序。
- 样式：leading 图标 + 文本（`ui-sm`，`color-text-muted` / `outline`）+ 可选
  trailing 操作（「查看」）；行式、低对比，不画气泡底。
- 桌面现状**没有**系统提示样式（只有 `.error-card` 与 `.pending-card`）；
  本样式是首个，后续 model/agent 切换等系统级通知可复用。
- 图标遵循 `DESIGN.md`（lucide 线性、禁 Unicode 字形充当图标）；字号/颜色走
  `tokens.css`。
- **本设计不新增** model-switched / agent-switched 通知（桌面跨端切换现为静默
  补丁），仅保留样式备用。

### D6 主会话 running（家族聚合）

- 新增 `sessionActivity(sessionID): "busy" | "retry" | "idle"`：沿子会话树
  BFS（自身 + 全部后代），`retry` 优先于 `busy`，全 idle 才 idle。
- 索引：`childSessionsOf` 维护 `childrenByParent` 缓存，由 `sessionRegistryVersion`
  计数器驱动**惰性重建**（在会话 upsert / 删除 / 整表替换的漏斗里自增：
  `applySessionEvent`、`applySessionsSnapshot`、`session.deleted`、项目关闭清空、
  teardown），避免每次线性扫描全量会话。**不挂 `cleanupSessionState`**：关 Tab =
  归档、不删会话，挂上会让仍在跑的后台任务淡出家族聚合（该函数还被关项目/删
  worktree 调用）；只要会话仍在 `sessionsByProject`，索引即有效。
- 消费口径（**只改指示器，不改输入锁**）：
  - `dotStateFor(sessionID)` 的进行中/重试投影改用 `sessionActivity`（终局
    `failed` 仍由本会话末条 assistant 派生）；→ 左栏 `SessionIndicator`、Tab
    状态点、项目行随之后台任务运行中点亮。
  - `pendingCountFor` 已含子会话待处理（`childPermissionFor` /
    `childQuestionsFor`），维持不变。
  - `ChatView` 的 composer 仍看本会话 `statusOf(sessionID)`：**后台任务不锁输入**，
    typing dots 也不因后台任务出现。
  - `isSessionActive` 保持「本会话自身」语义，不动（关 Tab 确认、composer 停止
    等依赖本会话精确状态）。

## 状态模型

```
runningBackgroundTasks(parentId) =
    childSessionsOf(parentId)
      ∩ sessionActivity(childId) !== "idle"
      ∩ childId ∉ activeClaimedChildIds(parentMessages)

noticesForSession(sid) = noticesBySession.get(sid)  // 按 created 排序
chatEntries(sid)        = sort(message 条目 ∪ optimistic 条目 ∪ notice 条目)
```

- `sessionActivity` 返回家族聚合；两个认领判据集见「识别」。
- 通知 id：启动 `bg-start:<childID>`；转后台 `bg-convert:<childID>`；完成 `<syntheticMsgID>`。去重按 id。

## 场景验证

| 场景 | 预期 |
|---|---|
| 命令型后台任务运行中 | 任务条常驻「1 个后台任务运行中」；父会话 Tab/左栏点仍亮 running；继续对话/滚动不影响它 |
| 点任务条 | 打开列表；「查看」浮层内嵌入子会话流；「停止」→ `execution.interrupted`，任务条移除该项 |
| 全部完成 | 任务条消失；流内留下「已启动」「已完成」两条系统提示 |
| 工具型前台（同步）运行中 | **无任务条**；`SubagentPanel` 照旧；composer 停止可取消 |
| 工具型 `background: true` 派发 | 启动提示照插；派发完成后任务条纳入；派发 tool part 留流内（SubagentPanel 呈现派发记录） |
| 工具型前台转后台（③） | 转换前无任务条；转换后任务条纳入 + 合成「已转后台」提示；完成通知照常 |
| SSE 缺口吞掉 `tool.called` | ②③照插/照常；前台子会话误插的启动提示在对账（60s 周期/重连）后撤回 |
| 命令型完成后重启/对账 | 启动提示不补（已知边界）；完成提示经 REST `synthetic` 重建 |
| 子会话内权限/问题 | 沿 `design-subagent-status` §D6 上浮父会话（既有路径不变） |
| 后台任务运行 + 用户发下一条 | 不受阻（父会话不 busy，输入不锁） |

## 关键设计决策

1. **按「异步」统一**（2026-10-08 升格，替代原「工具型完全不动」）：前台
   tool part 已自洽不动；`background:true` 与前台转后台与命令型同权——启动/
   完成提示 + 任务条。判据不依赖服务端新增字段：`input.background`（派发时）
   + part 状态（运行态）。
2. **后台任务「运行中」与消息流解耦**：常驻任务条承载进行中状态，消息流只留
   系统提示作为历史。
3. **两个判据集刻意不同**：插入/撤回看 `input.background`（前台认领），任务条
   看 part 运行态——单一判据覆盖不了③（`background` 缺省但运行中转后台）与
   SSE 缺口（input 不可读时宁可误插、对账纠正）。
4. **只提供单条停止** = `abortSession(childID)`：不做「停止全部」；终态由
   `execution.interrupted` + 完成 synthetic 收敛。
5. **详情用嵌入浮层**，不引入子会话独立 Tab / 路由（延续 design-subagent-status）。
6. **通知独立成表、不进消息容器**（桌面特化，理由见下）：通知 id 是客户端
   `bg-start:<childID>` 或 server `msg_…`，与消息 id 混存会污染排序、回滚过滤、
   空消息守卫与对账窗口删除；独立表让 D3 的对账持久性问题结构性消失。

## 与移动端的差异

| 维度 | 移动端 | 桌面端 |
|---|---|---|
| 状态容器 | `ServerStore`（会话/状态）+ `ConversationStore`（每会话消息）分离 | 单一 `AppStore`；通知表 `noticesBySession` 挂 store |
| 通知存放 | 作为 `DisplayMessage` 进消息流，靠 `metadata.kind` 在对账窗口删除中显式保留 | 独立 `noticesBySession`，不进 `messagesBySession`，结构免疫窗口删除 |
| 详情展示 | `showModalBottomSheet` | composer 锚定浮层（无 bottom sheet） |
| 子会话索引 | `_childSessions` 64 条 LRU（只收子会话） | `sessionsByProject` 全量保留；无 LRU 约束，新增 `childrenByParent` 惰性缓存 |
| 完成提示落地 | `onSynthetic` 物化 + inbox | inbox `synthetic` 直接物化；REST `synthetic` 抽取，按 id 去重 |
| 会话容器淘汰 | `_evictConversations` 豁免子会话 | `ensureConversation` 已豁免子会话（第 1932 行），无需改 |

## 不做的事

- 不为**前台**工具型 subagent 引入任务条 / 启动提示（同步阻塞，chip 自洽）。
- 不做子会话独立 Tab / 跳转页。
- 不把完成 synthetic 合并进任务条条目（启动/完成提示与任务条各司其职）。
- 不做「停止全部」；不做批量停止端点。
- 不在任务条上直接放停止（入口只在列表内）。
- 不新增 model/agent 切换通知。

## 实现影响（涉及文件）

| 文件 | 改动 |
|---|---|
| `src/shared/session-notices.ts`（新） | `SessionNotice` 类型；`parseSubagentSynthetic(text, metadata)`；`state → kind/图标` 投影；启动提示构造（纯函数，便于测试） |
| `src/shared/session-notices.test.ts`（新） | 解析/映射/去重用例 |
| `src/shared/api-types.ts` | `UserMessage.metadata?`（保留 REST synthetic metadata） |
| `src/shared/v2-adapter.ts` | `toInternalMessages` 的 `synthetic` 分支透传 `metadata` |
| `src/shared/message-merge.ts` | `ChatEntry` 增 `{ kind: "notice"; data: SessionNotice }`；`sortEntries` 增三 kind 秩 `message < notice < optimistic` 的并列 tie-break；`filterRevertedEntries` 保留 notice（回滚不隐藏通知） |
| `src/renderer/src/store/app-store.ts` | `noticesBySession`、`childrenByParent` 惰性缓存（版本号驱动）、`sessionActivity`、`childSessionsOf`/`toolFormChildIds`/`runningBackgroundTasks`、D3 合成与撤回、D4 inbox/REST 抽取与去重、`dotStateFor` 改家族聚合、`requestTaskDetail`/`consumeTaskDetailRequest`、`cleanupSessionState`（仅清通知）与 `teardownConnection` 挂点 |
| `src/renderer/src/components/workspace.tsx` | 抽出 `SubagentBody`（`SubagentPanel` 复用）、`BackgroundTaskBar` + 任务列表/详情浮层、notice 渲染、`ChatView` 接线（D2 详情请求消费）、`task`/`subagent` 都路由 `SubagentPanel` |
| `src/renderer/src/styles/app.css` | 任务条、任务行、系统提示行、锚定浮层、嵌入详情样式 |
| `src/renderer/src/i18n/index.ts` | 文案中/英（bgTaskRunning/Started/Completed/Failed/Cancelled/View/Stop/Done 等） |
| `docs/spec/spec-v0.5.md` | 功能范围同步（新增后台任务条，改功能范围必须同步） |

## 已知限制 / 坑

- **启动提示不补历史**：仅实时 `session.created` 合成；重启/对账拉起的后台任务
  只有完成提示与任务条，无启动提示（同移动端边界）。关父会话 Tab（归档）再
  重开同样不补启动提示（`noticesBySession` 随会话运行时状态清理；完成提示经
  REST `synthetic` 重建，不受影响）。
- **关父会话 Tab 期间无停止入口（已知空档）**：归档不改 `sessionsByProject`，
  子会话保留，左栏/Tab 家族聚合仍点亮（D6）；但任务条随 `ChatView` 卸载而消失，
  停止入口一并不可达。`closeChatTab` 只在本会话自身 `isSessionActive` 为真时
  abort，后台任务父会话 idle → 不 abort，子会话继续跑到完成。重开 Tab 即恢复
  任务条/停止入口。属可接受的行为空档；若要「关 Tab 询问是否停后台任务」，另立设计。
- **启发式匹配局限**：description 兜底在父会话并发多个 `task`/`subagent` 时
  可能挂错（`metadata.sessionId` 权威路径不受影响）；2026-10-08 起误撤风险
  收窄到**前台**认领（后台派生不撤）。
- **`subagent` tool 现状缺口**：现存 `SubagentPanel` 只认 `task`；本设计把
  `subagent` 一并纳入工具型路由与认领判据，否则其子会话会被误判成
  后台任务。载荷同构依据见「范围」表下注（移动端 `conversation_screen.dart:2006`）。
  另：v2.0.18 无 `task` tool（2026-10-06 核实，见契约表）——`task` 路由仅为
  v1 存量数据兼容，新事件恒为 `subagent`。
- **③转后台提示为客户端瞬态（D3b）**：前台转后台的子会话出生时是同步
  （running part 认领）→ 无启动提示，转后台时合成 `bg-convert` 提示（对齐
  补裁定）；与启动提示同不补历史。转换后瞬间完成的竞态下只有完成提示，
  接受。
- **②派发窗口的瞬时排除（~30ms，接受）**：`background:true` 从 `tool.called`
  到 `tool.success` 之间 part 为 running，任务条按运行态判据短暂排除该子会话；
  success 落地即纳入。派发失败（part error 且子会话未起）则维持排除。
- **家族聚合的瞬时窗口**：断连时 `sessionStatus.clear()` 会让运行中的后台任务
  短暂显示 idle/父亲族也灭，重连对账后恢复（与 typing dots 断连同语义，可接受）。
- **完成 synthetic 的 `state`**：主枚举 `completed/error/cancelled`，防御性
  接受 `failed`/`interrupted` 别名，wire 出现未知值时归「完成」样式（宽松兜底，
  不误报失败）。
- **通知与回滚**：通知不参与回滚隐藏（回滚只作用于消息）；这是桌面取舍，避免
  客户端 `bg-start:` id 与服务端 `msg_` id 比较产生未定义顺序。

## Review 记录（2026-10-03）

### 第一轮

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🔴 blocking | `sessionActivity` 签名返回字符串，公式却写 `.type`（恒真 → 已完成任务不消失） | 统一为返回字符串 + `!== "idle"`（识别/状态模型/D6 三处） |
| 2 | 🟠 | 引用 `docs/ref/ref-opencode-review-subagent.md` 在桌面仓库不存在 | 改指移动端 `../openbuilder/docs/ref/ref-opencode-review-subagent.md` |
| 3 | 🟠 | synthetic 的 REST 消息 id 与 inboxID 同空间无实证 | 补引移动端 ref §7「inboxID 即消息 id」 |
| 4 | 🟠 | `childrenByParent` 删除挂 `cleanupSessionState` 过宽（关 Tab=归档会丢运行中子会话） | 改为版本号驱动惰性重建，明确不挂 `cleanupSessionState` |
| 5 | 🟢 nit | `findChildSession` 行号 3718 → 3731 | 已修（3718 / 3731） |
| 6 | 🟢 nit | `RevertBar` 行号 1673 → 1674 | 已修 |
| 7 | 🟢 nit | 开头称工具型「呈现不变」与后文 `subagent` 补正矛盾；`subagent` tool 缺来源 | 开头改为「基本不变 + `subagent` 补正」；补引移动端 ref §3.4/§5 |

### 第二轮

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟠 | D3 撤回只用权威 `metadata.sessionId`，与 D1 的 description 兜底不一致；中断的 tool part 永不回写 id 时启动提示残留 | D3 撤回改用与 D1 同一 `toolFormChildIds` 判据（含兜底），记录误撤代价 |
| 2 | 🟠 | `sortEntries` 加第三种 kind 后 `created` 并列比较器非反对称 | D5 明确三 kind 秩 `message < notice < optimistic` |
| 3 | 🟠 | 后台任务运行中关父 Tab → 任务条/停止入口消失（行为空档）未记录 | 补入「已知限制」，说明 `closeChatTab` 不 abort idle 父会话 |
| 4 | 🟢 nit | 背景对「REST 路径丢失」描述不精确（丢在 part 过滤 + 空消息守卫，非 `toInternalMessages`） | 改写为转 part → 滤空 → 空消息守卫三段 |
| 5 | 🟢 nit | `state` 枚举前后不一致 | 统一为 `completed/error/cancelled` + 防御性别名 `failed`/`interrupted` |
| 6 | 🟢 nit | 「父会话 idle 时指示器全灭」不准（waiting 仍亮） | 改为「running 不点亮」 |
| — | ❓待确认 | `subagent` tool 是否存在及载荷形状 | 查证：移动端 `conversation_screen.dart:2006` 对 `task`/`subagent` 同走 `_SubagentPanel`，读同组字段；补注依据 |

### 第三轮（实现后，2026-10-06）

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟠 | 完成回执未排除工具型；工具型 task 完成是否带 `source=subagent` 待证 | 源码核实（tag v2.0.18）：`background:true` / 前台被 backgrounded 的工具型**也发**、前台正常完成不发。裁定**不排除**（同移动端 `_noticeMessage`），契约表 + D4 补记，测试钉行为 |
| 2 | 🟠 | D3 撤回只覆盖「创建早于 tool part」；反向时序 + 中断残留 | 已修：`onChildSessionCreated` 插入前先查 `toolFormChildIdsFor`，已认领直接不插；补反向时序用例 |
| 3 | 🟢 nit | 任务条浮层 / 详情浮层 / command-hints 同位无叠放次序 | `.bg-task-popover` / `.task-detail-slot` 加 `z-index: 30` |
| 4 | 🟢 nit | 完成通知 label 兜底链缺 childID，可能空名 | 兜底链补 `childID`，补用例 |
| 5 | 🟢 nit | 详情浮层无 Esc 关闭 / aria | 挂 window Esc（`isComposing` + `overlayCount > 0` 让位），`role=dialog` + `aria-label` 已有 |

### 第四轮（实现后，2026-10-06）

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟠 | 撤回钩子只在 `message.part.updated`；断线丢事件、REST-only 落地时不撤回 | `mergeMessagePage` / `onMessagesSnapshot` 合并后补调 `reconcileStartNotices`（无 background-started 时早退，零成本）；补 REST-only 用例 |
| 2 | 🟠 | 任务条全部结束后 `open` 残留，新任务启动浮层直接展开 | `tasks.length === 0` 时 effect 复位 `open`/`stopping` |
| 3 | 🟠 | 详情浮层对不可解析 childID 永久「加载中」 | 加载探测后 `!childSession && entries 空` 落 `subagentNoSession` 空态（会话在而 REST 失败仍走加载态——SubagentPanel 同款，重开是重试） |
| — | 🟢 nit | `chatEntryKey` 与 ChatView 内联 key 两处维护 | ChatView 改用 `chatEntryKey` |
| — | 🟢 nit | `entryCreated(e, 0)` 哑参 | 拆 `settledCreated`（模块级）+ `createdOf`（sortEntries 闭包） |

### 第五轮（2026-10-08 升格修订）

**触发**：现场病灶「后台任务启动通知过一会消失，完成通知始终在」。根因定位
（活体抓包 + 现场 REST 数据 + store 复现）：

1. 症状来自工具型 `background:true`（agent 发起的异步任务），非命令型。
2. SSE volatile 缺口吞掉 `tool.called`（与 `session.created` 仅隔 ~44ms）→
   认领判据失明 → 误插启动提示。
3. 60s 周期/重连对账经 REST 带回 `metadata.sessionID`（completed part 持久化
   可靠携带）→ 旧判据「任意认领即撤」把**合法**的后台启动提示一并撤掉 → 闪现。

**用户裁定**：按「异步即后台任务」统一——`background:true` 与前台转后台升格
为完整后台任务（启动提示 + 任务条 + 完成通知）；前台（同步）保持纯 chip。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🔴 | 旧判据单一（任意 task/subagent 认领 = 排除 + 撤回），completed part 的认领把②的合法启动提示撤掉 | 拆两个判据集：`foregroundClaimedChildIds`（插入/撤回，`input.background ≠ true` 才算前台）+ `activeClaimedChildIds`（任务条排除，仅 pending/running part） |
| 2 | 🟠 | `background:true` 是否可等价于异步 | 否——三路径（命令型 / `background:true` / 前台转后台），后者 `input.background` 缺省；组合判据覆盖（创建时读 input，运行时读 part 状态），契约表补记③与 background 端点 |
| 3 | 🟠 | 契约表漏记：`background:true` 的 `tool.success` 与 REST 持久化都带 `metadata.sessionID`（源码初读会误判为不带） | 契约表补记（2026-10-07 活体抓包 + 现场 REST 数据双证） |
| 4 | 🟢 | ③转后台无启动提示的不对称 | 接受并记录（出生时是同步；任务条出现即转换信号，不补历史） |
| 5 | 🟢 | ②派发窗口（~30ms）任务条瞬时排除 | 接受并记录（success 落地即纳入） |

### 第六轮（2026-10-08 对齐补裁定）

**用户裁定**：③转后台也应有系统通知。三路径呈现统一为「启动（或转后台）
消息、完成消息、任务条」。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟠 | ③转换在服务端无专用事件（仅 part completed + 父会话一条无 metadata 的 synthetic） | 客户端状态检测：前台认领 part 转 completed ∧ 子会话仍在跑（`jobs.block` 语义保证前台正常完成时子会话先归 idle，误报面为零）；`error` part 不算 |
| 2 | 🟢 | 转换时间服务端不暴露 | `created` 取合成时刻（live 路径与转换毫秒级相邻）；id `bg-convert:<childID>` 幂等防抖动 |
| 3 | 🟢 | 转换后瞬间完成的竞态 | 接受：子会话在合成闸门前归 idle 则只有完成提示（记入已知限制） |
