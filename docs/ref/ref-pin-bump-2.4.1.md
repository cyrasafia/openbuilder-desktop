# 契约基线升级审计：2.1.3 pin → 2.4.1（2026-11-25）

> 状态：**审计完成，pin 已升 2.4.1（2026-11-25，经用户同意改动移动端 pin 文件；桌面端改动已提交，移动端 pin 文件未提交），桌面端无需改代码**。移动端设计文档的注记同步未做——上次升 pin 同步了 4 份，需要移动端自己的消费面审计，见 §8。
> 触发：本机 opencode 包升到 2.4.1-1.1；systemd `opencode-serve` 已重启到 2.4.1（`GET /api/info` → `version: "2.4.1"`）。
> 范围：2.1.3 → 2.2.0 一段已由 ref-pin-bump-2.2.0 审过，本文不重复推导。本文 = **2.2.0 → 2.4.1 增量** + 全跨度消费面汇总 + ref-pin-bump-2.2.0 遗留验收项闭环（§7）。
> 方法：三步同前（schema 语义 diff → 发布者/事件面核查 → 客户端消费集比对）。本轮加一步**规范化比较**：两版 spec 先剥掉机械成分，再逐操作比。机械成分 = ±2^53−1 整型上下界、`location` 参数的可空包装、查询参数的 `| null`、描述文字、集合数组顺序。比较结果给出确定清单：消费面哪些操作有非机械差异。
> 数据源：旧 pin = `../openbuilder/opencode_openapi_v2.json`（与 GitHub v2.1.3 tag 语义全等，已复核）；新侧 = 本机 2.4.1 server `GET /openapi.json`（467460 字节）+ GitHub v2.4.1 tag 的 `packages/protocol/openapi.json`（919507 字节）；其余全部 tag（v2.1.4、v2.2.0–v2.2.7、v2.3.0–v2.3.2、v2.4.0）的 openapi.json 用于逐步归因到版本（§2.4）。源码 = `/tmp/opencode` 下 v2.1.3 / v2.4.1 两个 tag 的稀疏部分克隆（`packages/{schema,protocol,server,core}`），其余 tag 用 `git show` 取单文件。
> 规模：全跨度 paths 121 → 146（+26/−1）、操作 146 → 178（+33/−1）、schemas 293 → 528（+243/−8）。增量 2.2.0 → 2.4.1：paths 130 → 146（+16/−0）、操作 156 → 178（+22/−0）、schemas 337 → 528（+200/−9）。被删 schema 名（8 个）是生成期变体（`{type:"object"}` / `{type:"string"}` 的 `*Encoded`、`*_N`，以及 `Form.Fields_2/3`），在 2.4.1 被内联或改名；涉及消费面操作的那几个 ref 解析后无差异（§2）。

## 0. 结论

- 桌面端消费的 53 个操作（按 `src/shared/rest-client.ts` 调用点整理）**没有被删除，没有被改名**。
- 增量段消费面：39 个操作无实质差异，14 个有非机械差异，**全部是加法或无语义的联合摊平**（§2）。
- 事件面：客户端引用的 47 个事件名**无删除、无改名**；durable 集合两版都是 47 个，无归类翻转（§3）。
- 有 4 个 spec 看不到的行为变化需要知道（§5.1–§5.4；§5.5 是零散项）。其中 1 个是上游对「死目录请求建档」的治本修复，**已活体证实**（§5.3）。
- pin 已升 2.4.1；AGENTS.md 已补审计指针（§8）。移动端设计文档的注记同步未做（§8.3）。
- 没有发现阻塞项。

## 1. 破坏性/收窄（客户端已逐项核对）

