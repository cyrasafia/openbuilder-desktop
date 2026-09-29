# 桌面端 OpenCode V2 迁移设计 — 设计文档

> 目标：评估 opencode v2（GA，核对版本 **2.0.18**，源码锚 `anomalyco/opencode` `v2` 分支）对 openbuilder-desktop 的影响面，给出迁移路线与决策点。
>
> **⚠️ 前瞻设计，不代表立即执行。** v1（1.18.x）仍是当前实现基线；v2 契约在 GA 后仍快速迭代（两周 18 版），落地前需按当期版本复核。
>
> **决策已定（2026-09-28，用户裁定）**：D1–D5 与双兼容策略均已落定，见 §交互语义决策点、§双兼容与版本探测 及 §增补决策记录；**落地排期 v0.5——v0.5 起仅支持 v2 server**（0.4.x 及以前维持 v1.18.x 契约）。另注：本机 15120 已于 2026-09-28 13:55 升级为 v2.0.18（系统包 opencode-bin 1.18.32 → opencode 2.0.18，Basic auth 开启），v1 联调环境已不可用，本机即现成的 v2 靶机。
>
> **差异基线共用姊妹篇**：`../openbuilder/docs/design-v2-migration.md`（2026-09-28 修订版，下称「移动端基线」）。v1/v2 通用差异（状态模型、事件命名空间、认证机制、端点全集）以该文档为准，本文**不重复**，只展开桌面端特有的部分：桌面端使用的端面、受影响的子系统、交互语义决策点。参考来源：移动端基线 + 本仓库 rest-client/sse-subscriber/reconciler 实测盘点 + v2 源码核对（2026-09-28）。

## 文档导航

本文档是桌面端迁移的 **umbrella 设计**，不落代码。落地时按子系统拆 `plan-v2-*.md`（建议拆分：`plan-v2-protocol`（client/SSE/对账）、`plan-v2-chat`（消息模型与渲染）、`plan-v2-worktree`（项目/工作区交互）、`plan-v2-terminal`），并参照本文档的映射表与移动端基线逐项核对。

---

## 问题

### 桌面端在 legacy 根路径面上（与移动端起点不同）

移动端 client 已在 1.18.x 的过渡 `/api/*` 面，迁移是增量演化；**桌面端不是**。rest-client.ts 实测盘点：

- **legacy 根路径（主体，约 40 个调用点）**：`/global/event`（SSE）、`/global/health`、`/project`、`/project/current`、`/session*`（list/create/message/prompt_async/command/fork/revert/unrevert/abort/todo/permissions）、`/session/status`、`/permission`、`/question*`、`/file`、`/file/content`、`/find/file`、`/vcs/diff`、`/session/:id/diff`、`/experimental/worktree`、`/instance/dispose`、`/pty*`、`/agent`、`/command`、`/provider`、`/config/providers`
- **过渡 /api 面（少量，后期功能）**：`/api/command`、`/api/model`、`/api/skill`、`/api/session/:id/{agent,model}`、`/auth/:provider`

迁移距离 = **整体搬迁**：v2 下上述 legacy 路径全部 404，SSE 事件名全部解析失败。

### v2 GA，v1 维护模式

v2.0.0 已于 2026-09-11 发布；主站下载/文档/console 全面切 v2；v1.18.x 只收兼容性小修。新装用户默认 v2 server，桌面端「连接用户自配 server」的场景里 v2 占比只会上升。

### 与桌面端锁定语义的冲突（迁移前必须解决的三个）

1. **关 Tab = 归档**（AGENTS.md 锁定语义）：v1 走 `PATCH /session/:id` 的 `time.archived`。v2 实测：`PATCH /api/session/:id` 只接受 `title/metadata/permissions`，**归档字段无任何 REST 写入路径**（schema/DB 里 `time.archived` 存在，仅 import 迁移透传；`DELETE /api/session/:id` 是真删且连子会话）。见 §交互语义决策点 D1。
2. **todo 端点移除**：`/session/:id/todo` 无对应（todo 概念下沉）；桌面端 v0.2+ 若规划 todo 展示需改从消息流读取。
3. **question → form 改道**：`/question*` 三端点变成 `/api/session/:id/form` 体系（移动端基线 §端点映射）。

