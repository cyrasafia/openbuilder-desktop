# 后台 shell 任务卡（对齐 design-subagent-background）

> 对齐 [`design-subagent-background.md`](design-subagent-background.md) 的呈现模型
> （入列消息 + 完成消息 + 常驻任务卡 + 查看/停止），把承载对象从异步子会话
> 换成 agent 后台 shell。移动端 openbuilder 无同类功能（design-background-notify
> 是系统通知/保活域，不是流内任务卡）——本设计是双端首次实现，判据全部来自
> wire 数据推导，移动端后续可按本文对齐。
>
> 2026-10-19 首版；2026-10-20 缺口修订——超时细分呈现、输出尾部 1MB 自限、
> 停止破坏性预告、信息丢失空态文案按因二分（见决策 5-8）。同日 review 修订
> （两条 non-blocking + 一 nit 全采纳）：尾部取数改两段式（server cursor 无
> 尾部语义、size 仅在响应内）、运行期增量缓冲截断（1MB 上限丢头部）、
> `ShellInfo` 扩字段清单明化。实现后 review 修订（2026-10-20，1 blocking +
> 2 non-blocking + nits 全采纳）见文末 Review 记录。
>
> 范围：agent 经 `shell` tool `background: true`（或前台转后台）派发的后台命令。
> **不含**用户 `!` 命令路径（session shell 端点——桌面端无此入口，见「不做的事」）。

## 背景

agent 跑长命令（dev server、构建）用 shell 工具 `background: true` 派发即返回，
命令在 server 后台跑。当前桌面端四处不可见（与 subagent 升格前同构）：

- **消息流无指示**：派发 part 瞬间转 completed（~30ms），承载不了运行态；完成
  synthetic（`source:"shell"`）被 synthetic 滤空 + 空消息守卫隐藏——两头都丢。
- **无任务卡**：后台命令不在 `runningBackgroundTasks`（那个只扫子会话）。
- **完成不可见**：见上，synthetic 被隐藏后无任何呈现。
- **不可停止**：无停止入口（中断父会话对后台 shell 是 no-op——它是独立进程）。

## 契约事实（v2.0.18 源码核实，`tool/plugin/shell.ts` / `shell.ts` / `shell/result.ts`）

