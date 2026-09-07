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
- **stopped**（2026-09-07 修订）：✗ 图标 + agent 名 + 描述摘要 + aria「已停止」

**停止投影**（2026-09-07 修订）：`part.state.status` 的 pending/running 不是可信的
进行中信号——server 对中断的 task part 可能**永远不写终态**（API 契约事实，同
design-v0.1-implementation「中断消息 completed 恒 null」：实测本机 server 多个
父会话的 task part 卡 `status:"running"` 数周，父消息无 finish/completed/error，
而子会话早已结束）。投影规则：

```
running = part.status ∈ {pending, running} 且 (父会话活跃 或 子会话活跃)
stopped = part.status ∈ {pending, running} 且 父/子会话均 idle（无 sessionStatus 条目）
```

活跃 = `sessionStatus` 有条目（busy/retry，`isSessionActive`）。判据依据：

- task 工具在父会话 prompt 循环内同步执行——part 真在跑时父会话必为 busy；
  父会话 idle 而 part 卡 running 只可能是中断残留（abort 后 server 未回写终态）
  或历史僵死数据（重开旧 Tab，无状态事件可等）
- 子会话活跃作为并集判据兜底：父条目瞬时缺失（冷启动/重连对账窗口）而子会话
  确在跑时不误报停止；快照合并后父条目恢复，投影自愈
- 已知瞬态取舍：断连期间 `sessionStatus.clear()` 会让真跑着的 subagent 短暂显示
  停止，重连对账后恢复——与 typing dots 断连消失同语义，可接受
- 已知瞬态取舍（对偶窗口）：中断残留的 part 在父会话发起**下一轮 prompt** 期间会
  重新转圈（投影只看父会话 busy 与否，无法区分"本轮在跑"与"上轮残留"），新轮
  idle 后回停止样式。纯外观、自愈，且无 per-part 状态可区分，不做修复

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

### D6：子会话报错上浮与待处理请求路由（2026-09-07 二次修订）

**报错上浮**：subagent 的实际报错只落在子会话末条 assistant 的 `error` 上——
task part 可能同停止投影一样永卡 running 不回写（同批实测数据：卡 running 的
part 对应子会话末条 assistant `error: true`）。SubagentPanel 收起态直接消费：

- 末条 assistant 带非中止 error（`name !== "MessageAbortedError"`，与
  `inferFailedFromMessages` 同口径）→ ✗ 出错样式 + 报错文案（120 字截断），
  优先于 running/stopped（子会话报错即终局）；中止不算报错，保持已停止样式
- **retry 门控**：子会话活跃（busy/retry）期间挂起提取——退避窗口里失败尝试
  的末条 assistant 恒带 error，不门控会在 ✗/转圈间按重试轮次闪动
  （`dotStateFor` 的「busy/retry 期间跳过终局派生」同口径）；活跃期结束后
  终局自现。卡 running 的目标场景子会话必 idle，不受门控影响
- 冷开旧会话时子会话消息未经 SSE 累积、无报错文本来源 → stopped 且无内容时
  按子会话 id 一次性 REST 补拉（独立 ref，不与展开路径互扰；展开仍是失败重试
  入口）。loadSessionMessages 的 idle 副作用对停止态子会话无害（finish 推断
  只认终态，卡死数据无终态不触发）

**待处理请求路由**：子会话（subagent）工具触发的授权/问题请求挂在**子会话 ID**
上（`pendingPermissions`/`pendingQuestions` 以 sessionID 为 key），而子会话无
ChatView——请求原本无处展示，subagent 静默阻塞。路由规则（openbuilder 无先例，
本仓库首次约定）：

- 父会话 `ChatFooter`：自身请求优先，其次并入 `childPermissionFor` /
  `childQuestionsFor`（按 `findSession(sid).parentID === 父会话 ID` 匹配）；
  授权仍优先于问题（仅显示优先，queueTotal 计数含被授权卡遮蔽的问题——原
  语义不变）。应答走请求自带 sessionID/directory（`respondPermission`
  路由不变），卡片 UI 不变——上方 SubagentPanel 的转圈即上下文
- `pendingCountFor`（父会话）计入子会话待处理 → Tab/左栏指示器 waiting 点亮
- 并发多 subagent 同时请求取首个命中（短窗口，不排队区分）

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
- **中断 part 永卡 running**（2026-09-07，D4 停止投影的动因）：用户停止父会话后
  server 取消子会话，但父消息的 task part 可能不回写终态（半截消息，completed
  恒 null）——UI 只看 `part.state.status` 会永久转圈。修复 = D4 停止投影
  （父/子会话均 idle 时按已停止渲染）。openbuilder 移动端同源设计未覆盖此坑
  （其 D4 无停止态），后续移动端如修可参考本投影。
- **子会话报错无处可见 / 授权静默阻塞**（2026-09-07，D6 的动因）：同批卡 running
  数据中子会话末条 assistant `error: true`——报错只在展开面板滚到底才可见；
  授权/问题请求挂子会话 ID，子会话无 ChatView，请求根本不显示、subagent 无限
  等待。修复 = D6 报错上浮 + 待处理请求路由到父会话。