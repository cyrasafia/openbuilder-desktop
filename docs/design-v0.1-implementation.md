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
    ├─ components/        # sidebar / workspace / file-panel / status-bar / settings-dialog
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
- 内容：每个打开项目 `GET /session`（全量）+ 每个**打开的 chat Tab** `GET /session/{id}/message?limit=100`（窗口 K=100）
- 互斥锁防并发；被互斥跳过 ≠ 失败，pendingKick 重跑；失败静默（状态栏指示器复位）

### 消息合并（message-merge.ts）——移植 design-sort-order-race + message-accumulation

- 排序：**流式 assistant（completed 为空）恒排最后**——乐观消息的 created 竞态由排序层兜底
- 合并原则：`info` 取 REST 权威；`parts` 按 part-id 并集（text 取更长者，tool 状态非 pending 优先）；
  顺序以 REST 为基线、SSE-only 追加尾；**绝不 clear()+addAll()**
- 窗口区间删除：本地消息 created 落在快照 (min,max) 开区间且不在快照 id 集 → 删（revert 场景）
- 惰性累积：`message.*` 事件到达即 `ensureConversation(sid)` 建容器，不发 REST；
  part 先于 message.info 到达时缓存 pendingParts，快照/消息到达后回放

## 4. 状态层（app-store.ts）

- **持久化**（经 IPC 落 userData/store.json）：connection.profiles、project.state（opened/currentProjectId/currentWorkspaceId，按 profile 维度）、theme.mode、locale.mode
- **连接状态机**：`disconnected → connecting → streaming ⇄ degraded`；sseGroup 聚合出 degraded；`reconciling` 独立标志（状态栏"对账中"）
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
- 设置弹窗：profile CRUD + 激活（切换 = disconnect+connect 全量重对账）+ 测试连接 + 主题/语言
- 状态栏：streaming/degraded/对账中 + server 版本；connectionError 悬浮提示
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

## 7. 已知限制（v0.1 接受）

- 消息历史仅拉最新 100 条窗口，更早消息无上翻加载（spec 范围外，v0.2 分段加载）
- 工具调用输入输出为 JSON.stringify 展示，无按工具类型的结构化渲染
- 布局栏宽度固定（未实现拖拽调宽/折叠），localStorage 布局持久化未接
- managed 模式仅实现 spawn + 健康等待，未实现崩溃自动拉起
- SSE 无 per-directory idle LRU（打开项目数通常 <5，可接受）
