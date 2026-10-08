# 会话错误重试展示与收敛 — 设计文档

> 状态：已实现（`step.failed` 接入写终态；retry part 丢弃；`step.started` 收窄合并；测试 `app-store.test.ts`「重试收敛」describe）
>
> 参考来源：姊妹项目 openbuilder `docs/design/v2/design-session-retry-recovery.md`（2026-10-08 已实现，v2.0.24 mock provider 活体实测事件序列）；官方 GUI 客户端语义（web projector / desktop TUI 一致）。本端此前实现为 design-error-message §3.2/§3.6（v1 时代裁定），本文档按 openbuilder 修复后的语义收敛并改写其过期依据。

## 1. 问题（修复前现状）

对照 openbuilder 修复语义（其根因 1/2 在本端的表现形态）：

1. **`session.step.failed` 未接（表 A 应修项）**：`applyV2StreamEvent` 只接 `step.started/ended`。失败步不发 `step.ended`（server `publish-llm-event.ts` 二者互斥）→ 重试耗尽后：
   - 最后一次 `step.started` 曾整壳替换消息（清 error/finish），终态错误无处写入 → 错误卡缺失；
   - 消息滞留 streaming 骨架（无 finish、无 completed）；
   - `inferFailedFromMessages` 的 failed 静态红点（design-error-message §3.4）依赖末条 `info.error`，永不触发；
   - live 在场时无自愈触发（`execution.failed` 只置 idle 不重取；对账仅断连/60s 跑）。
2. **retry part 传播违反 INV-1**（design-error-message §3.2）：`message.part.updated` 的 retry part 把 error 写进 `info.error`——退避窗口消息挂红字，与「重试展示=会话级气泡、消息错误=终态专用」分离原则冲突。v2 pin 未观测到该 part 发布（防御式），但「同 openbuilder」依据已失效：openbuilder 修复后无此传播。
3. **`step.started` 整壳替换无防漂移**：每次合成全新 info 无条件覆盖——若接入 `step.failed`，同 mid 游离 `step.started` 会洗掉合法终态错误。

## 2. 契约事实（引 openbuilder 活体实测，升 pin 按 design-sse-event-surface §5 复核）

**重试成功**：

```
execution.started
step.started          (mid=A)
[provider 错误]
retry.scheduled       (mid=A, attempt=N, error)   ← 同一 assistantMessageID
step.started          (mid=A)                     ← 重试重启；不重发 execution.started
text.started/delta/ended (mid=A)
step.ended            (mid=A, finish=stop)
execution.succeeded                               ← 唯一收敛信号
```

**重试耗尽**：`[retry.scheduled → step.started] × N`，最终 attempt 以 **`step.failed`（终态 error）→ `execution.failed`** 收尾——`step.failed` 只在不再重试时发出，与 `retry.scheduled` 互斥。

REST 快照对照：重试成功后消息 `error=null, finish=stop`（服务端已清）；耗尽后 `error={...}, finish=error`（合法保留）。

官方 GUI 语义（三实现一致）：`retry.scheduled` 只写消息 retry 标记（横幅行）、不写消息级 error；`step.failed` 是消息级错误的**唯一合法来源**；`step.started` 同 mid 重启即恢复 running；`execution.*` settle 时清 retry 标记。

## 3. 设计

### 3.1 `session.step.failed` 接入（`applyV2StreamEvent`）

- 消息已存在：写 `info.error = 事件 error` + `finish = 事件 finish ?? "error"` + `time.completed`（终态收敛，同 `step.ended` 形态）；消息缺失静默丢弃（壳只会经 `step.started` 建立，正常序列 `step.failed` 必在其后）。
- 不在事件到达时重取快照——事件即权威（openbuilder 同构，无 reload 依赖）。

### 3.2 retry part 丢弃（`message.part.updated` 前置分支）

`part.type === "retry"` 整体丢弃：不传播 error、不入 parts、不入 pendingParts。重试期错误展示由会话级气泡独担（`status retry` → TypingSlot「重试中：{错误}」）。

### 3.3 `session.step.started` 收窄（存在时合并，不再整壳替换）

消息已存在时：只补 `agent`/`model` + 复位 `finish === "tool-calls"`（多步中间态）——**不清 error/终态 finish**（防同 mid 游离事件洗掉 `step.failed` 写入的终态，同 openbuilder `onStepStarted`）。不存在时维持原 message.updated 合成壳路径（含 pendingParts 回放）。

