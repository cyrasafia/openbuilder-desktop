# 用户后台任务卡 + 系统提示

> 参考移动端 `../openbuilder/docs/design/v2/design-subagent-background.md`。
> 桌面首次实现即采用「常驻任务指示 + 系统提示」方案（移动端废弃 chip 方案
> 的结论直接继承，桌面从未实现过 chip）；**2026-10-07 形态修订**：原「单行
> pill + 上弹浮层」改为**通栏折叠卡**（复用授权/问题卡的 `.pending-card`
> 形态，默认收起，见「常驻任务卡」节）。
>
> 2026-10-03 首版；2026-10-08 经升格/对齐/重建三轮裁定后全文重写——历史
> 推演与处置见文末 Review 记录（一至八轮）。**2026-10-08 交互修订**：卡位
> 上移分隔线上方、任务行整行点击查看（键盘可达）、行图标删除行加底色、
> 详情窗与任务卡互斥替代、展开态跨详情保留（见「常驻任务卡」节）。工具型
> **前台**（同步阻塞）的呈现不在本文，见 [`design-subagent-status.md`](design-subagent-status.md)。

## 背景

异步建立的子会话（后台任务）此前三处不可见：

- **消息流无指示**：看不出任务在跑（②的 tool part 派发即完成，承载不了
  运行态；①③根本没有运行态载体）。
- **状态不点亮**：父会话 idle 时 Tab/左栏/项目的 running 不亮。
- **完成不可见**：完成回执（synthetic）两头都丢——inbox 的非 user 项被
  忽略，REST 的 synthetic part 被滤空后再被空消息守卫隐藏。
- **不可停止**：无停止入口，中断父会话对后台子会话是 no-op。

工具型前台没有这些问题：前台阻塞调用，tool part 天然停在消息流尾部、
伴随主会话 running、composer 停止连带取消。因此前台保持纯 chip（本文
只负责把它与后台任务区分开，见认领模型）。

## 三种后台任务（场景与区别）

异步子会话共有三条产生路径，全部经 `SubagentCompletion.deliver` 发完成
synthetic（源码核实 tag v2.0.18）：

### ① 命令型 `subagent: true`

用户在输入框运行带 `subagent: true` 的命令（如 `/review`）。服务端
（`config/plugin/command.ts`）建子会话（title = 命令 description 或名），
模板展开后投给子会话执行，父 agent 不参与——父会话消息流里只有命令回显
（subtask part），**没有 task/subagent tool part**。

### ② 工具型 `subagent` tool `background: true`

主 agent 调 `subagent` tool 时传 `background: true`（`tool/plugin/subagent.ts`）。
派发即返回：tool part 在 ~30ms 内转 completed（输出文案「working in the
background…」），子会话后台跑。派发事件序（2026-10-07 活体抓包）：

```
tool.called（parsed input，含 background:true）→ session.created（晚 ~44ms，
title==description）→ tool.progress（metadata:{sessionID,…}）→ tool.success
（part completed，metadata:{sessionID,status:"running",truncated:false}）
```

### ③ 前台运行中转后台

主 agent 前台调用（默认，同步阻塞）运行中，任一客户端调
`POST /api/session/{父}/background`（TUI/CLI 动作；桌面端未接此端点，转换
可来自他端）→ `jobs.backgroundAll`：阻塞中的 tool 返回
`{type:"backgrounded"}` → part 转 completed（与②同款 `backgroundResult`），
子会话继续后台跑。父会话另落一条 synthetic（「User requested that active
blocking work be moved to the background…」，无 `source:subagent`，不渲染）。

### 区别一览

| | ① 命令型 | ② `background:true` | ③ 前台转后台 | 对照：前台（同步） |
|---|---|---|---|---|
| 发起方 | 用户（命令） | agent（传参） | agent 发起 + 他端转换 | agent（默认） |
| 父会话 tool part | 无 | 有，派发即 completed | 有，转换时 completed | 有，运行中 |
| `input.background` | 无此字段 | `true` | **缺省**（出生时是同步） | 缺省 |
| 子会话 title | 命令 description | == `input.description` | == `input.description` | == `input.description` |
| 出生时刻可判异步 | 是（无 part） | 是（called 先于 created） | 否（转换前是同步） | —（非后台） |
| 运行态可判 | 无 part + 子会话 busy | part completed + 子会话 busy | 同② | part running |
| 完成 synthetic | ✓ | ✓ | ✓（`subagents.notify` 补发） | ✗（结果内联 chip） |

