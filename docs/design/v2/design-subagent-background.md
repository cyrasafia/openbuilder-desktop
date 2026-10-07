# 用户后台任务卡 + 系统提示

> 参考移动端 `../openbuilder/docs/design/v2/design-subagent-background.md`。
> 本文只覆盖**用户后台任务**——命令型 `subagent: true` 建立的异步子会话。
> 工具型 subagent（`task` tool part，以及 v2 的 `subagent` tool part）的呈现
> 基本不变，仍按 [`design-subagent-status.md`](design-subagent-status.md)；
> 其中 `subagent` tool part 的**现状缺口**一并补正（见「范围」表下注）。
>
> 移动端把后台任务做成「按子会话启动注入消息流的 chip」后废弃并改为
> 「常驻任务条 + 系统提示」；桌面端**从未实现过 chip**，本次是首次实现，
> 直接采用常驻任务指示方案（初版为任务条，2026-10-07 修订为通栏折叠卡，
> 见 D1/D2）。桌面与移动端的主要结构差异见文末「与移动端的差异」。

## 背景与问题

命令型 `subagent: true` 会建立异步子会话：父会话不被阻塞、用户可继续对话
（服务端路径见移动端 `../openbuilder/docs/ref/ref-opencode-review-subagent.md` §3.4；
`subagent` tool 的存在与语义见同文 §3.4/§5）。

桌面端当前只处理**工具型**子会话（`task` tool part → `SubagentPanel`，
`workspace.tsx` 第 2597 行）。命令型子会话**三处不可见**：

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

## 范围

| | 命令型 `subagent: true`（用户后台任务） | 工具型 `task`/`subagent` tool part |
|---|---|---|
| 消息流呈现 | 启动/完成各一条**系统提示** | 保持 `SubagentPanel`（tool part 形态） |
| 进行中指示 | **常驻任务卡**（通栏折叠，默认收起） | tool part 自身（运行态） |
| 停止入口 | 任务列表内 | composer 停止（中断父会话连带取消） |

即：**不动**的是 `design-subagent-status.md`；**新增**的是本文。

> 桌面补正：工具型判据与渲染都须同时认 `task` **与** `subagent` 两个 tool
> （现存代码只把 `task` 路由到 `SubagentPanel`，`subagent` tool 落 `ToolChip`
> ——见「实现影响」）。依据：v2 存在 `subagent` 工具（移动端 ref §3.4/§5），
> 移动端把二者统一走 `_SubagentPanel`（`conversation_screen.dart:2006`），读同一
> 组字段 `input.description` / `input.subagent_type` / `metadata.sessionId`——
> 载荷同构，可复用桌面现有 `SubagentPanel`。

## 识别：哪些子会话算「用户后台任务」

- 候选 = 当前会话的直系子会话（`parentID == 当前会话`）。
- 其中**消息流里没有被 tool part 引用**的，才是后台任务：
  - 优先 `metadata.sessionId`（兼容 `sessionID`）；
  - tool part 尚在 `pending/running`、metadata 未写入窗口时，用
    description ↔ title 前缀启发式兜底（`findChildSession` 同款，避免刚发起就
    误判成后台任务）。
- 取运行中：子会话 `sessionActivity(childID) !== "idle"`（即 busy/retry）。
- 工具型即便用 `background: true`，仍保持 tool part 形态，**不进任务条**。

```
toolFormChildIds(parentId) =
    parentMessages 中 tool ∈ {task, subagent} 的 part
      ├─ metadata.sessionId / metadata.sessionID（权威）
      └─ input.description ↔ child.title 前缀且 part 处于 pending/running（兜底）

runningBackgroundTasks(parentId) =
    childSessionsOf(parentId)
      ∩ sessionActivity(childId) !== "idle"
      ∩ childId ∉ toolFormChildIds(parentId)

任务条可见 = runningBackgroundTasks(parentId).length > 0
```

`childSessionsOf` 由 D6 的 `childrenByParent` 惰性缓存提供（源 = `sessionsByProject`
全量，同 `findChildSession` 口径）；`sessionActivity` 见 D6。

## 设计

### D1 常驻后台任务卡

