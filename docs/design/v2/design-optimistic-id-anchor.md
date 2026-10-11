# 乐观消息 ID 锚（client-minted msg_ id + 三层按 id 精确消解）— 设计文档

> 状态：设计定稿（2026-10-11），随本分支落地。
> 修复问题：进入会话时一条乐观气泡恒挂消息流末尾、永不消解（实测
> ses_ed553db5fffepV5F6qLCabcAiA，kind-cactus 新 worktree 新会话首条消息）。
>
> 前置阅读：`docs/design/v2/design-inbox-admission.md`（准入即物化——本设计的
> 直接基座）、`docs/design/v2/design-sse-event-surface.md`（三层防御模式与事件面
> 契约基线）、`docs/design/design-supplement-send.md`（并发在途语义）。

## 1. 触发案例与根因链

**症状**：新会话发送首条消息后，真实 user 消息与 assistant 回复均正常，但消息流
最底部恒挂一条乐观气泡（同文本副本），切换 Tab/重进会话均不消失。

**根因链**（五环，逐环击穿既有防御）：

1. **契约缺口**：`POST /prompt` 200 回执携带 `data.id`（= inboxID = 投影消息 id，
   三体同 id，inbox-admission §1 活体双证），`rest-client.prompt` 丢弃回执返回
   void——乐观条目与 server id 空间无关联，消解只能靠时序敏感的模糊匹配。
2. **回执重取扑空**：`refreshMessagesAfterPrompt` 在 POST 200 后立即拉首页；
   projector 异步投影（实测晚 ~80ms）→ 页内无 user 消息 → `projected=false`。
   一次性，无重试。
3. **enqueued 事件被已加载门拦**：`session.inbox.enqueued` 在 POST await 期间
   到达（admit 时同步广播），此时新会话快照仍在途 →
   `messagesBySession.has(sessionID)`=false → 整个 case 跳过（物化与清乐观
   都没跑）。
4. **delivered 兜底判定失效**：排队 3.8 分钟后 delivered 到达时，真实 user
   消息已被进入会话的快照 / 60s 对账合入 conv → `refreshConversationTail` 的
   `hasNewUser`=false → 不清。
5. **快照漏斗不检查乐观**：`mergeRestSnapshot`（两条 REST 合并漏斗统一入口）
   完全不触及 `optimisticBySession`——错过一次性事件后无任何收敛通道
   （对照移动端：reload 全量替换天然清乐观）。

**结果**：`chatEntries` 把 Map 残留条目附在列表尾，`sortEntries` 锚定
`maxCreated+1` 恒排最后——永久悬挂。

## 2. 契约事实（spec + v2.0.18 源码 + 活体）

| 事实 | 出处 |
|---|---|
| `POST /api/session/:id/prompt` 请求体支持可选 `id`（pattern `^msg_`，client-minted） | spec `PromptInput.Prompt` |
| 200 回执 `{data: Session.Inbox.User}`：`id`/`time.created`/`payload`/`delivery` | spec + inbox-admission §1 活体实测（2.0.24） |
| server 准入按 id 幂等：`reconcile` 先 `find(db, request.id)`，已存在且匹配则返回既有项 | `packages/core/src/session/inbox.ts`（v2.0.18 tag 核对） |
| `session.inbox.enqueued` 与回执同源同刻；载荷 `{sessionID, inboxID, item}`；inboxID == 投影消息 id | inbox-admission §1 双证 |
| `session.inbox.delivered` 载荷含 `{sessionID, inboxID}`；发布于投影/投递时（busy 窗口可分钟级，error/blocked 收尾不投递） | 桌面端 sse-event-surface 表 A 载荷记录 |
| `session.inbox.cancelled` 载荷 `{sessionID, inboxID}`（他端取消排队项） | 同上 |
| server id 编码：`msg_` + 6 字节 hex 时间戳（ts×0x1000+counter 高 48 位）+ 14 字符随机（62 字符表）——跨进程碰撞概率可忽略 | `packages/schema/src/identifier.ts`（v2.0.18 tag） |
| 官方 GUI（v2.0.18 `packages/client/src/solid/data.ts`）就是这么做的：客户端铸造 `msg_` id 随 POST 传递，`session.inbox.enqueued` 到达即 `outbox.delete(event.data.inboxID)`——按 id 精确消解，无文本匹配、无时间戳比较、无已加载门 | 源码核对 |
| `POST /api/session/:id/command` 请求体无 `id` 字段、响应 204 无回执 | spec——**命令路径无法挂锚** |