| 变化 | 细节 | 引入版本 | 客户端影响 |
|---|---|---|---|
| **`GET /api/fs/read/*` 响应头改写**（spec 不可见） | 响应头改经 `ContentHeaders.download()` 生成：`content-type` 对 html / js / xml（含 svg）改写为 `text/plain; charset=utf-8`；一律加 `content-disposition: attachment`、CSP `sandbox`、`nosniff`（304 同样带） | v2.2.6 | **无**。`readFileContent` 经 fetch 读字节；mime 头只用于判 `image/*`，svg 已特判为文本；`.html` 本机走 `file://`、远程走文件 Tab 预览，都不直接导航到 server 响应。活体实测见 §5.1 |
| `location` 查询参数摊平 | `anyOf:[{directory}, null]` → `{type:"object", properties:{directory}}`，共 59 个操作 | v2.2.6 | 无。参数名与序列化方式不变，纯机械 |
| 可选查询参数去 `\| null` | `archived`、`cursor`、`limit` 等；`parentID` 改为「`^ses` 模式 或 字面量 `"null"`」 | v2.2.6 | 无。桌面端本就把「只取根会话」发成字面量字符串 `parentID=null`（`listSessions`），2.4.1 把这一形式写进 spec，活体 200。其余可选参数桌面端只在有值时才发送 |
| `types` 多值编码 | `GET /api/event?types=` 与 `GET /api/model?types=` 的多值须用**重复参数**（`types=chat&types=image`）。逗号或空格拼接：event → 400 `InvalidRequestError`；model → **HTTP 200 + 空集**（静默） | v2.2.0 | 无。桌面端不传 `types`。日后消费时注意 model 的静默空集 |
| 变体级 `settings.cache.ttl` 移除 | 模型变体的 `settings.cache.ttl` 删除（v2.2.1）；模型级新增 `settings.cache.warming`（v2.2.6），模型级 `ttl` 保留 | v2.2.1 / v2.2.6 | 无。桌面端不读 cache 设置 |
| 端点删除 / 改名 | 全跨度只删 `POST /api/experimental/voice/session/{id}/instructions`（v2.2.0）；v2.3.1 把 `/api/experimental/schedule/*` 改名 `/api/experimental/automation/*` | v2.2.0 / v2.3.1 | 无。均未消费 |
| `LocationNotFoundError` 继续收缩 | 会话组挂 `sessionLocationMiddleware` 的端点：20（2.1.3）→ 9（v2.2.0）→ 7（v2.2.6）。v2.2.6 再少两个：`POST /api/session/:id/compact`、`/synthetic` | v2.2.0 / v2.2.6 | 无。桌面端消费的 5 个（`fork`/`agent`/`model`/`interrupt`/`PATCH session`）在 v2.2.0 已摘，ref-pin-bump-2.2.0 §1 已裁定。这 5 个端点不带 `location[directory]`，不经 `withLocation`，不是被动确证的回执源 |

## 2. 消费面逐操作核对（规范化比较）

### 2.1 增量 2.2.0 → 2.4.1：53 个操作

39 个无实质差异（38 个规范化后完全等价，`GET /api/shell/{id}/output` 仅集合顺序不同）。14 个有非机械差异：

| 操作 | 非机械差异 | 性质 |
|---|---|---|
| `GET /api/session` | `Session.Info.time.busy`（可选）；`parentID` 参数结构整理 | 加法 |
| `POST /api/session` | `time.busy`；`parentID` 说明扩充 | 加法 |
| `GET /api/session/{sessionID}` | `time.busy` | 加法 |
| `POST /api/session/{sessionID}/fork` | `time.busy` | 加法 |
| `GET /api/session/{sessionID}/message` | Assistant 消息 `time.firstToken`（可选） | 加法 |
| `POST /api/session/{sessionID}/prompt` | `files[].source`（可选）：`{type:"inline"}` 或 `{type:"uri", uri}`；`required` 仍是 `["uri"]` | 加法（v2.2.2） |
| `POST /api/session/{sessionID}/command` | 同上 | 加法（v2.2.2） |
| `POST /api/session/{sessionID}/form/{formID}/reply` | `answer` 数值联合摊平 | 无语义 |
| `POST /api/integration/{integrationID}/connect/key` | `answer` 联合摊平 | 无语义 |
| `GET /api/form` | 6 种字段类型不变；`when[].value` 联合摊平 + 整型上界 | 无语义 |
| `GET /api/integration` | `methods[].form` 同上 | 无语义 |
| `GET /api/agent` | 503 `ServiceUnavailableError` 声明移除（v2.2.7，§5.4）；`request.settings` 新增 `tls`、`cache.warming` | 加法 |
| `GET /api/model` | `type` 枚举 + `video`；新增 `capabilities.freeform`、`experimental.speed` | 加法 |
| `GET /api/event` | `data` 首次带类型化联合（§3）；`types` 枚举 94 → 99 | 加法 |