核心结论（判据设计的出发点）：**`background:true` 是异步的充分条件而非
必要条件**——③的 `input.background` 缺省。单一标志覆盖不了三路径，须按
时刻分层判（见认领模型）。

## 前端呈现

三路径呈现一致（2026-10-08 双裁定：按「异步即后台任务」升格 + ③转后台
补提示）：每个后台任务有**入列消息（启动或转后台）+ 完成消息 + 运行中
任务卡**；前台任务只有 chip。

| | ① | ② | ③ | 前台（同步） |
|---|---|---|---|---|
| 入列消息 | 「已启动后台任务」 | 「已启动后台任务」 | 「已转后台任务」 | — |
| 完成消息 | ✓ | ✓ | ✓ | —（结果在 chip 内联） |
| 任务卡 | ✓ 出生即入 | ✓ 派发完成后入 | ✓ 转换后入 | ✗ |
| chip（tool part） | — | 派发记录留存 | 运行态→完成态 | 运行态 |

### 系统提示（流内低强调行）

`ChatEntry` 增 `kind: "notice"`，与消息按 `created` 混排；`created` 并列时按
kind 秧 `message < notice < optimistic` 稳定排序（三秧显式定义，防比较器
非反对称），同 kind 再按 id 字典序。

| kind | 触发 | 图标（lucide 14px） | 文案 |
|---|---|---|---|
| `background-started` | ①②出生 | `Rocket` | 已启动后台任务：{label} |
| `background-converted` | ③转换 | `CornerUpRight` | 已转后台任务：{label} |
| `background-finished`（completed） | 完成 | `CircleCheck` | 后台任务完成：{label} |
| `background-finished`（error） | 失败 | `CircleX` | 后台任务失败：{label} |
| `background-finished`（cancelled） | 取消 | `CircleStop` | 后台任务取消：{label} |

- 样式：leading 图标 + 文本（`ui-sm` / `color-text-muted`）+ 可选 trailing
  「查看」（有 childID 时 → 详情）；行式、低对比、不画气泡底。这是桌面
  首个系统提示样式，后续 model/agent 切换等系统级通知可复用。
- `label` 优先级：入列消息取子会话 `title`（回退 id）；完成消息优先解析
  synthetic 文本里的 `description`，回退 `payload.description` / `agent` /
  `childID`。
- 通知 id：启动 `bg-start:<childID>`、转后台 `bg-convert:<childID>`、完成
  `<syntheticMsgID>`（与消息同 id 空间，SSE 与 REST 天然去重）。
- 通知不参与回滚隐藏（回滚只作用于消息；`bg-` 前缀 id 与 `msg_` id 不可比）。

### 常驻任务卡

- 位置（**2026-10-08 修订**：由 `.composer` 顶行上移至分隔线上方独立
  `.bg-task-slot` 槽位——与授权/问题卡同域，定位块同 `.chat-footer`；
  用户裁定：任务卡不该落在输入区分隔线之下），不遮消息区、贴近输入区。
- 形态（**2026-10-07 修订**：原「单行 pill + 上弹浮层」废弃）：复用
  `.pending-card` 结构的**通栏折叠卡**（与授权/问题卡同款形态）——头部一行
  = `Rocket` 图标 + 标题「后台任务」+ 计数「N 个运行中」+ 展开箭头，
  **默认收起**，点击头部切换（**2026-10-08**：展开态受控挂 `ChatView`，
  跨详情开合保留）；展开体在卡内列出任务（320px 上限内滚动）、
  推高 composer，不再悬浮于消息区。配色中性 surface-container 系，
  图标 primary 表运行中。
- 可见性：`runningBackgroundTasks(sessionID)` 非空时常驻；全部完成后自动
  消失（展开态残留一并复位）。
- 展开体逐项（**2026-10-08 修订**：任务行整行可点击查看（键盘可达）、
  删除行内图标、行加底色表可点）：agent 名 + title + 已运行时长
  （`time.created` 起算，1s ticker）。
  - **查看**（整行点击/回车）→ **详情窗与任务卡同槽位互斥替代**
    （`.bg-task-slot` 内切换，2026-10-08 裁定）：内嵌子会话消息流（复用
    `SubagentBody`，独立滚动），不开独立 Tab/路由；Esc/× 关闭返回任务卡，
    **列表展开态跨详情保留**（受控挂 `ChatView`）；不可解析 childID 落空态
    （重开即重试）。
  - **停止**（行内钮）→ `store.abortSession(childID)`（= `interrupt`）；
    请求在途禁用。停止后 `execution.interrupted` → 状态归 idle →
    任务卡移除该项，流仍可看。