| # | 事实 | 依据 |
|---|---|---|
| C1 | shell tool Input：`{command, workdir?, timeout?, background?}`；`background:true` 时 timeout 默认 0（永不超时），前台默认 120s | `Input` schema + execute 首行 |
| C2 | **派发即返回**：`background:true` → `jobs.background` + `notifyWhenDone` 挂起 → part completed，StructuredOutput = `{shellID, output:"Command moved to the background (shell ID: …)…", truncated:false, status:"running"}`；part metadata 另带 shellID（`toolResult`）。**`output.status === "running"` 是后台派发的持久判据**——前台正常完成是 `"completed"` | `backgroundResult` / `toolResult` |
| C3 | 前台转后台同款：他端 `POST /api/session/:id/background` → `jobs.block` 返回 `{type:"backgrounded"}` → `shell.timeout(id, 0)` + `notifyWhenDone` + 同款 `backgroundResult`。`input.background` 缺省（出生时是同步） | execute 260-267 |
| C4 | `context.progress({shellID})` 在 spawn 后立即发——SSE `session.tool.progress`（metadata 仅 shellID；**不持久化**，REST Running 态 metadata 为 `{}`） | `shell.ts:220` + subagent 设计同款事实 |
| C5 | **完成通知**：`notifyWhenDone` 等 job 终态 → `sessions.synthetic` + `ShellResult.notification`：metadata `{source:"shell", shellID, jobID?, state:"completed"\|"cancelled"\|"error", exit?, signal?, timeout?, truncated}`，text = `<shell id="…" state="…" command="…">…输出…</shell>`。**resume 缺省 true → `execution.wake` 唤醒父会话**（agent 自动恢复，与工具描述「you will be resumed automatically」一致） | `notifyWhenDone` / `result.ts` / `session.ts` synthetic |
| C6 | synthetic 走 inbox admission：SSE `session.inbox.enqueued`（item.type `synthetic`）+ REST 消息快照 `type:"synthetic"` 条目（metadata 同）——与 subagent 完成回执同构。桌面端 v2-adapter 已透传 info.metadata；synthetic text part 统一滤空 + 空消息守卫隐藏（原消息不渲染，无双份问题） | 既有 `isSyntheticTextPart` / `syntheticDroppedBySession` |
| C7 | REST 资源面：`GET /api/shell?location[directory]=`（**仅返回 `status==="running"`**——源码 list 过滤，非 running 不在列）；`GET /api/shell/:id`（exited 记录保留在内存 map——**FIFO 25 个 exited 淘汰最老**（`EXITED_LIMIT`），文件侧另有 7 天 `RETENTION` 清理）；`GET /api/shell/:id/output`（byte cursor 分页，**默认 limit 64KB，可传大值**；返回 `{location, data:{output,cursor,size,truncated}}`）；`DELETE /api/shell/:id`（terminate + remove：杀进程 + 删记录 + **删输出文件** + fail done）。**全部端点 location-scoped（2026-10-21 活体）**：缺 `location[directory]` 时 server 按默认 location 解析 → 恒 404——get/output/delete 必带 shell 所属目录 | `shell.ts` list/get/output/remove + 活体 curl（15120，2.0.26） |
| C8 | shell 资源 metadata 恒带 `{sessionID}`（父会话 id）——list 后按它过滤归属 | `shell.create` 调用点 `metadata: { sessionID: context.sessionID }` |
| C9 | `session.shell.started/ended` 事件**仅用户 `!` 命令路径**（session shell 端点）发；agent 工具路径不发——运行态无事件，只有 REST 轮询 + C5 synthetic | `session.ts:199-208`（review 于 2.0.28 复核仍成立，无漂移） |
| C10 | env 特带 `AGENT=1` / `OPENCODE=1` / `OPENCODE_SESSION_ID`（与本设计无直接消费，记档） | execute 213-216 |
| C11 | 终态收敛不依赖轮询实时性：自然退出 / 超时（status `timeout` → settled 带 `timeout:true`）/ 外部 kill 都走 job 终态 → C5 synthetic 恒发 | `notifyWhenDone` 挂 job.wait |

**DELETE（停止）行为推演（实现时活体复核）**：remove 使 `done` Deferred 以
`ShellNotFoundError` 失败 → job run 失败 → `notifyWhenDone` 的 `info.status === "error"`
→ synthetic `state:"error"`（完成消息呈「失败」而非「取消」样式）。落地时以实测
为准（若 server 后续把 kill 路径改走 `cancelled`，客户端只消费 state 不受影响）。

## 与 subagent 模型的映射

| 维度 | subagent（现状） | 后台 shell（本设计） |
|---|---|---|
| 承载对象 | 子会话（Session） | Shell 资源（`sh_`，无会话） |
| 认领 | part ↔ child **跨对象匹配**（metadata.sessionId / input.sessionID / desc 前缀兜底） | shellID **直挂 part**（output.shellID / metadata.shellID）——无跨对象匹配、无兜底、**无误插/撤回路径** |
| 运行态 | `session.execution.*`（子会话 busy）事件驱动 | **无事件**——REST list 轮询 + synthetic 终态（C9/C11） |
| 完成回执 | synthetic `source:"subagent"` | synthetic `source:"shell"`（同构，C5/C6） |
| 停止 | `POST /api/session/:id/interrupt` | `DELETE /api/shell/:id` |
| 查看 | 子会话消息流详情窗 | **输出流详情窗**（output 端点 cursor 分页） |
| started 重建 | 会话行 + 覆盖窗口 | part completed ∧ `output.status==="running"`（**持久载体**，②③终态后均可重建——优于 subagent，其③终态后不可重建） |
| 指示器 | `sessionActivity` 家族 BFS | `dotStateFor` 平行扩展（shell 不是会话树成员，不动 `sessionActivity`——它同时服务输入锁口径的边界） |

## 前端呈现

