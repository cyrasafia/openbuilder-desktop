# 未读标记（Unread Marker）— 设计文档

> 目标：在监督驾驶舱里可靠标出「agent 已产出、人尚未验收」的会话——多 worktree 并行时，
> 「该看哪一个」一眼可判。
>
> 契约依据：**v2**（`../openbuilder/opencode_openapi_v2.json`，2.0.18 pin = `anomalyco/opencode`
> commit `cd9a14a6`）。本功能**仅支持 v2**——v1 契约无未读水位（`viewed`/`/view` 均不存在），
> 见 [ref-product-research-paseo](../../ref/ref-product-research-paseo.md) §2.6 版本范围注记。
>
> 参考来源（AGENTS.md 前置检索）：
> - 官方 **TUI** 实现（`../opencode` @ `cd9a14a6`，`packages/tui/src/context/session-tabs.tsx`）——
>   `isUnread` 判定 + 失败重试退避，本设计的主参照（ack 触发本端更简化，见 §3）。
> - 官方 **GUI** 实现（同 commit，`packages/app/src/shell/notifications/*`）——本地通知清单（告警层）。
>   本设计**只借鉴其交互约定**（点开即清、蓝色角标），**不采用其数据源**（见 §3.1）。
> - 服务端语义（同 commit）：`packages/core/src/session/session.ts` `view()`、
>   `packages/core/src/session/projector.ts` `projectIdle()` / `Viewed`、
>   `packages/schema/src/session-event.ts` `Viewed` / `Execution.*`。
> - 移动端 `openbuilder/docs/design/v2/design-sse-event-surface.md`（`session.viewed` 判 no-op 占位）、
>   `design-session-activity-time.md`（`time.idle` 语义盘点）。
> - 桌面端既有：`design-layout.md` §3（左栏状态指示器）、`design-typing-indicator.md`（状态来源）、
>   `design-error-message` §3（failed 终局派生）。

## 1. 问题与核心不变式

多 worktree 并行时，人需要回答一个问题：**哪个 agent 跑完了、产出我还没看？**
现有指示器区分 running / waiting / failed / idle，但 **idle ≠ 已验收**——一个跑完且成功的会话与
一个早就看过、此刻空闲的会话，视觉上都是灰点。缺少「已产出未验收」这一维。

- **INV-1（服务端单一事实源）**：未读只由服务端水位判定（`time.idle` vs `time.viewed`），
  客户端不持有独立的「已读」事实。跨端一致由 server 保证（任一端 ack，全体一致）。
- **INV-2（点开即清、停留即保持）**：未读会话被点开（成为当前激活 chat Tab）即清标；
  停留其中期间到达的新终态不再标未读——一般 IM 习惯。**不判滚动位置，也不判窗口聚焦**（理由见 §4.2）。

## 2. 契约事实（v2.0.18 源码核实）

### 2.1 未读定义

```
unread(session) ⟺  time.idle !== undefined  &&  (time.viewed === undefined || time.idle > time.viewed)
```

- `Session.Info.time.idle`：最近一次 run **终态**时刻（epoch ms）。
- `Session.Info.time.viewed`：未读水位（epoch ms），**可读不可经 PATCH 写**。
- 两字段都在 `GET /api/session`（列表）与 `GET /api/session/{id}` 返回（`Session.Info.time`）。

### 2.2 标记已读端点（`POST /api/session/{sessionID}/view`）

- body：`{ "idle": number }`（必填，回传**观察到的** idle 值）；返回 `204`。
- summary `View session`，description：*"Mark the idle transition observed by the viewer as viewed."*
- 服务端守卫（`session.ts` `view()`，三条任一命中即 no-op）：
  1. `time.idle === undefined`（从未跑完）；
  2. `input.idle > 服务端 time.idle`（观测值比服务端还新，丢弃）；
  3. `time.viewed !== undefined && time.viewed >= input.idle`（已看过这条或更新的）。
