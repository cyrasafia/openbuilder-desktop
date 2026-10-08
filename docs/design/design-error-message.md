# 报错消息呈现与重试状态 — 设计文档

> 目标：正确识别报错类消息（assistant `info.error` 与 `retry` part），错误卡呈现人读文案而非
> `[object Object]`/原始 JSON；报错退避重试期间状态指示器出现红色。

## 0. 参考来源（openbuilder 同类设计）

- `openbuilder/docs/design/v2/design-session-retry-recovery.md`（2026-10-08）：重试/终态错误分离语义的权威裁定——retry 来源不写消息级 error，`step.failed` 是唯一合法终态来源（INV-1）；本仓库对应落点 `docs/design/v2/design-session-retry-recovery.md`
- `openbuilder/lib/features/conversation/conversation_screen.dart` `_extractErrorMessage`：
  NamedError 形态的人读文案提取顺序
- `openbuilder/docs/docs/design/design-agent-status-indicator.md`：状态模型 retrying（移动端为橙色旋转胶囊，
  桌面按既有 token 体系改用红点，见 §3 决策）

## 1. 问题

1. **错误卡取值路径落空**：`MessageBlock` 曾按 `{type, message}` 假设取 `info.error.message`，
   实际契约人读文案嵌套在 `data.message`——取值落空后回退 `String(info.error)`，错误卡呈现
   `[object Object]`（不可读，即"暴露原始 json"表象的根因之一）。
2. **状态点永不红**：`sessionDotState(pendingCount, busy)` 把 retry 与 busy 同归 running（绿光晕），
   报错退避重试在 Tab 点/左栏会话指示点上无差异化呈现，`--status-error` token 形同虚设。
3. **retry part 无消费**：openapi Part 联合含 `RetryPart`（携带 APIError），此前类型未声明、
   事件路径直接透传忽略——若 server 发出，错误信息完全丢失（无错误卡）。
   （2026-10-09 修订：消费方向已反转——见 §3.2 与 design-session-retry-recovery，retry part
   整体丢弃，重试期错误由会话级气泡独担。）

## 2. 契约事实（本机 server 实测 + openapi 对齐）

- **AssistantMessage.error 是 NamedError 序列化**（REST/SSE 一致，2026-08-26 全量扫描实测）：

  ```json
  {
    "name": "APIError" | "UnknownError" | "MessageAbortedError" | …,
    "data": { "message": "…", "statusCode"?: 429, "isRetryable"?: true,
               "responseHeaders"?: {…}, "responseBody"?: "…" }
  }
  ```

  顶层**无** `message` 字段；`MessageAbortedError`（用户停止）同形态。
- **finish 不可靠**：halt 路径只置 `error` 不置 `finish`（实测错误消息 `finish: null`，仅
  ContextOverflow 分支置 `finish: "error"`）——错误判定只能依赖 `info.error` 存在性。
- **RetryPart**（openapi 1.18.x）：`{type: "retry", attempt, error: APIError, time: {created}}`。
  本地 server 1.18.13 实测未持久化到消息（retry 仅经 `session.status` 事件表达），消费为防御式。
- **session.status retry**：`{type: "retry", attempt, message, next, action?}`——store 已权威接收
  （design-typing-indicator §4），问题只在投影层。

## 3. 设计

### 3.1 错误文案提取（`src/shared/message-error.ts`）

`extractErrorMessage(error)`，提取顺序（移植 openbuilder `_extractErrorMessage`）：

`data.message` > `data.error` > `data` 有意义值整体 JSON dump > `data`（字符串形态）>
顶层 `message`/`error`/`msg`/`detail` > 未知字段整体 dump > `name` 回落。

- 兜底 dump 保证**永不输出 `[object Object]`**；未知形态原文可见（可诊断）。
- `MessageBlock` 错误卡：`{extractErrorMessage(info.error)}`——样式承载出错语义：
  红字（`--status-error`）+ 10% 错误色淡染底 + 35% 同色细描边。不用实底
  `error-container`（深色下 #93000a 底 + #ffdad6 字对比过强刺眼，2026-08-26 修订
  弱化，对齐 session-count 等淡染惯例）；不加「出错了/Something went wrong」
  前缀（i18n `errorTitle` 已移除）。
