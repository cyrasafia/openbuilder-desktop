# inbox 准入即物化（乐观态收敛前移）— 设计文档

> 状态：已落地（2026-10-10，活体实测 server 2.0.24）。
> 修复问题：busy 会话中补充发送（design-supplement-send）后，乐观气泡「发送中」
> 持续到 run 吸收该消息为止（长流式/重试退避下分钟级；error/blocked 收尾的 run
> 不再吸收时无限期悬挂）。
>
> 参考来源（AGENTS.md 设计前置约定）：
> - `../openbuilder/lib/core/session/conversation_store.dart` `onInboxEnqueued` —— 移动端同构实现：enqueued 事件到达即以 inboxID 物化 user 消息并清乐观（注释原话「乐观由 enqueue 到达时替换」）；`_bridgeOptimisticParts` 从乐观条目桥接附件 parts
> - 官方 app `packages/app/src/session/timeline/controller-projection.ts` —— POST 回执 handoff 进 timeline（`applyTimelineMessageHandoff`）；未投递 steer 项按真实 id 排在活跃工作下方
> - 官方 server 源码 `packages/core/src/session/inbox.ts`（2db9c2e1b3）——`admit` 在准入时同步 publish `InboxEnqueued`（事件 created = 准入时刻）

## 1. 问题：v2 把「接受」与「投影」拆开，客户端只认后者

活体时序（server 2.0.24 @15120，真实 busy 会话实测）：

```
T+0.00s  POST /prompt → 立即 200（0.02s），回执 {data: Session.Inbox.User}
         （id=msg_*、time.created、payload.text、delivery: "steer"|"queue"）
T+0.00s  SSE session.inbox.enqueued 同刻广播（信封 created == 回执 time.created，
         item={type,payload,delivery}，inboxID == 投影后消息 id——双证）
T+0~N    消息停留在 inbox，GET /api/session/:id/message 【不含】该消息：
         steer 在 step 边界吸收、queue 在 idle 边界吸收（retry 退避实测 78s 未投影；
         单步长流式 = 整步期间不投影；run error/blocked 收尾则 inbox 项滞留）
T+N      投影落地 + session.inbox.delivered（此刻消息才进 REST 列表）
```

清乐观三条既有路径（POST 200 重取、enqueued/delivered 尾部重取、60s 对账不碰消息）
全部依赖「投影后的 user 消息出现」——busy 窗口内全扑空，乐观气泡一直「发送中」。
M6c 评审 Y3 的 delivered 重取只闭合「最终吸收」场景，没闭合「吸收前长时间悬挂」。

## 2. 决策：enqueued = server 已持久接受的权威信号

准入即物化：`session.inbox.enqueued`（user 项）到达时，以 inboxID 为消息 id
立即物化 user 消息进 `messagesBySession`，同时清空该会话全部乐观（移动端同语义）。

- 发送已不可能失败——server 已把消息持久化进 inbox（durable），「发送中」语义
  在此时刻已经结束；剩余等待是「排队/吸收」，不是「在途」
- inboxID == 投影消息 id：后续投影（delivered 重取/翻页/对账）按 id 合并，
  `info` 取 REST 权威、parts 按 id 并集——物化→投影零跳变
- 物化消息 created = 准入时刻（信封 created），排活跃流式 assistant 之下
  （与旧乐观锚定 maxCreated+1 同位，替换不跳变）
- POST 200 回执与 enqueued 事件同源同刻：**只消费 SSE 事件**（单一代码路径，
  他端/命令发送同覆盖）；SSE 断连窗口内的自有发送维持旧行为（乐观悬挂至投影，
  重连对账收敛），不做回执第二路径

## 3. 实现

### 3.1 状态（app-store.ts）

- `materializedInbox: Map<sessionID, Set<msgId>>` —— 已物化、尚未在 REST 快照中
  见过投影的 inbox id 集合（窗口删除豁免 + cancelled 精确移除的记账）
- 生命周期与 `messagesBySession` 同：`cleanupSessionState` 一并卸载

### 3.2 物化（`session.inbox.enqueued` user 分支，v2-adapter 纯函数）

`inboxItemToUserMessage(sessionID, inboxID, item, created, bridge)` →
`MessageWithParts`：text part（`{id}:text`）+ 桥接 file parts。