三消息 + 任务卡 + 详情窗，全部对齐 subagent 形态：

| | ② `background:true` | ③ 前台转后台 | 对照：前台 shell（同步） |
|---|---|---|---|
| 入列消息 | 「已启动后台命令：{command}」 | 「已转后台命令：{command}」 | — |
| 完成消息 | 完成/失败/取消（state 三态） | 同左 | —（结果在 chip 内联） |
| 任务卡 | ✓ 派发后入 | ✓ 转换后入 | ✗（part running 即 chip） |
| chip（tool part） | 派发记录留存 | 运行态→完成态 | 运行态 |

### 系统提示（notice 行）

- kind 复用 `background-started` / `background-converted` / `background-finished`
  三 kind（`NoticeRow` 不改结构）；文案新键组 `bgCmd*`（与 `bgTask*` 并列，
  「后台命令」与「后台任务」一词一义）。label = `input.command`（不截断存储，
  渲染侧 CSS 截断——通知行与任务行各自 `text-overflow: ellipsis`）。
- **超时细分呈现（缺口 #1，2026-10-20 补）**：shell 超时终态的 synthetic 是
  `state:"completed"` + `metadata.timeout === true`（C5）——直接归「完成」文案
  会误导。`SessionNotice` 增可选字段 `timedOut?: boolean`（**不动共用三态
  `BackgroundTaskState`**——subagent 无此语义，扩枚举会波及它的渲染与测试）；
  渲染：finished ∧ `state === "completed"` ∧ `timedOut` → `bgCmdTimedOut`
  文案 + `CircleAlert` 图标（与完成/失败/取消三图标并列第四分支）。
- 通知 id：启动 `bg-shell-start:<shellID>`、转后台 `bg-shell-convert:<shellID>`、
  完成 = synthetic 消息 id（与消息同 id 空间，SSE 与 REST 天然去重——同 subagent）。
- `SessionNotice` 增可选字段 `shellID?: string`（查看/停止入口；与 `childID`
  互斥不冲突——kind 相同但来源不同，渲染按有无 shellID 路由）。

### 常驻任务卡

- 条目模型从 `Session[]` 泛化为联合类型：

```ts
export type BackgroundTask =
  | { kind: "session"; session: Session }
  | { kind: "shell"; shell: ShellInfo; parentSessionID: string }
```

- `runningBackgroundTasks(sessionID)` 返回 `BackgroundTask[]`（子会话路径不变，
  追加该会话的 running shell）。`BackgroundTaskBar` 按 kind 分支渲染：
  - shell 行：label = `shell.command`；副行 = 已运行时长（`shell.time.started`
    起算，复用 1s ticker）——不带 agent 名（无此概念）。
  - 整行点击查看 / 行尾「停止」按钮 / `stopPropagation` / 键盘可达 / 规格对齐
    问题卡选项——全部沿用 subagent 2026-10-08 修订后的交互。
- 停止：`DELETE /api/shell/:id`（rest-client 新封装）。请求在途禁用同款。
  停止后收敛：synthetic（C11/C DELETE 推演）→ 完成消息 + 任务卡移除 + emit。
  **破坏性预告（缺口 #3，2026-10-20 补）**：DELETE 语义是杀进程 + 删记录 +
  删输出（C7），与 subagent 的 interrupt（保留消息流）不同——停止按钮的
  title / aria-label 用 `bgCmdStopDiscardWarning`（「停止并丢弃输出」）明示；
  **不做确认弹窗**（与 subagent 一键停止交互一致；破坏性经文案预告，不弹窗）。
- 卡头部计数 = 全部条目数（会话 + shell 混计）。

### 输出详情窗（ShellOutputPanel）

- 槽位与互斥逻辑同款：`.bg-task-slot` 内与任务卡互斥渲染，流内嵌入、推高消息区；
  Esc/× 关闭返回，列表展开态跨详情保留（复用 ChatView 受控态）。
- 头部：command（等宽、截断）+ 终态行（运行中 spinner；终态 `exit N` /
  `killed by SIGTERM` / `timed out`，从 Shell.Info 或 finished 通知 metadata 取）。
