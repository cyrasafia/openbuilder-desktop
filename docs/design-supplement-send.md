# 会话进行中补充发送（supplement send）— 设计文档

> 目标：会话进行中（busy/retry）允许继续在输入区发送消息；消息以**补充**形式进入当前 run——**不打断**正在生成的回复，**不排队**为独立轮次。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：
> - `openbuilder/lib/features/conversation/conversation_screen.dart` `_send()` —— **无 busy 守卫**，busy 中直接 `client.prompt`（行 1240 起）；compose bar `showStop = busy && ctl.text.isEmpty && pending.isEmpty`（行 4181）——有输入即回到发送
> - `openbuilder/docs/review-optimistic-messages.md` OL 观察——"compose bar 未在 POST 进行中禁用发送，弱网下连发可达"：移动端事实上早已支持并发发送，乐观消息机制按此设计
> - 本仓库 `message-merge.ts` sortEntries 注释预留："若未来放开并发发送，乐观按时间序排其下"——本次放开即其预言路径，比较器无需改动

## 1. 需求

- busy/retry 期间输入区保持可用：可打字、可发送；
- 发送语义 = 补充：不 abort 当前 run、不产生"等当前结束后自动再跑一轮"的客户端排队；
- 补充气泡出现在进行中回复**下方**，视觉时序正确；
- 停止（abort）入口在补充输入期间不丢失。

## 2. 服务端契约（联调实测 + 源码核对）

实测环境：本机 opencode server `127.0.0.1:15120`，测试脚本 `/tmp/opencode/test_supplement.py`（两场景，会话即测即删）。源码核对：`../opencode`（v1.18.13）`session/prompt.ts`、`session/run-state.ts`、`effect/runner.ts`、`session/message-v2.ts`。

### 实测时间线

场景 A（首条 prompt 触发 read 工具，busy 中途发补充）：

```
user  U1 (Read note.txt …)
assistant A1 finish=tool-calls   tools=[read]     ← run 第 1 步
user  U2 (SUPPLEMENT: 词数统计)                    ← busy 中发送，server 立即落库
assistant A2 finish=stop          ← 同一 run 续轮，回答同时覆盖 U1 与 U2（含词数）
```

场景 B（首条 prompt 纯文本长流式，无工具，busy 中途发补充）：

```
user  U1 (Count 1..120)
assistant A1 finish=stop          ← 首轮流式输出（补充到达于流式中途）
user  U2 (SUPPLEMENT: … say DONE)
assistant A2 finish=stop          ← run 未退出，续轮回应补充
```

两场景 status 全程 busy（无 busy→idle→busy 抖动），补充均被回应。

### 源码依据（为什么"不打断、不排队"成立）

| 事实 | 源码 |
|---|---|
| `POST prompt_async` 在 busy 时**不报错**：handler 无 assertNotBusy；`prompt()` 先 `createUserMessage`（立即落库 + SSE 广播）再 `loop()` | `server/.../handlers/session.ts` `promptAsync`；`session/prompt.ts` `prompt` |
| `ensureRunning` 在 Running 态只 `awaitDone`（合并等待），**新 runLoop 不启动、不排队**；也绝不 interrupt 在跑的 fiber | `effect/runner.ts` `ensureRunning` |
| run loop 每轮迭代**重读全量消息**；退出条件含 `lastUser.id < lastAssistant.id`——补充 user 的 ULID id 大于进行中 assistant 的 id ⇒ 条件不成立 ⇒ **loop 续轮**，下轮 `toModelMessages` 天然带上补充 | `session/prompt.ts` `runLoop` 顶部；`session/message-v2.ts` `latest()`（max-id 语义） |
| 每轮迭代顶部 `status.set(busy)` ⇒ 补充被吸收期间状态连续 | `session/prompt.ts` `runLoop` |

### 已知边界（接受，不客户端补偿）

- **blocked/error 收尾不续轮**：当前轮因权限拒绝（`ctx.blocked`）或错误结束时 `result === "stop"` ⇒ run 退出 idle，已落库的补充**留存历史但不被本轮回应**（下次任何 prompt 的上下文都会带上它）。频率低；客户端不伪造排队去"补答"（违背"不排队"语义）。
- **abort 竞态**：补充发送与用户点停止几乎同时时，补充可能已落库而 run 被停——同上，留存历史。
- **跨版本**：以上为 v1.18 行为；旧版 server 若 `prompt_async` busy 时报错，`sendPrompt` 的 catch 会撤回乐观并提示（降级安全）。

## 3. 客户端改动

### 3.1 `workspace.tsx` ChatView

- `send()` 移除 `busy` 守卫（`!text` 之外的拦截清空）；
- composer 按钮区：
  - busy ⇒ **停止按钮常驻**（与移动端 `showStop` 输入即隐藏不同——桌面空间足够，保留停止入口：补充输入中途仍可直接终止 run，无需清空草稿）；
  - 发送按钮：idle 恒在（空草稿禁用，原状）；busy 时**有草稿才出现**（空输入无发送语义，维持只显示停止）。

### 3.2 `app-store.ts` sendPrompt

一处守卫新增：乐观 busy 写入改为**仅 idle 时生效**（原无条件写）。原本 idle→busy 场景幂等无害，但本项放开了 retry 中发送——retry 态被覆写成 busy 会让 TypingSlot 丢掉退避提示（attempt/message），而 server 每个 backoff 窗口只发一次 retry 事件，错误指示将持续整个退避期。busy 态本就无需写（幂等）。

### 3.3 排序（`message-merge.ts`）

比较器**零改动**——v0.1 实现时已为并发发送预留：

- 乐观补充锚定 `maxCreated+1` ⇒ 排活跃流式 assistant **之下**（乐观→真实替换无位置跳变）；
- 真实补充 user 消息 `created` 晚于进行中 assistant ⇒ 同样排其下；后续回应 A2 `created` 更晚 ⇒ `U1 < A1 < U2 < A2` 视觉时序正确（新增回归用例锁定）。

仅更新 sortEntries 注释（"不可达"→"已放开"）。

### 3.4 斜杠命令

同样放开（`POST /command` 服务端同样走 `prompt()` 路径，busy 中 = 补充语义；subtask 类命令的 subtask part 由 run loop 的 `tasks` 机制在续轮消费）。不特判。

## 4. 不做的东西

- **不做客户端排队/延迟重发**：server 已定义补充语义，客户端再排队会产生双答（server 续轮 + 客户端重发）；
- **不做 busy 专属占位文案/按钮样式**：移动端无此区分，语义由行为本身表达（发送后气泡出现在流式下方 + 回复内容合并回应）；
- **不做逐条乐观配对清除**：沿用"任何真实 user 事件到达即清全部乐观"（移动端 `removeOptimisticMessages` 同语义）。多条补充在途时，首条真实消息到达会短暂清掉后续乐观气泡（通常 <1s 内其真实消息到达补位）——已知轻微闪烁，接受（用例锁定该语义）。

## 5. 测试

- `message-merge.test.ts`：补充 user（created 晚于活跃流式）排流式之下、与其后回应同序；
- `app-store.test.ts`「busy 补充发送」：
  - busy 中 `sendPrompt` ⇒ 乐观追加于流式之下、状态保持 busy；真实 user 事件到达 ⇒ 乐观清空、消息入列；
  - 多条乐观并存 ⇒ 首条真实到达清全部。

## 6. 验收（同步 spec-v0.1）

见 spec-v0.1 验收口径新增条目：不打断、无排队轮次、气泡位置正确、停止可达。