- 位置：`ChatView` 的 `.composer` 顶行（与 `RevertBar` 同层，见
  `workspace.tsx` 第 1692 行），不遮消息区、贴近输入区。
- 形态（**2026-10-07 修订**：原「单行 pill + 上弹浮层」改为通栏折叠卡）：
  复用 `.pending-card` 结构（与授权/问题卡同款通栏折叠形态，用户裁定），
  头部一行 = `Rocket` 图标 + 标题「后台任务」+ 计数「N 个运行中」+ 展开箭头；
  **默认收起**，点击头部切换；展开体在卡内列出任务（D2）、推高 composer，
  不再悬浮于消息区。配色中性 surface-container 系（原任务卡同判），
  图标 primary 表运行中。
- 可见性：**仅当 `runningBackgroundTasks(sessionID)` 非空时显示；全部完成后
  自动消失**。
- 组件：`BackgroundTaskBar`，消费 `store.runningBackgroundTasks`。
- **不做**批量停止、不在头部直接放停止钮（停止入口只在展开列表内，防误触）。

### D2 任务列表（卡片展开体：查看 + 停止）

**2026-10-07 修订**：任务列表由「composer 上沿锚定浮层（悬浮不占布局）」
改为任务卡展开体（`.pending-card-body` 结构，320px 上限内滚动）——与授权/
问题卡的折叠展开形态一致、默认收起。**「查看」的嵌入详情浮层不变**：仍是
composer 上沿锚定（`CommandHints` 的 `.command-hints-slot` 同款约定），
悬浮于消息流不占布局。

- 列表逐项：agent 名 + `title` 描述 + 已运行时长。
- 每项操作：
  - **查看** → 浮层内切换到**嵌入**该子会话消息流（独立滚动），不开独立 Tab/
    路由。复用从 `SubagentPanel` 抽出的 `SubagentBody`（逐条 `MessageBlock` +
    独立滚动 + 贴底跟随），避免重复实现。
  - **停止** → `store.abortSession(childID)`（= `interrupt`）；请求在途禁用该钮。
    停止后子会话 `session.execution.interrupted` → `sessionStatus` 归 idle →
    任务卡移除该项；子会话消息流仍可查看。
- 已运行时长：取子会话 `time.created`（或首次观察到 busy 的时刻），列表/详情
  打开期间用 1s ticker 刷新；关闭即停。
- **不做「停止全部」**：绝大多数情况只有一个后台任务，单条停止足够。

### D3 启动系统提示（客户端本地合成）

- 触发：v2 `session.created` 且 `parentID` 命中某个**已加载/已开 Tab** 的
  会话时，在 `applyV2SessionEvent` 内调用 `onChildSessionCreated(child)`。
- 判定为后台任务（D1 识别）且子会话未处于终态 → 本地合成一条系统提示
  「已启动后台任务：<label>」，`label = child.title || child.id`。
- 存放：**独立通知表** `noticesBySession: Map<sessionID, SessionNotice[]>`，
  不写入 `messagesBySession`（**桌面关键取舍**，见「与移动端的差异」）：
  通知 id 为 `bg-start:<childID>`，`created = child.time.created`。
- **已知边界**：仅当父会话消息流已加载或父会话有打开 Tab 时合成（用户正在/
  曾打开该会话）；应用重启/对账拉起的历史会话不补启动提示（完成提示经 REST
  仍在，任务条也不受影响）。关 Tab = 归档经 `cleanupSessionState` 清
  `noticesBySession`（与消息容器同清理），重开 Tab 也不补启动提示。
- **竞态收敛**：子会话注册可能早于其工具型 tool part 入流而误插；`message.part.updated`
  落 `task`/`subagent` tool part 后，即按 `toolFormChildIds`（**与 D1 同一判据**，
  含 description 兜底）撤回误插的启动提示。用同一判据是刻意选择：D1 已用兜底把
  该子会话排除出任务条，D3 若只用权威 id，就会出现「有启动提示、无任务条、也不是
  后台任务」的三方矛盾；且中断的 tool part 可能永不回写 `metadata.sessionId`
  （`design-subagent-status` §坑），兜底是唯一撤回路径。代价 = description 前缀
  误匹配的并发任务可能被误撤，风险面与 D1 相同（已接受）。