- 不做「停止全部」/批量停止端点；不在卡头部直接放停止（防误触）。
- 关父会话 Tab 期间任务卡随 `ChatView` 卸载消失（停止入口空档，已知限制）。
- **2026-10-08 交互修订**（五项，用户裁定）：
  1. 逐项「查看」按钮删除——点击**整行**即查看（命中区更大；`role="button"`
     + Enter/Space，键盘路径不因删按钮丢失；行 keydown 带 target 守卫，
     内层「停止」钮的激活不被劫持——review 回归修复）；行尾仅留「停止」钮
     （`stopPropagation` 防误触发行点击）。
  2. 任务行图标删除——行内 `Rocket` 与卡头部图标重复，行内仅保留标题
     （agent + 时长副行）。
  3. 详情窗与任务列表**互斥渲染**——详情打开时整个任务卡被详情窗替代
     （同 `.bg-task-slot` 槽位内切换），关闭后回到任务卡；两者不同时存在。
     详情窗由「composer 上沿锚定浮层」改为槽位内**流内嵌入**（占布局，
     推高消息区），不再叠加显示。任务已结束（卡已消失）时从完成通知
     「查看」进入的详情窗独立呈现（槽位内无卡可替代，单独渲染）。
  4. 任务行规格对齐问题卡选项 + 卡底 tint 统一（DESIGN.md 排版/焦点环
     规范）——行内边距 `6px 10px`、标签 `ui-md`、行距 4px、hover/
     `:focus-visible` 升 `surface-container-highest`（同 `.pending-option`）；
     卡底 tint 混合比例 55% → 45%，与授权/问题卡一致。
  5. 展开态受控挂 `ChatView`——详情替代任务卡时组件卸载，展开态活在卡外：
     展开中点行查看、关闭详情后列表**保持展开**；复位（全部结束 → 收起）
     同挂 ChatView（详情开着任务清零时卡已卸载，卡内 effect 够不着——
     review 指出漏网路径）。回归测试 `workspace-bg-task.test.tsx`
     覆盖用户实测路径（展开 → 详情 → 关闭仍展开）。

### 指示器（家族聚合）

`sessionActivity(sessionID)` 沿子会话树 BFS（自身 + 后代）聚合 busy/retry，
`retry` 优先、全 idle 才 idle。`dotStateFor` 的进行中/重试投影消费它——后台
任务运行中点亮父会话 Tab/左栏/项目行。**只改指示器不改输入锁**：composer
仍看本会话状态，后台任务不锁输入、不出 typing dots。

## 契约事实（v2.0.18 实测/源码口径）

| 来源 | 事实 | 落点 |
| `session.created`（v2） | 携带 `sessionID/projectID/parentID/title/...`；子会话与父同 `directory`，过目录闸门 | `applyV2SessionEvent` → `applySessionEvent`；`parentID` 非空不开 Tab，触发入列消息闸门 |
| `session.execution.started/succeeded/failed/interrupted` | **旁路目录闸门**（信封无 location，按 sessionID 解析目录）；驱动 `sessionStatus` | 子会话 busy/idle 事实源（任务卡与家族聚合） |
| `session.inbox.enqueued` | `item.type` ∈ `user/synthetic/compaction/move`；`synthetic` 的 `payload = {text, description, metadata}`，`metadata = {source:"subagent", childID, agent, state}`，`state` 主枚举 `completed/error/cancelled`，`item.time.created` 可信 | 完成提示实时合成；③的转换 synthetic（无 source）不渲染 |
| `POST /api/session/{id}/interrupt` | 停止子会话 = 中断该子会话 | `abortSession(childID)`（任务列表「停止」） |
| `GET /api/session/{id}/message` | `synthetic` 条目 `metadata` 同 inbox payload | 完成提示对账重建（`extractSyntheticNotices`） |
| **完成 synthetic 发件方**（2026-10-06 源码核实） | `SubagentCompletion.deliver` 统一产出 `metadata {source:"subagent", childID, agent, state}` + `<subagent …>` 文本；①恒发、②也发、③经 `subagents.notify` 补发；**前台正常完成不发**（结果内联） | 一切 `source=subagent` synthetic 都渲染完成提示（不按路径排除，移动端同款） |
| **② 派发即完成**（2026-10-07 活体抓包） | 事件序见「②」节；`tool.success` 事件与 REST 持久化**都带** `metadata:{sessionID,status:"running",truncated:false}`（源码初读会误判为不带——框架层并入） | ②的运行态 = part completed + 子会话 busy；`input.background` 在 `session.created` 前即可读 |
| **③ 前台转后台**（源码核实） | `POST /api/session/{父}/background` → `jobs.backgroundAll` → 阻塞 tool 返回 `{type:"backgrounded"}` → part 转 completed（同②）；父会话另发无 `source` 的 synthetic | 转换检测 = 前台认领 part completed ∧ 子会话仍在跑 |
| **SSE volatile 缺口**（2026-10-07 现场病灶） | 事件流断线丢事件、慢消费者被断流；缺口可吞掉 `tool.called`（与 `session.created` 仅隔 ~44ms）或整个派发 part——`session.created` 到达时认领数据缺席 | 缺口误插由对账纠正；判据须区分「前台认领」（撤）与「后台派生」（不撤） |
| **启动信号全程 REST 可得**（2026-10-08 核定） | ①会话行（子会话全量在列，`time.created`/`title` 服务端权威）②`part.state.input`（called 持久化 parsed input，含 `background` 与续跑 `sessionID`）③`part.state.metadata`（success 持久化、failed 经 failureSnapshot 并入）④`part.state.status` ⑤`GET /api/session/active`（子会话 busy）⑥`tool.progress` **不持久化**（无影响：运行中 part 的 REST 态是 `Running({input, metadata:{}})`，兜底照样可判） | 入列提示可随 REST 对账重建，不依赖 live 见证 |
| **v2 无 `task` tool**（2026-10-06 核实） | 工具名只有 `subagent`；`task` 是 v1 遗留 | 认领判据与渲染双认 `task`/`subagent`（存量数据兼容） |

