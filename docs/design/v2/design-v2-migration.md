# 桌面端 OpenCode V2 迁移设计 — 设计文档

> 目标：评估 opencode v2（GA，核对版本 **2.0.18**，源码锚 `anomalyco/opencode` `v2` 分支）对 openbuilder-desktop 的影响面，给出迁移路线与决策点。
>
> **⚠️ 前瞻设计，不代表立即执行。** v1（1.18.x）仍是当前实现基线；v2 契约在 GA 后仍快速迭代（两周 18 版），落地前需按当期版本复核。
>
> **决策已定（2026-09-28，用户裁定）**：D1–D5 与双兼容策略均已落定，见 §交互语义决策点、§双兼容与版本探测 及 §增补决策记录；**落地排期 v0.5——v0.5 起仅支持 v2 server**（0.4.x 及以前维持 v1.18.x 契约）。另注：本机 15120 已于 2026-09-28 13:55 升级为 v2.0.18（系统包 opencode-bin 1.18.32 → opencode 2.0.18，Basic auth 开启），v1 联调环境已不可用，本机即现成的 v2 靶机。
>
> **差异基线共用姊妹篇**：`../openbuilder/docs/docs/design/v2/design-v2-migration.md`（2026-09-28 修订版，下称「移动端基线」）。v1/v2 通用差异（状态模型、事件命名空间、认证机制、端点全集）以该文档为准，本文**不重复**，只展开桌面端特有的部分：桌面端使用的端面、受影响的子系统、交互语义决策点。参考来源：移动端基线 + 本仓库 rest-client/sse-subscriber/reconciler 实测盘点 + v2 源码核对（2026-09-28）。

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
| `GET /session/status?directory=` | `GET /api/session/active`（部分对应，2026-09-29 活体修正） | **高**：会话状态改事件驱动（`session.status/idle`）+ active 对账重设计；完整 per-session 状态端点（`/api/session/status`，busy/retry/idle Map）已在官方源码但未随 2.0.18 发布（活体 400——被 `/:sessionID` 路由吞），回归后可换绑 |
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
- **会话状态对账改 active 双向 diff**（V2D-3 修复，2026-09-29）：`/session/status` 无 v2 对应（M3a 裁定仍成立），但 `GET /api/session/active`（全局 drain 集合，「absent = inactive」契约语义）提供双向收敛——重连/首连对账时与本地 `sessionStatus` diff：stale busy/retry 清 idle、丢失的 busy 补回、retry 细节降级等下一次事件自愈。详见 design-typing-indicator §4 来源表与 `reconcileActiveSnapshot`（app-store）。
- **session.created 事件骨架做字段级合并**（2026-09-30 活体修复）：v2 事件 payload 是**增量字段**而非完整 Session.Info——本端 `createSession` 的 POST 响应（完整 SessionInfo，含 agent/model）先落地 map 后，随后到达的 SSE `session.created` 骨架（`applyV2SessionEvent` 构造、time 以事件时间播种）直接 `map.set` 整体覆盖，会把已写入的 agent/model 顶掉——**会话底部 model/variant 消失 bug 的根因**（活体复现：POST 与事件双路径竞态，引导页发首条消息即触发）。修复：构造骨架前 `findSession` 回读本地记录，事件缺失的字段（parentID/slug/title/agent/model/metadata）从本地回填，事件显式携带的字段以事件为准；本地无记录（他端/CLI 新建）骨架原样入。竞态双向安全：事件先到 → POST 响应字段更全，覆盖无损；POST 先到 → 字段回填保留。替代方案否决记录：移动端 openbuilder 的「selected 事件回源 `GET /api/session/:id` 刷新」（`server_store.dart` `_refreshSessionMeta`）多一次 REST 往返且不覆盖创建竞态——字段级合并是零成本收口。
- **事件面全量审计与三层收敛策略（2026-10-07，design-sse-event-surface）**：M6c 盘点以活体抓包为基线，未比对 schema 定义全集——`session.revert.committed`（回滚提交信号）漏接，回滚暂存后发送新消息被本地残留回滚态整轮隐藏（60s 对账才自愈）。v2.0.18 全量审计矩阵（事件 × 发布者 × 客户端消费，分「应修 / 功能降级 / 无发布者勿接 / v1 死 case」四组，含「发布了但不在 ServerDefinitions 收不到」类陷阱）与「事件驱动 + 回执驱动 + 快照适配」三层收敛模式见 design-sse-event-surface；升 pin 事件面复核流程亦在该文档（审计基线必须是 schema 定义全集，不能是抓包）。

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
**实施修订 II（2026-09-29，活体推翻 M5/M6d 判断）**：v2.0.18 已把 worktree 迁至 WorktreeTable（`GET /api/worktree?projectID=` 库存 + `POST /api/worktree/refresh` 对账），`Project.sandboxes` 成为冻结 legacy 列（server 唯一写点 = upsertProject 的 insert 空数组，create/remove 均不维护）——「sandboxes 投影 + 项目列表 diff」在新 server 上等价失明：他端新建不显示、已删幽灵常驻且删除必 400。原案 v0.6 优化**提前强制落地**：库存直连 + refresh 对账 + union 合并进内部 sandboxes（闸门/作用域/快照同构复用），渲染库存优先；附带修正 create 响应为裸 `{directory}`（无 `{data}` envelope）。详见 design-worktree-sync §0。

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
| V2D-3 | 🟢 低（已解决，2026-09-29） | `GET /session/status` 消失后的状态对账细节（运行中会话的 UI 指示）未设计 | 落地记录：M3a 曾裁定「无端点、靠 finish 推断 + 事件收敛」——finish 推断只覆盖开 Tab 会话且只能清不能补，左栏漂移（卡绿/显灰）无收敛通道。活体重新调研发现 `GET /api/session/active`（drain 集合，缺席即不活跃）可做双向 diff，已落地 reconciler `onActiveSnapshot` → `reconcileActiveSnapshot`（决策矩阵见 design-typing-indicator §4）。review #1 修订（2026-09-29）：补在途竞态守卫（清 idle 看 `statusSetAt` 置位时刻 vs 快照发起时刻；补 busy 看本地消息终局证据）+ 60s 周期对账钳制残余漂移存活时间。完整 `/api/session/status` 发布后换绑端点即可恢复 retry 细节，对账框架不变 |
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
| **D7（V2D-3 修复，2026-09-29）** | **会话状态对账换绑 active**：`GET /api/session/active`（全局 drain 集合快照，`{ses_x: {type:"running"}}`，缺席 = 不活跃；v2.0.18 活体核对）作为断连窗口状态漂移的权威收敛源——reconciler 末段拉取后与本地 `sessionStatus` 双向 diff（清 stale busy/retry、补丢失 busy；retry 在场保留细节；乐观 in-flight 跳过；null 保留）。server 侧依据：drain 与 SessionStatus 生命周期绑定（run-state `onBusy`/`onIdle`、processor 的 retry 在 drain 内）。未来 `/api/session/status`（完整 Map，源码已有未发布）回归后换绑，恢复 retry 细节。**review #1 修订**：在途竞态守卫（`statusSetAt` vs `fetchedAt` + 消息终局证据，快照在途期间新旧事件交错的误置防护）+ 60s 周期对账（request 原只有 onReconnected 触发，残余漂移无自愈通道） |

