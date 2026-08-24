# v0.1 实现方案（通信层 + 状态层 + UI）

> 对应 [spec-v0.1.md](./spec-v0.1.md) 与 [design-layout.md](./design-layout.md)。
> 本文记录落地时的关键实现决策与联调中发现的契约事实。参考移动端：
> design-sse-reconnect-recovery、design-message-accumulation、design-optimistic-messages、
> design-sort-order-race、design-incremental-reconcile、design-network-error-handling。

## 1. 工程结构

```
src/
├─ main/            # Electron 主进程（TS，ESM）
│   ├─ index.ts     # 窗口 + Wayland 参数（ozone-platform-hint=auto + enable-wayland-ime）
│   ├─ ipc.ts       # store:get/set（JSON 持久化 userData/store.json）、managed server、对话框
│   └─ managed-server.ts  # 发现 PATH 的 opencode → 随机端口 spawn → 健康等待 → will-quit 清理
├─ preload/index.ts # contextBridge 暴露 window.desktop（ESM .mjs，Electron 43）
├─ shared/          # renderer 与 preload 共享（无 electron 依赖，纯 TS）
│   ├─ api-types.ts       # openapi 契约手写最小子集
│   ├─ rest-client.ts     # fetch 封装（basic auth + directory query + 错误分类）
│   ├─ sse-subscriber.ts  # SSE 订阅器（重连状态机）
│   ├─ message-merge.ts   # 排序/合并（竞态防护）
│   └─ reconciler.ts      # 对账引擎
└─ renderer/src/
    ├─ store/app-store.ts # 一体化状态层（外置 store + subscribe/emit）
    ├─ components/        # sidebar（含服务器状态行）/ workspace / file-panel / settings-dialog
    └─ styles/            # tokens.css（视觉令牌唯一权威）+ app.css
```

- 无状态管理库：单一 `AppStore` 类 + `useSyncExternalStore` 风格订阅（app.tsx 里 force-render），
  React 19 下 `messagesBySession` 等按 sessionID 分 Map，避免全列表重渲染的路径在 store 层就分开
- 别名 `@shared/*`（tsconfig paths + vite alias 双配置）

## 2. 联调发现的契约事实（openapi.json 之外的增量）

以运行中的 server 1.18.20 实测（这些写进了代码注释）：

| 事实 | 影响 |
|---|---|
| CORS 对 `http://localhost:*` / `127.0.0.1:*` 无条件放行（含 Authorization preflight） | renderer 直连可行，D4 成立 |
| `POST /session/{id}/message` 同步等待整个回复，长回复必超时 | 改用 `POST /session/{id}/prompt_async`（立即空响应，回复走 SSE） |
| `GET /file/content` 返回 `{type:"text", content:string}` 包装对象，非裸文本 | rest-client 解包 |
| `POST /experimental/workspace` 的 `type` 契约不可用（400） | 工作区改用 `/experimental/worktree`（与移动端同源） |
| worktree 列表的真实数据源是 `Project.sandboxes`（directory 数组）；`GET /experimental/workspace` 对 worktree API 创建的目录返回空 | 工作区列表从 sandboxes 派生 |
| `?workspace=` 参数（wrk id 体系）传 worktree directory 会 500 | worktree 过滤是**纯客户端行为**：`session.directory === worktreeDir`（同移动端） |
| `GET /session?directory=X` 为 directory **精确匹配**：项目根查询不返回 worktree 会话（实测根快照 28 条全为根会话） | 会话快照逐目录拉取（项目根 ∪ sandboxes）；快照合并按 directory 分域（session-merge.ts） |
| `GET /session`（server 源码 `V2Session.list` 核实，2026-08-24）：① 列表**含 archived 会话**（无归档过滤条件）② 按 `created desc` 排序 + `limit` 分页（不传默认 50，首页空 = 全表空）③ 单次快照可能截断 | ① 空≠全被归档：store 空快照清除本地同目录会话是安全的（applySessionsSnapshot）② "不在快照 = 已删除"不成立：merge 层维持 updated 开区间窗口保守删除 ③ 目录会话 >50 时窗口误删风险（旧会话落窗口内）为已知限制 |
| Electron renderer 的 `fetch` 是绑定 window 的包装，`const f = fetch; f(...)` 抛 `Illegal invocation` | rest-client 必须 `fetch.bind(globalThis)` |

