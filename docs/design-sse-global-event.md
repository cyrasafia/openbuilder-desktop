# SSE 单全局流：`/global/event` 替代 N×`/event?directory=`

> 状态：已实施（2026-08-24）。代码：sse-subscriber.ts（单流 + 信封解析 + sync 丢弃）、
> app-store.ts（单 subscriber、openedDirectories 统一目录源、handleEvent 前置闸门）。
> E2E 见 §8。
> 参考来源：opencode 官方 app `packages/app/src/context/server-sdk.tsx`（单流 + directory 路由 + 16ms 帧 coalesce）、
> openchamber `packages/ui/src/sync/event-pipeline.ts`（SSE 兜底即直连上游单条 `/global/event`；其 WS 层是自建 relay，本项目不涉及）。
> 移动端 openbuilder 未做过多目录场景（单 scope，`/event` 足够），无同类设计可借鉴。

## 1. 问题

现行方案（v0.1 实测后收敛）：SSE 订阅集合 = 当前 scope 目录 ∪ 打开项目根，每目录一条 `GET /event?directory=<dir>`，上限 5（浏览器同 host HTTP/1.1 并发 6，需留 ≥1 给 REST）。

痛点（全部源于"每连接只圈定一个 directory"这一 `/event` 端点性质）：

| # | 痛点 | 出处 |
|---|---|---|
| 1 | 非当前 worktree 无事件通道：其会话列表/指示器只能靠快照，无实时性 | v0.1 明确取舍（subscriptionDirectories 注释） |
| 2 | ≥5 个打开项目时预算截断，scope 之外的目录事件丢失 | review 7.5 #9、7.6 #1 两轮才修对优先级 |
| 3 | 开/关项目、切工作区 = SSE 全组重订，历史上反复出事：旧组泄漏（7.1 #1）、重订丢凭据（7.5 #1） | review 记录 |
| 4 | REST 连接池被 5 条常驻 SSE 压到 ~1 槽，扇出必须 `runLimited` 限流 | 7.7 追加项 |

## 2. 调研结论（可行，且优于"每 worktree 一条"）

最初诉求是"每个 worktree 一条 SSE"。调研发现 server 提供更强的端点，一条连接即可覆盖全部目录——比逐 worktree 订阅更简单也更省连接。

### 2.1 server 端点性质（源码，`../opencode` monorepo）

- **`/global/event` = GlobalBus 无过滤直通**（`handlers/global.ts`）：所有实例（任意 directory/workspace）的 EventV2 事件经 `event-v2-bridge.ts` 汇入 GlobalBus，信封 `{directory, project?, workspace?, payload:{id,type,properties}}`；首帧 `server.connected`，10s 心跳 `server.heartbeat`
- **`/event?directory=X` = 同一总线按 directory 过滤**（`handlers/event.ts`：`event.location.directory === instance.directory`）——即 `/global/event` ⊇ 所有 `/event?directory=X` 之和
- 版本门槛：`v1.0.66`（2025-11-16，release notes "Added global.event.subscribe() to SDK"，引入提交 `5fc26c958a`）。最初信封仅 `{directory, payload}`，无心跳/sync 双发/project 字段；现代版本（本机 1.18.20）齐全。端点已收录于契约源 `openbuilder/opencode_openapi.json`（`global.event`）

### 2.2 同类客户端做法

| 客户端 | 做法 |
|---|---|
| opencode 官方 app（packages/app，Solid） | 单条流：v1 协议走 `global.event()`，v2 走 `event.subscribe()`，均按 `event.directory` 路由 + 16ms 帧 flush + delta coalesce |
| openchamber（Electron） | WS 优先 + **SSE 兜底直连 `/global/event` 单条**；按信封 directory 分队列 33ms flush；重连带 Last-Event-ID |
| 本项目现行 | N 条 `/event?directory=`（本文替换对象） |

## 3. 实测契约事实（server 1.18.20 @127.0.0.1:15120，2026-08-24）