消息联合（`GET /api/session/:id/message`）11 个成员类型不变；逐成员展开后，差异只有 `time.firstToken` 与 `error.retryAfterMs` 的整型上界。

### 2.2 全跨度 2.1.3 → 2.4.1：多出的 6 个

除上表 14 个外，全跨度还有 6 个操作有非机械差异，均落在 2.1.3 → 2.2.0 段（ref-pin-bump-2.2.0 已审）：`GET /api/info`（+ `hostname`）、`GET /api/project`（404 去 `LocationNotFoundError`）、`POST /api/session/:id/interrupt`（同左）、`POST .../revert/stage` / `GET /api/session/:id/diff` / `GET /api/vcs/diff`（diff 条目 + `more` 截断标记；`vcs/diff` + `untracked` 参数）。`untracked` 缺省不传时行为不变；桌面端不读 `more`。

`worktree` 四件套（`GET`/`POST`/`DELETE /api/worktree`、`POST /api/worktree/refresh`）、`PATCH`/`DELETE /api/session/:id`、`view`、`move`、`DELETE .../revert`、`permission reply`、`GET /api/session/active` 在全跨度 ref 解析后语义等价（全跨度等价的既有操作共 29 个）。`GET /api/fs/read/*` 的 schema 只有 `location` 参数的机械摊平，但**响应头变了**（§5.1）。

### 2.3 只读活体冒烟（2026-11-25，2.4.1，location = 本仓库活目录）

消费的读端点全部 200，信封形状不变：`GET /api/project` 裸数组、`/api/session` `{data,cursor}`、location 域 `{location,data}`、`/api/worktree` 裸数组。`/api/vcs/base` 返回 `{name,ref,source}`；`/api/vcs/diff?mode=working`（带或不带 `untracked=folders`）、`/api/shell`、`/api/fs/list`、`/api/vcs/status`、`/api/agent`、`/api/command`、`/api/skill`、`/api/form`、`/api/permission/request`、`/api/integration` 均正常。`GET /api/session` 的 `parentID=null`、`archived=true|false` 均 200。

### 2.4 逐版本归因：2.2 系列（基线 = pin 2.1.3）

相邻 tag 逐步比较（v2.1.4、v2.2.0 … v2.2.7），只列落在桌面端依赖面上的改动；全面（含未消费端点与配置面）的粗粒度归因见文末附表：

| 版本 | 桌面端依赖面上的改动 | 对桌面端 |
|---|---|---|
| v2.1.4 | 只多 3 个 debug / experimental 操作（`heap-dump`、`client-mcp`、`client-mcp/token`） | 无 |
| v2.2.0 | `GET /api/info` + `hostname`；`GET /api/project` 与 `interrupt`、`fork` 等控制面的 404 去 `LocationNotFoundError`；diff 条目 + `more`；`vcs/diff` + `untracked`；`GET /api/model` + `types`（缺省 chat）+ `type` 字段；`GET /api/event` + `types`（94 型）；`GET /api/agent` 声明 503 + `request.settings.cache.ttl`；删 voice instructions 端点 | 无破坏。死目录下控制面不再 404 |
| v2.2.1 | `GET /api/model` 变体级 `settings.cache.ttl` 删除 | 无 |
| v2.2.2 | `Session.Info.time.busy`；`prompt` / `command` 的 `files[].source`；表单 `answer` 与 `when[].value` 联合摊平 | 无 |
| v2.2.3 | 消费面无变化 | 无 |
| v2.2.4 | 事件 `persistent-pty.updated`、`artifact.updated` | 无（未消费） |
| v2.2.5 | 消费面无变化 | 无 |
| v2.2.6 | spec：SSE `data` 类型化联合（98 成员）、`location` 参数摊平、可选查询参数去 `\| null`、模型级 `cache.warming`、`compact` / `synthetic` 去 `LocationNotFoundError`。行为：`/api/fs/read` 响应头（§5.1）、终端 socket 保留 location + 1012（§5.2）、死目录请求不再建行（§5.3） | 无需改代码；防御链含义见 §5.3 |
| v2.2.7 | `GET /api/agent` 去 503 声明（`awaitPlugins` 第一步，§5.4）；`credential.updated` 载荷进 spec 联合 | 无（未消费 credential 事件） |