## 实现方案

### 1. 数据与状态

- `noticesBySession: Map<sessionID, SessionNotice[]>`——独立通知表，**不进
  `messagesBySession`**（通知 id 与消息 id 混存会污染排序、回滚过滤、空消息
  守卫与对账窗口删除；独立表结构免疫窗口删除）。随 `cleanupSessionState`
  （关 Tab/删会话/关项目）与 `teardownConnection` 清理，经对账重建恢复。
- `childrenByParent` 惰性缓存（`sessionRegistryVersion` 驱动重建；**不挂**
  `cleanupSessionState`——关 Tab=归档不删会话，挂上会让运行中任务淡出
  家族聚合）。
- 纯逻辑层集中在 `session-notices.ts`（认领判据、通知构造、合并去重），
  store 只做编排，便于单测。

### 2. 认领模型

**认领**（claim）= 父会话消息流里某 `task`/`subagent` tool part 引用了该
子会话——区分「后台任务」与「前台工具调用」的唯一判据，不依赖服务端
新增字段：

- 权威（任意 part 状态可判）：`metadata.sessionId` / `sessionID`（progress
  写入、success 持久化、REST 同带）；续跑认领 `input.sessionID`（显式指定
  续跑对象，随 parsed input 持久化——progress 不持久化且 title≠desc 使
  兜底失效时的补偿认据）。
- 兜底（仅 part pending/running，metadata 未写入窗口）：`input.description`
  ↔ 子会话 `title` 前缀（与 `findChildSession` 同口径；工具型 title==
  description，天然命中）。

三个判据集**刻意不同、各司其职**：

```
claim(part, child) =
    part.tool ∈ {task, subagent}
      ├─ metadata.sessionId / sessionID（权威）
      ├─ input.sessionID（续跑认领，权威）
      └─ part pending/running ∧ input.description ↔ child.title 前缀（兜底）

foregroundClaimedChildIds = { child | claim ∧ part.input.background ≠ true }
    // 入列消息的插入闸门与撤回判据：被前台 part 认领 = 同步调用

activeClaimedChildIds = { child | claim ∧ part pending/running }
    // 任务卡排除判据：part 仍运行 = 前台阻塞中；
    // completed part 的认领不排除——②派发完成与③转换后的运行态

convertedBackgroundChildIds = { child | claim ∧ part completed ∧ background ≠ true }
    // ③转换检测：调用方再以「子会话仍在跑」为闸

runningBackgroundTasks(parent) =
    childSessionsOf(parent) ∩ sessionActivity ≠ idle ∩ ∉ activeClaimedChildIds
```

为何两个主判据集不能合一：单一判据覆盖不了③（`background` 缺省但运行中
转换——任务卡须纳入）与 SSE 缺口（input 不可读——入列消息宁可误插、对账
纠正）。

### 3. SSE 实时路径