## 3. 决策

**乐观条目的消解锚 = client-minted `msg_` id（sendPrompt 路径）。**

- `sendPrompt` 铸造 `msg_` 形状 id 作乐观 `localId`，随 `POST /prompt` 的 `id`
  字段传递；server 准入幂等（同 id 重复准入不双计，官方依赖此行为）
- 消解比对全部走 id：`clearOptimisticAt(sessionID, inboxID)`（既有精确清除
  函数，按 localId 匹配——锚即 localId，无新字段）
- **不采纳**「消费回执 id 挂锚」替代方案：SSE 事件可能先于 HTTP 回执到达
  （enqueued 与回执同刻、通道并行），回执挂锚存在反向竞态；铸造 id 从乐观
  创建起锚即存在，无窗口
- `localId` 保持 `msg_` 形状后 React key 在乐观→物化替换时**不变**
  （`msg_x → msg_x`）——气泡无重挂载闪烁（原 `opt_ → msg_` 是 key 跳变）
- 命令路径（sendCommand）契约无 id：乐观维持 `opt_` 无锚形状，消解靠
  物化清全部（既有）+ 层 3 快照兜底新增的「无锚条目 created>= 比对」

## 4. 三层防御（对齐 sse-event-surface §4 模式）

### 4.1 层 1：事件驱动（精确清前置到已加载门外）

`session.inbox.enqueued`（user 项）case 内、`messagesBySession.has` 门**之前**：

```
clearOptimisticAt(sessionID, inboxID)   // 锚精确清，无需 conv 加载
```

- conv 未加载场景（本 bug 主缺口）：乐观条目锚命中即消——物化不需要发生
  （用户未打开会话，无渲染面）；打开时快照自然带来真实消息
- conv 已加载场景：门外精确清 + 门内物化清全部（既有语义保留）双保险，
  幂等
- 物化桥接（`materializeInboxUser`）匹配升级：**锚优先**（`o.localId ===
  inboxID`）命中即桥接；锚 miss 退回现有 normText 归一匹配（无锚条目的
  最后桥接通道）。锚匹配消灭「多候选撞匹配跳过桥接」边界（supplement-send
  并发在途的两条乐观各有锚，各自物化各自桥接）

`session.inbox.delivered` case：补取载荷 `inboxID`（现只取 sessionID），
门外 `clearOptimisticAt(sessionID, inboxID)`；门内尾部重取照旧（幂等收敛，
`hasNewUser` 判定失效不再有影响——精确清已闭环）。

`session.inbox.cancelled` case：增 `clearOptimisticAt(sessionID, inboxID)`
——他端取消排队项 = 该消息永不投影，锚命中的乐观条目撤回（与「发送失败
撤回」同语义）；`removeMaterializedInbox` 照旧（未投影物化项移除）。

### 4.2 层 2：回执驱动（id 命中判定）

`refreshMessagesAfterPrompt` 的 `projected` 判定升级：

```
m.info.role === "user" && (m.info.id === optimistic.localId || m.info.time.created >= optimisticCreatedAt)
```

- id 命中为主判；`created >=` 保留为防御（server 不尊重传入 id 的假想场景
  下，与层 3 兜底同判据）

POST 200 后校验回执 id：`receipt.id !== optimistic.localId` 时 log warn
（不重挂锚——防御场景由层 3 兜底收敛，见 §6 边界 1）。

### 4.3 层 3：快照漏斗（终兜底，封死一切时序缺口）

`mergeRestSnapshot` 合并完成后统一结算（一次落点覆盖全部漏斗：进入会话
快照 / 60s 周期对账 / 重连对账 / 回执重取 / 尾部重取 / 翻页）：

```
for 每条乐观条目 o（该会话）：
  有锚（localId 为 msg_ 形状）：
    merged.has(o.localId)  → clearOptimisticAt(o.localId)   // 投影已确认
  无锚（opt_ 形状，命令路径）：
    merged 存在 role=user && time.created >= o.createdAt → 清
```

- 无锚判定同时是层 2 防御的兜底（锚失配时 created>= 收敛）
- 性能：每次合并 O(乐观数) 次查找，乐观通常 0–2 条，忽略

## 5. 实现