- 体：等宽 `<pre>` 纯文本（**不引 xterm/CodeMirror**——Keep Lean；ANSI 转义残留
  原样呈现，接受），自动滚底（用户上滚则停驻，同消息流惯例）。
- 数据（**两段式取数**——server cursor 是绝对字节偏移、无尾部语义，`size`
  仅在 output 响应内可得，`Shell.Info` 无 size 字段；review 2026-10-20 #1）：
  1. **首段探测**：`GET /api/shell/:id/output`（cursor 0，默认 limit 64KB）——
     响应带回 `size`，同时充作首屏；
  2. **补齐/转尾部**：`size ≤ 1MB` → cursor 续进拉完全量；`size > 1MB` → 丢弃
     已拉内容，以 `cursor = size - 1MB`、`limit = 1MB` 重拉**尾部**，头部常驻
     `bgCmdOutputTailOnly` 提示「仅展示尾部 1MB，已省略前 {bytes} 字节」。
  **不做「加载更多」上翻**——后台命令输出（构建日志/dev server）的关注点在
  尾部，上翻翻页交互复杂度收益不成比例（Keep Lean），需要全文的场景应由
  agent 落文件。
- 运行中每 2s 增量拉（cursor 前进，**仅详情窗打开时轮询**——不设全局 watcher）；
  synthetic 到达后补拉一次收尾。**运行期缓冲截断**（review 2026-10-20 #2）：
  增量追加使前端缓冲超过 1MB 时**丢头部保尾部**（与首拉口径一致），TailOnly
  提示行的「已省略字节数」累计更新——dev server 高输出长跑是本设计主场景，
  无上限累积会把几十 MB 文本灌进单个 `<pre>`（移动端「消息累积」已踩坑域，
  桌面端不重蹈）。
- **不可用空态——丢失原因二分（2026-10-20 补，缺口 #4/#5 的文案兜底）**：
  shell 已被停止（DELETE 删输出）或记录已失（server 重启清内存 / 7 天
  RETENTION 清理）→ `GET` 404。两因都 404，按「本端是否停止过」区分文案
  （store 记 `deletedShellIds: Set<shellID>`——`stopBackgroundShell` 成功即记，
  会话内存态，不持久化）：
  - 在集合 → `bgCmdOutputDiscarded`：「命令已停止，输出已丢弃」
  - 不在集合 → `bgCmdOutputGone`：「输出不再可用（服务器已重启或过期清理）」
  - 重开详情窗即重试（无永久错误态，同 subagent 详情窗加载探测语义）。
- 任务已结束后从完成通知「查看」进入：详情窗独立呈现（无卡可替代，同 subagent）。

### 指示器

`dotStateFor` 投影追加：该会话 running 后台 shell 非空 → 按 busy 点亮（Tab/左栏/
项目行）。**不进 `sessionActivity`**（会话树语义，且避免波及输入锁口径）——
composer 不锁输入、不出 typing dots（后台命令不是父会话在思考）。

## 实现方案

### 1. 判据与构造（session-notices.ts 扩展）

```ts
// part 判据：shell tool 后台派发/转换的持久识别（C2/C3）
shellBackgroundDispatchFromPart(part: ToolPart):
  | { shellID: string; converted: boolean }   // converted = input.background !== true（③）
  | undefined
//   = part.tool === "shell"
//     ∧ state.status === "completed"
//     ∧ (state.output.shellID ?? state.metadata.shellID) 存在
//     ∧ state.output.status === "running"      // 前台完成是 "completed"，天然排除

shellStartedNotice(shellID, command, created): SessionNotice   // id bg-shell-start:<id>
shellConvertedNotice(shellID, command, created): SessionNotice // id bg-shell-convert:<id>
shellSyntheticNotice(id, created, payload): SessionNotice | null
//   = payload.metadata.source === "shell" → finished 通知
//     state 经 normalizeBackgroundState（"error"→error，"cancelled"→cancelled，
//     其余→completed）；timedOut = metadata.timeout === true（超时细分呈现，
//     缺口 #1）；label = text 内 <shell command="…"> 标签（metadata 无
//     command 字段——C5，只在 text XML 里）?? shellID；shellID 透传（查看入口 +
//     任务卡终态过滤）
```