- 投影（`projector.ts` `Viewed`）：`time_viewed = max(idle, coalesce(time_viewed, idle))`——
  **单调水位**，重复/过期 ack 不回退；且**刻意不 touch `time_updated`**（未读不参与活动时间）。
- 推论：客户端**必须回传精确的 idle**。若回传偏小的值，`viewed < idle` → 仍未读（会闪回）。
  所以标记已读用的是**来自 REST 的权威 idle**，不是本地推导值。

### 2.3 `time.idle` 的推进（`projector.ts` `projectIdle()`）

- 仅在 `session.execution.succeeded / failed / interrupted` 时推进；
  `time_idle = max(event.created, coalesce(time_idle + 1, event.created))`——
  **保证严格前进**（同一毫秒内多次终态也不相等，服务端注释明示「Unread 用严格比较」）。
- 例外：`interrupted` 且 `reason === "shutdown"` 时**不推进** idle（不产生未读）。
- `Execution.*` 事件 payload **不含 idle 时间戳**（只有 sessionID + 可选 error/reason）——
  客户端无法从事件精确还原 `time_idle`（+1 守卫会漂移），只能靠 REST 取权威值（见 §4.3）。
- 同时写 `idle_outcome`（= `Session.Info.outcome`：succeeded/failed/interrupted）。

### 2.4 `session.viewed` 事件

- payload：`{ sessionID, idle }`（durable）。语义：水位被推进到 `idle`。
- 客户端收到 → `time.viewed = max(本地, event.data.idle)`。桌面端现有 case 是 **no-op 占位**
  （`app-store.ts:1625`），本设计启用之。
- 移动端不消费（`design-sse-event-surface.md` 判 no-op）——不影响本端，水位仍在 server 全局。

## 3. 与移动端 / 官方实现的差异（为什么不能照抄）

| 维度 | 移动端 openbuilder | 官方 TUI | 本端（桌面） |
|---|---|---|---|
| 消费未读 | ✗（`session.viewed` no-op） | ✓ | ✓ |
| 判定 | — | `idle !== undefined && (viewed === undefined \|\| idle > viewed)` | 同 |
| ack 时机 | — | 窗口聚焦 + 正在看该会话 | **激活 chat Tab**（不判聚焦，见 §4.2） |
| ack 去重 | — | `acknowledged Map<sessionID, idle>`，失败指数退避重试 | 同思路（见 §4.4） |
| 呈现场 | — | Tab 标记（`activity`/`error`） | 左栏状态指示器 + chat Tab（见 §5） |
| 子会话 | — | 未读**只读 root 会话**（子代理完成唤醒父会话） | 同 |

**ack 口径（本端比 TUI 更简化）**：**激活 chat Tab 即 ack**——不判滚动位置，也不判窗口聚焦。
理由：未激活的会话要点开才清，而点 Tab 必然使窗口获得焦点，故判不判聚焦在「点开」路径上等价；
而「停留」期间（Tab 已是激活态）到达的完成，无论窗口是否失焦都视为已看（用户裁定）。
早期草案曾要求「消息视口贴底」，按 IM 习惯废弃（见 §4.2）。

### 3.1 参考：官方 GUI 方案（不采用其数据源）

官方 GUI 的未读挂在**本地通知清单**（`packages/app/src/shell/notifications/notification.tsx`，per-device 持久化）上，
**从不读写服务端 `time.viewed`**。查证结论：该清单是 **2025-12 的桌面「告警」系统**（声音/系统通知/多窗口去重/聚焦抑制）的副产物，
而服务端水位 `time.viewed` 是 **2026-08-21**（`feat(session): add viewed state #42811`）才加入的，**发布时唯一接入的客户端是 TUI，GUI 未迁移**。
其本地清单对**告警投递**合理（投递天然 per-device），但作为**未读真相**是遗留：per-device 不一致（桌面看过多端不清）、
`viewedInCurrentSession` 是路径名启发式而非显式 ack。故本设计**采用服务端水位为准**（INV-1），只借鉴其两条交互约定：