| 事件 | 动作 |
|---|---|
| `session.created`（parentID 命中已加载/已开 Tab 的会话） | 入列闸门：未被 `foregroundClaimedChildIds` 认领 → 合成 `bg-start`（①②照插；③出生是同步，前台认领 → 不插） |
| `message.part.updated`（task/subagent part） | ①按前台认领撤回误插的 `bg-start`；②`convertedBackgroundChildIds` 命中且子会话在跑 → 合成 `bg-convert`（幂等） |
| `session.inbox.enqueued`（synthetic + `source=subagent`） | 合成 `background-finished` |
| `session.execution.*`（子会话） | 驱动 `sessionStatus` → 任务卡/家族聚合 |
| SSE `tool.failed` 分支 | 保留事件 `metadata`（failureSnapshot 并入 progress，与 REST 持久化一致——被中断的前台 part 靠它维持认领） |

### 4. 对账恢复

挂点：`mergeMessagePage`（loadSessionMessages / 翻页 / 尾部重取）与
`onMessagesSnapshot`（60s 周期 + 重连对账），REST 页合并后依次执行：

1. **完成提示抽取**（`extractSyntheticNotices`）：页内 `source=subagent`
   synthetic → 通知，与 live 按 id（消息 id）去重。
2. **撤回**（`reconcileStartNotices`）：前台认领的 `bg-start` 移除——SSE
   缺口误插的纠正；后台派生（②的 completed+bg:true 认领）不撤。
3. **启动提示重建**（`rebuildStartNotices`）：**覆盖窗口**（下界 = 最早已
   加载消息 created，上不设界——尾部即当下）内非前台认领的子会话，逐个
   **直推权威值**（`created`/`label` 取会话行）。live 插入的骨架值（信封
   时间/缺省 title）经一次对账校正到权威值，之后 mergeNotices 同 id 幂等
   无抖动。窗口下界防翻页未及的更早历史误判（其认领 part 可能未加载，
   未认领 ≠ 后台任务）；翻页下探后窗口下移再补。
4. **转后台提示恢复**（`reconcileConvertedNotices`）：③检测集命中且子会话
   仍在跑 → 补 `bg-convert`（缺口恢复；id 幂等）。

恢复时序节拍（接受）：重启恢复 Tab 时 `loadSessionMessages` 可能先于会话
快照落地（children 未进注册表）→ 首轮不产，下一拍（60s 对账/下一条消息）
补——与完成提示同节拍。关 Tab = 归档清通知表，重开经重建恢复。

**三类提示的持久性终态**：

| 提示 | live | REST 恢复 | 残留边界 |
|---|---|---|---|
| 启动（①②） | `session.created` | ✓ 窗口内，权威值校正后幂等 | 窗口外待翻页下探 |
| 转后台（③） | part completed 事件 | ✓ 仅运行中 | **终态后不可重建**（前台正常完成与转换后跑完终态同形；转换 synthetic 无 metadata 不解析——接受） |
| 完成 | inbox synthetic | ✓（既有） | 无 |

## 场景验证

| 场景 | 预期 |
|---|---|
| ① 运行中 | 任务卡常驻；父会话 Tab/左栏点亮；继续对话/滚动不受影响 |
| ② 派发 | 「已启动」即插；派发完成后任务卡纳入；派发 part 留流内 |
| ③ 转换 | 转换前无任务卡；转换后任务卡纳入 + 「已转后台」；完成提示照常 |
| 前台（同步）运行中 | 无任务卡、无任何系统提示；`SubagentPanel` 照旧；composer 停止可取消 |
| 点任务卡头部 | 展开任务列表（占布局）；点任务行（整行可点，键盘可达）→ 详情窗替代任务卡（Esc/× 关闭返回，列表保持展开）；「停止」→ `execution.interrupted`，任务卡移除该项 |
| 全部完成 | 任务卡消失；流内留下入列 + 完成两条系统提示 |
| SSE 缺口吞 `tool.called` | ②③照常；前台子会话误插的启动提示在对账后撤回 |
| 重启/重开 Tab/对账拉起 | 启动提示窗口内重建（权威时间）；完成提示重建；③转后台提示仅运行中恢复 |
| 子会话内权限/问题 | 沿 `design-subagent-status` §D6 上浮父会话（既有路径） |
| 后台任务运行 + 用户发下一条 | 不受阻（父会话不 busy，输入不锁） |

## 关键设计决策

1. **按「异步」统一**：前台 tool part 自洽不动；②③与①同权——入列提示 +
   任务卡 + 完成提示。判据全从既有 wire 数据推导（`input.background` +
   part 状态 + 认领关系），不依赖服务端新增字段。