前台失败（`tool.failed`）无 shellID / output——判据不命中，天然不插；**无撤回
路径**（subagent 的 `withdrawForegroundStartNotices` 对 shell 不需要：插入判据
本身就是持久终值，无「先插后证伪」竞态窗口）。

### 2. REST 封装（rest-client.ts）

```ts
listShells(directory): Promise<ShellInfo[]>      // GET /api/shell?location[directory]=
getShellOutput(id, cursor?, limit?): Promise<{output, cursor, size, truncated}>
deleteShell(id): Promise<void>                   // DELETE /api/shell/:id
```

`runShell`（worktree 分支挂载）不动。

### 3. store 编排（app-store.ts）

- **SSE `session.tool.success`**（既有 handler 扩展）：shell 判据命中 →
  started（②）/ converted（③）通知；created = 事件信封时间（≈派发时刻）。
- **SSE `session.inbox.enqueued`**（既有 synthetic 分支扩展）：`source:"shell"` →
  `shellSyntheticNotice` 与 `subagentSyntheticNotice` 并列尝试（source 不同互斥）。
- **list 对账**（`reconcileShellTasks(sessionID)`，挂点 = 会话消息加载后 +
  `onMessagesSnapshot`（60s/重连）+ synthetic 到达后 + 停止请求后）：
  `listShells(directory)` → `metadata.sessionID` 过滤 → running ∧ ∉ 终态集
  （该会话 finished 通知的 shellID 集合）→ 更新 `runningShellTasks(sessionID)`。
  竞态处理：synthetic 先到（list 尚含）→ 终态集过滤；list 先无（synthetic 未投）
  → 任务卡暂失、下一拍 synthetic 补完成消息（与 subagent「转换后瞬间完成」同节拍）。
- **通知重建**（挂 `mergeMessagePage` / `onMessagesSnapshot`，subagent 三 reconcile
  同点并列）：覆盖窗口内逐 part 跑 `shellBackgroundDispatchFromPart` → started/
  converted 直推（id 幂等；created 取 part completed 时间，live 骨架值经一次对账
  校正——同 subagent 第八轮 #1 口径）；synthetic 条目跑 `shellSyntheticNotice`
  （REST 抽取，按消息 id 去重）。窗口下界 = 最早已加载消息 created（同 subagent）。
- **`runningBackgroundTasks` 泛化**：返回 `BackgroundTask[]`（子会话逻辑不变）。
- **`stopBackgroundShell(shellID)`**：`deleteShell` → 成功后记入
  `deletedShellIds`（空态文案二分依据）→ 触发 list 对账刷新。
- 清理挂点：`cleanupSessionState` / `teardownConnection` 清 shell 缓存与
  `deletedShellIds`（通知表走既有清理）。

### 4. 组件（workspace.tsx）

- `BackgroundTaskBar` 泛化 `BackgroundTask[]`；行渲染/动作按 kind 分支；shell
  停止钮 title/aria-label 用 `bgCmdStopDiscardWarning`。
- 详情路由：`onOpenDetail(id)` 按 id 前缀分流（`sh_` → ShellOutputPanel，
  否则 TaskDetailPanel——subagent 的 childID 路由不动）。
- `ShellOutputPanel` 新组件（受控开关挂 ChatView，同款互斥/Esc/展开态保留）：
  尾部 1MB + `bgCmdOutputTailOnly` 头部提示、404 空态按 `deletedShellIds`
  二分文案。
- `NoticeRow`：kind 不变，文案按 `notice.shellID` 有无切 `bgCmd*` 键；finished
  增第四分支（completed ∧ timedOut → `bgCmdTimedOut` + `CircleAlert`）。

### 5. i18n / 样式 / spec

- `bgCmdStarted/Converted/Completed/Failed/Cancelled/TimedOut/View/Stop/
  StopDiscardWarning/ExitCode/KilledBy/OutputTailOnly/OutputDiscarded/
  OutputGone` 中英。