- **桥接**（自有发送）：按 `payload.text` 匹配乐观条目（v2 text 原样落库，含
  纯附件零宽空格占位），把其 refs/attachments 铸成 `FileDisplayPart`
  （refs：`source.type="file"` + path，chip 可点；attachments：data: url + mime，
  图片缩略图）——乐观→物化替换不丢 chip/缩略图（移动端 `_bridgeOptimisticParts`
  同构）。命令回显 payload 是展开文本，匹配失败不桥接（与投影后无 chip 的现状
  一致，不新增回退）。清乐观 = 清全部（design-supplement-send §4 既有语义：
  并发在途第二条无桥接，接受）
- **payload files 兜底解析**（他端发送/防御）：live 2.0.24 形状
  `{data, mime, source:{type:"uri",uri}, name}`——name chip；有 data 时重组
  `data:` url 供图片缩略图。v2.0.18 形状 `{uri, name}` 同函数防御兼容
- 物化后同步：清全部乐观（首条真实到达清全部，移动端同判）+ emit；
  尾部重取（`refreshConversationTail`）保留——合并已投影页 + 幂等收敛

### 3.3 窗口删除豁免（message-merge.ts）

`mergeSnapshotIntoMessages` 的窗口区间删除（快照 (min,max) 开区间内且不在快照中
→ 已被删除）会误删未投影物化消息——实测 busy 中 in-flight assistant 的 created
会前移（retry 重启 step）越过排队消息 created，把它圈进窗口。签名增可选
`preserveIds`：窗口删除跳过其中的 id（乐观/notice 不在 messages map，不受影响，
维持原语义）。

`mergeMessagePage`（REST 合并唯一漏斗）双动作：
1. 合并前传 `preserveIds`（会话的未投影集合）；
2. 合并后页内出现过的 id → 从集合摘除（投影已确认，恢复常规删除语义）。

### 3.4 取消（`session.inbox.cancelled`，新 case）

他端取消排队项：id 在未投影集合中 → 摘除集合 + 删物化消息（mobile
`removeInboxMessage` 同语义）；已投影（不在集合）不动——历史消息不可撤。
`session.inbox.delivery.changed`（steer↔queue 重排）不接：官方 app 用于队列
面板排序，本端物化消息恒排尾部，无消费点（Keep Lean）。

### 3.5 已投递（`session.inbox.delivered`，既有 case 不变）

重取 → 页含该 id → 合并（REST 权威 info 覆盖物化）+ 集合摘除（3.3 步骤 2）。

## 4. 不做的东西

- **不做回执第二物化路径**：POST 200 body 不解析（rest-client.prompt 维持 void），
  SSE 是唯一准入面。断连窗口自有发送的乐观悬挂 = 旧行为（投影/重连对账收敛）
- **不做排队面板/重排/编辑**：官方 queue-panel（重排、改写、取消队列项）整域
  不做（PRINCIPLES 不做大而全）；本端取消仅被动跟随 cancelled 事件
- **不做 queue/steer 视觉区分**：delivery 字段不进渲染——物化消息位置（活跃
  流式下方）已表达等待语义，同官方 timeline 投影
- **不做会话未加载物化**：`messagesBySession` 无 key 不物化（与既有 enqueued
  尾部重取同门）；重开 Tab 走 REST，未投影项由 delivered 重取收敛

## 5. 测试

- `message-merge.test.ts`：窗口删除豁免（preserveIds 中的 id 落窗口不被删；
  快照含该 id 时常规合并且调用方摘除）
- `v2-adapter.test.ts`：`inboxItemToUserMessage`——text part、桥接 refs/
  attachments 铸 FileDisplayPart（chip 可点/图片缩略图）、payload files 兜底
  （name chip、data: 重组）、synthetic/缺字段防御
- `app-store.test.ts`：
  - busy 补充发送：enqueued 到达 → 物化消息以真实 id 入列（排流式下方）+
    乐观清空；busy 中途重取（快照不含该 id + assistant created 前移圈窗口）
    → 物化消息不被窗口删除；delivered 重取（页含 id）→ info 取 REST + 豁免解除
  - cancelled：未投影物化项被移除；已投影（集合已摘）不删
  - 回归：idle 发送（enqueued + 投影几乎同刻）物化→合并幂等；乐观清全部语义
    （既有用例改挂新时机）；cleanupSessionState 卸载未投影集合

## 6. 验收

- busy（长流式或 retry 退避）中发送：气泡立即变为正常 user 消息（无「发送中」
  行），chip/缩略图保留；run 吸收后无跳变（id 不变、位置不变）
- 他端在本地 busy 窗口发送：消息实时出现
- 他端取消排队项：物化消息消失；已投递消息不受影响
- 既有用例全绿（乐观清除时机变更的用例同步改挂）