2. **运行中与消息流解耦**：任务卡承载进行中状态，消息流只留系统提示作
   历史。
3. **两个判据集刻意不同**（见认领模型）。
4. **入列/完成提示尽可能持久**：完成提示服务端落库天然持久；启动提示靠
   REST 重建（权威值校正）；③转后台受运行态判据所限仅运行中可恢复——
   彻底解决需上游给转换 synthetic 补 metadata（另行跟进）。
5. **只提供单条停止**；终态由 `execution.interrupted` + 完成 synthetic 收敛。
6. **详情窗与任务卡互斥、流内嵌入**（**2026-10-08 修订**：原「嵌入浮层」
   悬浮 composer 上沿、与任务卡叠加显示——用户裁定两者不同时存在，详情
   改 `.bg-task-slot` 槽位内替代任务卡），不引入子会话独立 Tab/路由。
7. **通知独立成表、不进消息容器**（见「数据与状态」）。

## 与移动端的差异

| 维度 | 移动端 | 桌面端 |
|---|---|---|
| 状态容器 | `ServerStore` + `ConversationStore` 分离 | 单一 `AppStore`；通知表 `noticesBySession` 挂 store |
| 通知存放 | 作为 `DisplayMessage` 进消息流，靠 metadata 显式保留 | 独立 `noticesBySession`，不进 `messagesBySession`，结构免疫窗口删除 |
| 判据 | 任意 task/subagent 认领即排除（旧模型，待跟进升格） | 前台认领/运行认领分层 + REST 重建 |
| 详情展示 | `showModalBottomSheet` | 槽位内嵌详情窗（与任务卡互斥替代，无 bottom sheet；2026-10-08 修订） |
| 子会话索引 | `_childSessions` 64 条 LRU | `sessionsByProject` 全量 + `childrenByParent` 惰性缓存 |
| 完成提示落地 | `onSynthetic` 物化 + inbox | inbox 直接物化；REST 抽取按 id 去重 |
| 会话容器淘汰 | `_evictConversations` 豁免子会话 | `ensureConversation` 已豁免 |

## 不做的事

- 不为前台工具型 subagent 引入任务卡/系统提示（同步阻塞，chip 自洽）。
- 不做子会话独立 Tab/跳转页。
- 不把完成 synthetic 合并进任务卡条目（各司其职）。
- 不做「停止全部」/批量停止端点；不在任务卡上直接放停止。
- 不新增 model/agent 切换通知（样式复用另行设计）。

## 实现影响（文件清单）

| 文件 | 内容 |
|---|---|
| `src/shared/session-notices.ts` | 认领遍历（`forEachClaim`）与三判据集（`foregroundClaimedChildIds` / `activeClaimedChildIds` / `convertedBackgroundChildIds`）、通知构造（started/converted/finished）、`mergeNotices`（id 去重合并）、`withdrawForegroundStartNotices` |
| `src/shared/session-notices.test.ts` | 判据分层/续跑认领/构造/合并用例 |
| `src/shared/api-types.ts` + `src/shared/v2-adapter.ts` | REST synthetic `metadata` 透传 |
| `src/shared/message-merge.ts` | `ChatEntry` notice kind、三 kind 秩排序、回滚不隐藏通知、parts 快照合并（参数正名见 Review 八轮附注） |
| `src/renderer/src/store/app-store.ts` | `noticesBySession`、`childrenByParent` 惰性缓存、`sessionActivity`、`runningBackgroundTasks`、入列合成闸门（`onChildSessionCreated`）、撤回/重建/转后台三 reconcile、完成抽取、SSE tool.failed metadata 保留、`dotStateFor` 家族聚合、`requestTaskDetail`/`consumeTaskDetailRequest`、清理挂点 |
| `src/renderer/src/components/workspace.tsx` | `NoticeRow`（三 kind）、`BackgroundTaskBar` + 任务列表/详情窗（`.bg-task-slot` 槽位**互斥渲染**，整行点击查看、展开态受控挂 `ChatView`）、`SubagentBody` 复用、`task`/`subagent` 双认路由 |
| `src/renderer/src/components/workspace-bg-task.test.tsx` | 任务卡交互回归（展开 → 详情 → 关闭仍展开等用户实测路径，2026-10-08 修订 5） |
| `src/renderer/src/styles/app.css` | 任务卡（复用 .pending-card）、任务行（对齐问题卡选项规格）、系统提示行、`.bg-task-slot` 槽位与详情窗样式 |
| `src/renderer/src/i18n/index.ts` | bgTaskRunning/Started/Converted/Completed/Failed/Cancelled/View/Stop 中英 |
| `docs/spec/spec-v0.5.md` | 功能范围同步 |