- app.css：输出窗（等宽、滚底、终态行、尾部截断提示行）+ shell 任务行复用
  既有 `.bg-task-row`。
- `docs/spec/spec-v0.5.md` 功能范围表 #10 扩写 + 验收清单追加（实现时同步）。

## 场景验证

| 场景 | 预期 |
|---|---|
| ② 派发（dev server） | 「已启动后台命令」即插；任务卡入列（时长走表）；父会话 Tab 点亮；chip 派发记录留存 |
| ② 完成 | 完成/失败消息（state 三态）；任务卡移除；指示器随空熄灭 |
| ② 超时（timeout:true） | 「后台命令超时」文案 + `CircleAlert` 图标（缺口 #1）；详情窗终态行 TimedOut |
| ③ 他端转后台 | 前台 chip 运行中 → 转换后「已转后台命令」+ 任务卡入列 |
| 前台（同步）运行 | 无通知无任务卡；chip 运行态；composer 停止可取消（不变） |
| 任务行点击 | 输出详情窗替代任务卡（Esc/× 返回，列表保持展开）；运行中 2s 增量滚底 |
| 停止 | DELETE（按钮 title「停止并丢弃输出」）→ in-flight → synthetic 收敛完成消息 → 卡移除；再查看落「命令已停止，输出已丢弃」 |
| 输出 > 1MB | 首拉探测后转尾部重拉；头部常驻「仅展示尾部 1MB，已省略前 N 字节」；不做上翻 |
| 高输出长跑 + 详情窗长开 | 增量追加超 1MB 丢头部保尾部；TailOnly 提示累计更新（review #2） |
| SSE 缺口吞 success | 对账窗口内 REST 重建 started/converted（part 持久判据） |
| 重启/重开 Tab/60s 对账 | started/converted/finished 三类通知全量重建；任务卡按 list 重建 |
| server 重启后查看输出 | 404 → 空态「输出不再可用（服务器已重启或过期清理）」（非本端停止，走 Gone 文案） |
| 7 天清理后查看输出 | 同上（Gone 文案） |
| 后台命令运行 + 用户发消息 | 不受阻（父会话不锁输入）；完成 synthetic 唤醒 agent（C5，server 侧行为） |

## 关键设计决策

1. **判据单点化**：`output.status === "running"`（C2）既是 live 插入判据也是
   REST 重建判据——同一持久终值，无 subagent 的「先插后证伪」竞态，撤回路径
   整体不需要。
2. **运行态轮询最小化**：不给 shell 状态建常驻轮询——打开会话/60s 对账/
   synthetic 后/停止后四个挂点拉 list；时长显示走本地时钟。终态收敛由 synthetic
   事件驱动（C11 保证恒发），list 只兜底任务卡归属。
3. **不动 `sessionActivity`**：shell 非会话树成员；指示器在 `dotStateFor` 投影
   层平行扩展，输入锁口径零波及。
4. **输出窗不引终端栈**：纯 `<pre>`。xterm 是交互终端的栈（回放/应答闸门全套
   复杂度），只读输出用不上（Keep Lean）。
5. **停止即删输出**（C7）接受并预告：按钮文案明示「停止并丢弃输出」，不弹
   确认（与 subagent 一键停止一致）；丢弃后的查看落 Discarded 空态。
6. **丢失文案按因二分**（2026-10-20 补）：同为 404，本端停止过 →「输出已丢弃」
   （确定因），否则 →「服务器已重启或过期清理」（推测因）——`deletedShellIds`
   会话内存态够用，不持久化（客户端重启后信息本就丢失，统一走推测因）。
7. **输出只保尾部 1MB**（2026-10-20 裁定；review #1/#2 修订为两段式 + 运行期
   截断）：首段探测取 size，超限转尾部重拉；运行期增量追加超 1MB 丢头部——
   首拉与缓冲同一上限，陈述与机制一致。不做上翻翻页；需要全文的场景应由
   agent 落文件后走文件视图。