---

## 设计

### 核心思路

1. **基线锚定与契约参考源换 pin**：AGENTS.md 现行约束「契约以 `../openbuilder/opencode_openapi.json`（v1）为准」。v2 官方将生成物入库——`anomalyco/opencode` `packages/protocol/openapi.json`（与 Effect HttpApi 定义同源生成）。迁移落地时把契约参考源 pin 到该文件（拷贝入本仓库或 openbuilder 同步），并同步修订 AGENTS.md 硬约束措辞。**仍然自写通信层、不用官方 SDK**（D1–D4 与 Keep Lean 不变）。
2. **整体搬迁，分子系统 plan**：一次性切换（不做 legacy/api 双写），按 §文档导航拆 plan 分批实施、分批评测。
3. **双兼容策略已定案**（§双兼容与版本探测）：不做兼容，v0.5 起仅支持 v2。

### 端点迁移映射（桌面端实际使用面）

| 桌面端现用（v1） | v2 对应 | 变化 |
|---|---|---|
| `GET /global/health` | `GET /api/info` | 低（连接探活改路径+响应） |
| `GET /global/event`（SSE） | `GET /api/event` | **高**：无 query 单流；`V2Event` envelope `{id, created, metadata?, location?, type, data}`；事件命名 `session.*`（无 `next` 段）；**volatile 契约** |
| `GET /project` | `GET /api/project` | 中：`worktree`→`canonical`；`time.active` 必填 |
| `GET /project/current?directory=` | `GET /api/location?location[directory]=` | 中：`Project.Current{id,directory}` → `Location.Info{directory, project{id, directory, canonical}}` |
| `GET /session?directory=` | `GET /api/session?directory=` | 中：响应 `{data, cursor}`；flat query 保留但加分页（limit 默认 50 + cursor） |
| `GET /session?scope=project&directory=/`（global 发现） | `GET /api/session`（无过滤） | **高**：需翻页拉全量再按 `location.directory` 分组；`scope=project` 语义无对应 |
| `GET /session/status?directory=` | **移除** | **高**：会话状态改事件驱动（`session.status/idle/execution.*`）+ `Session.outcome` 字段；对账重设计 |
| `POST /session`（创建） | `POST /api/session` | 中：payload `{id?, title?, agent?, model?, location?, metadata?, permissions?}`（**无 parentID/agentID 旧字段形态**）；响应 `{data}` |
| `POST /session/:id/prompt_async`（204+SSE） | `POST /api/session/:id/prompt` | **高**：200 + `{data: SessionInbox.User}` 准入回执；payload `{id?, text, files?, agents?, skills?, metadata?, delivery?, resume?}`——发送管线与乐观消息重写 |
| `GET /session/:id/message` | `GET /api/session/:id/message` | **高**：消息 typed union（11 种）；`X-Next-Cursor` 响应头 → body `cursor{previous,next}`；type 过滤 |
| `POST /session/:id/command` | `POST /api/session/:id/command` | 中：payload `{name, text?, ...}`；NoContent |
| `POST /session/:id/fork` | `POST /api/session/:id/fork` | 低（需核对 payload） |
| `POST /session/:id/revert`、`/unrevert` | `POST .../revert/stage`、`POST .../revert/commit`、`DELETE .../revert` | 中：三段式 undo，交互流程改 |
| `POST /session/:id/abort` | `POST /api/session/:id/interrupt` | 低 |
| `GET /session/:id/todo` | **移除** | 见 §问题 |
| `POST /session/:id/permissions/:pid` | `POST /api/session/:id/permission/:requestID/reply` | 低（路径改） |
| `GET /permission`（全局） | `GET /api/permission/request` | 低 |
| `GET/POST /question*` | `GET/POST /api/session/:id/form*` | 中：form 体系（移动端基线） |
| `GET /file`、`/file/content` | `GET /api/fs/list`、`GET /api/fs/read/*` | 中：LocationQuery deepObject `?location[directory]=`；`path` 支持相对 |
| `GET /find/file` | `GET /api/fs/find` | 低：`{location, query, type, limit}` |
| `GET /vcs/diff` | `GET /api/vcs/diff` | 中：deepObject location；`base` 参数语义（working/branch/committed） |
| `GET /session/:id/diff` | `GET /api/session/:id/diff?from&to&context` | 中：**turn 语义**（idle 边界定界），`from/to` 是消息 ID；响应 `{data: FileDiff.Info[]}` |
| `GET/POST/DELETE /experimental/worktree` | `GET/POST/DELETE /api/worktree` | 中：payload/query 形态变（projectID 必填；create 支持 from/branch/父目录/name + setup 脚本）；**新增 refresh** |
| `POST /instance/dispose` | `POST /api/location/reload` 或 `DELETE /api/debug/location` | **决策点**：语义近似但 reload 是「重建全部已加载 location」（影响面更大），见 D5 |
| `/pty*` + WS connect | `/api/pty*` + connect | 中：组结构保留；ticket/WS 契约（`x-opencode-ticket`、close 1000/4404 分流）需核对；另有 persistent-pty 体系（v0.2+ 参考） |
| `GET /agent`、`/command`、`/provider` | `GET /api/agent|command|provider` | 低 |
| `GET /config/providers` | `GET /api/config`（+ `/api/config/shell`） | 中：需核对形态 |
| `PUT/DELETE /auth/:provider` | credential/integration 体系 | 中（移动端基线） |
| `/api/command`、`/api/model`、`/api/skill`、`/api/session/:id/{agent,model}` | 同路径保留 | 低：少数已对齐的调用点 |