## 已知限制 / 坑

- **③终态后转后台提示不可重建**：判据是运行态（part completed ∧ 子会话
  在跑）；终态后与前台正常完成同形。服务端转换 synthetic 无 metadata/
  childID，不解析文案。彻底解决需上游补 metadata。
- **②派发窗口瞬时排除（~30ms）**：`background:true` 从 called 到 success
  之间 part 为 running，任务卡短暂排除；success 落地即纳入。
- **转换后瞬间完成**：子会话在合成闸门前归 idle 则只有完成提示。
- **关父 Tab 期间无停止入口**：任务卡随 `ChatView` 卸载消失；归档不删
  会话，家族聚合仍点亮。`closeChatTab` 不 abort idle 父会话，子会话跑到
  完成。重开 Tab 即恢复。若要「关 Tab 询问是否停后台任务」，另立设计。
- **desc 前缀兜底误匹配**：父会话并发多个 task/subagent 时可能挂错（权威
  认领不受影响）；误撤风险已收窄到前台认领。
- **`subagent` tool 渲染缺口**：`SubagentPanel` 原只认 `task`，本设计双认
  （载荷同构，移动端 `conversation_screen.dart:2006` 同款）。
- **家族聚合瞬时窗口**：断连 `sessionStatus.clear()` 让运行中任务短暂
  idle，重连对账恢复（与 typing dots 同语义）。
- **完成 state 宽松兜底**：未知 wire 值归「完成」样式，不误报失败。
- **移动端判据仍是旧模型**：任意认领即排除、入列提示瞬态——双端行为
  不同，待移动端跟进升格。

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
| 3 | 🟠 | 后台任务运行中关父 Tab → 任务卡/停止入口消失（行为空档）未记录 | 补入「已知限制」，说明 `closeChatTab` 不 abort idle 父会话 |
| 4 | 🟢 nit | 背景对「REST 路径丢失」描述不精确（丢在 part 过滤 + 空消息守卫，非 `toInternalMessages`） | 改写为转 part → 滤空 → 空消息守卫三段 |
| 5 | 🟢 nit | `state` 枚举前后不一致 | 统一为 `completed/error/cancelled` + 防御性别名 `failed`/`interrupted` |
| 6 | 🟢 nit | 「父会话 idle 时指示器全灭」不准（waiting 仍亮） | 改为「running 不点亮」 |
| — | ❓待确认 | `subagent` tool 是否存在及载荷形状 | 查证：移动端 `conversation_screen.dart:2006` 对 `task`/`subagent` 同走 `_SubagentPanel`，读同组字段；补注依据 |

### 第三轮（实现后，2026-10-06）

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟠 | 完成回执未排除工具型；工具型 task 完成是否带 `source=subagent` 待证 | 源码核实（tag v2.0.18）：`background:true` / 前台被 backgrounded 的工具型**也发**、前台正常完成不发。裁定**不排除**（同移动端 `_noticeMessage`），契约表 + D4 补记，测试钉行为 |
| 2 | 🟠 | D3 撤回只覆盖「创建早于 tool part」；反向时序 + 中断残留 | 已修：`onChildSessionCreated` 插入前先查 `toolFormChildIdsFor`，已认领直接不插；补反向时序用例 |
| 3 | 🟢 nit | 任务卡浮层 / 详情浮层 / command-hints 同位无叠放次序 | `.bg-task-popover` / `.task-detail-slot` 加 `z-index: 30` |
| 4 | 🟢 nit | 完成通知 label 兜底链缺 childID，可能空名 | 兜底链补 `childID`，补用例 |
| 5 | 🟢 nit | 详情浮层无 Esc 关闭 / aria | 挂 window Esc（`isComposing` + `overlayCount > 0` 让位），`role=dialog` + `aria-label` 已有 |