8. **timeout 不动共用 state 枚举**（2026-10-20 补）：`timedOut` 独立字段 +
   渲染第四分支，`BackgroundTaskState` 三态保持 subagent 语义不变。
9. **type:"shell" 消息（他端 `!` 命令）不渲染**：桌面端无 `!` 入口，事件面
   （`session.shell.*`）与消息条目都不接——留待 session shell 端点接入时统一设计。

## 已知限制 / 坑

- **DELETE 后 synthetic 的 state 实测待验证**（C11 推演 error；若 server 语义
  调整，客户端只消费 state 不改代码）。
- **`output.status` 字段名依赖**：C2 的 StructuredOutput 是 server 工具层包装，
  非公开契约 schema——升级 pin 后按活体复核（同 subagent 对 metadata 形状的
  活体核对惯例）。
- **list 仅 running**（C7）：历史 shell 盘点不可行；「已完成但 synthetic 未投」
  窗口内任务卡暂失（下一拍补完成消息）。
- **③终态后 converted 通知可重建**（part 判据持久），但 created 只有 part
  completed 时间（≈转换时刻，毫秒级偏差）——接受。
- **输出 ANSI 转义原样呈现**：不做着色/清洗。
- **多端并发**：他端 DELETE 后本端任务卡最长 60s 对账才移除（无事件）。
- **`deletedShellIds` 二分的误判面**：他端停止（非本端）的 404 走推测因文案
  （「服务器已重启或过期清理」）——文案含「或」，不构成错误陈述；接受。
- **`session.shell.started/ended`（用户路径）不接**：他端 `!` 命令在本端打开的
  会话只有 finished 通知（synthetic REST 抽取命中 `source:"shell"`）而无 started
  ——呈现不对称，随决策 9 一并留待后续。

## 不做的事

- 不做 `!` 命令输入入口（session shell 端点）与 `type:"shell"` 消息渲染。
- 不做 shell 状态常驻轮询 / SSE 模拟事件。
- 不做「停止全部」/批量停止。
- 不做输出搜索、复制增强、xterm 渲染。
- 不把 shell 任务并入 `sessionActivity` 家族聚合。

## 实现影响（文件清单）

| 文件 | 内容 |
|---|---|
| `src/shared/session-notices.ts` | `shellBackgroundDispatchFromPart` 判据、`shellStartedNotice` / `shellConvertedNotice` / `shellSyntheticNotice`（含 `timedOut` 解析）、`SessionNotice.shellID` / `timedOut` 字段 |
| `src/shared/session-notices.test.ts` | 判据（②③/前台完成/failed 排除）、构造、synthetic 解析（state 归一/timedOut/label 兜底链）用例 |
| `src/shared/api-v2-types.ts` | `ShellInfo` 扩字段：现仅 `{id, status, exit?}`，必增 `command`（任务行 label）、`time.started`（时长起算）、`metadata.sessionID`（归属过滤）、`signal` / `time.completed`（详情窗终态行）——对照 wire schema `Shell.Info`（review nit） |
| `src/shared/rest-client.ts` | `listShells` / `getShellOutput` / `deleteShell` |
| `src/renderer/src/store/app-store.ts` | `BackgroundTask` 联合、`runningBackgroundTasks` 泛化、`runningShellTasks` + `reconcileShellTasks`（四挂点）、SSE success/inbox 扩展、通知重建并列、`stopBackgroundShell` + `deletedShellIds`、`dotStateFor` 扩展、清理挂点 |
| `src/renderer/src/components/workspace.tsx` | `BackgroundTaskBar` 泛化（shell 停止钮 DiscardWarning title）、`ShellOutputPanel`（尾部 1MB 提示/404 二分空态）、详情路由（`sh_` 前缀分流）、`NoticeRow` 文案分支（含 timedOut 第四分支） |
| `src/renderer/src/components/workspace-bg-task.test.tsx` | shell 任务行交互（点击查看/停止/互斥/Esc）、输出窗两段式取数/增量/缓冲截断/空态二分回归 |
| `src/renderer/src/styles/app.css` | 输出窗、终态行与尾部截断提示行样式（任务行复用 `.bg-task-row`） |
| `src/renderer/src/i18n/index.ts` | `bgCmd*` 键组（含 TimedOut/StopDiscardWarning/OutputTailOnly/OutputDiscarded/OutputGone）中英 |
| `docs/spec/spec-v0.5.md` | 功能范围 #10 扩写 + 验收清单 |