2.2 系列之后落在消费面的变化：v2.3.0（`session.step.first-token`、`experimental.mcp.event`、Assistant `time.firstToken`、`request.settings.tls`、`capabilities.freeform`）、v2.3.1（`Model.Type` + `video`；`schedule/*` → `automation/*`）、v2.4.0（`awaitPlugins` 第二步、`experimental.job.updated`）、v2.4.1（`Model.Info.experimental.speed`）。

## 3. 事件面

**定义集**（`packages/schema/src`，同法抽取 `type: "a.b"` 字面量，排除 `v1/`、`config/`）：105 → 111，**+6 / −0**。

| 方向 | 事件 | 进全局流联合 | 引入版本 |
|---|---|---|---|
| + | `artifact.updated` | 是 | v2.2.4 |
| + | `persistent-pty.updated` | 是 | v2.2.4 |
| + | `session.step.first-token`（durable，载荷 `{sessionID, assistantMessageID}`） | 是 | v2.3.0 |
| + | `experimental.mcp.event` | 是 | v2.3.0 |
| + | `experimental.job.updated` | 是 | v2.4.0 |
| + | `experimental.mcp.subscription.changed` | 否（有定义，不在联合内） | v2.3.0 |

- **SSE 帧骨架两版完全一致**：`{data: string(application/json), event: string, id: string|null}`，`required: [event, data]`。活体帧仍是 data-only：`data: {"id":"evt_…","type":"server.connected","data":{}}`，其后 `: heartbeat`。
- **`data` 的类型化联合首现于 v2.2.6**（此前 spec 里 `data` 只是 JSON 串）。2.4.1 = 100 个字面量类型 + 1 个 `rpc.*` 模式；52 ephemeral、47 durable、1 `server.connected`。
- **durable 归类**：2.1.3 源码 47 个，2.4.1 spec 47 个，两版都在联合内的事件**零翻转**。
- **发布者**（`.publish(X)` 调用点）：143 处 / 89 个目标 → 151 处 / 93 个目标。`SessionEvent.Text.Delta`/`Ended`、`Reasoning.Delta`/`Ended` 在 2.4.1 改经 `contentFragments(name, events)` 辅助函数发布，**事件照常发出，载荷不变**（`publish-llm-event.ts`）。
- **有定义无发布者，维持**：`session.status`、`session.idle`（typing-indicator 兼容判断不变）；`worktree.ready`、`worktree.failed`、`worktree.resolved`。
- **`filesystem.changed`**：发布者 = `.git/HEAD` location watcher（两版都有）+ v2.2.0 起的单文件 watch 端点 `POST /api/experimental/fs/watch`。`file.watcher.updated` 仍无定义，spec-v0.5 降级表 #3 维持。本机 server 的 `OPENCODE_EXPERIMENTAL_FILEWATCHER=true` 只启用 server 内部 watcher 后端（插件与配置监听、`.git/HEAD` 监听、单文件 watch 端点），不向客户端发通用文件事件。
- **载荷变化（涉及消费事件的）**：仅 Assistant 消息 `time.firstToken`（可选，v2.3.0）。其余：`credential.updated` 载荷 `{}` → `{integrationID, credentialID}`（未消费；spec 联合自 v2.2.7 体现）；`session.usage.recorded` 的 `source` 枚举 + `"generate"`（不在全局流联合内）。
- **客户端比对**：非测试源码引用 47 个事件名，全部仍在 2.4.1 定义集内；45 个在全局流联合内，`worktree.ready`/`worktree.failed` 有定义但不在联合内（既有记载）。新增 6 个事件桌面端都未消费；`handleEvent` 的 `default:` 分支对未知事件透传忽略。
- 另有 7 个 v1 时代事件名（`message.updated`、`session.updated` 等）留在 `app-store.ts`，两版定义集都没有它们，非本轮变化。

## 4. 加法（新端点/新字段，客户端暂不消费）