### 修复复审

（文档为基线记录 + 已定决策，无代码改动。落地时按 plan 逐项 review，配套 `review-v2-*.md`；D1 的官方 API 回归核对点已入 plan-v2-protocol 复核清单。）

---

## 附录一：遗留待服务端更新项清单（2026-10-06 核对）

> 核对基准：上游 `anomalyco/opencode` v2.0.19–v2.0.24 标签（`packages/protocol/openapi.json` 逐 tag diff + 源码 grep）与 GitHub PR 实时状态（API 查询）。来源：本文档 D1–D7/V2D-x 决策点、spec-v0.5 功能降级表、plan-v2-protocol 复核清单、`docs/ref/ref-pseudo-project-cleanup.md`、openbuilder `docs/todo/`（todo-large-file-download-bun-keepalive、todo-ghost-worktree-projects）。
>
> **版本事实**（按 openapi 契约口径）：v2.0.19–v2.0.20 与 2.0.18 完全一致；v2.0.21 仅 form 取消携带 message（#52137）；**其余全部契约增量集中在 v2.0.23 tag 首见**（openapi.json 为发布期统一再生成产物，源码合入时间早于 tag——如 credential #52139 代码 09-29 已入）；v2.0.24 契约零变化。整体为**纯增量**：无删除/改名端点，已有 schema 只加可选字段，对 2.0.18 客户端向后兼容。

### 已解堵（服务端就绪，客户端可排期）