### 第四轮（实现后，2026-10-06）

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟠 | 撤回钩子只在 `message.part.updated`；断线丢事件、REST-only 落地时不撤回 | `mergeMessagePage` / `onMessagesSnapshot` 合并后补调 `reconcileStartNotices`（无 background-started 时早退，零成本）；补 REST-only 用例 |
| 2 | 🟠 | 任务卡全部结束后 `open` 残留，新任务启动浮层直接展开 | `tasks.length === 0` 时 effect 复位 `open`/`stopping` |
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
为完整后台任务（启动提示 + 任务卡 + 完成通知）；前台（同步）保持纯 chip。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🔴 | 旧判据单一（任意 task/subagent 认领 = 排除 + 撤回），completed part 的认领把②的合法启动提示撤掉 | 拆两个判据集：`foregroundClaimedChildIds`（插入/撤回，`input.background ≠ true` 才算前台）+ `activeClaimedChildIds`（任务卡排除，仅 pending/running part） |
| 2 | 🟠 | `background:true` 是否可等价于异步 | 否——三路径（命令型 / `background:true` / 前台转后台），后者 `input.background` 缺省；组合判据覆盖（创建时读 input，运行时读 part 状态），契约表补记③与 background 端点 |
| 3 | 🟠 | 契约表漏记：`background:true` 的 `tool.success` 与 REST 持久化都带 `metadata.sessionID`（源码初读会误判为不带） | 契约表补记（2026-10-07 活体抓包 + 现场 REST 数据双证） |
| 4 | 🟢 | ③转后台无启动提示的不对称 | 接受并记录（出生时是同步；任务卡出现即转换信号，不补历史） |
| 5 | 🟢 | ②派发窗口（~30ms）任务卡瞬时排除 | 接受并记录（success 落地即纳入） |

### 第六轮（2026-10-08 对齐补裁定）

**用户裁定**：③转后台也应有系统通知。三路径呈现统一为「启动（或转后台）
消息、完成消息、任务卡」。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟠 | ③转换在服务端无专用事件（仅 part completed + 父会话一条无 metadata 的 synthetic） | 客户端状态检测：前台认领 part 转 completed ∧ 子会话仍在跑（`jobs.block` 语义保证前台正常完成时子会话先归 idle，误报面为零）；`error` part 不算 |
| 2 | 🟢 | 转换时间服务端不暴露 | `created` 取合成时刻（live 路径与转换毫秒级相邻）；id `bg-convert:<childID>` 幂等防抖动 |
| 3 | 🟢 | 转换后瞬间完成的竞态 | 接受：子会话在合成闸门前归 idle 则只有完成提示（记入已知限制） |

### 第七轮（2026-10-08 重建修订）

**用户核定**：启动信号全部 REST 可得（契约表新增行的六项等价性），
「事后不可反推」不成立——启动提示不应是瞬态。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟠 | REST 重建的误判面：窗口外更早子会话的认领 part 可能未加载（未认领 ≠ 后台任务） | 覆盖窗口下界 = 最早已加载消息 created；翻页下探后窗口下移再补 |
| 2 | 🟠 | 续跑（`input.sessionID` 续既有子会话）title≠desc 使兜底失效，且 REST 合并把 live 的 progress metadata 洗成 `{}`（`Running({input, metadata:{}})`） | `input.sessionID` 补入权威认领（随 called 的 parsed input 持久化） |
| 3 | 🟢 | 重建的 created 抖动风险 | 取子会话行服务端权威 `time.created`；live 骨架值经一次对账校正（第八轮 #1） |
| 4 | 🟢 | ③终态后转后台提示仍不可重建 | 接受（判据是运行态；转换 synthetic 无 metadata 不解析），记入 D3b 已知边界 |

### 第八轮（2026-10-08，reviewer 子代理审查 1646d7e）

结论：可合入，无 blocking / non-blocking；两条 nit 与一条附注处置如下。

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🟢 nit | live 插入的 `bg-start` 其 `created` 取 SSE 信封时间，重建取会话行权威时间——「与 live 插入同值」依赖两时间戳相等的假设，不等则既有 notice 永不校正（按 id 去重跳过） | 重建改为**不查重直推权威值**：mergeNotices 同 id 校正一次（created/label 均收敛），之后幂等——假设升级为不变量；补校正回归用例 |
| 2 | 🟢 nit | 重启恢复 Tab 时 `loadSessionMessages` 先于会话快照落地（children 未进注册表）→ 首轮 merge 不产启动提示，下一拍才补 | 接受：与完成提示（synthetic 抽取）同节拍，对账哲学内既定行为；D3 重建段补记 |
| — | 附注 | `message-merge.ts` 的 tool part 合并方向：调用点以（本地 SSE, REST 快照）传入而 mergePart 注释称「SSE 优先」——名义与实际相反，即「REST 把 live 的 progress metadata 洗成 `{}`」的根源 | 正名不改行为：参数更名 `localParts`/`snapshotParts`、注释改写为「快照非 pending 优先」并记录已知代价（认领由 `input.sessionID` 与持久化 metadata 兜住）；方向翻转属独立议题，超出本轮 |
