# 会话输入中提示（TypingIndicator）— 设计文档

> 目标：会话进行中（busy/retry）时，在消息流末尾展示"输入中"动效；**展示/隐藏提示不得引起已接收消息的任何位移**（提示位置必须预留）。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-session-status.md` — 状态来源双层修复 + 内存缓存按目录合并 + finish 推断规则
> - `openbuilder/docs/review-session-status.md` — `_statusMap..clear()` 误清 busy 的回归坑（cdb0872 / SS-1）
> - `openbuilder/docs/design-run-assembly.md` — footer 动态行（typing dots/retry）作为独立基底项的滚动数学
> - `openbuilder/docs/design-frontend.md` — TypingDots 三点脉冲组件规格

## 1. 需求与核心不变式

- 会话 busy / retry 期间，消息流末尾（最后一条消息之后、输入区之前）显示输入中提示；
- **INV-1（本文核心不变式）**：提示的显示与隐藏**只改变槽位内部内容，不改变消息流的内容总高度**——已接收消息的像素位置完全不变。

## 2. 与移动端方案的差异（为什么不能照抄）

移动端 `_TypingDots` 是**条件渲染**的 footer 行（`conv.busy || conv.loading` 时插入）。它能这么做是因为 Flutter 列表 `reverse: true` + 钉底滚动：dots 行出现在 pixels≈0 侧，显隐引起的基底高度变化被钉底滚动吸收（openbuilder design-run-assembly 仍为此专门处理 footer 高度对滚动定位的影响）。

桌面端是 DOM 自上而下文档流 + 吸底滚动：在消息之后**插入/移除**一个高 H 的节点，会让上方所有消息整体上移/回落 H 像素——正是本需求明确禁止的抖动。

## 3. 设计：常驻固定高度槽位（reserved slot）

消息流滚动容器的内容末尾**常驻**一个固定高度槽位 `TypingSlot`：

```
┌─ 消息流（滚动容器）──────────────┐
│  …                              │
│  assistant 消息（流式增长中）      │
│ ┌─ TypingSlot（H = 28px，常驻）─┐ │
│ │ ● ● ●   ← busy：三点脉冲       │ │
│ │         ← idle：空白           │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
┌─ 输入区 ────────────────────────┐
```

- **高度恒定**：`height: 28px`（4px 网格 × 7）+ `overflow: hidden`，不随内容显隐变化——busy ⇄ idle 切换零布局变化，INV-1 成立；
- **idle 时不浪费**：槽位兼作消息流底部呼吸留白（最后一条消息与输入区之间的间距本来就存在），空闲会话的视觉成本≈0；空会话（尚无消息）时槽位同样无害；
- **内容约束**：槽内呈现物高度必须 ≤ H（dots 行垂直居中）；
- **显隐动画**：只用 `opacity`/`visibility` 过渡（150ms），任何布局属性（height/margin/padding）不得参与动画。

### 被否决的替代方案（决策记录）

| 方案 | 问题 | 结论 |
|---|---|---|
| 条件渲染（移动端做法） | DOM 流下插入/移除节点 ⇒ 上方消息位移 H，违反 INV-1 | ❌ |
| 绝对定位 overlay（不占布局） | 切换同样零位移，但会遮挡流式增长的末条消息尾部，且"预留位置"的需求语义就是 in-flow 占位 | ❌ |
| 仅 busy 期间插入槽位、结束后延迟收回 | 收回时刻仍有一次位移；状态切换时机与布局耦合，边界（retry、SSE 断）复杂化 | ❌ |

### retry 态

移动端 retry 用 `_RetryMessage` 多行气泡替换 dots——**变高，破坏 INV-1，不采用**。桌面 v0.1：retry 在同一槽位内呈现（旋转图标 + 单行截断提示文案，高度仍 ≤ H）；`SessionStatus.retry` 的 `message`/`attempt` 字段完整交互留 v0.2。

## 4. 状态语义（沿用移动端已验证模型）

会话状态为纯客户端内存映射，project-scoped（随事件闸门过滤，见 design-layout §3）：

```ts
sessionStatus: Map<sessionID, 'busy' | 'idle' | 'retry'>
```

### 来源与转换（优先级从上到下）

| 来源 | 时机 | 效果 |
|---|---|---|
| SSE `session.status`（`{sessionID, status}`，status = busy/idle/retry） | 实时 | 权威设置（含 retry 态） |
| SSE `session.idle`（`{sessionID}`） | 实时 | 置 idle（仅状态实际变化时通知，防 spurious idle 抖动——移动端 wasBusy/wasRetry 守卫） |
| 乐观设置 | `POST /session/{id}/message` 成功 | 立即置 busy（不等事件，消除首字节延迟） |
| REST `GET /session/status?directory=<dir>` | 冷启动快照 + 重连对账 | **按目录覆盖合并**：成功目录 fresh 权威（返回里缺该会话 ⇒ idle）；失败目录**保留旧值**——严禁 `clear() + addAll()`（SS-1 回归：某目录 fetch 失败返回 `{}` 会把已知 busy 全误清成 idle）。**快照目录集 = 打开项目全集（root ∪ sandboxes）**：非当前 worktree 无 SSE 事件通道（订阅集合仅含当前 scope，见 design-v0.1-implementation 连接池约束），其 busy 结束后只能靠对账快照纠正——对账目录集若与订阅集一致，左栏 dots 会永久卡亮（对齐移动端 `_fetchAllStatuses` 覆盖全部目录的语义） |
| 消息 finish 推断 | 任何 `GET /session/{id}/message` 结果处理时 | 末条 assistant 且 `finish === 'stop' \|\| 'error'` ⇒ idle；`'tool-calls'`（中间步骤）与 `null`（生成中）**不触发**（移动端 D-SS-A/B 已验证：进行中消息在 REST 可见且 finish=null） |

- 状态不落盘（时效性强，磁盘 busy 是误导；冷启动显示 idle 直到 REST 返回）；
- chat Tab 标题的 8px running 状态点（design-layout §4 / DESIGN.md 既有约定）与消息流槽位**消费同一状态源**，单一事实源，杜绝 Tab 与消息流不一致。

### 事件闸门

`session.*` 事件按打开项目集合过滤（未打开项目的事件直接丢弃）；关闭项目时其状态随会话状态一并卸载。

## 5. 视觉规格（对齐 DESIGN.md）

| 项 | 规格 |
|---|---|
| 三点 | 直径 6px、间距 4px、色 `outline`（次级提示语义；`status.running` 留给状态点/Tab，不混用） |
| 动效 | opacity 脉冲 0.3 ↔ 1.0，周期 900ms，三点相位差 300ms（沿用移动端节奏参数）；纯 CSS animation，无 JS 定时器驱动 |
| 对齐 | 左对齐 assistant 内容列（与消息正文同一水平 padding） |
| retry 呈现 | 16px 旋转图标（lucide `loader-circle`）+ 单行截断文案 `ui-sm`，高度 ≤ H |
| a11y | 槽位容器 `role="status"`，busy 时文案"正在生成…"（i18n key 对齐移动端 ARB 同场景，无则新增中英两份 catalog） |
| token | 无新增 token（复用 `outline` 色）；H 与动画参数为组件常量 |

## 6. 与滚动的交互

- **吸底流式增长**：末条消息内容增长照常推内容上移——这是内容增长，不受 INV-1 约束（INV-1 只约束提示显隐）；
- **busy 开始**：乐观 user 消息 append + 吸底滚动由**新消息**引起（内容变化，允许）；随后 dots 出现在已预留的槽内，无额外位移；
- **busy 结束**：dots 消失，槽位保持——无位移；此刻若仍有尾部 part 到达，属内容增长；
- **用户上滚浏览历史**：槽位随内容底部离开视口，busy 感知由 DESIGN.md"进行中的活动 = 状态可见"的另两处承担（Tab running 点、会话列表）；"跳到最新"浮层属滚动交互，不在本文范围。

## 7. 场景验证

| # | 场景 | 期望 |
|---|---|---|
| 1 | 发送消息后 | dots 于槽内立即出现（乐观 busy），已有消息零位移 |
| 2 | 流式中途 SSE 断（degraded） | 状态冻结 busy（不被误清），dots 保持；重连对账后按 REST 收敛 |
| 3 | 会话正常结束（`session.idle`） | dots 隐藏，消息零位移 |
| 4 | 打开一个正在跑的会话 Tab | REST status/message 快照 → busy 正确，打开即见 dots |
| 5 | 会话在对账窗口内完成 | 重连 reconcile → idle，dots 消失 |
| 6 | 上滚浏览历史 | dots 不可见，Tab running 点仍在 |
| 7 | retry 态 | 槽内切换为 retry 呈现，高度不变 |
| 8 | 空会话（无消息） | 槽位为空白留白，首个 run 开始时 dots 出现，无跳动 |

## 8. 已知残留 gap（沿用移动端结论）

发消息后 SSE 断开且重连成功前：乐观 busy 无自动复位路径（`session.idle` 丢失、reconcile 未触发）。依赖状态栏 degraded 提示 + 手动刷新（刷新走消息 finish 推断兜底）。v0.2 可评估发送后延迟 status 检查——移动端 design-session-status 同结论，不重复发明。

另一残留：非当前 worktree 的 busy 结束若期间无任何 SSE 重连，对账不触发，该目录左栏 dots 保持到下次 scope 切换/项目重开（对账快照目录集虽覆盖全集，但只在重连时跑）。v0.2 可评估低频周期刷新；移动端同样只在 bootstrap/reconcile 拉取，不超前发明。

## 9. 涉及文件（已实现）

| 位置 | 改动 |
|---|---|
| `src/shared/api-types.ts` | `SessionStatusValue` 联合类型 + `session.status` / `session.idle` 事件声明（契约：`opencode_openapi.json`，未知事件透传忽略） |
| `src/shared/rest-client.ts` | `listSessionStatus(directory)`（无 directory 返回 `{}`，必须带目录查） |
| `src/shared/session-status.ts` | 纯逻辑层：按目录覆盖合并（SS-1 防回归）+ finish 终态推断 |
| `src/shared/reconciler.ts` | 对账附加逐目录状态快照：`getStatusDirectories` = 打开项目全集，并发受限 2（连接池约束），失败目录回传 null |
| `src/renderer/src/store/app-store.ts` | `sessionStatus` 映射（单一事实源）+ 5 类来源接入 + 在途快照闸门（`isOpenedDirectory`） |
| `src/renderer/src/components/workspace.tsx` | 消息列表末尾 `TypingSlot`（常驻 28px）+ 三点 / retry 呈现 |
| `src/renderer/src/i18n/index.ts` | "正在生成…" / "重试中" / "重试中：{message}" 中英 key |