- **点开即清**（GUI：会话路由挂载时 `markViewed`）；
- **蓝色角标**（GUI：`--v2-background-bg-accent` = blue-600；本端未读点同样取蓝，见 §5）。

## 4. 设计

### 4.1 数据来源

未读状态是 Session 的时间字段派生 + 一个本地「待 ack」去重表，**不新增持久化字段**：

- 权威数据：`time.idle` / `time.viewed` 进内部 `Session`（新增 `SessionTime.idle?` / `viewed?`，
  `toInternalSession` 映射）。来源 = REST 快照（`listSessions` 连接/开项目/60s 对账）+
  `GET /api/session/{id}`（终态补拉，见 §4.3）+ `session.viewed` 事件（他端 ack）。
- **合并纪律：`time.idle` / `time.viewed` 的所有写入路径一律 `max(本地, 权威)`**。`mergeSessionsSnapshot`
  对快照内已存在会话是**整对象覆盖**（`next.set(s.id, s)`，`src/shared/session-merge.ts`）——一个
  在 POST `/view`（或终态补拉）之前发出、之后落地的在途快照会带回旧 `viewed`/`idle`，把乐观置位打回未读、闪一下。
  故快照 / 补拉落库须对这两字段特判取 max（事件路径本就是 max）。
- `sessionDotState` 新增第 6 态 `unread`；`dotStateFor` 传入本会话（root）的 unread 布尔。

### 4.2 标记已读策略（ack）

触发条件（**一条**）：

- **该会话是当前激活 Tab**（`activeTabKey === chat:${sessionID}`）。

命中且 `isUnread(session)` 且本地 idle 权威 → `POST /view {idle: 本地 time.idle}`。

- **语义 = 一般 IM**：未读会话被点开（成为激活 Tab）即清标；停留其中期间到达的新终态也即时 ack
  （会话仍是激活 Tab、条件持续成立）——「正在看的会话不显未读」。
- **不判窗口聚焦**：未激活的会话需点开才清，点 Tab 必获焦点——判聚焦在「点开」路径上等价；
  「停留」期间到达的完成即便窗口失焦也视为已看（用户裁定：Tab 激活即视为在看）。
- ack 落点：Tab 激活（点击 / 切作用域恢复 / 被动补开转激活）、`time.idle` 变化——任一促成条件成立，
  统一走 `maybeMarkViewed(sessionID)` 单入口，内部判一条 + 去重。
- 被否决的方案：
  - **要求「消息视口贴底」**（早期草案）：防上滚读历史时误清，但按 IM 习惯废弃——点开即清更直觉，
    且「滚到底才清」会让用户困惑「明明打开了为什么还有未读」；
  - **要求「窗口聚焦」**：与「激活 Tab」在点开路径等价，在停留路径却引入「失焦即变未读」的额外态，
    按用户裁定去掉。

### 4.3 终态补拉（保证及时）

`Execution.*` 事件不带 idle 时间戳，靠 60s 对账补则未读延迟可到分钟级（违背监督场景）。
故 **run 终态时对该会话补一次 `GET /api/session/{id}`**，取权威 `time.idle`/`outcome`/`viewed`：

- 挂点是既有终态消费点（`app-store.ts` 的 `session.execution.succeeded/failed/interrupted` 分支）；
- **跳过 `interrupted`+`reason==="shutdown"`**（server 不推进 idle，补拉纯浪费）；
- 只对已打开目录的已知会话发（过事件闸门）；按 session 去重（在途合并）。**不经 `runLimited` 池**——
  依赖浏览器同 host 连接上限（~6）+ 终态低频 + per-session 去重（子会话终态同样触发，同项目多会话
  齐发时可短暂并发 N 个 GET；压力上升再评估挂池，见 §7 末条）；
- 补拉失败静默（60s 对账兜底）。