### 5.1 id 铸造（`src/shared/v2-adapter.ts`）

`mintMessageID(): string`——server 同构编码：6 字节 hex 时间戳前缀
（`Date.now()×0x1000+counter` 高 48 位）+ 14 字符随机（62 字符表，
`crypto.getRandomValues`）。模块级 `lastTimestamp/counter` 与 server
`identifier.ts` 同构（同毫秒内递增计数）。

### 5.2 落点表

| 文件 | 改动 |
|---|---|
| `src/shared/v2-adapter.ts` | `mintMessageID` 导出 |
| `src/shared/rest-client.ts` | `prompt` 请求体带 `id`；返回 `Promise<{id: string}>`（204/无体防御返回 `{id: ""}`） |
| `src/renderer/src/store/app-store.ts` | `sendPrompt`：localId=铸 id、POST 带 id、回执校验 warn；enqueued/delivered/cancelled 三 case 门外 `clearOptimisticAt`；delivered 补取 inboxID；cancelled 增乐观撤；`materializeInboxUser` 桥接锚优先；`refreshMessagesAfterPrompt` id 命中判定；`mergeRestSnapshot` 终兜底结算 |
| `src/shared/message-merge.ts` | 无结构改动（`OptimisticMessage` 不增字段；注释更新锚语义） |

`sendCommand` 的乐观生成（4782 行）**不动**——`opt_` 无锚形状是层 3 无锚
判定的判据（`localId.startsWith("msg_")` 区分有锚/无锚）。

### 5.3 判定细节

- 「有锚」判据：`localId.startsWith("msg_")`——与移动端 GAP-2 的 id 空间
  限定同构思路（`optimistic_` vs `msg_` 空间分离），此处反向利用：前缀即
  锚有无的标记
- `sortEntries` / React key / `filterRevertedEntries` 均无 `opt_` 前缀逻辑
  依赖（grep 核对），localId 形状变化零影响

## 6. 已知边界（接受）

1. **server 不尊重传入 id**（假想防御场景）：回执 id ≠ 铸 id 时精确清失配
   ——层 3 的 created>= 判定收敛（同旧逻辑），仅丢失精确性不悬挂。log warn
   留痕。官方客户端同依赖此行为，风险同级
2. **命令乐观无精确锚**：`POST /command` 契约无 id。conv 已加载时物化清全部
   （既有）覆盖；conv 未加载（guide 页发命令）时靠层 3 快照兜底消解
   （进入会话即触发）。不悬挂，仅消解时机略晚
3. **client/server id 撞**（同毫秒 + 随机后缀碰撞，62^14 空间）：概率可忽略
   （官方客户端同级风险），不防御
4. **并发在途误清闪烁**（supplement-send §4 既有边界）：门内物化「清全部」
   语义保留——首条物化瞬间清掉第二条在途乐观，第二条物化时补位。门外
   精确清只清锚命中条目，不扩大误清面

## 7. 测试

- `v2-adapter.test.ts`：`mintMessageID` 格式（`^msg_`、26 字符、同毫秒
  递增、多次唯一）
- `rest-client.test.ts`：prompt 请求体含 id、回执解析返回 `{id}`
- `app-store.test.ts`：
  - **回归（本 bug）**：新会话 conv 未加载 + enqueued 事件到达 → 乐观按
    inboxID 精确清（不悬挂）
  - enqueued（conv 已加载）：物化 + 清全部（既有）+ 桥接锚命中（并发两条
    各自桥接，多候选跳过边界消除）
  - delivered（未加载）：inboxID 精确清
  - cancelled：锚命中乐观撤回；无锚乐观不受动
  - refreshMessagesAfterPrompt：id 命中清；锚失配时 created>= 兜底
  - mergeRestSnapshot 终兜底：有锚条目锚入快照即清；无锚条目 created>=
    命中即清；均不误清未落地条目
  - sendPrompt 失败回滚：localId（msg_ 形状）照常撤

## 8. 验收

1. 新会话（含 guide 页首条消息）发送：乐观气泡出现 → 消解（物化替换或
   锚清除），重进会话无残留、无双气泡
2. busy 补充发送：并发在途各条独立消解，chip/缩略图各自桥接
3. 断连窗口内发送：重连对账后乐观消解（层 3）
4. 他端取消排队项：本端乐观气泡即时撤回
5. 既有用例全绿（乐观清除时机语义未变的部分回归）
