# 契约基线升级审计：2.0.18 pin → 2.1.3 pin（2026-10-25）

> 状态：已完成审计并落新 pin。触发：本机 server 已随 CachyOS 仓库升到 2.1.3，pin 停在 2.0.18 跨了两个 minor 段。
> 方法：按 design-sse-event-surface §5 升 pin 三步（schema 定义 diff → 发布者核查 → 客户端 case 比对），REST/schema 面加做 **ref 解析语义 diff**（把 2.1.x 大规模的品牌化 `$ref` 抽取——内联 `{type:"string"}` 换 `Session.ID`/`AbsolutePath` 等——解析回扁平树再比，过滤掉这类纯机械重构）。
> 数据源：`../openbuilder/opencode_openapi_v2.json` 旧 pin（2.0.18 + 本地补的 pair 两端点）；新 pin = 本机 2.1.3 server `GET /openapi.json`（`tool/gen_client.sh` 既有流程），已核与 GitHub `v2.1.3` tag 的 `packages/protocol/openapi.json` **JSON 语义一致**（非逐字节——server 输出 minified 284873 字节、tag 文件 pretty-printed 595993 字节，且 `components/schemas` 键序不同，排序规范化后相等）；事件面对照 `packages/schema/src` 两 tag 源码（118 → 115 个事件定义；新侧取 v2.1.4 tag——其事件面与 2.1.3 逐定义一致，event-manifest 两 tag 无 diff）。
> 规模：paths 115 → 121（+6/−0）、schemas 247 → 293（+54/−8，净 +46）——新增 54 个中约 30 个为品牌化 `$ref` 抽取（`*.ID`/`*.Name`/`Native*`/`AbsolutePath` 等，无新语义），余 24 个承载新语义（voice ×10、credential ×7、错误编码等）；删除的 8 个全部是 `ProviderState*`/`ProviderContext*`（§1 改名/删除的下脚料）。

## 1. 破坏性/重命名（客户端已核对全部无感）

| 变化 | 细节 | 客户端影响 |
|---|---|---|
| 消息 part `state`/`providerState` → `native` | Assistant.Text/Reasoning 的 `state`、Assistant.Tool 的 `providerState`/`providerResultState` 统一改名 `native`（`{type:"object"}` 不透明） | 无——桌面端从未建模这三个不透明字段（api-v2-types 无、v2-adapter 不读） |
| Compaction 消息字段删除 | `Session.Message.Compaction.Completed/Running` 删 `recent`（原 required）、`providerState`；Completed 另删 `providerContext` | 无——桌面端不读 `.recent`/providerContext |
| `Session.Inbox.Compaction(Payload)` 放宽 | payload 从 `object \| array` 收敛为 `not: null`（任意非空） | 无——桌面端把 compaction 当非过滤项，无形状依赖 |
| `WorktreeError` envelope + `_tag` | 400 错误体 `{name, data}` → `{_tag, name, data}`（`_tag` required） | 无——rest-client 按 `name`+`data` 解析，加法字段 |
| SSE 帧 `id` 不再 required | `GET /api/event` 200 流 schema required `[id,event,data]` → `[event,data]`；活体帧本就 data-only（type 在 JSON 内），schema 追认现实 | 无 |

## 2. 归档链路官方化（**D1 迁回条件成立**——移动端已迁回（openbuilder design-archive-metadata §迁回官方归档 API，2026-10-25），桌面端待迁）

| 端点/事件 | 形状 | 活体验证（2026-10-25，本机 2.1.3） |
|---|---|---|
| `PATCH /api/session/:id` body + `archived: boolean \| null` | 204 无 body；`true` 置 `time.archived`、`false` 清除 | ✅ 归档→`time.archived=1792895938520`；`false`→清除 |
| `GET /api/session?archived=true\|false` | 过滤参数（true=仅归档/false=排除，缺省=全量） | ✅ 归档后 `archived=true` 命中、列表数吻合 |
| `session.archived` / `session.unarchived` 事件（durable，新增） | payload `{sessionID}`，durable envelope `{aggregateID, seq, version}`，信封带 `location`（活体见 directory） | ✅ 两事件均抓到（data-only 帧） |
| `Project.Time.archived` + `GET /api/project?archived=` | 项目级归档面（新） | schema 证实，未活体 |

读路径 `Session.Info.time.archived` 2.0.18 已有（D1 当时判定「只读、无写入路径」），本次补齐的是**写路径 + 过滤 + 事件**三件套。

## 3. 加法（新端点/新字段，客户端暂不消费）