## 3. 通信层

### REST（rest-client.ts）

- `RestClient`：baseUrl 尾斜杠归一、可选 basic auth、`AbortSignal.timeout`（默认 15s，health 5s，文件 30s）
- 错误分类 `ApiError{status, kind}`：401/403→auth、404→not-found、≥500→server、AbortError→timeout、TypeError→network；
  **不暴露响应体**（可能含密钥，同移动端 friendlyError 原则）
- `directory` 走 query 参数（`?directory=<abs>`），所有目录级 API 统一 `dirQuery` helper

### SSE（sse-subscriber.ts）——移植移动端 design-sse-reconnect-recovery

- 每个打开项目一条订阅：`GET /event?directory=<dir>`；打开集合变化 = 全组重建
- 重连状态机：退避 `1→2→4→8→16→30s`（clamp 30）；**建连总超时 15s**（覆盖 TCP 挂起）；
  **心跳静默 60s 判死**（5s tick 看门狗主动断开）
- `reconnectNow()` 无条件 kick：重置退避 + 置 kick 标志；退避睡眠是 200ms 可中断轮询；
  connecting 态被 kick 直接掐掉重建（lost-kick 防护）
- 事件解析只认 `data:` 行（server 只发 data 帧，实测确认）；坏 JSON 丢弃不炸
- 原生 EventSource 不支持 Authorization header → 自写 fetch 流解析（fetch-stream shim）
- `reconnecting→connected` 转换触发 `onReconnected` → 对账

### 对账（reconciler.ts）——移植 design-incremental-reconcile

- 触发：SSE 重连成功（debounce 800ms 合并）
- 内容：每个订阅目录（scope ∪ 打开项目根，见 7.5 #9）`GET /session`（directory 精确匹配）+ 每个**打开的 chat Tab** `GET /session/{id}/message?limit=100`（窗口 K=100）
- 互斥锁防并发；被互斥跳过 ≠ 失败，pendingKick 重跑；失败静默（连接状态指示器复位）

### 消息合并（message-merge.ts）——移植 design-sort-order-race + message-accumulation

- 排序：**流式 assistant（completed 为空）恒排最后**——乐观消息的 created 竞态由排序层兜底
- 合并原则：`info` 取 REST 权威；`parts` 按 part-id 并集（text 取更长者，tool 状态非 pending 优先）；
  顺序以 REST 为基线、SSE-only 追加尾；**绝不 clear()+addAll()**
- 窗口区间删除：本地消息 created 落在快照 (min,max) 开区间且不在快照 id 集 → 删（revert 场景）
- 惰性累积：`message.*` 事件到达即 `ensureConversation(sid)` 建容器，不发 REST；
  part 先于 message.info 到达时缓存 pendingParts，快照/消息到达后回放

## 4. 状态层（app-store.ts）

- **持久化**（经 IPC 落 userData/store.json）：connection.profiles、project.state（opened/currentProjectId/currentWorkspaceId，按 profile 维度）、theme.mode、locale.mode
- **连接状态机**：`disconnected → connecting → streaming ⇄ degraded`；sseGroup 聚合出 degraded；`reconciling` 独立标志（状态行"对账中"）
- **事件闸门**：订阅按打开项目建立，天然满足"关闭项目事件忽略"；`session.*` 事件再按 `info.directory` 与订阅目录比对双保险
- **乐观消息**：发送即插 pending 态；收到任意真实 user `message.updated` 即清除该会话全部乐观；POST 失败撤回+错误提示；写操作不自动重试
- **busy 判定**：assistant `time.completed` 为空 → busy（Tab/会话列表/输入区三处联动）；`abortSession` 支持停止
- **Tab**：`kind:key`（chat=sessionID、file=绝对路径）；重复打开复用；**关 chat Tab = abort（若流式中）+ PATCH time.archived**；
  切项目 = Tab 全关 + 文件树重置（project-scoped）
- **工作区模型**：`currentWorkspaceId` 存 worktree directory（null=主工作区）；
  会话过滤 `s.directory === scopeDirectory()`；`createSession` 的 directory = 当前工作区路径

## 5. UI 层