### 认证层（新增子系统）

v2 server 默认强制密码（移动端基线 §认证）。桌面端影响：

- 连接配置模型从 `serverUrl` 扩展为 `serverUrl + 凭据`（Basic：用户名固定 `opencode` + 密码/30 天 token）；
- **配对 UI**：桌面端可打开系统浏览器走 `POST /api/pair` → `/auth/connect/:code` 拿 token（Electron 下比手机端更自然）——参考桌面端已有 browser tab 能力（design-browser-tab）承接授权页；
- token 30 天过期/密码轮换失效 → 重配对流程；凭据存储走 Electron safeStorage。

### SSE 与对账重设计

- **事件表重写**（sse-subscriber）：v1 `message.part.updated`/`session.status` 等 → v2 `session.*` 命名空间全集（移动端基线 §SSE 事件契约）；envelope 换 `V2Event`；
- **volatile 契约是硬约束**：断线期间事件**必丢**、慢消费者被断流。现有 SSE+REST 对账（design-v0.1-implementation 的 Reconciler）思路可延续，但策略要更激进：**每次重连必做全量对账**（会话列表 + 打开的会话消息 + worktree 清单），不能依赖任何 server 侧补偿或「断点续传」；
- **global 发现改分页全量**：`scope=project&directory=/` 无对应 → 无过滤翻页拉全量按 `location.directory` 分组（cursor 翻页 + 去重）；`openedGlobalDirectories` 事件闸门语义可保留；
- **会话状态快照端点消失**：`/session/status` → 事件驱动（`session.execution.*`/`session.idle`）+ 列表时读 `outcome` 字段；Reconciler 的 status 对账分支删除。

### 消息模型与渲染管线（最大工作量）

- v2 消息是 **typed union**（`agent-switched/model-switched/location-switched/user/synthetic/system/skill/shell/assistant/compaction/idle`），取代 v1「role + parts」两层结构；`message-merge`、消息渲染组件按类型分发重写；
- 流式 token 事件拆分（`session.text.delta`/`session.tool.input.delta`/`session.reasoning.delta`）+ `session.message.content.updated` 兜底——渲染管道的增量合并逻辑重写（L2 阶段参考 `../opencode` session-ui 的管道仍是可选项）；
- 分页：`{data, cursor}` 双向游标（cursor 不可与 order 并用）；「加载更早消息」交互从 `before` 参数改为 `cursor.previous`；
- 乐观消息：prompt 200 回执（`SessionInbox.User` + `delivery/resume`）提供准入确认，v1 的 204-盲发 + SSE 回显模式可升级为回执驱动。