- **新端点（增量 22 个操作 / 16 个路径，全在 `/api/experimental/`）**：`generate/video`（+ `/{id}`）、`blob/{id}`、`automation` CRUD + `pause`/`resume`、`artifacts` CRUD + `providers` + `/{id}/view/*`、`job` + `/{id}/cancel`、`machine` + `/link` + `/{name}`。
- **`Session.Info.time.busy`**（v2.2.2）：最近一次执行的开始时刻。注释写明「执行期间 `idle` 仍保有上一次执行的结束时刻」。已核源码：`time_idle` 两版都只在执行终态事件单调推进，**执行开始时两版都不清空**——`time.idle` 语义不变，未读标记（`time.idle > time.viewed`）不受影响。
- **`Model.Info`**：`type` 字段（v2.2.0）+ `video`（v2.3.1）；`capabilities.freeform`（v2.3.0）；`experimental.speed`（v2.4.1）。`GET /api/model` 缺省只回 chat 型（v2.2.0 引入，ref-pin-bump-2.2.0 §1）。
- **`files[].source`**（`prompt` / `command` 请求体，可选判别字段，v2.2.2）。
- **`Agent`/`Model` 的 `request.settings`**：`cache.warming`（v2.2.6）、`tls`（cert/key/passphrase，v2.3.0）。

## 5. spec 不可见的行为变化（源码核对，标注是否活体）

### 5.1 `GET /api/fs/read/*` 响应头（v2.2.6）——已活体

| 文件 | `content-type` | 其他 |
|---|---|---|
| `src/renderer/index.html` | `text/plain; charset=utf-8` | 下同 |
| `sample/logo.svg` | `text/plain; charset=utf-8` | |
| `package.json` | `application/json` | |
| `src/main/index.ts` | `video/mp2t`（server MIME 库既有误判，未变） | |
| `DESIGN.md` | `text/markdown` | |

全部带 `content-disposition: attachment; filename="…"; filename*=UTF-8''…`、`content-security-policy: default-src 'none'; img-src 'self'; media-src 'self'; sandbox`、`x-content-type-options: nosniff`、`cache-control: no-cache, no-transform`。Range 请求仍 206。客户端影响见 §1 首行。

### 5.2 终端 socket 保留 location + 关闭码 1012（v2.2.6）——源码，未活体

`server/src/handlers/pty-socket.ts` 新增 `holdLocation`：socket 存活期间其 location 免于空闲清扫（`location_idle_timeout`，缺省 60 分钟）。location 因 reload / VCS init / debug evict 关闭时，socket 以 **1012 "location shut down"** 关闭。另：`POST /api/pty` 自 v2.2.0 起不再合并 `PtyEnvironment`——2.1.3 的 `get` 恒返回 `{}`，无行为影响。

客户端：1012 落「退避重连 → connect-token 404 → 被动关闭只读态」，终态与现在一致，**无需改**。正面变化：常开的终端 Tab 不再因闲置被清扫杀掉 shell。桌面端 `removeWorkspace` 在 `DELETE /api/worktree` 之前就杀掉该目录的 pty（`killPtyInDirectory`），再 evict；即使 evict 时仍有 socket，也只是以 1012 关闭，落被动关闭路径。

### 5.3 死目录请求不再建项目行（v2.2.6）——已活体证实（2.4.1）

`core/src/location.ts`：

```ts
const persist = ref.workspaceID !== undefined || (yield* fs.isDir(ref.directory))
const resolved = yield* project.resolve(ref.directory, { persist })
```

2.1.3 是 `project.resolve(ref.directory)` 无条件落行（目录哈希兜底，ref-pseudo-project-cleanup §3.1）。v2.2.6 起，不带 `workspaceID` 的 `location[directory]` 请求若目录不存在，`persist = false`，`project.resolve` 只解析不落行、不取消归档。请求仍 404 `LocationNotFoundError`（`server/src/location.ts` 的 `locationErrors` 未变，错误体形状不变）。

这是 ref-pseudo-project-cleanup §3.4「燃料 6」的上游治本。桌面端 `removeWorkspace` 里「DELETE 前先杀 pty」的既有顺序（app-store `killPtyInDirectory` 注释：留到 unload 再杀会落在死目录上「确定性建一行」）针对的正是同一机制。

**活体复测**（2026-11-25，经用户授权，2.4.1）——探测式取自 ref-pseudo-project-cleanup §3.4 的复现命令：