- 三栏 grid：`260px | minmax(800px,1fr) | 300px`，CSS 变量驱动
- 左栏两段：项目区（打开的，含活跃时间/关闭按钮）+ 工作区二级（主工作区 + sandboxes 列表）+ 会话区（当前作用域，归档折叠）
- 工作区：Tab 条（busy 状态点）+ 聊天视图（user 气泡 / assistant 全宽块 + reasoning 斜体 chip + tool chip 四态色）+ 文件视图（纯文本 pre mono）
- 消息流 markdown（assistant 文本 + reasoning 体；user 消息保持纯文本，对齐移动端 app 的 TextPart 策略）：streamdown L0——流式不完整语法修复与块级 memo 由其承担；**组件层全量覆写回语义元素**（其内置默认件是 Tailwind 样式件如 strong→span.font-semibold，本项目无 Tailwind），样式收敛在 app.css `.md` 前缀、全部走 tokens 语义色；代码块带语言标签 + 复制按钮（沿用 chip 展开体 code-block 视觉）；链接 target=_blank 经 main 的 setWindowOpenHandler → shell.openExternal 走系统浏览器；无语法高亮（spec 范围外，shiki 留待后续）
- 设置弹窗：profile CRUD + 激活（切换 = disconnect+connect 全量重对账）+ 测试连接 + 主题/语言
- 服务器状态行（2026-08-24 修订，原全宽状态栏取消）：收入左栏底部与设置齿轮同行、置底常驻；streaming/degraded/对账中；connectionError ⚠ 悬浮提示；不展示 server 版本
- i18n：ts catalog（zh/en），key 与移动端 ARB 场景对齐；`session: 4` 式单复数不敏感句式
- 主题：`tokens.css` 双套 `:root[data-theme]`，auto 跟随 `prefers-color-scheme`

## 6. E2E 验证记录（GNOME/Wayland 实机，server 1.18.20）

通过 CDP（--remote-debugging-port）驱动真实窗口验证：

- [x] attach 连接 → 快照 → streaming；37 项目可见
- [x] 打开/切换项目 → 会话列表（真实会话）+ 文件树懒加载
- [x] 新建会话 → prompt_async 发送 → SSE 收 user+assistant（reasoning/text）→ busy 复位
- [x] 乐观消息出现与收敛（真实 user 事件到达即清）
- [x] 关 chat Tab = 归档；已归档区可见/可恢复（unarchive 后回列表）
- [x] 文件 Tab：`{type,content}` 解包后正常显示 AGENTS.md
- [x] worktree：创建（随机/命名）→ 切换（会话过滤 + 文件树重载）→ 会话落 worktree → 删除 → sandboxes 同步
- [x] kick 重连不炸；typecheck（node+web）+ vitest 19 用例 + electron-vite build 全绿

## 7. Code Review 发现与修复（第一轮，2026-08-22）

