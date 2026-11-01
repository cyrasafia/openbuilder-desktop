# 契约基线升级审计：2.1.3 pin → 2.2.0（2026-10-28）

> 状态：**审计完成，pin 未动**。pin 实落的前置条件：① 本机 server 实升 2.2.0（pacman 现 2.1.4-1.1，2.2.0 发布于 2026-10-27，Arch 包未跟进）；② 移动端 pin 文件改动另行征得同意（`../openbuilder` 只读约定）。
> 触发：2026-10-27 会话评估 v2.2.0 更新对本项目的影响。
> 方法：同 ref-pin-bump-2.1.3 三步（schema 语义 diff → 发布者/事件面核查 → 客户端消费集比对）。本轮无大规模品牌化 `$ref` 重构，语义 diff 直读。
> 数据源：旧 pin = `../openbuilder/opencode_openapi_v2.json`（2.1.3 server 活体输出）；新侧 = GitHub tag `v2.2.0` 的 `packages/protocol/openapi.json`（662863 字节）。**未经活体 server 核验**（本机未升 2.2.0）——2.1.3 审计已证 server 输出与 tag 文件 JSON 语义一致，本轮沿用该信任，升 pin 时按 `tool/gen_client.sh` 流程重出并复核。事件面对照 `packages/schema/src` 两 tag 源码 diff。
> 规模：paths 121 → 130（+10/−1）、schemas 293 → 337（+44/−0，纯加法）、事件面定义 115 → 115（零增删改）。

## 1. 收窄/破坏性（逐项核对客户端影响）

| 变化 | 细节 | 客户端影响 |
|---|---|---|
| **`LocationNotFoundError` 从 14 个端点的 404 移除** | session 控制面 POST（agent/model/background/fork/interrupt/revert/commit）、PATCH /api/project、GET /api/project、permission/saved ×2、instructions entries ×3、session/wait。对应上游 #58997「目录删除后仍可管理会话」 | **无破坏，语义利好**。我们死目录被动收敛的回执源是 fs/vcs/session-diff 等 **GET 面**（全部保留 LNF，见 §4 清单）；控制面 POST 不再因死目录 404，只是少一类预期失败，静默吸收逻辑（design-worktree-sync §3.6）不依赖这些端点的 LNF |
| `GET /api/model` 默认只回 chat 型 | 新增 `types` 参数（`Model.Type` = chat/decision/image/开放串），description 明示「of the requested types, **chat by default**」 | 理论无感——`Model.Type` 是 2.2.0 新概念，2.1.3 目录实为全 chat（活体 65 模型）。**升 server 后活体复核模型数不变**（验收项） |
| `POST /api/experimental/generate` 降为 deprecated 别名 | 指向新 `generate/text` | 无——未消费 |
| `POST .../voice/session/{id}/instructions` 端点删除；`VoiceModel` 删 integration/workspace 字段 | voice 面收缩 | 无——未消费 voice |
| `Session.Event.Source` 结构体删除 | schema src 层，无任何事件引用（grep 实证） | 无 |

`Plugin.Info.id` 改品牌化 `$ref`（`Plugin.ID`）——2.1.3 审计同类机械重构，无语义。

## 2. 加法（新端点/新字段，客户端暂不消费）

- **新端点 10 个，全部 debug/experimental 面**：
  - `POST /api/debug/heap-dump`、`GET /api/experimental/client-mcp` + `/token`——即 2.1.4 的 3 个路径（ref-pin-bump-2.1.3 §5 已记账「待 server 升级自然带入」，本轮随 2.2.0 一并入 pin）
  - `POST/DELETE /api/experimental/fs/watch`——单文件 24h watch，发布 `filesystem.changed`
  - `POST /api/experimental/generate/{text,image,decisions}`——无态生成三件套（Generate.* 27 个新 schema 的载体）
  - `GET /api/experimental/media/{hash}`——内容寻址 media blob 读（配 `experimental.media_blob`）
  - `GET /api/experimental/usage/limits`——Console 预算/Go 用量（UsageLimits.* 5 schema）
  - `GET /api/plugin/gui`——插件 GUI bundle 分发（`Plugin.GuiBundle`）
