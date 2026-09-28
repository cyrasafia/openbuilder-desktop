# V2 迁移实施计划 — 协议层（plan-v2-protocol） — 计划文档

> 依据：`docs/design-v2-migration.md`（D1–D5 与双兼容已裁定，v0.5 起仅支持 v2）。
> 范围：通信层（REST client / wire 类型 / SSE / 对账）与连接流程的 v2 切换。
> 不在本文：消息渲染管线（plan-v2-chat）、worktree 交互（plan-v2-worktree）、终端（plan-v2-terminal）——协议层为其供给契约。
> 契约参考源：`../openbuilder/opencode_openapi_v2.json`（官方 `packages/protocol/openapi.json` 2.0.18 拷贝，与移动端同源惯例）；源码核对锚 `anomalyco/opencode` `v2` 分支。

## 模块策略（迁移期结构，最终收敛）

- **新增自包含模块**：`src/shared/api-v2-types.ts`（wire 类型，按里程碑增量补字段）+ `src/shared/rest-client-v2.ts`（v2 client，**最终命名**，不与 v1 方法临时共存）。错误分类/鉴权/fetch 管道在 v2 模块内自持（复用 v1 的 ApiError 会造成收敛期反向依赖）；
- app-store 等调用方按里程碑**逐子系统换绑**到 v2 client（测试 mock 同步换绑）；
- **收敛步（M6）**：删除 `rest-client.ts`/`api-types.ts` v1 面，`rest-client-v2.ts` 更名为 `rest-client.ts`（或调用方 import 统一改指），全局 grep 无 v1 路径残留；AGENTS.md 契约约束与 spec 同步修订，版本号升 0.5.0 + tag。

## 里程碑

### M0 契约 pin 与 v2 client 骨架（本计划随附交付）

- `../openbuilder/opencode_openapi_v2.json` 拷贝入库（113 路径）；
- `api-v2-types.ts`：M1 所需最小面——`ServerInfo`、`ProjectInfo`（canonical/active/sandboxes）、`LocationRef`/`LocationInfo`、`SessionInfo`（列表最小字段）、`CursorPage<T>`、`ListSessionsInput`；
- `rest-client-v2.ts`：fetch 管道（Basic auth 用户名固定 `opencode`、超时、ApiError 分类）+ 四个读方法：`serverInfo()`、`listProjects()`、`resolveLocation(directory?)`（deepObject query）、`listSessions(input)`（flat query + `{data, cursor}` envelope + parentID null 语义）；
- 单测 `rest-client-v2.test.ts`：URL 构建（deepObject/flat 两种风格）、鉴权头、envelope 解析、空体容忍、401/400 错误分类；
- **验收**：`npm run test` 全绿 + `npm run typecheck` 通过；对 127.0.0.1:15120（v2.0.18）手测四方法返回真实数据。

### M1 连接与项目发现

- app-store 连接流程换绑：探活 `/global/health` → `/api/info`（`serverInfo()`）；**连 v1 server 的明确报错指引**（双兼容裁定：错误指引而非分派——探活 404/HTML 即判 v1，提示「server 版本不支持，需 opencode v2」）；
- 401 凭据交互沿用现有 prompt 流（app-store.ts:756-774 已有 username 默认 `opencode` + 401 弹窗，无需新做，仅验证对 v2 生效）；
- `listProjects()` 换绑左栏数据源（`ProjectInfo.canonical` 替代 `worktree` 字段，basename 展示逻辑不变）；`resolveProject(/project/current)` → `resolveLocation(directory)`（返回含 project{id, directory, canonical}）；
- global 项目发现：`GET /session?scope=project&directory=/` → `listSessions({})` 无过滤**翻页全量**（cursor 循环拉取，limit 取上限）→ 按 `location.directory` 分组；`openedGlobalDirectories` 闸门语义保留；
- 验收：真实 server 上连接 → 项目列表渲染 → global 目录发现全通；`app-store.test.ts` 连接/项目用例换绑 v2 mock。

### M2 会话域（列表/创建/归档）

- `createSession`（POST /api/session：location 对象 payload）、`getSession`、`deleteSession`（连子会话）、`updateSession`（PATCH：title/**metadata**）；
- **D1 落地**：`archiveSession(id, archivedAt)` = `updateSession` 写/清 `metadata.archivedAt`；store 的归档识别改读该字段（识别/对称逻辑不动）；列表过滤客户端做；
- Tab 归档语义（关 Tab = 归档）在 app-store 换绑；
- 验收：关 Tab → 重连后会话不在列表（归档过滤生效）；开 Tab → 字段清除。

### M3 SSE 与对账

- `sse-subscriber` 换绑：`GET /api/event`（无 query 单流）+ `V2Event` envelope（`{id, created, metadata?, location?, type, data}`）；事件表按 `session.*` 命名空间重写（映射见移动端基线 §SSE 事件契约）；
- **volatile 契约落地**：重连必全量对账（对账触发从「增量 reconcile」升级为「全量快照重建」）；`/session/status` 快照删除——状态改事件驱动（`session.execution.*`/`session.idle`）+ `SessionInfo.outcome`；
- 事件闸门：`location.directory` 为闸门键（PublicRef 无 workspaceID，口径以客户端可见为准）；
- 验收：断流/重连场景（含 kill server）全量恢复；慢消费断流不 panic。

### M4 消息域（供给 plan-v2-chat）

- `listMessages`（typed union + `type` 过滤 + body cursor 双向）、`sendMessage`（prompt 200 + `SessionInbox.User` 回执）、`interrupt`、`fork`、`revert` 三段式、`command`、`form` 体系；
- 乐观消息管线改回执驱动；
- 验收：发送→流式渲染→undo 全链路（与 plan-v2-chat 联合）。

### M5 worktree 域（供给 plan-v2-worktree）

- `listWorktrees(projectID)`、`createWorktree`、`deleteWorktree`（D2：级联删会话在 store 层组合）、`refreshWorktrees`（对账触发点：SSE 重连 + 选择器打开）；
- `location.reload`/`debug evict` 不接（D5）；`instance/dispose` 调用点删除；
- 验收：D2 交互（删除后消失/外部删除对账消失）。

### M6 收敛与发版

- 删除 v1 面（rest-client.ts/api-types.ts 及 v1 测试）、v2 模块更名、全局 grep `/session?` `/project` `/global/event` 等无残留；
- AGENTS.md（联调说明、契约约束、归档锁定语义修订）、spec v0.5、版本号 0.5.0 + `git tag v0.5`；
- 验收：`npm run test`/`typecheck` 全绿；打包冒烟。

## 落地前复核清单（每里程碑启动时过一遍）

- 官方 `packages/protocol/openapi.json` 当期 diff（vs 本仓库 pin 版本），重点：事件清单、消息 union 枚举、form 体系、**归档 API 是否回归（D1 迁移触发点）**；
- 本机 15120 server 版本（现 v2.0.18，Basic auth 密码见 systemd unit）。

## 风险

- v2 小版本契约漂移 → 每里程碑复核 pin；
- app-store 体量（~6000 行）换绑面大 → 逐里程碑小步提交，每步测试全绿；
- SSE 事件表重写波及渲染层 → M3 与 M4 之间设联合验证点。