Subagent 按 /review 方法全量审查（P1=3 P2=6 P3=7），核心结论：**store 的生命周期管理"只建不拆"**——SSE 组、会话状态、连接上下文三类资源没有拆除路径，正是锁定语义走样的根源。全部 P1/P2 及多数 P3 已修复并 E2E 回归：

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | P1 | SSE 订阅组泄漏：`startSse` 重建时不 stop 旧组（僵尸 `subscriber` 字段从未赋值）；关闭项目后旧订阅仍收事件，违反"关闭=事件忽略" | `startSse` 开头逐个 `stop()` 旧组再重建；删除僵尸字段 |
| 2 | P1 | FilePanel 条件 Hook：`if (!project) return` 在 useEffect 之前，项目从有到无时 Hook 数变化 → React 崩溃白屏 | Hook 无条件执行，early return 移后 |
| 3 | P1 | 设置弹窗 upsert/remove 落盘 stale closure：函数式 setState 后 `save()` 闭包里是旧列表，新增 profile 不持久化 | 持久化统一用计算出的 `next` 列表直接调 `saveProfiles(next, activeId)` |
| 4 | P2 | 切项目 `this.tabs = []` 静默丢弃 chat Tab，不归档——违反"关 Tab 即归档"锁定语义 | `switchProjectContext` 前置 `archiveAllChatTabs()`（流式中先 abort 再归档再清状态）；UI 侧切换前 confirm 提示 |
| 5 | P2 | busy 只增不减：断线期间完成的会话在对账后仍卡 busy，输入区永久锁死 | `reevaluateBusy(sessionID)`：快照合并后按"存在未完成 assistant"重估（loadSessionMessages 与 reconcile 的 onMessagesSnapshot 都调用） |
| 6 | P2 | 会话快照整体覆盖（`set(new Map(...))`）：async gap 期间到达的 session 事件被抹掉——违反自家"绝不 clear()+addAll()"原则 | `mergeSessionsSnapshot`：REST 权威覆盖同 id + updated 窗口开区间删除 + SSE-only 保留（三处调用点统一） |
| 7 | P2 | 会话级状态（messages/pendingParts/optimistic/busy）永不释放，内存无界增长 | `cleanupSessionState(sessionID)`：closeChatTab/deleteSession/切项目归档路径统一调用；teardownConnection 清全部 |
| 8 | P2 | 连接生命周期串台：managedBaseUrl 不清（SSE 打死地址）、切 profile 旧 Tab/消息残留、client 在快照失败前赋值 | `teardownConnection()`：disconnect/connect 前置完整拆除（SSE 组+域数据+Tab+managed 地址）；client 赋值移到快照全部成功后 |
| 9 | P2 | managed 模式 spawn 时生成的密码从未交给 renderer，鉴权开启即不可用 | managedStart 返回 `{baseUrl, username, password}`，connect 用其构造 RestClient 与 SSE |
| 10 | P3 | sidebar 菜单按钮点击冒泡到父行（点"归档"同时开 Tab） | 菜单容器 stopPropagation |
| 11 | P3 | SSE 聚合"任一 connected 即 streaming"掩盖部分 degraded | 改为"全部 connected 才 streaming" |
| 12 | P3 | `AbortSignal.timeout` 抛 `TimeoutError` 而非 `AbortError`，超时误分类 unknown | 分类函数加 `TimeoutError` 分支 |
| 13 | P3 | void 端点（prompt_async 等）200 空体时 `json()` 抛错 → 乐观消息误撤回重发 | 空文本直接返回 undefined；JSON 解析失败归类 ApiError |
| 14 | P3 | 安全：安全警告禁用生产也生效、sandbox:false、openExternal 不校验协议、无 will-navigate 拦截、密码框明文 | 仅 dev 禁警告；`sandbox:true`（验证 preload 正常）；openExternal 限 http/https；will-navigate 限制应用 origin；密码框 type=password |
| 15 | P3 | 与设计偏差：首次连接缺"最近活跃 1 个"、关当前项目回退插入序而非最近活跃 | ensureDefaultProjects 开 current+最近活跃；closeProject 按 time.updated 回退。工作区"分支"输入：worktree API 实际不支持 branch 参数（body 仅 name/startCommand），i18n key 已删，design-layout 相应更正 |
| 16 | P3 | Tab 重激活不重拉（陈旧内容） | chat/file Tab 激活即重拉（组件随激活重挂载，去掉缓存守卫；合并层保证不丢数据） |

E2E 回归记录：关 Tab=归档+状态清理 ✓；切项目=Tab 全关+会话归档+项目切换 ✓；sandbox:true 下 preload/连接/流式正常 ✓。

## 7.5 Code Review 第二轮发现与修复（2026-08-23）