- **内嵌 JSON 清洗（`stripEmbeddedJson`，两路统一）**：provider 错误原文（server
  retry.ts 透传 `error.data.message`）可内嵌 JSON body——如
  `Internal Server Error: {"error":{"message":"…","type":"server_error"}}`。提取内嵌
  JSON 的人读字段（error.message > message > error > detail）与前置摘要重组；非 JSON/
  解析失败/无可读字段均原文返回。`extractErrorMessage` 产出（错误卡）与
  `extractRetryMessage`（TypingSlot retry 提示）同源消费同一清洗——纯展示层，
  store 数据保持忠实。

### 3.2 retry part 消费（app-store `message.part.updated`）——2026-10-09 修订

**决策反转**（原「error 传播到 `info.error`（无错误时）」废止）：`part.type === "retry"`
**整体丢弃**——不传播 error、不入 parts 数组、不进 pendingParts 缓存。

依据（design-session-retry-recovery §3.2，同 openbuilder 修复后语义）：

- **INV-1**：消息级 `info.error` 的唯一合法来源是 `step.failed` 终态（或 REST/缓存快照携带）；
  retry 来源一律不写。重试期错误由会话级气泡独担（`status retry` → TypingSlot
  「重试中：{错误}」），对应官方 GUI 的「重试横幅」；
- 旧传播的实害形态即 openbuilder 根因 1：退避窗口消息挂红字，清除依赖下一个合成壳
  （`step.started`）——SSE 断连丢事件即永久残留；
- v2 pin 未观测到 retry part 发布（v1 1.18.13 实测亦不发），本分支整体防御式；若未来
  发布，退避窗口也只有气泡，符合 INV-1/场景 1 期望；
- 「openbuilder 也传播」的旧依据随其 retry-recovery 修复失效（其 `onRetryScheduled`
  收敛为只驱动气泡，亦无 retry part 传播）。

### 3.3 状态点投影（pending-requests `sessionDotState`）

```
waiting（待输入，琥珀静态）> error（retry 退避重试，红）> running（busy，绿）> idle
```

- 入参从 `busy: boolean` 改为 `statusType`（`SessionStatusValue["type"]`）——retry 与 busy 在
  投影层分离；`waiting` 显示时底层 busy/retry 事实保留（design-agent-status-indicator 语义不变）。
- **error 为红色光晕呼吸**（同 running 的 halo-breathe 参数，颜色 `--status-error`）：重试是
  进行中而非终态失败，红色仅示错因——参考 app retrying 状态的动效语义（有动效 = 正在工作）。
- **几何对齐**：会话状态点统一 `session-*` 变体类（`session-running`/`session-error`/
  `session-waiting`/`session-failed`/`session-idle`，Tab 条与左栏共用）——统一 12px 盒、
  中心 6px 实心点 ::after 居中、颜色经 `--session-dot-color` 定制。此前 Tab 条 waiting/error
  用基础 6px 点与 running 的 12px 光晕盒并存，视觉纵向不齐；统一盒几何后结构上保证对齐。
  左栏 idle 点维持既有 12px 盒规则。
- **Tab 条常显（含 idle）**：chat Tab 的状态点在 idle 时也显示（`session-idle` 灰静态、
  同 0.55 弱化档）——Tab 是跨项目混排的唯一会话入口，状态列常驻可一眼区分"该 Tab 有事/
  无事"，且常显不引入状态切换时的布局位移（点常驻，只有颜色/动效变化）；非 chat Tab
  无会话语义，不显示。左栏会话指示器维持原语义（idle 会话逐点显示，无 Tab 的 0 点省略）。
- 落点：Tab 条状态点、左栏会话指示点、>4 会话聚合 chip（`.session-count.error` 红字淡染底）；
  `sessionIndicatorTitle` 增 `{error}`。
- `isSessionActive` 不变：retry 仍视为进行中（停止按钮、关 Tab 确认、补充发送语义均维持）。
- 左栏连接状态点（ServerStatus 离线红点）是另一体系：静态实心 6px 基础类，不走 session-* 变体。

### 3.4 报错终局静态红点（failed）