被否决的替代：**用事件 `created` 本地合成 idle**——服务端 `max(created, prev+1)` 守卫会让二者
在同毫秒终态时相差 1ms，ack 回传偏小值 → 未读闪回（§2.2 推论）。不采用。

### 4.4 ack 去重与重试

- 本地 `acknowledged: Map<sessionID, idle>`：**发请求前**记录，防事件驱动的重复 effect 重发同一水位
  （同 TUI）。
- 成功：清重试；并乐观置本地 `viewed = idle`（走 `max`，与 §4.1 合并纪律一致；不等 `session.viewed` 回环，点即时转灰）。
- 失败：删记录，指数退避重试（基数 250ms、上限 5s，同 TUI 参数）；期间保持未读。
- 收到 `session.viewed`（本端或他端）：`viewed = max(viewed, event.idle)`；若 ≥ 本地 idle，
  未读自然消除。

### 4.5 状态机（`dotStateFor` 扩展）

优先级（自上而下，命中即返回）：

```
pending > 0           → waiting（琥珀，最高）
status === retry      → error（红呼吸）
status === busy       → running（绿呼吸）
terminalError         → failed（红静态）
idle && unread        → unread（未读，见 §5）
否则                  → idle（灰 0.55）
```

- `waiting` 优先于 `unread`：待输入要人立刻动作，未读只是「待验收」。
- `failed` 优先于 `unread`：红色报警信息量更大；失败会话**仍参与 ack**（看到即清，只是点不显未读色）。
- unread 只对**顶层会话**（`!parentID`）判定，与 `sessionsInDirectory` 的过滤一致；
  子代理完成由父会话 idle 承载（同 TUI）。

## 5. 呈现

呈现面（用户裁定）：**左栏状态指示器 + chat Tab**，两处消费同一 `dotStateFor` 投影。
**不做**手动清除入口（点开即清已足够）；**不做**托盘/任务栏角标。
>4 会话的聚合 chip 当时另开分支重设计（见 §5.1），本分支不含未读 chip——**2026-10-11 重设计已落地**（design-indicator-aggregate-chip），未读 chip 随之生效。

### 5.1 左栏状态指示器（design-layout §3）

未读在此新增**一个状态点变体** `session-unread`（12px 盒、6px 实心点、**静态**，沿用 `session-*` 现有几何）。

**>4 会话的聚合 chip：本分支不做，未读不加入 chip。** 现有聚合 chip 全族（待输入 / 重试 / 运行 / 失败 / 空闲）
**保持现状不动**；目检发现其可用性问题（同色字压同色底致对比不足、深色下灰 chip 对比过低、
未继承状态点的圆点 / 呼吸致语义断裂），需**整体重设计**——另开分支。因此**>4 会话的行本分支暂不呈现未读**
（≤4 行的逐会话蓝点不受影响）。
> **后续（2026-10-11 同日落地）**：聚合 chip 整体重设计已实施
> （[design-indicator-aggregate-chip](../design-indicator-aggregate-chip.md)）——chip = 状态圆点
> 领头 + 中性数字，六态（含未读）全量进 chip，渲染序对齐移动端裁定
> （running → error → failed → waiting → unread → idle）。本节「未读不入 chip」自此失效。

- `sessionIndicatorTitle` i18n 增 `{unread}` 段（中英两份 catalog）。

### 5.2 chat Tab

- Tab 前状态点复用同款：未读 → `session-unread`；running → 既有 `session-running`。
- 不做 Tab 标题加粗 / 星号等第二套信号（保持「状态点单一语法」）。
- **注意（两处映射链）**：左栏 `sidebar.tsx` 与 chat Tab 的「状态 → 类名」映射都是**三元链、末档回落
  `session-idle`**；`dotStateFor` 新增 `unread` 后**两处都必须显式加分支**，否则 TypeScript 不报错、
  未读会被静默画成灰点。

### 5.3 视觉规格（定稿）