第一轮修复验证 + 新问题（P1=2 P2=5 P3=7），全部修复：

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | P1 | managed 模式打开/关闭项目后 SSE 重建丢失凭据（startSse 参数只传一次，重建回退 profile 空凭据 → 401 死循环） | 生效凭据存 `sseCreds` 字段（connect 时设置），startSse 一律使用 |
| 2 | P1 | worktree 会话收不到任何事件：server 每条 /event 连接只圈定一个 directory，只订项目根 → worktree 内无流式、busy 永不置位、乐观消息不清 | 订阅集合加入当前 scope 目录（见下 #9 连接预算） |
| 3 | P2 | StrictMode 双 init → managed 双 spawn 泄漏进程 | AppStore.init() 幂等（initPromise）；startManagedServer in-flight 去重 |
| 4 | P2 | ProjectPicker 打开项目绕过切换确认，静默归档当前会话 | picker onClick 同样走 confirmSwitchProject 门控 |
| 5 | P2 | 会话被其他客户端删除后 Tab 永远关不掉（findSession null → 静默失败） | closeChatTab/deleteSession 对已不存在会话视为成功关闭；session.deleted 事件主动关 Tab + 清状态 |
| 6 | P2 | 删除当前激活 profile：activeId 改指未连接项，旧连接残留 | remove 激活项时先 disconnect 再落盘 |
| 7 | P2 | chat→chat Tab 切换复用 fiber，草稿跨会话泄漏（可误发） | `<ChatView key={active.key}>` 强制重挂载 |
| 8 | P3 | 无 Tab 会话的 busy 无法通过对账清除 | onSessionsSnapshot 时重置无 Tab 的 busy（仍在流式的会被后续事件重新置位） |
| 9 | P3→实测升级 | 空组状态栏永久"重连中"；**连接池饿死**：浏览器同 host HTTP/1.1 上限 6，SSE 全占后 REST 排队超时（实测 6 条订阅时 POST worktree 60s 超时，curl 直连 19ms 成功——定位为浏览器连接池） | 订阅集合 = 打开项目根 ∪ 当前 scope 目录，**上限 5**（永久留 ≥1 给 REST）；空组不再触发 degraded |
| 10 | P3 | disconnect 后 reconciler 空跑（非空断言抛错） | client() 返回 null 时 reconcile 直接放弃 |
| 11 | P3 | 空体消费者解引用 undefined；store:get/set 读改写竞态 | readFileContent/updateSession 判空；main 侧内存缓存 + 写队列串行化 |
| 12 | P3 | 无 Tab 会话消息状态无界累积 | 惰性累积门槛：有 Tab/已有容器无条件；其余容器上限 20（超出丢弃，打开走 REST 快照） |
| 13 | P3 | 死代码：subscriber 僵尸字段、eventGate、isStreamingAssistant、sendMessage/listWorkspaces | 全部删除 |

E2E 回归：worktree 全流程（创建→切换→会话→发消息→**流式 busy 置位/复位**→回复 OK→归档→删除）✓；SSE 3 条预算内 REST 全程可用 ✓。

## 7.6 Code Review 第三轮发现与修复（收敛轮，2026-08-23）

前两轮 30 条修复验证通过；本轮 P1=1 P2=2，已修复：

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | P1 | SSE 预算截断优先级错误：scope 目录最后入集，超预算时第一个被砍（≥5 项目时 worktree 流式复发病灶） | scope 目录最先入集（聊天流式命脉不可丢），项目根随后 |
| 2 | P2 | profile 切换/删除先 saveProfiles 后 disconnect：managed→attach 切换时旧 serve 进程泄漏（stop 按新 profile 判定）；删激活项后无重连入口 | disconnect 提前（旧 profile 仍激活，managed stop 命中）；remove 后继 profile 存在则自动 connect |
| 3 | P2 | pendingParts 在 message.updated 到达时不回放：part 先于 info 到达的消息缺开头内容（缓存机制只做了一半） | message.updated 新建条目时回放 pendingParts 并清缓存 |

新增测试：reconciler client 判空（断开后不抛错、状态复位）。

第三轮修复后追加发现并处理：**sandbox:true 的 preload 加载器不支持 ESM**（`Cannot use import statement outside a module`），preload 改为 CJS 输出（`format:"cjs"` + `index.cjs` 后缀避开 package.json type:module 歧义），sandbox 保留。

第四轮（最终确认）：四项修复全部验证通过（scope-first 截断/disconnect-first 顺序/pendingParts 回放/preload CJS 一致性），**P1=0 P2=0，评审收敛**。测试 20/20、typecheck 双侧、build 全绿；E2E 冒烟（scopeFirst ✓ 流式回复 ✓ 归档 ✓ REST ✓ streaming ✓）。

## 7.7 联调修复：worktree 会话不可见（2026-08-23）