| 步骤 | 结果 |
|---|---|
| 基线 | 项目行：未归档 62 / 已归档 118；已加载 location 10 |
| 探测：`GET /api/vcs/diff?mode=working&location[directory]=/tmp/opencode/audit/dead-dir-probe-20261125-cpx2eo`（目录不存在） | 404 `{"_tag":"LocationNotFoundError","location":{"directory":"…"},"message":"Location not found: …"}` |
| 探测后立即 | 项目行 62 / 118，新增 0，无 canonical 等于探测目录的行；已加载 location 仍 10，探测目录不在其中 |
| 75 秒后（server 扫描是异步的，按 §5.3 验证口径） | 同上，无变化 |

结论：≥2.2.6 上死目录的 location 请求**不建行、不驻留**，404 错误体不变。旧版对照未做（本机无 2.1.3 server）；旧版行为以源码与 ref-pseudo-project-cleanup §7e 的实验记录为准。附带确认：`GET /api/session` 不挂 location 中间件，`location[directory]` 对它不起作用——会话作用域走 `directory` 参数（桌面端 `listSessions` 即如此）。

对桌面端防御链的含义（ref-pin-bump-2.2.0 §4 的「三条全部维持」结论在此更新）：

| 防御 | 原始目的 | 2.4.1 实测 | 处置 |
|---|---|---|---|
| ① 删除窗口挂起等清零 | 防迟到请求建档 | 不再建行 | 维持（须兼容 2.1.3 – 2.2.5）；放宽候选 todo |
| ② `evictLocation` | 清 warm 死驻留与事件噪声 | 失败的引导不驻留。「先加载、后删目录」的驻留不受本修复影响（推断，未活体） | 维持 |
| ③ 静默吸收 | 死目录 404 是预期结果 | 404 照旧，仍需要 | 维持 |
| 红线：不用 location 请求探测 | probe 即建档 | 不再建行 | 维持（须兼容 2.1.3 – 2.2.5）；放宽候选 todo |

桌面端可连接的 server 下界是任意 v2；在 2.1.3 – 2.2.5 上这四条都照旧有效。

### 5.4 location 域请求逐步不再等插件激活（v2.2.7 / v2.4.0）——源码

`awaitPlugins`（插件激活等待，5 秒超时 → 503 `ServiceUnavailableError`，message "Location plugins did not finish activating"）分两步取消：

- v2.2.7：`agent`、`artifact`、`usage` 三个处理器不再调用；spec 同步去掉 `GET /api/agent` 的 503 声明。
- v2.4.0：定义删除；`model`、`provider`、`generate`、`voice`、`websearch` 处理器也不再等待。

桌面端消费的 `GET /api/model`：503 `ServiceUnavailableError` 的 spec 声明自 2.1.3（pin）起一直在；≤2.3.2 上生产者是 `awaitPlugins`（service `"plugin"`），v2.4.0 起模型路径上已无生产者，只剩残留声明。桌面端对 503 的处理无需变（`/api/vcs/base` 的 503 静默处理继续保留）。

### 5.5 其他（均无影响）

- `ProjectGroup` 自 v2.2.0 摘掉 location 中间件：`GET /api/project` 不再为 server 工作目录引导 location。本机 server 工作目录 = `/home/cyrasafia`（非 git），对应存量项目行 `5fe1489c…`。
- `Project.sweep`（归档目录全部消失且闲置超 1 小时的项目）在 2.1.3 已存在，非本轮增量。
- 鉴权中间件 `middleware/authorization.ts`：只为新路由（client MCP WS、machine link）加豁免，既有路由的 Basic 校验未变。
- `handlers/worktree.ts`：建 worktree 失败时的 message 文案变更，`_tag` 不变。
- 桌面端版本闸门只有下界（v2 server；归档 API ≥2.1.3），2.4.1 通过。

## 6. pin 与版本事实