- **`GET /api/event` + `types` 参数（服务端事件过滤）**：枚举 **94 型**，是权威事件清单的新来源（§3 用它做客户端消费集比对）。我们事件闸门在客户端、消费约 50 型，不过滤维持现状——过滤的隐患是升版漏新类型，不建议启用
- **`GET /api/vcs/diff` + `untracked` 参数**（`Vcs.Untracked` = files/folders）：未跟踪目录可折叠为单个 `dir/` 条目，配 `FileDiff.Info + more`（截断标记）。官方 desktop「untracked 文件夹折叠成一行」的配套契约。可选消费，默认行为不变
- **`ServerInfo + hostname`**（nullable，`GET /api/info`）——多 server 场景标识来源
- **`Mcp.Server + title`**（#58950）；**Model.Info + type**、**Provider.Cache/CacheTTL + Model/Config Settings + cache**（prompt cache TTL 配置面）
- **Config.experimental + `background_compaction` + `media_blob`** 两布尔键
- schema src 层 `Session.Inbox.MediaUser/MediaInfo`、`Session.Message.MediaUser/MediaInfo`、`Prompt.MediaRef/MediaFileAttachment`——experimental-media-uri capability opt-in 的媒体引用形状，**未进 openapi spec**（spec 只出默认形状）；我们不 opt in，inbox/消息 union 不变

## 3. 事件面（115 → 115，零增删改）

- `event.ts`、`event-manifest.ts`、`durable-event-manifest.ts` 两 tag **逐字节一致**；`session-event.ts` 仅删未使用的 `Source` 结构体（§1）
- 94 型 filter 枚举 vs 客户端消费集（app-store 全部 wire case + `ev.type ===` 直判，57 项含内部名）比对：
  - wire 消费**无缺失**——枚举外命中的全部是内部事件名（`message.updated`/`message.part.updated`/`permission.updated`/`session.updated`/`session.next.*`，api-types.ts 内部 union，非 wire）或既有记载项（`file.watcher.updated` 维持 spec-v0.5 降级表 #3）
  - `worktree.ready`/`worktree.failed` 仍**不进 filter 枚举**——与「定义但无发布者」裁定互洽（ref-pin-bump-2.1.3 §4 结论维持）
- 归档双事件 `session.archived/unarchived` 在枚举内，D1 迁回接线（design-archive-official-api）不受影响

## 4. spec 不可见的行为变化（release notes 交叉，升 server 后实测复核）

| 上游条目 | 与我们防御链的交叉 |
|---|---|
| #59327 等价目录路径（含尾斜杠）归一同一 location | 我们按 directory 字符串键控作用域/闸门/删除窗口——**复核键控是否需同步归一** |
| #56259 等价路径的 session 事件保活 location | 减少 warm location 误死 |
| #59083 表单轮询不再唤醒空闲/已删 location | 伪行「请求触发建档」的一条燃料被 server 侧掐断（ref-pseudo-project-cleanup §3.4 语境） |
| #58997 目录删除后会话可管理（§1 的 LNF 移除） | 死目录语义松动；todo-session-location-reassign 的可行性依据之一 |

**防御链处置结论（审计建议，实施另议）**：① 删除窗口挂起等清零、② evictLocation、③ 静默吸收——三条全部**维持**，直到 2.2.0 活体实测证明伪行不再产生。server 侧修复只覆盖已点名的触发器，未知触发器不排除。

2.2.0 仍保留 LNF 的我们消费面（被动收敛回执源不变）：`GET /api/fs/{list,read/*,find}`、`GET /api/vcs/{status,diff,base,branch}`、`GET /api/session/{id}/diff`、`POST /api/session/{id}/prompt|command|shell`、`GET/POST/DELETE /api/pty*`、`GET /api/shell*`、`GET /api/location` 等。

## 5. pin 与版本事实

- 本机 server **2.1.4**（2026-10-27 升，pin 已落后一段）；上游最新 tag **v2.2.0**（2026-10-27 发布）。pin 仍 = 2.1.3
- 2.2.0 内含 2.1.4 的 3 路径差（§2），升 pin 至 2.2.0 后无残留差额
- 升 pin 动作（届时）：server 实升 2.2.0 → `GET /openapi.json` 重出 pin → 与 tag 文件语义比对（同 2.1.3 流程）→ §1/§4 活体复核项 → 移动端 pin 同步（另行征得同意）

## 6. 验收

- [x] 语义 diff 覆盖全部 130 路径 + 337 schema，实质变化全量落档（§1/§2）
- [x] 事件面三步走完（定义 diff = 零变化；94 型 filter 枚举交叉；客户端 57 项消费集比对无 wire 缺失）
- [x] 死目录语义交叉评估（§1 LNF 移除 + §4 行为变化），防御链维持结论落档
- [ ] （升 server 后）`GET /api/model` 默认集活体复核——模型数与 2.1.4 一致（65 上下）
- [ ] （升 server 后）死目录场景活体复测：fs/vcs GET 面 LNF 回执照旧；控制面 POST 死目录下不再 404 的行为确认
- [ ] （升 pin 时）pin 文件与 v2.2.0 tag 语义一致核验