### 交互语义决策点（已全部裁定，2026-09-28）

**D1 归档语义（已定，2026-09-28）——方案 a：metadata 自造归档**

决策：关 Tab = 写 `metadata.archivedAt = Date.now()`（`PATCH /api/session/:id`）；打开 Tab = 清除该字段；列表过滤客户端做。**归档的识别/对称交互逻辑不变，仅换存储字段**（`time.archived` → `metadata.archivedAt`）。官方背景（佐证这是过渡桥接而非永久私约）：

- v1 过渡面 `PATCH /api/session/:id` 的 UpdatePayload 含 `time.archived`（1.18.x `groups/session.ts:55`）；v2 砍到 title/metadata/permissions，`time.archived` 仅存于 schema/DB/import 透传；
- 官方 v2 app 的归档按钮是**有意降级的占位**：v1/v2 双协议期按 `protocolKind()==="v1"` 门控调 v1 API；2026-08-06 code owner 删 v1 兼容层（#40382）时替换为 `Promise.reject("Session archiving is unavailable")`，留三处 TODO 原话 *"Restore archiving when the V2 client exposes a session archive API"*；
- 社区两次完整服务端实现（#38440、#39358：durable `session.archived` 事件 + `Session.archive` core op，明确「archive 与 delete 分离」）均未被 merge（满月被 automated PR cleanup 关门）；unarchive 修复 PR #47848 仍 open。

**官方 API 回归后的迁移路径**：v2 PATCH/端点暴露归档写入（`time.archived` 或等价）→ 通信层与 store 换字段源，客户端归档逻辑（识别/对称/过滤）不动。迁移触发核对点写入 plan-v2-protocol 的落地前复核清单。

**实施发现（M2，2026-09-28）**：v2 `PATCH` 返回 204 无 body——归档/重命名本地乐观落地（重连快照对账兜底）；metadata 为 REPLACE 语义（私约写入须整包合并既有字段，实测活体 server 通过）。**已知边界**：v1 迁移存量会话的 `time.archived` 在 v2 无写入路径——「开 Tab = 取消归档」对这类会话不可持久（重连快照复活归档；官方 unarchive 修复 PR #47848 未合），识别层双源不受影响，已记录于 D1 测试。

否决记录：b) 改删除语义——不可逆且连子会话，违背「关 Tab = 归档」产品语义（PRINCIPLES：理念先行）；c) 纯客户端状态——重连/换端后 Tab 复活，对称性最差。

选定后**同步修订 AGENTS.md 锁定语义**条目（架构文档决策记录性质：改写决策与依据）。

**D2 worktree 删除后消失（已确认，2026-09-28）——删除前级联删会话（非归档）**：删除入口调 `DELETE /api/worktree` → `worktree.updated` 事件 → 重拉。**实施修订（M5/M6d）**：原案「数据源换 `GET /api/worktree?projectID=` + `POST /api/worktree/refresh` 对账」未直连实施——列表数据源实况 = `GET /api/project` 的 `Project.sandboxes` 投影，对账走项目列表全量 diff（外部删除等价可发现），端点直连与 refresh 列为 v0.6 优化。外部删除对账：SSE 重连全量对账 + 项目选择器打开时项目列表刷新。

**删除 worktree 时级联删除该 directory 下全部会话（`DELETE /api/session/:id`，连子会话）而非归档**——与现行实现一致（`removeWorkspace`，app-store.ts:2883「删除 worktree 前，先级联删除该目录全部会话」），v2 迁移时语义照搬。这同时消解**同名重建会话重现**问题（store.ts 精确匹配 directory 字符串、无 incarnation 概念——会话已删，重建后无旧会话可重现）；唯兜底场景是对账时发现「他端删除未走本端」（会话残留），按 D3 的悬空标记提示用户手动清理。