> 用户 2026-10-11 定稿：未读用**蓝**（暗 `#58a6ff` / 亮 `#0969da`）。
> 静态预览：同目录 `design-unread-marker.preview.html`（浏览器打开，深浅两主题并排；
> 预览里的 chip 行保留作对照，其重设计已落地：design-indicator-aggregate-chip）。

- 新增令牌 `--status-unread`（深浅两态，遵 DESIGN.md「新增色必须先走令牌」）：
  - 暗 `#58a6ff` / 亮 `#0969da`（GitHub blue，同既有 `--syntax-link` 亮暗配对，已过对比审）。
- 与 status 四色（绿 / 红 / 灰 / 琥珀）**色相均不撞**；蓝＝「新 / 未读」通用约定，
  且与官方 GUI 角标同色系（其 `--v2-background-bg-accent` = blue-600）。
- 状态点 CSS：`.status-dot.session-unread { --session-dot-color: var(--status-unread); }`——
  沿用 `session-*` 12px 盒 / 6px 实心点几何、**静态满不透明**（区别于 running 的绿呼吸光晕）。
- ~~聚合 chip CSS `.session-count.unread`~~：**延后**——并入聚合 chip 整体重设计（另开分支，见 §5.1）；
  已随重设计落地（形态为「蓝点领头 chip」而非同色字变体）。
- 被否决备选：复用 running 绿静态（与 running 靠动效区分太弱、聚合 chip 出现两个绿数字）；
  复用 `--primary`（绿系，且已承担选中 / 焦点语义，语义争用）。
- **DESIGN.md 同步（末步）**：`status` 由「四色」扩为「五色」并声明理由；token 落 `tokens.css`。

## 6. 场景验证

| # | 场景 | 期望 |
|---|---|---|
| 1 | 后台 worktree 的 agent 跑完（非当前 Tab，该行 ≤4 会话） | 终态补拉后该行出现蓝点 |
| 2 | 跑完时该会话正被看（激活 Tab） | 立即 ack（`POST /view`），无蓝点闪烁 |
| 3 | 跑完时该会话是激活 Tab、但窗口失焦（用户切走了） | 仍立即 ack（Tab 激活即视为在看），不置未读 |
| 4 | 跑完时用户在该会话上滚读历史 | 仍即时 ack（不判滚动位置，IM 习惯），不显未读 |
| 5 | 打开一个已未读的会话（从 Tab/恢复） | 激活即 ack，点转灰 |
| 6 | 另一客户端先 ack | 收到 `session.viewed` → 本端未读消除，不再 POST |
| 7 | 会话失败后未看 | 显示 `failed`（红静态）；打开看到后 ack（点仍红，不再未读） |
| 8 | ack 请求失败（网络） | 保持未读，指数退避重试直到成功 |
| 9 | 断线重连 | 对账快照重算 `idle/viewed`；未读状态收敛 |
| 10 | 连续两次 run 终态 | `viewed` 单调；只 ack 到观察到的 idle，后一次 idle 保持未读 |

## 7. 已知 gap / 明确不做

- **不做消息级未读数**：契约只有会话级水位，无「未读消息条数」。计数型角标（如「3 条新消息」）不可得。
- **不做手动清除未读入口**：未读会话点开即清（§4.2），无需额外「全部标记已读」入口（Keep Lean）。
- **不做托盘 / 任务栏角标**：v0.x 无托盘形态（PRINCIPLES Keep Lean）；未来若做，数据源即本设计水位。
- **不做每设备各自已读**：水位在 server 全局（单用户），任一端已读全体一致——这正是 v1 时代
  「多端不一致」顾虑被 v2 解决的形态。
- **不处理 shutdown 型中断**：server 不推进 idle，无未读（与 server 同口径）。
- **不新增会话列表入口**：未读经左栏点（≤4 会话行）/ chat Tab 可见；**>4 会话行的未读**已随聚合 chip
  重设计呈现（2026-10-11，design-indicator-aggregate-chip——蓝点领头未读 chip）；超出 8 个未自动开 Tab 的会话仍无独立列表入口（沿 design-layout §4 既有取舍）。