| # | 遗留项 | 来源 | 服务端变化（v2.0.23） | 备注 |
|---|--------|------|------------------------|------|
| A1 | **Provider credential 体系**（spec 降级 #2：无 API key 写入端点、无连接状态） | spec-v0.5 降级表、M6d | 新增 `GET/POST /api/credential`（#52139）：`Credential.CreateInput{integrationID, value, activate?, label?}`，`value` 支持 `Credential.Key`（`{type:"key", key}`，API key 型）或 OAuth 型；`Integration.Info` 内 `Connection.CredentialInfo/EnvInfo` 增 `status`（`Connection.Status`：`needs_auth` + message + url） | Provider 页签恢复的服务端前提已满足。**2026-10-06 修正**：原记「无 DELETE 端点」有误——`PATCH /api/credential/:id`（label）、`POST :id/activate`、`DELETE /api/credential/:id` 在 v2.0.23 源码与二进制均在（活体实测 DELETE 204 幂等），仅**生成的 openapi.json 滞后未收录**；另有 `POST /api/integration/:id/connect/key`（2.0.18 起可用，设置 key 正道）。已落地恢复：design-provider-config v2 重写 |
| A2 | **配对登录端点**（本文档 §认证层的设想） | §认证层、spec-v0.5 范围外 | 新增 `POST /api/pair`（`PairingCode{code, expires_in}`）+ `GET /auth/connect/{code}` | 客户端仍为范围外，按需另行 design |
| A3 | **persistent-pty 能力上报**（spec 范围外「v2 新能力」） | spec-v0.5 范围外 | `ServerInfo.capabilities.persistentPty`（Windows false，其余 true，#52760）；重启不破坏 pty 移交（#52573）；bun-pty 0.4.9 修 spawn 首段输出丢失（#52960） | 终端 Tab 能力闸门可改读该字段，替代客户端平台判断 |
| A4 | （间接）非 git 项目 git init | ref-pseudo-project-cleanup（伪项目成因） | 新增 `POST /api/vcs/init`（#51455） | 给非 git 目录伪项目行提供「转正」通道；**不是回收机制**，死目录燃料模型不变。**注意**：init 不建首提交——零提交 resolve 落 `ID.global` 桶（见附录二身份规则）。init 后主动 resolve+invalidate，转正即时生效 |
| A5 | （顺带）location 目录缺失报错规范化 | ref-pseudo-project-cleanup §6「PATCH 死目录会话 500」 | #52668：location 目录缺失由 500 改 404（session-location 中间件 + 多端点 `declaredStatuses` 补 404） | D1 私约对死目录会话的 PATCH 应由 500 转 404；待活体复核后更新 ref 文档处置方式 |

### 未解决（私约/兜底继续，证据为 2026-10-06 核对）

| # | 遗留项 | 现行兜底 | 核对证据 |
|---|--------|----------|----------|
| B1 | **归档 API 回归**（D1 私约 `metadata.archivedAt` 的迁回触发点） | metadata 私约 + 识别层双源 | v2.0.24 PATCH `/api/session/{sessionID}` payload 仍只有 title/metadata/permissions；v2.0.18..24 零 archive 提交；PR #47848（unarchive）GitHub 实查 open/未合 |
| B2 | **`GET /api/session/status` 完整状态端点**（retry 细节恢复，D7） | `GET /api/session/active` 双向 diff 对账 | v2.0.24 路径全集无此端点 |
| B3 | **文件监听自动刷新**（spec 降级 #3：无 `file.watcher.updated` 事件、无 watch 端点） | 重开文件 Tab / 切作用域 / 重连对账重拉；链路代码保留 | v2.0.19–24 无 watch 路径；事件 schema 名单 v2.0.18→24 零变化 |
| B4 | **大文件下载被 Bun keepAliveTimeout 截断**（openbuilder todo，🔴 >20MB 慢链路 100% 失败） | 无（客户端明确不做续传——server 不支持 Range） | PR #50507（4 行 `keepAliveTimeout=0`）实查 open/未合；v2.0.24 源码 grep 零命中 |
| B5 | **worktree create 恒 detached**（上游 #26931 未合） | 本端 `POST /api/shell` 挂 `opencode/{name}` 分支 + 删除时 canonical 下 `branch -D`（design-worktree-branch-sync） | v2.0.24 `git.ts` `worktree add --detach` 仍硬编码 |
| B6 | **伪项目回收机制**（server 只 upsert 不删、重启解析 cwd 复活、`project.sandboxes` 冻结列无写 API） | 客户端指纹过滤 + SQL 手工清理（ref-pseudo-project-cleanup） | v2.0.18..24 project 层仅 refactor（#51729），无回收机制；上游 issue 仍未提（ref §8 待办）。身份模型与解析时机核对见附录二——「upsert-only 无回收」是配套缺陷而非身份模型问题 |
| B7 | **todo 概念回归**（spec 降级 #1：任务卡全链移除） | 无（消息流内计划文本不受影响） | 无端点无事件，概念仍在 server API 层面缺席 |
| B8 | **文件树 ignored 弱化样式**（spec 降级 #4） | 无害降级（dot 文件仍展示） | `FileSystem.Entry` schema 无变化，仍无 gitignore 标记 |

### 对复核清单的影响