**D3 悬空 location（已确认，2026-09-28）**：v2 不拦悬空目录上创建会话（执行期才失败）。客户端对账时按 directory 存在性标记，新建入口拦截 + 旧会话提示不可执行。

**D4 canonical 自愈红利（已确认，2026-09-28）**：v1 时代「项目移动后登记路径 stale、手改 DB」的知识（本仓库 2026-09-28 实操过）在 v2 由服务端解决（旧 canonical 消失才替换 + `PATCH /api/project/:id` 可改）。左栏项目条目数据源改 `Project.canonical`，相关容错逻辑可删。**已实测验证**：本机升级 v2.0.18 后，上午手改的 c139e90b 行被原地迁移并正确映射为 `canonical=/home/cyrasafia/projects/PRD&文档/订前Agent优化`、`sandboxes=[]`。

**D5 instance/dispose 的对应（已确认，2026-09-28）**：v1 `POST /instance/dispose?directory=` 逐实例释放；v2 `POST /api/location/reload` 是**重建全部已加载 location**（pending permission/form 取消、运行中会话在新服务层继续）、`DELETE /api/debug/location` 是 debug 端点（逐个 evict）。桌面端目前使用 dispose 的场景（如 worktree 删除后清实例缓存）改走 refresh + 服务层自管理，**不直接映射** reload；保留 debug evict 做诊断。

### 双兼容与版本探测（已定，2026-09-28）

**决策：不做兼容——v0.5 起仅支持 v2 server**（0.4.x 及以前维持 v1.18.x 契约；版本切换按版本号管理规则走第二段升级 + `git tag v0.5`）。

- 探测仅用于错误指引：连接时 `GET /api/info` 失败/legacy 响应 → 给出「server 版本不支持，需 v2」的明确错误，不做协议分派、不做双写；
- 桌面端连用户自配 server，v1/v2 并存期以年计——v0.5 用户连 v1 server 将收到明确报错（接受此约束）；
- 本机 15120 已是 v2.0.18（Basic auth），联调环境即 v2 靶机；v1 回归测试（如需）另起 1.18.x 二进制于其他端口。

---

## 场景验证

### 场景 1：用户运行 v1.18.x 服务器

0.4.x 及以前：当前实现继续工作。**v0.5 起：仅支持 v2**——连接 v1 server 给出明确「版本不支持」错误（双兼容已裁定不做）。

### 场景 2：用户升级到 v2 服务器

0.4.x 连 v2 server：全部 404/HTML + 401 + SSE 解析失败（无部分可用；本机 15120 已实测复现）。v0.5 迁移完成后按 v2 契约工作，认证/分页/事件/消息模型全部生效。

### 场景 3：迁移启动时 v2 仍在快速迭代

以 2.0.18 为基线写 plan，落地前对当期版本复核（核对源：官方 `packages/protocol/openapi.json` 与 protocol group 源码 diff）。已知风险项：事件清单、消息 union 枚举、form 体系、归档 API 回归（D1 迁移触发点）。

---

## 关键设计决策

1. **迁移落定 v0.5**（2026-09-28 裁定）：0.4.x 及以前维持 v1.18.x 契约；**v0.5 起仅支持 v2**，按版本号管理规则走第二段升级 + `git tag v0.5`，并配套 v0.5 spec 修订（AGENTS.md「改功能范围必须同步 spec」）。
2. **契约参考源换 pin**（落地时）：`../openbuilder/opencode_openapi.json`（v1）→ 官方 `packages/protocol/openapi.json`（v2），同步修订 AGENTS.md 硬约束；继续自写通信层。
3. **不做双协议**：探测仅用于错误指引（Keep Lean；场景 1）。
4. **D1 归档走 metadata 私约**（已定）：`metadata.archivedAt`，归档识别/对称逻辑不变仅换字段；官方 archive API 回归后迁回（触发核对点入 plan 复核清单）。
5. **对账升级为重连全量**：volatile 契约下这是唯一正确策略；global 发现改无过滤分页全量。
6. **worktree 删除 = 级联删会话**（已定，与现行 removeWorkspace 语义一致）：同时消解同名重建的旧会话重现。

