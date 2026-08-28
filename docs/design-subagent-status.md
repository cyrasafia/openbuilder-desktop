# subagent 工作状态显示

## 背景

主 agent 通过 `task` 工具启动 subagent（子会话）。`task` 工具是一个特殊的 tool part：
- `part.tool === "task"`
- `part.state.input.subagent_type`：agent 类型（如 explore / general）
- `part.state.input.description`：任务描述
- `part.state.metadata.sessionId`：子会话 ID（运行后由 server 写入 metadata）

子会话（`Session.parentID` 指向父会话）与父会话共享同一 directory，因此其 SSE 事件
（`message.part.updated`、`message.updated` 等）**会通过现有事件闸门**（`isOpenedDirectory`）。
现有 store 的 `ensureConversation` 惰性累积机制（≤20 容器上限）天然接收子会话事件——
但此前无 UI 消费。

## 参考

- 官方 opencode app `session-ui/message-part.tsx` 的 task 工具渲染（`ToolRegistry.register("task")`）：
  显示 agent 名 + 描述 + spinner/完成图标，点击跳转子会话。**不内嵌子会话消息流**。
- `message-timeline.tsx:92` `taskDescription`：从父会话 tool part 的
  `state.metadata.sessionId` 匹配当前子会话 ID，提取 `input.description` 作为子会话标题。
- `message-timeline.tsx:591` `taskSession`：无 metadata.sessionId 时按 parentID +
  description + agent name 启发式匹配子会话（降级路径）。

本项目不做跳转（桌面端无子会话独立 Tab 需求），而是在主消息流中**内嵌展开**子会话消息流。

## 设计

### D1：展开/收起

`task` 工具的 ToolChip 替换为 SubagentPanel 组件：
- **收起态**：与现有 ToolChip 收起态同构——灰色填充 chip（`surface-container-highest`）
  + agent 名 + 描述 + 状态图标（spinner / ✓ / ✗）。点击 header 切换展开/收起。
- **展开态**：面板整体保持 chip 灰底（与消息区同宽），子会话消息流嵌入圆角矩形块——
  观感对齐工具 input/output 的 `.code-block`（`color-code-bg` 底 + `color-border` 边），
  内嵌模块与面板通过底色差自然分层。模块有**独立滚动**
  （overflow-y: auto，max-height: 400px），不随主消息流滚动。

### D2：子会话消息流渲染

展开时通过 `store.chatEntries(childSessionId)` 获取子会话消息列表，复用 `MessageBlock`
渲染每条消息。子会话消息流内不含乐观消息（子会话不接受用户输入）。

子会话消息在 SubagentPanel 内按正常排序展示（text / tool / reasoning 等 part 均渲染），
但 SubagentPanel 内的 ToolChip 不再嵌套展开子 agent（递归深度 = 1，server `subagent_depth`
默认 1 阻止 subagent 再起 subagent，无需 UI 防护）。

### D3：数据加载

子会话 ID 来源优先级：
1. `tool.state.metadata.sessionId`（running/completed 后 server 写入）
2. 降级：在 `sessionsByProject` 中按 `parentID === 父会话 ID` + `input.description`
   前缀匹配（参考 opencode `taskSession`）

首次展开时触发 `loadSessionMessages(childSessionId, directory)`（REST 快照）。
后续 SSE 事件已通过现有闸门自动累积到 `messagesBySession`，无需额外订阅。

子会话 directory = 父会话 directory（同 worktree），从 `findSession(childSessionId)`
或父会话获取。

### D4：状态显示

- **running/pending**：spinner + agent 名
- **completed**：✓ 图标 + agent 名 + title 摘要（`state.title`）
- **error**：✗ 图标 + agent 名 + error 摘要

### D5：独立滚动

SubagentPanel body 设置 `overflow-y: auto; max-height: 400px`，滚轮事件不冒泡到
主消息流（`onWheel` stopPropagation）。子会话消息流内的链接/代码块复制等交互正常工作。

- **宽度**：展开态与消息区同宽。面板渲染在 `.message-list-inner`（限宽 [600,800]+padding）
  内，`width: 100%` 即消息区内容宽，无独立 max-width 上限。
- **滚动条隐藏**：`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`，
  与 `.message-list` 同款（消息区滚动条本就隐藏，内嵌容器保持一致）。
- **贴底跟随**（ChatView 同构语义）：展开挂载即贴底；贴底时新消息/流式更新跟随
  （useLayoutEffect 置底）。上滚解除：wheel（deltaY<0）+ 键盘上滚键（ArrowUp/
  PageUp/Home/Shift+Space——body tabIndex=-1 可被点击聚焦，键盘滚动只产生
  scroll 事件，不清 pinned 则流式更新拉回底部，§7.14 同款教训）；只认 body
  自身聚焦的按键（焦点在可滚后代 pre.code-block 时按键滚的是内层，误清会让
  跟随静默停摆）。回底吸附带滞回（向下滚且距底 <8px 才恢复）。收起重置 pinned，
  再展开恢复默认贴底。

## 坑

- **metadata.sessionId 时序**：tool part 初始状态为 pending/running 时 metadata 可能
  尚无 sessionId。展开按钮在无 sessionId 时禁用（或降级到启发式匹配）。一旦 completed，
  metadata.sessionId 必定存在。
- **子会话未入 sessionsByProject**：`session.created` 事件到达时 `sessionsByProject`
  会记录子会话（按 projectID 归属，与父同 project），但左栏会话列表过滤掉 `parentID`
  非空的会话（`sessionsInDirectory` 等），子会话仅作内部数据存在。
- **容器上限豁免**：`ensureConversation` 对无 Tab 的会话最多累积 20 个容器。子会话无 Tab，
  但已在 `ensureConversation` 中豁免（`findSession(sessionID)?.parentID` 非空时不检查上限），
  防止 SSE 增量被拒导致展开后内容缺失。
- **REST 快照跳过**：首次展开时若 SSE 已累积子会话消息（`chatEntries.length > 0`），
  跳过 `loadSessionMessages` REST 拉取——避免冗余请求及其 idle 副作用对运行中子会话的误判。
- **加载 id 记录**（review R2-#1）：REST 触发以 ref 记录**已加载 id** 而非布尔——
  childSessionId 漂移（启发式命中在先 → metadata.sessionId 到达切换）时对新 id 重新
  触发；收起即重置，再展开是 REST 失败后的重试入口（面板无错误态渲染）。
- **启发式匹配局限**（已知取舍）：`findChildSession` description 前缀匹配不上时回退
  "该父会话最新创建的子会话"——父会话并发跑多个 task 工具时可能挂到别的任务的子会话
  （`metadata.sessionId` 权威路径不受影响）；同 created 并列时排序结果不稳定。