## Review 记录

### 第一轮（2026-10-20，设计评审）

结论：可合入。两条 non-blocking + 一 nit 全采纳（两段式取数 / 运行期缓冲
截断 / ShellInfo 扩字段清单，见决策 7 与详情窗节）；2.0.28 上 C9 复核无漂移。

### 第二轮（2026-10-20，实现后 reviewer 子代理审查）

结论：需修订→已修订。1 blocking + 2 non-blocking + nits 全处置：

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | 🔴 | ShellOutputPanel 双闭包竞态：输出闭包结尾无条件 `setPhase("done")` 覆盖状态闭包的 `running` → 2s 增量永不启动（主场景失效且静默） | 改函数式更新 `setPhase(p => p === "running" ? "running" : "done")`；补「info 先回 running、output 后回仍 running」回归测试 |
| 2 | 🟠 | SSE 缺口下 success 的 state.input 是原始 JSON 字符串 → ②误判③且无撤回（bg-shell-convert 与 REST 重建的 bg-shell-start 并存） | 双修：判据函数对字符串 input 尝试 JSON.parse；live 挂点（onShellToolPartSettled）input 非对象**不插**——误插源头消除，缺口序交 REST 对账重建（快照 input 恒为 parsed 对象）；补缺口序不插测试 |
| 3 | 🟠 | loadShellOutput/loadShellInfo 一切错误归 null → 断网也落「服务器已重启」误导文案 | 404（`ApiError.kind === "not-found"`）才归 null；其他 rethrow，组件维持加载态（重开重试） |
| 4 | 🟢 | 全量补齐 while 无进展守卫（server 读流出错 cursor 不前进 → 死循环） | `if (page.cursor <= cursor) break` |
| 5 | 🟢 | setOmitted 在 setText updater 内（StrictMode 双调用 omitted 双计） | textRef 镜像 + applyOutput 纯函数化，副作用移出 updater |
| 6 | 🟢 | 停止后对账挂点缺失（设计四挂点 vs 实现三处）；终态行在滚动体内随滚动离开视口；killed 无 signal 落「退出码 0」误导 | stopBackgroundShell 尾部补 reconcileShellTasks；终态行移 header 下固定区 + running spinner 行；`bgCmdKilled` 单列文案 |
| — | 附注 | 首拉 first.output 漏入缓冲（#1 修复重构引入，测试抓住） | applyOutput(first.output) 补齐 |

### 第三轮（2026-10-21，实测发现的缺陷修复）

**现场**：测试包实测——启动/完成消息、任务卡均正常，**输出详情窗看不到内容**。

**根因**（活体 curl 15120 定位）：`/api/shell/:id`、`/:id/output`、`DELETE /:id`
都是 **location-scoped** 端点——缺 `location[directory]` query 时 server 按默认
location 解析，shell 不在 → 恒 404 → 输出窗落 Gone 空态。实现里只有 `listShells`
带了 location（任务卡因此正常），get/output/delete 三个端点全漏——C7 契约事实
当初只从源码读参数表、未核对 scoped 语义，活体补记（上表已修订）。

**修复**：三端点签名加 `directory` 必填参数并拼 `location[directory]` query；
`loadShellOutput` / `loadShellInfo` / `ShellOutputPanel` 透传（ChatView 从
`findSession(sessionID).directory` 供给）；`stopBackgroundShell` 内部解析目录。
store 测试断言 DELETE 携带目录钉住契约。

**顺带活体修订**：exited 记录保留 = 内存 map FIFO 25 个（超限淘汰最老）∩ 文件
7 天清理——比原「7 天」表述先到期的是 FIFO；get/output 响应为 `{location, data}`
envelope（data 内即 Shell.Info / Shell.Output，与实现解析一致）。