### 3.4 保持既有：`retry.scheduled` 只驱动气泡、settle 收敛

- `retry.scheduled` → `setSessionStatus(retry, {attempt, message, next})`（连续重试最新覆盖）——本端原本即符合，不变；
- `execution.succeeded/failed/interrupted` → idle + `retryHold` 解除——INV-2 尾段，不变。

### 3.5 与 openbuilder 的有意偏差：retryHold（不随 step.started 回落 busy）

openbuilder 改动 2（`step.started` 回落 busy）本端**不跟进**，维持 design-error-message §3.6 的保持锁存：retry 态持续到重启后**首个内容 part**（排除 step-start/snapshot 伴随 part）才解除恢复 busy。理由：

- openbuilder 根因 2 的实害形态是「重试成功后多步 run 继续跑数分钟、期间误示重试中」——本端内容 part 秒级到达即解除，无数分钟误示窗口；
- 快失败类错误（429/5xx，请求期即失败、无任何 part）若随 step.started 回落，红绿按尝试次数交替闪——锁存让整个重试期稳定红点；
- openbuilder「多轮重试 retry/busy 正确摆动」是可接受的官方语义，本端选择阻尼它，视觉更稳，代价是重启后 TTFB 窗口（首 token 前）仍示「重试中」——信息仍准确（该尝试尚未产出）。

注：§3.6 原依据「server 退避后每次尝试起点发 busy（session.status）」在 v2.0.18 已不成立（表 C：`session.status` 无发布者）；现状锁存实际防的是 REST 快照 busy 合并（重连对账落退避窗口）与尝试起点的绿闪，语义表见 design-error-message §3.6 修订。

## 4. 不变式（与 openbuilder 对齐）

- **INV-1**：`msg.error` 非空 ⇔ 收到过该 mid 的 `step.failed`（或 REST/缓存快照携带）——retry 来源（事件与 part）不写、`step.started` 不清；
- **INV-2**：会话级 retry 态生命周期 = `retry.scheduled` 置位 → 首个内容 part 解除保持恢复 busy（本端偏差，见 §3.5）→ settle（`execution.*`）置 idle → 再次 `retry.scheduled` 重新置位；
- **INV-3**：SSE 断连期间的收敛缺口不新增机制——状态由 `reconcileActiveSnapshot` 对账、消息由重连 `onMessagesSnapshot`/重开 Tab/下一条 user 消息重取兜底（既有行为）。

## 5. 场景验证（`app-store.test.ts`「重试收敛」describe）

| # | 场景 | 期望 |
|---|------|------|
| 1 | 退避期（retry.scheduled 后、重启前） | 状态 retry + 红点；消息无 error |
| 2 | 重试成功（step.started 同 mid → 内容 part → step.ended → settle） | 保持解除恢复 busy；消息 `finish=stop`、无 error 残留 |
| 3 | 连续多重试 | 气泡文案始终最新一次错误 |
| 4 | 重试耗尽（step.failed → execution.failed） | 消息 `finish=error` + 终态 error + completed；idle + failed 静态红点（§3.4 终局闭环） |
| 5 | step.failed 壳未建 | 静默丢弃，不误建容器 |
| 6 | 同 mid 游离 step.started | 终态 error/finish 不被洗掉；tool-calls 中间态复位；agent/model 补写 |

## 6. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/renderer/src/store/app-store.ts` | `applyV2StreamEvent` 增 `step.failed` case；`step.started` 收窄为存在时合并；`message.part.updated` 的 retry part 改整体丢弃；移除 `RetryPart` 导入 |
| `src/renderer/src/store/app-store.test.ts` | 「报错消息与重试状态」retry part 三用例改写（不传播/无影响）；新增「重试收敛」describe 六用例 |
| `docs/design/design-error-message.md` | §0/§1/§3.2/§3.6/§3.7/§5 按 INV-1 修订 |
| `docs/design/v2/design-sse-event-surface.md` | 表 A 移除 step.failed（已修出表注记） |

## 7. 不做的事

- 不为重试横幅增加消息级 UI（沿用会话级底部气泡形态）；
- 不处理 SSE 断连期间 missed settle 的即时收敛（INV-3，既有对账兜底）；
- 不改 `step.ended` 既有 finish/cost/tokens 收敛语义；
- 不动 `retryHold` 机制本身（§3.5 维持，仅改写其文档依据）；
- 不在 `OpencodeEvent` 联合补声明 `step.*` 家族（沿 M4a 惯例：流式族经 `{type, properties}` 透传翻译层消费）。