| 事实 | 影响 |
|---|---|
| 信封 `{"directory":"/abs/dir","project":"…","payload":{…}}`，懒加载目录（从未请求过的新 worktree）的 session.created/updated/status/deleted/diff 事件全部到达 | 无需预热，新 worktree 即时可见 |
| 同事件与 `/event?directory=X` 内容一致（payload 结构相同），仅多信封包装 | handleEvent 的 payload 处理逻辑零改动 |
| **durable 事件双发**：每个持久事件额外跟一条 `{"payload":{"type":"sync","syncEvent":{…}}}` | 必须忽略（官方 app：`if (type === "sync") continue`） |
| **SSE 帧无 `id:` 字段**（`handlers/global.ts` 明确 `id: undefined`） | Last-Event-ID 续传无效；断线恢复全靠 REST 对账（本项目 reconciler 已覆盖，无退化） |
| 心跳 10s（`server.heartbeat`；**首帧实际在建连后 ~20s**——server 侧 `Stream.tick("10s").pipe(Stream.drop(1))` 丢掉首个 tick，源码复核确认）；无关目录事件不串台（对照实验确认隔离） | 现行 60s 心跳静默判死直接复用（60s 阈值 ≫ 10s 心跳，首帧 20s 亦余量充足） |
| **`server.connected`/`server.heartbeat` 帧无 directory 字段**（裸 `{payload}`）；带 `directory:"global"` 的仅 `server.instance.disposed` | 解析层信封 directory 缺省 `"global"`（§4.1）；connected/heartbeat 忽略；disposed 见 §5 #2 |

## 4. 方案

**一条 `GET /global/event` 常驻连接，按信封 directory 在客户端路由/过滤。** 连接生命周期与项目打开集合完全解耦。

### 4.1 sse-subscriber.ts（改动小）

- URL：`/global/event`（去 directory 参数）；`directory` 字段删除
- 解析：`JSON.parse` 后取信封；`envelope.payload.type === "sync"` 直接丢弃；`onEvent(directory, payload)` 回调签名多一个 directory 参数（取自 `envelope.directory ?? "global"`）
- 重连状态机（退避/kick/建连超时/心跳看门狗）**不动**——是传输层无关的策略

### 4.2 app-store.ts（改动重点：删重订，闸门前置）

- **删除** `subscriptionDirectories()`、`sseGroup` 数组语义（退化为单 `sseSubscriber` 字段）、开关项目/切工作区的全组重订路径；`startSse` 只在 connect/disconnect（teardownConnection）时各调一次
- **闸门前置**：`handleEvent` 入口统一 `isOpenedDirectory(envelope.directory)` 过滤（含 worktree：`worktree ∪ sandboxes`，函数已存在）。⚠️ 现状 `message.*`、`session.created/updated/deleted` 依赖"订阅集合即打开集合"隐式隔离，无显式闸门——单流后收到 server 上**全部项目**的事件，不过滤会污染 store。这是本次改造的正确性关键点
- `session.*` 事件的 `info.directory === directory` 双保险保留（现逻辑）
- 状态聚合：`updateSseAggregate` 简化为单 status 直映；空组语义（无订阅 ≠ degraded）随单流自然消失——connect 后恒有订阅，degraded 即全局降级
- 事件闸门集合变化（开/关项目、切工作区）**不再触发任何连接操作**，只影响过滤

### 4.3 收益：闸门集合放宽 + REST 预算释放

- 闸门集合 = 打开项目 `worktree ∪ sandboxes` **全集**——非当前 worktree 的会话/指示器/busy 也实时更新（超出原诉求"每 worktree 一条"的覆盖面，且不再需要"切工作区重订+快照兜底"）
- SSE 1 条 → REST 独占连接池；`runLimited` 限流参数可放宽（保留机制防未来扇出，仅调倍率）
- review 7.1 #1 / 7.5 #1 / 7.6 #1 整类"SSE 组生命周期"bug 的土壤消失

### 4.4 reconciler / merge 层

- 对账触发（重连 debounce 800ms）、逐目录快照 + 打开 Tab 消息窗口、session-merge 分域合并**不动**——Last-Event-ID 无效（§3）意味着断线窗口恢复完全依赖它，正好是现有设计
- ⚠️ 唯一必须改的接线点：reconciler 的 `getOpenedDirectories` 现取 `subscriptionDirectories()`（app-store.ts:1434），该函数删除后改接**打开项目目录全集**（`worktree ∪ sandboxes`，与 §4.3 闸门/快照同源）。行为决策：对账范围从"上限 5 的订阅集"扩展为全集——与闸门放宽一致，避免"事件收得到、对账补不到"的覆盖面错位

### 4.5 兼容性决策

- **不做多订阅回退**。门槛 server ≥ v1.0.66（2025-11 发布，距今 9 个月；本机/managed spawn 的 1.18.20 满足）。保留双模式等于永久维护两套闸门语义与状态聚合，状态空间翻倍
- 老版本识别：`/global/event` 返回 404 时，连接错误提示明确"server 版本过旧（需 ≥ v1.0.66）"（SSE 建连失败进 connecting→reconnecting 既有路径，错误信息在状态栏 connectionError 呈现）
- 官方 app 的 `detectServerProtocol`（v1/v2 双协议探测）不引入——v2（`/api/*`）端点族超出本项目契约源范围

### 4.6 范围外（明确不做）

