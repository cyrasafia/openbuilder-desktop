# V2 迁移实施计划 — 协议层（plan-v2-protocol） — 计划文档

> 依据：`docs/design/design-v2-migration.md`（D1–D5 与双兼容已裁定，v0.5 起仅支持 v2）。
> 范围：通信层（REST client / wire 类型 / SSE / 对账）与连接流程的 v2 切换。
> 不在本文：消息渲染管线（plan-v2-chat）、worktree 交互（plan-v2-worktree）、终端（plan-v2-terminal）——协议层为其供给契约。
> 契约参考源：`../openbuilder/opencode_openapi_v2.json`（官方 `packages/protocol/openapi.json` 2.0.18 拷贝，与移动端同源惯例）；源码核对锚 `anomalyco/opencode` `v2` 分支。

## 模块策略（迁移期结构，最终收敛）

- **新增自包含模块**：`src/shared/api-v2-types.ts`（wire 类型，按里程碑增量补字段）+ `src/shared/rest-client-v2.ts`（v2 client，**最终命名**，不与 v1 方法临时共存）。错误分类/鉴权/fetch 管道在 v2 模块内自持（复用 v1 的 ApiError 会造成收敛期反向依赖）；
- app-store 等调用方按里程碑**逐子系统换绑**到 v2 client（测试 mock 同步换绑）；
- **收敛步（M6a–M6d）**：逐批换绑剩余 v1 消费面后，删除 `rest-client.ts`/`api-types.ts` v1 面，`rest-client-v2.ts` 更名为 `rest-client.ts`（或调用方 import 统一改指），全局 grep 无 v1 路径残留；AGENTS.md 契约约束与 spec 同步修订，版本号升 0.5.0 + tag。

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
- **global 语义退役（用户裁定 A，2026-09-28，M1b 落地）**：原案「global 发现改无过滤翻页全量 + openedGlobalDirectories 闸门保留」**作废**——v2 实测无 global 项目行（非 git 目录 = 目录哈希伪项目行），非 git 目录以普通项目行进左栏，v1 的 `global\0<dir>` entry 模型/发现快照/事件闸门 global 分支整体删除；持久化旧键由 `migrateLegacyGlobalState` 连接期按 worktree 匹配迁移（实测：本机两个 profile 的旧键均能命中项目行）；新目录发现 = 项目列表刷新（连接/选择器打开 syncWorktrees/60s diff/M3 起 project.updated）；
- 验收：真实 server 上连接 → 项目列表渲染 → global 目录发现全通；`app-store.test.ts` 连接/项目用例换绑 v2 mock。

### M2 会话域（列表/创建/归档）