现象：worktree 内已存在的会话在切进工作区后，中栏会话列表与左栏指示器均不显示（server 上该会话存在、未归档、无 parentID、directory 匹配）。两个叠加病灶，均以运行中 server 实测复现：

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | P1 | REST 快照拉不到 worktree 会话：所有快照路径都用项目根调 `listSessions(project.worktree)`——连 `setCurrentWorkspace` → `refreshSessionsForProject` 也是；而 `/session?directory=X` 精确匹配，根快照不含 worktree 会话。worktree 会话进 store 的唯一通道是"当前 scope 订阅期间的 SSE 事件"，订阅建立前创建的会话永远不可见 | `refreshSessionsForProject` **逐目录**拉取（项目根 ∪ `Project.sandboxes`），启动/切项目/切工作区统一走它；左栏非当前 worktree 行的指示器也因此有快照数据 |
| 2 | P1 | 快照合并按 projectID 全域审判：`mergeSessionsSnapshot` 用根快照的 updated 开区间窗口清除整个项目 map——SSE 已收到的 worktree 会话若 updated 落在根窗口内（实测确落），会被下一次任意根快照合并误判为已删除 | 合并逻辑抽到 `shared/session-merge.ts`，**按 directory 分域**：REST 覆盖与窗口删除只作用于快照同目录的本地会话 |

顺带修正：`removeWorkspace` 显式卸载已删目录的会话与 busy 标志（该目录已出 sandboxes，此后无快照/订阅通道覆盖它）；对账回调 `onSessionsSnapshot(dir, …)` 向合并层透传目录。

新增测试：session-merge 4 用例（覆盖跨目录误删回归、同目录窗口边界、空快照保守保留），24/24 全绿。

提交后 review 追加三项，已处理：

- **在途快照闸门**（P3 竞态）：`applySessionsSnapshot` 落地前校验项目仍打开、目录仍在 `worktree ∪ sandboxes`——removeWorkspace 清理之后才完成的旧请求、对已关项目的迟到快照直接丢弃，防复活已卸载的 worktree 会话（该目录此后无任何通道覆盖它）
- **REST 扇出限并发**（P3 性能）：快照拉取改为 `runLimited`（项目 2 × 目录 3）——连接池被 5 条 SSE 常驻后仅 ~1 空闲槽，无限扇出会让排队请求的 15s 超时从分发起算、尾部饿死（超时降级为空快照虽保守保命，但该目录会陈旧到下次刷新）
- **补窗口上边界断言**：`updated === max` 且不在快照的本地会话靠开区间 `(min, max)` 保留——此前测试未覆盖该契约点

## 7.8 首屏滚动动画修复 + 列表贴底方案（2026-08-24）

现象：首次打开已有消息的会话，列表有从顶部滚到底部的可见动画。

根因：`ChatView` 的 `initialScrollDone` gate 与滚动 effect 竞态。gate 阻止渲染时 effect 对空容器 `scrollToBottom("auto")` 空滚无效（`scrollHeight≈clientHeight`），放行渲染后同一批 entries 的 effect 命中 `entries.length(N) > lastEntryCount(0)` 走 `smooth`，产生动画。gate 本想"先置底再显示"，但置底那一刻 DOM 里还没有消息。

考虑过的替代方案与决策依据（架构决策记录）：

- **反转渲染顺序（`column-reverse` / DOM 顶部=新消息，视觉底部=最新）**：**否决**。流式更新是同一条目 parts 增长而非新增条目，反转后增长的 DOM 顶部元素在 `column-reverse` 下会把视觉底部的旧消息推走——与正序"钉底部"对称的锚定难题，未省掉。且需改 `sortEntries` 比较方向、乐观消息排序语义、测试用例、a11y 阅读顺序。逆序的真实收益场景是"向上翻页 prepend 不跳动"，v0.1 不做翻页（见 §8），用不到。
- **纯命令式 `scrollToBottom`（原方案）**：少消息会话内容不足容器高度时消息堆顶部、底部留白，必须靠 JS 拉底，是首屏动画的土壤之一。

采用方案：`justify-content: flex-end` + `useLayoutEffect` 同步置底，职责分离：

- **布局层**（`.message-list` 加 `justify-content: flex-end`）：内容不足容器高度时声明式贴底，零 JS、零滚动，首屏无动画可能；内容超出时自然进入滚动态。
- **JS 层**（`useEffect`→`useLayoutEffect`）：仅处理内容超出时的精确跟随——`useLayoutEffect` 在 DOM 变更后、浏览器绘制前同步执行，`scrollTo({behavior:"auto"})` 瞬时定位，用户看不到中间帧；新条目 N→N+1 用 smooth，同条目流式更新用 auto。删除 `initialScrollDone` gate 及渲染时的 `{initialScrollDone && ...}` 条件，消除竞态土壤。