- **依赖 cp 到 REST 补拉**：若未来 pool 压力上升，可评估退化为周期性快照（代价 = 未读延迟）。

## 8. 涉及文件（已实现，2026-10-11）

| 位置 | 改动 |
|---|---|
| `src/shared/api-types.ts` | `SessionTime` 增 `idle?` / `viewed?` |
| `src/shared/v2-adapter.ts` | `toInternalSession` 映射 `time.idle` / `time.viewed` |
| `src/shared/rest-client.ts` | 新增 `getSession(sessionID)`（`GET /api/session/:id`）与 `markSessionViewed(sessionID, idle)`（`POST /api/session/:id/view`） |
| `src/shared/pending-requests.ts`（或新 `src/shared/unread.ts`） | `SessionDotState` 增 `"unread"`；`isSessionUnread(session)`；`sessionDotState(...)` 增 unread 入参 |
| `src/renderer/src/store/app-store.ts` | `session.viewed` case 合并 `viewed`；终态补拉；`dotStateFor` 传入 unread；`maybeMarkViewed`（激活 Tab 驱动）+ `acknowledged` 去重 / 退避 |
| `src/renderer/src/components/sidebar.tsx` | `SessionIndicator` 加 `session-unread` 点（>4 的 chip 分支当时不动；chip 重设计已随后落地，见 §5.1 后续注） |
| `src/renderer/src/components/workspace.tsx` | chat Tab 未读点（Tab 条状态点复用 `session-unread`） |
| `src/renderer/src/styles/tokens.css` | `--status-unread` 深浅两态 |
| `src/renderer/src/styles/app.css` | `.status-dot.session-unread`（`.session-count.unread` 当时延后，已随 chip 重设计以「蓝点领头 chip」形态落地） |
| `src/renderer/src/i18n/index.ts` | `sessionIndicatorTitle` 增 `{unread}`；相关 a11y 文案 |
| `docs/design/design-layout.md` | §3 左栏指示器状态点枚举加第 6 态 `unread`（该文是布局权威，AGENTS.md「布局/交互改动以此为准」） |
| `DESIGN.md` | 状态色「四色→五色」；未读语义与使用规范 |

## 9. 待办

1. ~~未读蓝目检定稿~~ → **已定稿**：`--status-unread` 暗 `#58a6ff` / 亮 `#0969da`（用户 2026-10-11 确认）。
2. ~~**聚合 chip 整体重设计**：另开分支~~ → **已落地（2026-10-11）**：
   [design-indicator-aggregate-chip](../design-indicator-aggregate-chip.md)；
   未读 chip 已生效（>4 会话行呈现蓝点领头未读 chip，渲染序对齐移动端裁定）。
3. **终态补拉的频率**（实施细节）：每终态 1 次 `GET` 是否可接受（§4.3）；备选批量延迟合并。
4. ~~落地~~ → **已实现（2026-10-11）**：`tokens.css` `--status-unread`（暗 `#58a6ff` / 亮 `#0969da`）；`DESIGN.md` 状态五色；`app.css` `.status-dot.session-unread`；`sidebar.tsx` / `workspace.tsx` 状态点映射加 unread 分支；`app-store.ts` ack（激活 Tab 驱动 + `acknowledged` 去重 + 250ms→5s 退避）、`session.viewed` 单调合并、run 终态补拉、`emit` 单入口触发；`rest-client` `getSession` / `markSessionViewed`；`pending-requests` `SessionDotState` 加 `unread`；`unread.ts` `isSessionUnread`；`session-merge` `mergeMonotoneSessionTime`（idle/viewed 单调 max，防在途快照回退）；i18n `{unread}`。测试：`unread` / `session-merge` / `pending-requests` / `rest-client` / `app-store` 新增用例；全量 vitest 1224 通过、typecheck 绿。