- `createSession`（POST /api/session：location 对象 payload）、`getSession`、`deleteSession`（连子会话）、`updateSession`（PATCH：title/**metadata**）；
- **D1 落地**：`archiveSession(id, archivedAt)` = `updateSession` 写/清 `metadata.archivedAt`；store 的归档识别改读该字段（识别/对称逻辑不动）；列表过滤客户端做；
- Tab 归档语义（关 Tab = 归档）在 app-store 换绑；
- 验收：关 Tab → 重连后会话不在列表（归档过滤生效）；开 Tab → 字段清除。

### M3 SSE 与对账

- `sse-subscriber` 换绑：`GET /api/event`（无 query 单流）+ `V2Event` envelope（`{id, created, metadata?, location?, type, data}`）；事件表按 `session.*` 命名空间重写（映射见移动端基线 §SSE 事件契约）；
- **volatile 契约落地**：重连必全量对账（对账触发从「增量 reconcile」升级为「全量快照重建」）；`/session/status` 快照删除——状态改事件驱动（`session.status`/`session.idle`）+ `GET /api/session/active` 对账（V2D-3 修复 2026-09-29：reconciler 末段 `onActiveSnapshot` 双向 diff，详见 design-typing-indicator §4 与 design-v2-migration D7；`SessionInfo.outcome` 未采用——idle 消息经 v2-adapter 丢弃，failed 终局由 assistant `error` 字段派生已冗余覆盖）；
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
- **补录（2026-09-29）**：`listWorktrees`/`refreshWorktrees` 当日落地消费（原 M5/M6d 判定「sandboxes 投影够用、直连列 v0.6」被活体推翻——v2.0.18 起 sandboxes 是冻结 legacy 列，详见 design-worktree-sync §0）；`createWorktree` 响应裸 `{directory}`（无 envelope）同日修正。

### M6 收敛与发版（2026-09-29 拆分为 M6a–M6d）

原 M6 单体拆分为四批——审计发现剩余 v1 消费面远超单 turn 量（pty/文件/diff/权限/命令五大子系统），逐批换绑每步测试全绿。

#### M6a 交互核心恢复（P1：权限/agent/model 切换）

- `respondPermission` → `POST /api/session/:id/permission/:requestID/reply`；
- `replyQuestion`/`rejectQuestion` → v2 form 体系 `POST /api/session/:id/form/:formID/reply`；
- `switchAgent`/`switchModel` → `POST /api/session/:id/agent` 与 `/model`（过渡 /api 面已有路径，只需换 client）；
- 验收：授权弹窗按钮可用、会话默认 agent/model 可设置。

#### M6b 文件/diff/终端（P2：Tab 三类恢复）

- `readFileContent` → `GET /api/fs/read/*`（deepObject location）；
- `findFiles` → `GET /api/fs/find`；
- `listSessionDiff` → `GET /api/session/:id/diff?from&to&context`（turn 语义）；
- `listVcsDiff` → `GET /api/vcs/diff`（deepObject + base 参数）；
- pty 六方法 → `POST/PUT/DELETE /api/pty` + `connect-token` + WS connect（路径不变，只换 client——**ticket/WS 契约需逐项核对**，V2D-2）；
- 验收：文件 Tab 打开/搜索、diff Tab 双模式、终端 Tab 创建/退出分流。

#### M6c 命令面板与 pending（P3：设计决策 + 死代码清理）

- `listCommands`/`sendCommand`：v2 `GET /api/command` 注册制不同（无外部 skill 扫描、不合并 skill）——**设计决策**：换绑（命令集缩小）或降级隐藏入口（v0.5 无斜杠命令，v0.6 评估）；
- `listSessionTodos` → 删除（v2 无 todo 端点）；
- `backfillPending`（listPendingPermissions/listPendingQuestions）→ v2 `GET /api/permission/request` + form 待办，或删（reconciler 的 pending 阶段 v2 下恒 null）；
- 死代码清理：`commandEchoPending`、`applyStatusSnapshot`、v1 死 case（message.updated user 分支/message.removed/message.part.removed/todo.updated/catalog.updated）、reconciler 死 import（SessionStatusValue/toInternalMessages）。

**已落地（2026-09-29）**：命令域换绑 `/api/command` + `/api/skill` 合并（skill 斜杠触发，source 标记——对齐移动端 listCommands，命令集不缩小）；sendCommand body 换 `{name, text, files}`（timeoutMs: 0 保 SC-4 不设超时，评审 R1）。todo 体系全链删除（事件 case/`sessionTodos`/TodoCard/`session-todos.ts` 模块/i18n 键/todo 样式，server 侧概念消失；api-types 的 Todo 死类型留 M6d 随 v1 面删）。pending 回填换绑 v2 两端点（reconciler 与 backfillPending 同步，questions 以归一化形态回调）。死代码按清单清理（`applyStatusSnapshot`/`mergeStatusSnapshot`（含 session-status 侧函数与用例）/scheduleCatalogRefresh/two status-snapshot 用例；`commandEchoPending` 改挂 `session.inbox.enqueued` 而非删除——见下）。

**盘点发现（活体 SSE probe）**：① v2 user 消息经 `session.inbox.enqueued|delivered` 落地（`session.message.content.updated` 实测未发）——M4 漏了「他端消息实时落地」，本批补 `refreshConversationTail`（enqueued → 已加载会话首页重取合并，新增 user 清乐观 = v1 user 分支对称语义，in-flight 去抖；**非 user 项（compaction 等）过滤**，评审 Y1）；`session.inbox.delivered` 同挂重取，闭合 busy 排队补充的「悬挂乐观→双气泡」缺口（评审 Y3）；`message.updated`/`message.part.updated` case 保留（翻译层 step.started/streamPartUpsert 合成使用），仅删 user 分支与 `message.removed`/`message.part.removed`/`todo.updated`/`catalog.updated` 死 case。② **file.watcher 缺口**：2.0.18 事件全集无 `file.watcher.updated`、无 watch 端点——文件监听自 M3 起静默失效（重开/切作用域重拉兜底），case 与链路保留待上游恢复，spec-v0.5 记功能降级。

#### M6d 收敛发版

**已落地（2026-09-29）**：v1 面删除（rest-client.ts 原文件 + v1 测试 + api-types 的 HealthInfo/ConfigProviders/ProviderCatalog/ProviderInfo(v1)/Todo/PtyShell 死类型 + model-catalog 的 parseModels/parseCatalog）；`rest-client-v2.ts` 更名 `rest-client.ts`、类名 RestClientV2 → RestClient、AppStore 双字段合一（client 即 v2 唯一实例）；main 进程两处 v1 探活换绑（managed-server 健康等待 + scan 发现扫描 → `GET /api/info`，v2 版本前缀校验）；**Provider 页签降级移除**（v2 credential/integration 无 API key 写入路径——spec-v0.5 降级表 #2）；欢迎屏测试连接换 serverInfo（unsupported → 「需要 v2」指引）。全局 grep 无 v1 根路径调用残留（注释中的历史提及已改写或加注记）。

- 删除 v1 面（rest-client.ts/api-types.ts 及 v1 测试）、`rest-client-v2.ts` 更名 `rest-client.ts`（或 import 统一改指），全局 grep `/session?`（根路径）/`/project`（非 /api 前缀）/`/global/event` 等无残留；
- AGENTS.md（联调说明、契约约束换 pin 至 opencode_openapi_v2.json、归档锁定语义修订——D1 metadata.archivedAt）、spec-v0.5、版本号 0.5.0（package.json + PKGBUILD + spec 三落点）+ `git tag v0.5`；
- 文档同步复核：`docs/design/design-pending-cards.md`（M6a 已改写 v2 契约，检查回填节 M6c 改动后是否仍一致）、其余 design 文档中残留的 v1 端点引用（grep `/session`、`/permission`、`/question` 等根路径）；
- 验收：`npm run test`/`typecheck` 全绿；打包冒烟（`npm run package:linux`）。

**已落地（M6 首批，`f9928f3`）**：createWorkspace v2 换绑丢失修复（M5 脚本中断）+ Reconciler 会话/消息快照换绑 v2（v1 listSessions/listMessages 在 v2 server 全 404——重连对账的消息恢复路径断裂）。

## 落地前复核清单（每里程碑启动时过一遍）

- 官方 `packages/protocol/openapi.json` 当期 diff（vs 本仓库 pin 版本），重点：事件清单、消息 union 枚举、form 体系、**归档 API 是否回归（D1 迁移触发点）**；
- 本机 15120 server 版本（现 v2.0.18，Basic auth 密码见 systemd unit）。

## 风险

- v2 小版本契约漂移 → 每里程碑复核 pin；
- app-store 体量（~6000 行）换绑面大 → 逐里程碑小步提交，每步测试全绿；
- SSE 事件表重写波及渲染层 → M3 与 M4 之间设联合验证点；
- pty WS 契约（ticket/connect/退出分流）在 M6b 前未逐项核对——**M6b 首项任务**（V2D-2），核对不可跳过；
- 斜杠命令 v2 注册制差异（无外部 skill 扫描）是 M6c 的**设计决策**而非纯换绑——命令集缩小对用户可感知，需产品判断。