- **新端点**（6 个路径 7 操作，全 experimental/边缘面）：`GET/POST /api/credential`（凭据列/建，`Credential.Entry`）、`POST /api/vcs/init`（`VcsInitNotSupportedErrorEncoded`）、`POST /api/integration/:id/connect/external`（external 连接方式，`Connection.CredentialInfo.method` enum + `external`）、`GET /api/experimental/voice/models` + `POST /api/experimental/voice/session` + `POST .../instructions`（voice 三件套）。
- **`POST /api/session` body + `parentID`**：客户端自建子会话可用（child ID 同步可得、location 继承父会话，源码 `handlers/session.ts` 已核）——未来桌面端自有子会话入口/后台任务流的使能项。注意**对既有命令乐观消解无直接简化**：命令子会话仍由 server 内部派生（SubagentJob）、204 不带 child ID，`session.created` 出生探测（design-optimistic-id-anchor §4b 层 1b）仍必要。
- **`ServerInfo.capabilities.persistentPty`**（`GET /api/info`）：persistent-pty 能力旗标（端点 2.0.18 已有，本次补能力声明；桌面终端用 `/api/pty` 非 persistent，不受影响）。
- **错误面规整**：404 `LocationNotFoundError` 大面积补进 location 域端点（伪项目防御的 `evictLocation` 死目录场景会得到更明确错误）；多个 404/400 schema 从精确对象改 anyOf 错误 union（变宽，解析容错要求不变）。
- **模型目录**：`Model.Capabilities` + `temperature`（bool）、`reasoning` 形状化；`Model.Compatibility` + `cacheFormat`/`streamUsage`/`supportsEffortUpdates`/`supportsThinkingBlockBinding`；`releaseDate`。agent/model 切换 UI 暂不消费。
- **`Session.Message.Idle` + `error`**、**`Session.StructuredError` + `response.body`/`retryAfterMs`**：错误呈现更丰富，加法。
- **Config 面**：`experimental.policies` 的 action enum 从 `["provider.use","permission"]` 改为 `["provider.use","tool.use","integration.use"]`（**`permission` 被替换，非纯加法**）；顶层（非 experimental）`policies` 为新增；`experimental` 新增键 `location_idle_timeout`/`todo`（`background_compaction` 在 config 源码存在但**未进 spec**，两版 pin 均无此键）；provider/model settings + `encoding`（zstd/gzip/none）。

## 4. 事件面（118 → 115，逐项）

| 方向 | 事件 | 说明 |
|---|---|---|
| + | `session.archived` / `session.unarchived`（durable） | §2；桌面 handleEvent 暂无 case——属 D1 迁回工作项，非缺口 |
| − | `session.compacted`（ephemeral） | 2.0.18 已有 `session.compaction.started/delta/ended/failed` 家族替代；桌面未消费被删者 |
| − | `question.asked/rejected/replied`（ephemeral） | question 体系消亡（form 取代）；桌面未消费 |
| − | `ide.installed`（ephemeral） | 桌面未消费 |
| 不变 | `session.status` / `session.idle` | 两版均定义、均无发布者（typing-indicator 兼容保留判断维持，见 design-typing-indicator §表格） |
| 不变 | `worktree.ready` / `worktree.failed` | 仍定义、仍无发布者（core `worktree.ts` 只 publish `Event.Updated`）——design-sse-event-surface 表 C/D 结论维持，移动端记载冲突裁定无需翻转 |
| 仍缺 | `file.watcher.updated` | 2.1.3 事件全集仍无此定义（spec-v0.5 降级表 #3 维持）；仅有 `filesystem.changed`（唯一发布者只监听 `.git/HEAD`，design-sse-event-surface 表 B 记载维持） |

客户端消费的 50 个事件 case 逐一比对：无被删者、无改名者（`session.next.*` 式静默改名本轮没有）。

## 5. pin 与版本事实

- 新 pin = **2.1.3**（121 路径/293 schema，284873 字节）；上游最新 tag **v2.1.4**，差 3 个路径（`POST /api/debug/heap-dump`、`GET /api/experimental/client-mcp`、`POST /api/experimental/client-mcp/token`，均 debug/experimental），无客户端价值，待 server 升级自然带入。
- 旧 pin 本地补的 `/api/pair` + `/auth/connect/{code}` + `PairingCode`/`PairingSession` 已被上游收编：`/api/pair` 定义与本地版**逐字节一致**，`/auth/connect/{code}` 的 401 schema 上游精化（anyOf → 精确对象）——新 pin 全量上游化，本地补丁归零。
- npm `opencode-ai` 的 `latest` 仍是 v1 线（1.19.4，2026-10-22）；2.x 走 `dev` dist-tag（`0.0.0-dev-*`），GitHub Release 不挂 2.x——**2.x 无稳定版渠道，pin 挂运行中 server 是既有流程的正确姿势**。

## 6. 验收

- [x] ref 解析语义 diff 覆盖全部 121 路径 + 293 schema，实质变化全量落档（本表 1–4 节）
- [x] 事件面三步审计走完（定义 diff / 发布者 grep / 客户端 case 比对），无静默漏网
- [x] 归档链路活体四点验证（PATCH 置/清、过滤参数、双事件帧）
- [x] pin 文件经 `tool/gen_client.sh` 刷新，与 GitHub v2.1.3 tag 语义一致（JSON 等价；格式与键序差异见头部数据源注）