**语义**：会话以报错结束（retry 耗尽/不可重试错误 → halt → idle）时，指示器显示**红色静态点**
（`session-failed`，同 12px 盒无呼吸）——终局不是进行中，动效上区别于 retry 的红呼吸；
idle 灰点无法表达"上次运行失败了"。retry 呼吸红 = 正在重试，failed 静态红 = 已死等你。

**判定**（session-status.ts `inferFailedFromMessages`）：会话 idle 且末条消息为携带**非中止**
错误的 assistant（中止 `MessageAbortedError` 是用户主动停止，不算失败）。中止判定经
`isAbortError`（message-error.ts）name/type 双键——v2 SSE 事件 error 形态为
`{type, message}`，中止标记可落在 `type`（design-session-retry-recovery §2 待复核项）。
`finish` 不可靠（halt 只置 error 不置 finish，§2），以 `info.error` 存在性为准。

**实现**（app-store `dotStateFor` 纯派生，无缓存/锁存集合）：

- idle 时对已加载消息排序取末条判定（`inferFailedFromMessages`）；busy/retry 跳过派生
  （进行中状态优先，也无终局语义）。无消息容器（未打开会话）⇒ 空列表 ⇒ 不触发。
- **不设事件清除路径**：终局是消息数据的纯函数——新 run 的 user/新 assistant 消息天然
  成为新末条，终局自愈；事件锁存（如新 run 清标记）反而引入「清除后重新派生又复活」
  的一致性问题（busy 期间无新消息落地的窗口）。代价是每次 dotStateFor 对 idle 会话的
  已加载消息全量排序——与 chatEntries 同模式（每调用排序），长会话（数百条）下由
  消费者数量放大的成本可观测时再考虑缓存末条判定，桌面规模先接受。

**投影优先级**（pending-requests `sessionDotState` 第三参 `terminalError`）：
`waiting > error(retry 呼吸) > running > failed(静态红) > idle`——进行中状态永远优先于终局。

**视觉落点**：Tab 条/左栏会话点 `session-failed`（红静态，共享 12px 盒）；>4 聚合
`.session-count.failed`（与 error 同红色，悬停 title 计数区分语义）；`sessionIndicatorTitle`
增 `{failed}`。

### 3.6 retry 保持锁存（红点防闪）

**问题**：尝试起点事件会把投影从 retry 拉回 busy——v1 时代是 `session.status`（processor
每轮尝试首行 `status.set({type:"busy"})`，往往零点几秒内失败回 retry，忠实投影红绿交替闪）；
v2.0.18 起 `session.status` 无发布者（design-sse-event-surface 表 C），同形态闪烁源变为
**REST 快照 busy 合并**（重连对账落在退避窗口内时）与 openbuilder 已跟进的
`step.started` 回落 busy 语义（design-session-retry-recovery 改动 2——本端**有意不跟进**，
见下）。锁存规则不变：保持到真实流式进展（首个内容 part）才恢复 busy。

**与 openbuilder 改动 2 的偏差裁定（2026-10-09）**：openbuilder/官方在 `step.started`
同 mid 重启时即回落 busy（红绿按尝试次数摆动，官方接受）；本端维持锁存到首个内容
part——快失败类错误整个重试期稳定红点，代价是重启后首 token 前（TTFB 窗口）仍示
「重试中」（信息仍准确：该尝试尚未产出）。依据与不变式见 design-session-retry-recovery
§3.5/INV-2。

**锁存规则**（app-store `retryHold: Set<sessionID>`，随 sessionStatus 生命周期）：

| 事件 | 锁存中行为 |
|------|-----------|
| `session.status` / REST 快照的 **busy** | 扣住不覆写（投影保持 retry/红）。REST 路径改写 busy→本地 retry 再合并——直接丢弃会触发 merge 的 covered⇒idle 分支误清退避状态 |
| `session.status` **retry**（attempt 递增） | 正常更新（重进退避窗口），锁存维持 |
| REST 快照 **retry**（未持有时） | **补建锁存**——重连对账落在退避窗口内的场景：SSE 断线期间进入退避，快照是首个 retry 来源，缺此半边则下一轮尝试起点的 busy 事件覆写造成一次绿闪 |
| **内容 part** 事件（text/reasoning/tool/subtask/patch…） | **解除锁存** + 恢复 busy（绿）——模型真实产出说明重试已成功。排除尝试起点伴随 part（step-start/snapshot）：它们每轮尝试都发，不构成进展信号 |
| **idle**（事件/快照缺席/快照 idle） | 解除锁存（终态） |
| 关项目/删工作区（purge）、disconnect teardown | 随状态一并卸载 |