- **对账持久性**：启动提示本就不进 `messagesBySession`，天然不受
  `mergeSnapshotIntoMessages` 的窗口删除影响（移动端需显式保留 metadata，
  桌面结构上免疫）。

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
- **不按工具型排除**（2026-10-06 裁定）：工具型 `subagent` tool `background:true` /
  前台被 backgrounded 的完成 synthetic 与命令型同源（`SubagentCompletion.deliver`），
  一并渲染为完成通知——移动端同款；工具型 tool part 呈现不变，通知只是流内历史。
  工具型前台正常完成无 synthetic（结果在 tool part content），不受影响。

### D5 系统提示样式（统一）

新增一种低强调行式系统提示，`ChatEntry` 增加 `kind: "notice"`，与消息一起
按 `created` 排序渲染。

| kind | 触发 | 图标（lucide，14px） |
|---|---|---|
| 后台任务启动 | D3 | `Rocket` |
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
      ∩ childId ∉ toolFormChildIds(parentMessages)

noticesForSession(sid) = noticesBySession.get(sid)  // 按 created 排序
chatEntries(sid)        = sort(message 条目 ∪ optimistic 条目 ∪ notice 条目)
```

- `sessionActivity` 返回家族聚合；`toolFormChildIds` 由父会话 tool part 计算。
- 通知 id：启动 `bg-start:<childID>`；完成 `<syntheticMsgID>`。去重按 id。

## 场景验证

| 场景 | 预期 |
|---|---|
| 命令型后台任务运行中 | 任务卡常驻（默认收起，头部「后台任务 · N 个运行中」）；父会话 Tab/左栏点仍亮 running；继续对话/滚动不影响它 |
| 点任务卡头部 | 展开任务列表（推高 composer）；「查看」浮层内嵌入子会话流；「停止」→ `execution.interrupted`，任务卡移除该项 |
| 全部完成 | 任务卡消失；流内留下「已启动」「已完成」两条系统提示 |
| 工具型 subagent 运行中 | **无任务条**；`SubagentPanel` 照旧；composer 停止可取消 |
| 工具型 `background: true` | 仍为 tool part 形态（按范围不进任务条） |
| 命令型完成后重启/对账 | 启动提示不补（已知边界）；完成提示经 REST `synthetic` 重建 |
| 子会话内权限/问题 | 沿 `design-subagent-status` §D6 上浮父会话（既有路径不变） |
| 后台任务运行 + 用户发下一条 | 不受阻（父会话不 busy，输入不锁） |

## 关键设计决策

1. **工具型完全不动**：前台 tool part 已自洽，不引入任务条/启动提示。
2. **后台任务「运行中」与消息流解耦**：常驻任务条承载进行中状态，消息流只留
   系统提示作为历史。
3. **识别以「有无引用它的 tool part」为判据**：区分命令型与工具型，不依赖
   服务端新增字段；`task` 与 `subagent` 两个 tool 都算工具型。
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

- 不为工具型 subagent 引入任务条 / 启动提示（含 `background: true`）。
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
| `src/renderer/src/styles/app.css` | 任务卡（复用 .pending-card）、任务行、系统提示行、嵌入详情浮层样式 |
| `src/renderer/src/i18n/index.ts` | 文案中/英（bgTaskRunning/Started/Completed/Failed/Cancelled/View/Stop/Done 等） |
| `docs/spec/spec-v0.5.md` | 功能范围同步（新增后台任务卡，改功能范围必须同步） |

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
- **启发式匹配局限**：`toolFormChildIds` 的 description 兜底在父会话并发多个
  `task` 时可能挂错（`metadata.sessionId` 权威路径不受影响）。
- **`subagent` tool 现状缺口**：现存 `SubagentPanel` 只认 `task`；本设计把
  `subagent` 一并纳入工具型路由与 `toolFormChildIds`，否则其子会话会被误判成
  后台任务。载荷同构依据见「范围」表下注（移动端 `conversation_screen.dart:2006`）。
  另：v2.0.18 无 `task` tool（2026-10-06 核实，见契约表）——`task` 路由仅为
  v1 存量数据兼容，新事件恒为 `subagent`。
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