- plan-v2-protocol 复核清单「归档 API 回归（D1 迁移触发点）」**保留**，复核面收窄为：PATCH payload 扩字段 / 新归档端点 / PR #47848 合并状态。v2.0.19–24 上游零动作，复核周期可放宽（建议改为跟随 minor 版本升级评估，不再逐里程碑核对）。
- A1/A2 就绪后，spec-v0.5「范围外 v2 新能力」中的 credential 体系与配对 UI 可进 v0.6+ 设计排期。
- 若升级本机 server 至 ≥2.0.23：通信层无需改动（契约向后兼容）；可选消费 A3（persistentPty 闸门）与 A5（死目录 PATCH 由 500 转 404 的错误分类）。

---

## 附录二：项目身份模型与解析时机（2026-10-07 源码核对，v2.0.23）

> 背景：A4（`/api/vcs/init`）调研延伸出的机制核对。与 ref-pseudo-project-cleanup（伪项目清理）互为表里：该 ref 记「怎么清」，本节记「身份怎么算、何时重算」。源码锚 `packages/core/src/project.ts`、`git.ts`、`location*.ts`。

### 身份规则（`Project.resolve`，project.ts:337-380）

| 仓库状态 | projectID | 说明 |
|---|---|---|
| 有 `origin` remote | `sha1("git-remote:" + 归一化URL)` | **只看 origin**，其他 remote（upstream/fork/backup）不参与；无 origin 但有其他 remote = 等同无 remote |
| 无 origin、有 `.git/opencode` 文件 | 文件内容 | 身份缓存文件（可手工钉死 ID） |
| 无 origin、有提交 | 根提交（root commit）哈希 | 无 remote 也有稳定身份；改写历史/重置首提交会换 ID |
| **无 origin 且零提交** | `ID.global` | **陷阱**：所有空仓共享一个桶——`git init` 后必须至少 commit 一次才有独立身份（`/api/vcs/init` 也只跑裸 init 不建首提交） |

URL 归一化（project.ts:273-291）：HTTPS/SSH/scp 语法归一为 `host/path`；host 转小写、剥 `.git` 尾；**path 保留大小写**（`User/Repo` ≠ `user/repo`，GitHub 实际不区分——潜在分裂点）；`file://` 显式拒绝（避免本地路径混入身份，等同无 remote）。

### 多 clone 语义（"Clones share a project ID"，源码注释原话）

同一 origin 的多份 clone = **同一行项目**：

- **canonical 单值、先到先得**：`upsertProject` 冲突时只更新 vcs 列不碰 canonical（sql.ts:56-59）；替换唯一路径 = 旧 canonical 磁盘消失（persist 显式 UPDATE）→ 删除处理让位是自动的，但「谁是主」取决于解析顺序（任意性）。`PATCH /api/project/:id` 可手动改（D4 红利依据）
- **每份 clone 目录都登记**进 `WorktreeTable`/`project_directory` → `GET /api/worktree?projectID=` 全部返回 → 本端左栏 = 同一项目下多个工作区条目
- **删除影响面跨 clone**：删项目行级联物理删**全部 clone** 的会话（ref §4 危险点放大）；rm -rf 单份 clone 的库存死行由 refresh 清
- fork（origin 不同）天然两项目，不合并

### 解析时机（何时重算身份/转正）

| 触发 | 机制 | 生效 |
|---|---|---|
| 该目录新建会话 | `Session.create` 每次直调 `projects.resolve()`（session.ts:271，无缓存） | 立即 |
| location 缓存逐出后重建 | 服务栈按目录缓存在内存 LayerMap，构建时才 resolve（location.ts:24） | 逐出后下次触碰 |
| ├ 空闲 60 分钟自动逐出 | location-activity TTL sweep（每分钟检查）。**TTL 到点会就地 interrupt 该 location 运行中会话**（reason `"inactivity"`），非只清空闲 | 最长 1 小时 |
| ├ `POST /api/location/reload` | 逐出全部已加载 location | 手动即时 |
| └ server 重启 | 内存缓存清空，按需重建 | 手动 |
| `GET /api/project` | **纯 DB 读不触发解析** | — |

`/api/vcs/init`（handlers/vcs.ts:46-52）与手动 `git init` 的差异：init 后主动 `resolve()` 落库 + `locations.invalidate()` + 发 `worktree.updated`——即时生效，不等触发时机。

### 设计评估（一句话：认血统修了认位置的病，但没配销户流程）

身份模型本身自洽（修 v1 目录身份的搬家断链之痛，跨端同仓同 ID）；不合理在配套四点：① **upsert-only 无回收**（伪项目根源，B6）；② canonical 先到先得的任意仲裁；③ 零提交落 global 桶无提示；④ URL 归一化大小写不对称。本端展示层兜底见 ref-pseudo-project-cleanup §8。