- 本机：包 `opencode-bin 2.4.1-1.1`；二进制 `opencode v2.4.1`；运行中 server 2.4.1（pid 已变）。
- 上游最新 tag = **v2.4.1**（与二进制一致，无更新版本）。npm `opencode-ai` 的 `latest` = 1.19.6（v1 线），`dev` = `0.0.0-dev-202611170722`——2.x 仍无稳定 npm 渠道，「pin 挂运行中 server」仍是正确姿势。
- **活体 spec 与 v2.4.1 tag 语义一致**：操作面 178 个全等；schema 活体 542 个 = tag 528 个 + 14 个生成期冗余副本（2.3.2 活体同样多 14 个，是生成器行为，非版本差异）。
- **pin = 2.4.1**（2026-11-25，经用户同意）：`../openbuilder/opencode_openapi_v2.json` 经 `tool/gen_client.sh` 从本机 server 重出，467460 字节，146 路径 / 542 schema，与活体 spec 逐字节一致。相对旧 pin（2.1.3）：操作 +33/−1/~116，schema 293 → 542（含 14 个生成期冗余副本）。桌面端改动已提交；移动端 pin 文件未提交。

## 7. ref-pin-bump-2.2.0 遗留验收项闭环

- [x] pin 文件与 tag 语义一致核验（§6，2.4.1 上已做）。
- [x] `GET /api/model` 缺省集活体复核：缺省 52 个（37 个 `type:"chat"` + 15 个无 `type` 字段）；`types=chat` 同为 52；decision 1、image 6、video 3；四种已知类型合计 62。**与该审计记录的 2.1.4 活体「65 上下」不等**。差额原因未能确定（目录漂移，或存在四种已知类型之外的 `type`——该枚举是开放串）。对桌面端无功能影响：`model-catalog.ts` 不按类型过滤，模型选择器只用缺省集。
- [x] 死目录场景活体复测（§5.3）：不建行、不驻留；location 域 GET 面的 `LocationNotFoundError` 保留。控制面 POST 不再因死目录 404 一项只有 spec 与源码依据，未单测。
- [ ] ref-pin-bump-2.2.0 §4 的「等价路径归一后键控是否需同步归一」：本轮未复核。

## 8. 建议与处置（2026-11-25 更新）

已做（经用户同意；桌面端已提交，移动端 pin 文件未提交）：

1. **升 pin 至 2.4.1**：`../openbuilder/tool/gen_client.sh` 从本机 server 重出 → 与 tag 语义比对（§6）。移动端仓库只有 `opencode_openapi_v2.json` 一个文件改动。桌面端通信层手写、不从 pin 生成，**无代码改动**。
2. **AGENTS.md 补审计指针**：联调条与硬约束条改为 2.4.1 pin + 三份审计；worktree 条追加防御链补注。

未做：

3. **移动端设计文档注记同步**。上次升 pin（2.1.3）同步了四份，本次只改了 pin 文件。移动端仍把 pin 写成 2.1.3 的位置：`docs/spec/spec-overview.md` §4.1、`docs/design/v2/design-unread-marker.md`（契约依据）、`design-v2-migration.md`（基线记录，追加条目）、`design-sse-event-surface.md`（升 pin 复核，追加条目）。移动端代码不依赖 pin 内容（只有 `tool/gen_client.sh` 引用它）。注记同步需要移动端自己的消费面审计（移动端 Dart 客户端的事件与端点消费集与桌面端不同），建议在移动端会话里按 design-sse-event-surface §5 三步做。
4. **todo：死目录防御链在 ≥2.2.6 上放宽**。活体前置已满足（§5.3）。实施须按版本闸门，因为桌面端仍可连接 2.1.3 – 2.2.5。
5. **方法沉淀**：≥2.2.6 的 spec 自带逐事件类型化联合，后续事件面 diff 可直接在两版 pin 之间做，不必再拉 `packages/schema/src`。归因版本必须用相邻 tag 逐步比——跨多版只比两端会把中间的变化记错版本（本文初稿因此把三处错记到 v2.2.5，已更正）。
6. 可选消费：`time.busy`（运行起点）、`session.step.first-token`（首 token 延迟）、`files[].source`。按需。

## 9. 验收