---

## 不做的事

1. 不在本文档阶段改任何代码（client/SSE/store 维持 v1 契约）。
2. 不引入官方 SDK（`packages/sdk` 为 TS 包；D1–D4 维持）。
3. 不做 v1/v2 双协议并行实现（探测仅用于错误指引）。
4. 不预实现 v2 新能力（persistent-pty、form、inbox、skill、websearch、session stats/log/import-export）——与迁移解耦，按需另行 design。
5. 不为「v2 没有归档」提前发明 server 侧方案（如自建中间层）——违反 D4（无中间服务层）。

---

## 评审意见

### 一次评审意见（自审）

| 编号 | 优先级 | 问题 | 建议 |
|------|--------|------|------|
| V2D-1 | 🔴 高 | D1 归档方案 a 的 metadata 字段是私约，其他 v2 客户端不识别 | 官方 app 留有 *"Restore archiving when the V2 client exposes a session archive API"* TODO（三处）且两个完整实现 PR（#38440/#39358）现成未合——落地时先核对当期 v2 是否已补 API；私约方案定位为过渡桥接，并在 openbuilder 侧对齐字段约定；回归后切回官方字段 |
| V2D-2 | 🟡 中 | pty ticket/WS 契约（`x-opencode-ticket`、1000/4404 分流）未逐项核对 | plan-v2-terminal 首项任务：对照 v2 pty handler 源码核对，终端退出分流语义不可走样（2026-09-22/09-23 锁定语义） |
| V2D-3 | 🟡 中 | `GET /session/status` 消失后的状态对账细节（运行中会话的 UI 指示）未设计 | plan-v2-protocol 内补：事件驱动状态机 + 重连全量对账后的状态重建 |
| V2D-4 | 🟢 低 | global 发现翻页全量的性能（会话多时 cursor 翻页 N 次） | plan-v2-protocol 内评估 limit 上限与增量缓存；必要时只在选择器打开时发现 |
| V2D-5 | 🟢 低 | `POST /session` payload 无 parentID，子会话（后台任务）创建路径未确认 | 核对 v2 fork/inbox 体系是否覆盖桌面端现有用例 |

### 增补决策记录（2026-09-28，用户裁定）

| 决策点 | 裁定 |
|--------|------|
| D1 | 走方案 a（metadata 自造）；归档识别逻辑不变，官方归档 API 回归后迁移 |
| D2 | 确认；删除 worktree 时**级联删除**该目录全部会话而非归档（现行 removeWorkspace 实现即删除语义，v2 迁移照搬） |
| D3 | 确认（悬空 location：客户端对账标记 + 新建拦截 + 旧会话提示） |
| D4 | 确认（canonical 自愈红利；本机 v2.0.18 实测验证通过） |
| D5 | 确认（dispose 不映射 reload；refresh + 服务层自管理） |
| 双兼容 | **不做兼容；v0.5 起仅支持 v2**（0.4.x 及以前维持 v1.18.x 契约；v0.5 按版本规则打 tag） |
| **D6（M1 实施期增补）** | **global 语义退役**：v2 实测无 global 项目行（非 git 目录 = 目录哈希伪项目行，出现在 `GET /api/project`）——v1 的 `global\0<dir>` entry 模型整体删除，非 git 目录以普通项目行进左栏；持久化旧键连接期按 worktree 匹配迁移（`migrateLegacyGlobalState`）；M1b 已落地（AGENTS.md 锁定语义已同步改写） |

### 修复复审

（文档为基线记录 + 已定决策，无代码改动。落地时按 plan 逐项 review，配套 `review-v2-*.md`；D1 的官方 API 回归核对点已入 plan-v2-protocol 复核清单。）