改动：`workspace.tsx`（引入 `useLayoutEffect`、删 `initialScrollDone` state 与渲染 gate、滚动 effect 改 `useLayoutEffect`）、`app.css` `.message-list` 加 `justify-content: flex-end`。typecheck 双侧 + vitest 36/36 全绿。

v0.2 上翻加载方向（预留）：保持正序 DOM + scroll-anchor 锚定（记录锚点元素 offset，插入更早消息后补偿 `scrollTop`），而非反转渲染顺序——与 Telegram/ChatGPT 等工业惯例一致，阅读习惯、流式锚定、乐观排序全部不动。

## 7.9 流式跟随死锁修复——pinned 只由用户滚动意图解除（2026-08-24）

现象：流式回复期间消息列表不跟随贴底（§7.8 之前即潜伏，其 smooth 策略使触发概率接近必然）。

根因：`onScroll` 以"距底 >40px"清除 `pinnedToBottom`，但 scroll 事件无法区分用户滚动与程序滚动/smooth 动画：

1. 发送、新条目（N→N+1）走 `scrollTo({behavior:"smooth"})`，动画逐帧派发 scroll 事件，未到位时距底恒 >40px → pinned 被误清为 false；
2. 其后流式更新在 `useLayoutEffect` 命中 `!pinned` 分支直接 return——停止跟随；
3. smooth 的目标是发起时刻的 scrollHeight（流式内容仍在增长，已过期），动画终点仍距底 >40px，scroll 事件只会再次确认"距底远"→ 没有任何事件把 pinned 置回 → **死锁**，直到用户手动滚到底。

方案（与 §7.8 同思路的职责分离）：**吸附与解除分离**——

- `onScroll` 只做**吸附**：距底 <40px → `pinned = true`（滚回底部附近自动恢复跟随）；
- **解除**只认用户主动上滚：message-list `onWheel` 中 `deltaY < 0` → `pinned = false`。

依据：滚动条已隐藏（`app.css` `.message-list` scrollbar-width:none），wheel/触控板是桌面端唯一用户上滚入口（列表不可聚焦，无键盘滚动）；Chromium 已把自然滚动方向归一到 wheel deltaY（deltaY<0 恒等于"向上看历史"），无需按输入设备分支。两类误触排除（review 补充）：`ctrlKey` 事件是缩放手势（Ctrl+wheel 放大/触控板 pinch-out），不解除；内容未溢出（`scrollHeight ≤ clientHeight`）时上滚是视觉 no-op，也不解除——否则流式增长越过容器后无 scroll 事件可再吸附（scrollTop 未变），跟随会停摆到用户手动滚底。效果：smooth 动画期间的 scroll 事件不再影响 pinned；流式更新 auto 精确贴底；用户上滚浏览历史不受流式打扰。

改动：`workspace.tsx`（onScroll 改为仅吸附、新增 onWheel 挂到 `.message-list`）。typecheck 双侧 + vitest 36/36 全绿。

## 7.10 消息列表不可滚修复——flex-end 溢出不可达（2026-08-24）

现象：消息列表**完全无法上滚**——滚轮/触控板上滚无任何反应，历史消息不可达；§7.8/§7.9 两轮修复后依旧。

根因（联调实例 CDP 实测确认）：§7.8 给 `.message-list` 加的 `justify-content: flex-end` 触发 css-overflow 规范的"start 侧对齐溢出不可滚"——flex-end 把溢出推到容器**上方**（start 侧），而规范不把对齐导致的 start 侧溢出计入可滚动区域。Chromium（Chrome 151 / Electron 43 实测）表现为：`scrollHeight === clientHeight`（溢出部分不计入）、`scrollTop` 恒 0、`maxReachableScrollTop === 0`——容器**根本不是滚动容器**，首条消息被裁剪在视口上方（实测 live 实例：104 条消息、首条 top=-6304px、`maxReachableScrollTop=0`）。连带使 §7.9 的整套逻辑退化：`onWheel` 解除条件 `scrollHeight - clientHeight > 0` 永假（上滚永不解除跟随）、`onScroll` 吸附条件恒真（pinned 永真）。