- [x] 规范化比较覆盖消费面 53 个操作，增量段与全跨度各一遍（§2）
- [x] 事件面三步走完：定义集 diff（+6/−0）、发布者清单 diff（143 → 151 处）、客户端 47 个事件名比对（§3）
- [x] durable 归类零翻转；SSE 帧骨架逐字段等价
- [x] 错误 `_tag` 矩阵全量 diff：全跨度 18 个既有操作有变化，16 个是 `LocationNotFoundError` 收缩，无新增
- [x] 只读活体：版本、spec 一致性、SSE 帧、`/api/fs/read` 响应头、模型缺省集、消费读端点冒烟；未产生新的项目行（12 条无 `vcs` 的存量行均创建于 9–10 月）
- [x] 死目录行为活体复测（§5.3）：不建行、不驻留；全程项目行数不变（未归档 62 / 已归档 118）
- [ ] 未交叉 release notes；行为变化以源码 diff 为准
- [ ] 移动端：设计文档注记同步、移动端客户端对 2.1.3 → 2.4.1 的消费面审计（§8.3）

## 附：增量段按版本归因（2.2.0 → 2.4.1）

整面 178 个操作 = 2.2.0 的 156 个 + 新增 22 个。既有 156 个里，规范化后 112 个完全等价，41 个有非机械差异（桌面端消费的 14 个见 §2.1），3 个仅 SSE 联合或集合顺序不同。新端点 28 个、删除 6 个（均为 `schedule/*` → `automation/*` 改名）。新端点全部在 `/api/experimental/` 下。

| 版本 | 端点 | 事件 | 其他 |
|---|---|---|---|
| v2.2.5 | + `schedule` ×6、`artifacts` ×7 | + `artifact.updated`、`persistent-pty.updated` | `Session.Info.time.busy`；`files[].source`；模型变体级 `settings.cache.ttl` 删除；`compaction.buffer` 接受百分比字符串；策略动作 + `integration.connect`、`mcp.use`、`skill.use`、`plugin.use`；persistent-pty 响应 + 必填 `userTitle`，`PUT` 的 `size` 改可选 |
| v2.2.6 | + `GET /api/experimental/job` | — | SSE `data` 类型化联合；`location` 参数摊平、可选参数去 `\| null`（机械）；`compact`、`synthetic` 去 `LocationNotFoundError`；`settings.cache.warming`；MCP server 配置 + `pool`；策略动作 + `websearch.use`。行为变化见 §5.1–§5.3 |
| v2.2.7 | — | `credential.updated` 载荷 `{}` → `{integrationID, credentialID}` | `GET /api/agent` 去 503 声明（§5.4）；`POST /api/session/:id/generate` 响应 + 必填 `cost`、`tokens`；`generate/decisions` 问题形状调整 |
| v2.3.0 | — | + `session.step.first-token`、`experimental.mcp.event` | `settings.tls`；`capabilities.freeform`；Assistant 消息 `time.firstToken` |
| v2.3.1 | `schedule/*` → `automation/*`；+ `generate/video` ×2、`blob/{id}` | — | `compaction.background` 上移顶层（`experimental.background_compaction` 删除） |
| v2.3.2 | — | — | spec 零变化 |
| v2.4.0 | + `job/{id}/cancel`、`machine` ×4 | + `experimental.job.updated` | `awaitPlugins` 定义删除（§5.4）；automation 动作 + `shell`；job + `video` 种类；`generate/video` 去 403 `ForbiddenError`；voice models 的 `engine`、`name` 变必填 |
| v2.4.1 | — | — | `Model.Info.experimental.speed` |

注：首行「v2.2.5」是 v2.2.0 → v2.2.5 一步的合计。逐 patch 版本：`schedule` ×6 与变体级 `settings.cache.ttl` 删除在 v2.2.1，`Session.Info.time.busy` 与 `files[].source` 在 v2.2.2，`artifacts` ×7 与两个新事件在 v2.2.4。桌面端依赖面的逐版表见 §2.4。

Config 面的实验开关（`Config.Info.experimental`）：7 个 → 21 个。净增 15 个（`all_flags`、`artifacts`、`codemode_vm`、`console_watches`、`full_codemode`、`home_memory`、`image_generate`、`machines`、`model_speeds`、`opencode_api`、`part_rows`、`project_overlay`、`recommended_api`、`sqlite_fts`、`video_generate`）。`background_compaction` 移除（v2.3.1 上移为 `compaction.background`）。`schedules`、`automations`、`mcp_events`、`shell_timeout_background` 在区间内出现后又移除。