**语义**：红 = "卡在重试循环、无有效进展"；绿 = "模型正在产出"。快失败类错误
（429/5xx，请求期即失败、无任何 part）整个重试期稳定红点；尝试成功产出首个内容
part 即恢复绿。中途失败类错误（已产出部分内容后断流）每轮仍会绿一下再回红——
无未来信息可区分，接受（比未锁存时的每轮必闪已大幅收敛）。

**副作用收益**：TypingSlot 的"重试中：{message}"提示同样保持整个退避+尝试窗口
（此前在途尝试的零点几秒会闪回三点 dots）。

### 3.7 不做的事

- **TypingSlot retry 呈现保持 outline 中性色**（design-typing-indicator §5 已决策"次级提示语义，
  复用 outline"），红色只进状态点，不双处示警。
- 不按错误 `name` 分级配色/文案（MessageAbortedError 同样入卡）——错误分类学无 server 契约
  保障，`action`（Go upsell 等）交互留后续版本。
- 不监听 `Session.Event.Error` 类 v1 遗留事件——消息级错误由 `session.step.failed`
  （2026-10-09 接入，design-session-retry-recovery）与 REST/缓存快照 `info.error` 覆盖。

## 4. 改动落点

| 文件 | 改动 |
|------|------|
| `src/shared/api-types.ts` | `NamedErrorShape`；`AssistantMessage.error` 改型；`RetryPart` + PartType/Part 联合 |
| `src/shared/message-error.ts`（新） | `extractErrorMessage` |
| `src/shared/session-status.ts` | `inferFailedFromMessages`（报错终局判定，§3.4） |
| `src/shared/pending-requests.ts` | `SessionDotState` 增 `"error"`/`"failed"`；`sessionDotState` 吃 status 类型 + 终局参数 |
| `src/renderer/src/store/app-store.ts` | retry part 消费；`dotStateFor` 报错终局纯派生；retry 保持锁存（§3.6） |
| `src/renderer/src/components/workspace.tsx` | 错误卡用 `extractErrorMessage`；Tab 状态点映射 session-* 变体 |
| `src/renderer/src/components/sidebar.tsx` | 会话指示点映射 session-* 变体；聚合 chip/标题增 error/failed |
| `src/renderer/src/i18n/index.ts` | `sessionIndicatorTitle` 增 `{error}`/`{failed}` |
| `src/renderer/src/styles/app.css` | `session-error`（红呼吸）/`session-failed`（红静态）/`session-waiting`（琥珀静态）变体共用 12px 盒 + `--session-dot-color`；`.session-count.error`/`.session-count.failed` |

## 5. 测试

- `message-error.test.ts`：NamedError 主路径/中止/多形态兜底/永不 `[object Object]`。
- `session-status.test.ts`：`inferFailedFromMessages` 中止排除/末条非 assistant 排除。
- `app-store.test.ts`（"报错消息与重试状态"）：retry part 丢弃（不传播/不入 parts/未知消息
  不建容器/既有终态错误无影响）、`dotStateFor` retry→error/busy→running/idle 链、
  保持锁存（busy 扣住/内容 part 解除/step-start 不解除/REST 快照改写与解除）、
  报错终局（failed 投影/中止不算/新末条消息自愈）。
- `app-store.test.ts`（"重试收敛"，design-session-retry-recovery）：退避期气泡独担、
  成功重放无 error 残留、连续重试最新错误、耗尽 `step.failed` 终态 + failed 红点闭环、
  壳未建丢弃、`step.started` 防漂移（不清终态/复位 tool-calls）。
- `pending-requests.test.ts`：retry 投影 error、idle+终局投影 failed，waiting 仍最高优先。