为何前两轮没发现：§7.8 引入该 CSS 时，流式"跟随"依赖的 scrollTo 在 scrollHeight===clientHeight 下是 no-op，恰好视觉上仍显示底部内容（flex-end 底对齐），跟随看似正常；只有"上滚看历史"这条路径彻底坏死，而 §7.9 的验证聚焦流式跟随。JS 层任何逻辑都救不了 CSS 层"不可滚"。

方案：`justify-content: flex-end` → **`safe flex-end`**（单字修复）。`safe` 对齐在内容溢出时退回 start 对齐——溢出转到底部（end 侧，**可滚**），不溢出时保持底对齐（§7.8 的声明式贴底目标不变）。Chromium 115+ 支持，Electron 43（Chromium 144）覆盖。实测验证（live 实例注入 + headless 复刻）：短内容底对齐不变；溢出后 `maxReachableScrollTop = scrollHeight - clientHeight` 完整可达。

配套 JS 修正（滚动性恢复后 §7.8 症状会随之回归，必须同改）：滚动 effect 的 `grew` 改为 `lastEntryCount.current > 0 && entries.length > lastEntryCount.current`——排除 0→N。溢出态初始 `scrollTop=0` 在**顶部**，0→N 若走 smooth 是可见的整屏滚动动画（§7.8 症状）；auto 在 useLayoutEffect 绘制前同步跳底，用户看不到顶部帧。原代码 `grew = entries.length > lastEntryCount.current` 对 0→N 恒真，与其注释声称的"0→N 用 auto"矛盾（§7.8 时因列表不可滚而未显形）。

改动：`app.css`（`.message-list` safe flex-end + 注释）、`workspace.tsx`（grew 条件）。typecheck 双侧 + vitest 60/60 全绿。

## 7.11 消息两侧空白处滚轮失效——滚动层与限宽层分离（2026-08-24）

现象：窗口宽于消息列限宽（848px）时，鼠标在消息**左右两侧空白处**滚轮完全无效；悬停在消息内容上滚动正常。

根因：`.message-list` 同时承担**滚动容器**（overflow-y:auto）与**限宽居中**（max-width:848px + margin:0 auto）两个职责。窗口更宽时该元素水平居中，两侧空白处的命中元素是 `.chat-view`（overflow:hidden）——浏览器滚轮滚动只沿**命中元素的祖先链**找可滚动容器，`.chat-view` → `.workspace-body` → `.workspace` 全是 overflow:hidden 不可滚，而 `.message-list` 是 `.chat-view` 的**子元素**、不在空白处的祖先链上，找不到可滚容器，事件被丢弃。

方案：职责分离为两层——`.message-list` 只做全宽滚动容器（flex:1 + overflow-y:auto，scrollRef/onWheel/onScroll 不动）；新增内层 `.message-list-inner` 承接限宽居中（max/min-width + margin:0 auto + padding + gap）与 §7.10 的 `safe flex-end`。贴底语义经 `min-height:100%` 保留：内容不足时内层占满滚动层可见高度，flex-end 才有下压空间（高度 auto 的内层 flex-end 是 no-op，消息会贴顶）。§7.10 的溢出可滚性不受影响（滚动容器为普通 block，内层高度完整计入 scrollHeight）。

改动：`app.css`（两层拆分 + 注释）、`workspace.tsx`（MessageBlock/TypingSlot 包入 `.message-list-inner`）。typecheck 双侧 + vitest 63/63 全绿。

## 8. 已知限制（v0.1 接受）

- 消息历史仅拉最新 100 条窗口，更早消息无上翻加载（spec 范围外，v0.2 分段加载；方向见 §7.8——正序 DOM + scroll-anchor，不反转渲染顺序）
- 工具调用输入输出为 JSON.stringify 展示，无按工具类型的结构化渲染
- 布局栏宽度固定（未实现拖拽调宽/折叠），localStorage 布局持久化未接
- managed 模式仅实现 spawn + 健康等待，未实现崩溃自动拉起
- SSE 无 per-directory idle LRU（打开项目数通常 <5，可接受）
- worktree 创建不支持指定分支（/experimental/worktree 契约仅 name/startCommand）