- WS 传输（openchamber 的 `/global/event/ws` 是其自建 relay 层的端点，上游无此 API）
- 事件帧级 coalesce / 批量 flush（官方 app 16ms、openchamber 33ms）——待流式渲染管道优化（v0.2，移植 session-ui 时）一并考虑；单流后事件率上升的缓解手段预留于此

## 5. 风险与开放问题

| # | 风险 | 处置 |
|---|---|---|
| 1 | 单流收到 server 上全部项目的事件（含未打开），每条都过 JSON.parse + 闸门 | v0.1 接受：单用户 server 活跃会话有限，parse+Set 查找成本远低于连接池饿死；帧级 coalesce 为 v0.2 预留（§4.6） |
| 2 | `server.instance.disposed`（directory:"global"）语义：server 侧 dispose 全部实例 | v0.1 忽略（重启 server 场景走断线→重连→对账既有路径）；不特殊处理 |
| 3 | 心跳超时判死（60s）与 server 心跳周期（10s）余量大 | 无需处理；仅记录 |
| 4 | sync 双发漏过滤会导致重复应用事件 | 测试用例覆盖（见 §6） |

## 6. 验收标准

- [x] 单元：信封解析（directory 缺省→global、sync 丢弃、坏 JSON/非信封结构丢弃）——sse-subscriber.test.ts 12 用例；对账多目录容错——reconciler.test.ts 新增用例
- [x] E2E：非当前 worktree 内创建/删除会话，事件穿透闸门进 store（原方案做不到的点）
- [x] E2E：连接预算——NetworkService 对 15120 仅 3 条 TCP（1 SSE + 2 REST keep-alive）；对照同场景旧代码实例 5 条（3 SSE + 2 REST）
- [x] E2E：切工作区（真 worktree 切换）/切项目/关项目期间零新增 SSE 请求、零重连日志
- [x] E2E：关闭项目后同目录事件被闸门拦截（不泄漏进 store）
- [x] typecheck 双侧 + vitest 66 用例 + build 全绿

## 7. 实施记录（2026-08-24 完成）

| 文件 | 改动 |
|---|---|
| `src/shared/sse-subscriber.ts` | URL → `/global/event`；信封解析（directory 缺省 "global"）；`onEvent(directory, payload)` 双参；sync 丢弃 |
| `src/renderer/src/store/app-store.ts` | 删 subscriptionDirectories/sseGroup/全部重订调用点（setCurrentWorkspace/switchProjectContext/createWorkspace/removeWorkspace）；单 sseSubscriber 字段；handleEvent 前置闸门 `isOpenedDirectory`；`openedDirectories()` 统一目录源（闸门/对账/状态快照三处共用）；updateSseAggregate 单流直映；快照限流校准（项目 2 × 目录 3，乘积 ≈ 空闲槽） |
| `src/shared/reconciler.ts` | 会话快照从无界 `Promise.all` 改 `runLimited`（3）+ 单目录失败跳过回调（保留旧值）——旧方案的隐式并发上限（订阅集 ≤5）随目录全集接线消失，须显式恢复（review 发现）；status/messages 限流按 1 SSE/5 槽口径校准（3/4）；`getStatusDirectories` 接口文档更新 |
| `src/shared/api-types.ts` | GlobalEventEnvelope 类型 |
| `src/shared/sse-subscriber.test.ts` | 信封化重写 + 新用例（sync 丢弃/缺省 global/非信封结构） |
| `docs/spec-v0.1.md`、`docs/design-v0.1-implementation.md` | 事件端点与契约事实表同步（设计定稿时完成） |

session.status/session.idle 分支内的旧闸门删除（前置闸门已覆盖）；`getOpenedDirectories`/`getStatusDirectories` 均接 `openedDirectories()` 全集。

## 8. E2E 验证记录（GNOME/Wayland 实机，server 1.18.20 @15120，CDP 9223/9224 驱动真实窗口）

- [x] 冷启动：单条 `/global/event` connected → streaming，37 项目可见，2 打开项目快照正常，无 error 日志
- [x] 切工作区（openbuilder-desktop → neon-squid worktree → 回根）：scope 正确变化，期间 `[sse]` 日志为空（连接不动）
- [x] 非 scope worktree（sunny-circuit）内创建会话：事件 2s 内进 store（`eventArrived:true`），删除同步消失（`deletedGone:true`）
- [x] 关闭项目后在同目录创建会话：闸门拦截（`leakedIntoStore:false`）
- [x] CDP Network 域：切工作区/切项目/关项目全流程**零新增 SSE 请求**
- [x] TCP 实测：新代码实例 NetworkService 对 15120 共 3 条（1 SSE + 2 REST 池）；同场景旧代码实例（另一检出，9222）5 条（3 SSE + 2 REST）——连接预算释放得到直接对照证实
