# design-worktree-sync.md — 他端创建/删除 worktree 的同步

> 日期：2026-08-28；2026-09-29 修订（§0 数据源切换）；2026-10-12 增补（§3.4 删除后 location evict）
> 状态：已实现，待评审

## 0. v2 GA 数据源修订（2026-09-29，取代 §2/§3 的 sandboxes 假设）

**活体核实（2.0.18 + 官方源码 `081eef3b80` "make worktree APIs project-based"）推翻
D2 时代的判断**：worktree 已迁至独立 WorktreeTable，`Project.sandboxes` 成为**冻结
legacy 列**——server 侧唯一写点只剩 `upsertProject` 的 insert 空数组（onConflict 不
更新），create/remove 均不再维护它。实况（openbuilder-desktop 项目）：

- 新 API 创建的 worktree（如 `shiny-planet`，落 `worktree/<projectID 前 6 字符>/`）
  只进库存，**sandboxes 永远没有它** → 客户端按 sandboxes 渲染 = 永不显示；
- 旧机制时代的存量（如已删 `quick-cactus` 的 addSandbox 残留）**永不清理** → 幽灵行
  常驻且删除必 400（目录不在磁盘，server `canonical()` 抛 DirectoryUnavailableError）；
- 附带契约修正：`POST /api/worktree` 响应是**裸 `{directory}`**（无 `{data}` envelope，
  全 client 唯一）——原按 envelope 解析 `res.data` 得 undefined，createWorkspace 抛
  TypeError 报「创建失败」（server 实际已建成功）。

**修订后机制**（官方 v2 app 同源：`withWorktreeInventory` 以库存覆盖 sandboxes）：

| 端点/事件 | 用途 |
|---|---|
| `GET /api/worktree?projectID=` | 库存列表（裸数组 `[{directory, strategy?}]`，含主 checkout 行——渲染时排除项目 canonical） |
| `POST /api/worktree/refresh` | server 端对账：跨已知 checkout 根发现外部 git worktree 增删、清理死行（**rm -rf 的库存残留只有此端点能清**） |
| `worktree.updated` SSE | create/remove/refresh 有变更时发（`data.projectID`，**无 location**）；ready/failed 是旧 experimental 面事件，v2.0.18 不再发 |

实现（app-store）：

- `worktreeDirs: Map<projectId, string[]>` 库存缓存；`loadWorktreeInventory(id, {refresh?})`
  载入 + `mergeWorktreeDirsIntoProjects()` **union 进内部 sandboxes**（只增不减——
  闸门/作用域/快照/记忆全下游同构受益，无需逐处改）；
- `workspacesOfProject` 渲染**库存优先**（幽灵不渲染、新建可见），未加载/端点失败回退
  sandboxes（旧 server 兼容）。**显示顺序 = 创建顺序（新建的在最后，2026-09-29）**：
  server 返回创建逆序（2.0.18 活体实测，契约无显式排序保证），客户端在
  `loadWorktreeInventory` 反转——`WorktreeDirectory` 无时间戳字段，数组序是创建序
  唯一载体，只能信任 server 返回序；回退 sandboxes 路径不反转（顺序随 server 快照，
  兼容路径不做保证）；
- 对账触发点：连接（refreshAllOpenedProjects）/打开项目/60s 定时/SSE 重连 → 每打开的
  git 项目 `refresh + list`；本端 create/remove 后定向 list（server 状态已随 mutation
  更新）；`worktree.updated` SSE → syncWorktrees（丢消息补偿）；
- 卸载：库存 diff（消失目录 → `unloadWorktreeDirectory`，内含 sandboxes 剥离——防
  union 残留导致 60s 重复卸载）。

## 1. 问题（2026-08-28 原始记录）

左栏 worktree 列表数据源是 `Project.sandboxes`（`listProjects()` 快照）。本端创建/删除
（`createWorkspace`/`removeWorkspace`）会同步重拉，但他端操作时本端无感知——直到本端同
项目新建 worktree 才重拉刷新。现象：通过 CLI/TUI/移动端创建或删除 worktree 后，桌面端
左栏不更新。

## 2. 调研（历史结论，§0 已修订）

### 2.1 server 事件契约（v1 experimental 面，已随 v2 迁移作废）

| 操作 | SSE 事件 | 说明 |
|------|---------|------|
| 创建（`POST /experimental/worktree`）| `worktree.ready` / `worktree.failed` | boot 流程结束发 `ready`；boot 失败发 `failed`。**v2.0.18 的 /api/worktree 不再发**（改发 `worktree.updated`，见 §0） |
| 删除（`DELETE /experimental/worktree`）| **无任何事件** | 全程不发 SSE，只返回 HTTP 成功（v2 亦然——删除靠 `worktree.updated` 事件，它在 DELETE 成功后发） |

### 2.2 移动端现状（`../openbuilder`）

- `design-worktree-remove-cleanup.md`：删除走本地定向清理（`ServerStore.removeWorktree`），他端删除靠 `server.connected` 触发的 `_scheduleReconcile`（800ms 延迟全量快照）兜底，非实时。
- v2 迁移后：`_reconcileSandboxes` 对每项目 `GET /api/worktree` 后**过滤** sandboxes
  幽灵（`_filterSandboxes`）；`worktree.resolved/updated/ready/failed` 事件统一
  `_scheduleReconcile`（与本端 §0 修订同源共识：库存为准）。

### 2.3 结论

- **创建/删除**：`worktree.updated` SSE 实时刷新（v2 GA 起删除也有事件）。
- **外部非 API 变更**（手动 `git worktree add`/`rm -rf`）：靠 refresh+list 对账。
- **双重保证**：SSE 负责实时性，refresh+list 负责外部变更检测 + SSE 丢消息补偿。

## 3. 设计（§0 修订后的现行实现）

### 3.1 SSE 监听（`worktree.updated`）

`handleEvent` 在目录闸门**之前**处理 `worktree.ready/failed/updated`（事件的目录可能
尚未进本地库存）：

- `worktree.updated`：`data.projectID` 判断项目是否打开（信封无 location/project 字段，
  活体实测 2026-09-29），已打开 → `syncWorktrees()`（refresh + list + diff）。
- `worktree.ready/failed`：v2.0.18 不再发（旧 experimental 面事件），保留分支兼容早期
  v2：按 `meta.project` 门控走同一 reconcile。

### 3.2 对账检测（`syncWorktrees`）

```ts
async syncWorktrees(): Promise<void> {
  // 每打开的 git 项目：refresh（server 对账）+ list（库存载入 + union 合并）
  await runLimited(this.openedProjects.filter((p) => p.vcs), 3,
    async (p) => { await this.loadWorktreeInventory(p.id, { refresh: true }) })
  const fresh = await client.listProjects()   // canonical/name 等其余字段对账
  this.projects = fresh; this.mergeWorktreeDirsIntoProjects()
  // diff：before(worktree ∪ sandboxes) vs next(同构)——库存行消失即卸载信号
  for (const d of oldDirs) if (!nextDirs.has(d)) toUnload.push(...)
  for (...) await this.unloadWorktreeDirectory(...)  // 内含 sandboxes 剥离
}
```

**`unloadWorktreeDirectory`**：卸载会话/Tab/记忆/状态/pty/浏览器视图/草稿，复位
`currentWorkspaceId`（当前项目删当前 worktree 时），并从内部 sandboxes 剥离该目录
（union 残留防 60s 重复卸载）。

**为什么渲染库存优先而闸门用 union？** 幽灵目录（仅存于冻结 sandboxes）不渲染是产品
诉求；闸门/作用域放宽到 union 是防御（死目录无会话/事件流量，多放行无害），且免改
15+ 个 sandboxes 消费点。

### 3.3 触发时机

| 时机 | 触发 | 说明 |
|------|------|------|
| 应用启动 | `connect()` → `refreshAllOpenedProjects`（库存先行 + 会话快照） | 快照目录集 = worktree ∪ sandboxes（WT-1），库存必须先合并 |
| 窗口 focus | `app.tsx` onFocus → `syncWorktrees()` | 切回应用即见最新态 |
| 定时 | 60s `setInterval` → `syncWorktrees()` | 外部变更兜底（refresh 发现 + 死行清理） |
| SSE 重连 | `onReconnected` → `syncWorktrees()` | 补偿断连窗口丢的 `worktree.updated` |
| SSE 事件 | `worktree.updated` → `syncWorktrees()` | 他端 create/remove 实时（v2 GA 起删除也有事件） |
| 本端操作 | `createWorkspace`/`removeWorkspace` → `refreshWorkspacesForProject`（定向 list）；`removeWorkspace` 删除成功后另做 location evict（§3.4） | server 状态已随 mutation 更新，无需 refresh |

**连接拆除**：`teardownConnection` 清空 `worktreeDirs`（重连重载）并停定时器。

### 3.4 删除后 location evict（2026-10-12 增补，原 todo-worktree-delete-location-evict 落地）

**问题（ref-pseudo-project-cleanup §3.4，燃料 6）**：客户端打开过的目录在 server 留
warm location（`location-services.ts` `idleTimeToLive: Duration.infinity`——LayerMap
层永不闲置淘汰），**不随目录删除而消失**：死目录 location 实测驻留 ≥10 分钟，且
每 5 分钟照常刷新 provider/model（对死目录发事件）。

**2026-10-13 三订定位（真触发器）**：伪行建档与 warm 无关——**任何带
`location[directory]=<目录>` 的请求**都会经 location 中间件按需 boot →
`project.resolve(目录)`，而 `FSUtil.resolve` 对缺失路径回退原路径，死目录照样
走完 → 目录哈希兜底建档，**一发一行**（两条 curl 可确定性复现，ref §5.2 诊断式）。
桌面端的请求来源 = fs/vcs/session-create 等带 location 的调用（vcs 面板、文件树、
diff 轮询）。删除 worktree 后若有任一在途/迟到的此类请求落向死目录，即建一行；
neon-wizard 中招、quick-circuit 幸免即此差异。evict 的价值 = 治 warm 死驻留与
事件噪声（保留），**防不住本机制**（请求会 re-boot location）——预防见 §3.5。
`POST /api/location/reload` 不适用（invalidate 全部后**立即重建**）。

**设计**：`removeWorkspace` 在 `DELETE /api/worktree` **成功后**顺手 evict 该目录
location。删除失败路径不 evict——worktree 未删，location 保留是正确行为。

| 项 | 决策 |
|---|---|
| 端点 | `DELETE /api/debug/location?location[directory]=<绝对路径>`，**204** 无返回体。pin 的 openapi_v2.json **含**该端点（debug 组：GET `debug.location.list` / DELETE `debug.location.evict`，deepObject query，204/400/401）——原 todo 与 ref-pseudo-project-cleanup §3.4 判「未文档化」是误查（2026-10-12 订正）；debug 面语义稳定性弱于业务组，**server 升级随 pin 核对** |
| 封装 | 单点 rest-client `evictLocation(directory)`，不散落调用；directory 必填——requestRef 取参兜底是 `process.cwd()`，裸调会 evict server cwd 的 location，签名层面杜绝 |
| 失败 | best-effort（同 `mountWorktreeBranch` 降级风格：**warn 留痕**不阻塞删除）——端点被升级移除/改名时不静默失效（伪行再生恰是本设计要消灭的故障模式，无声回归与之相悖）；伪行仍可 SQL/server 重启处置（ref §5.2） |
| 顺序安全 | 该目录会话已在删除前级联删（D2 语义），evict 不打断活会话；invalidate 语义 = detach 路由、borrowers 保留旧图到边界，无新增风险 |
| 上游 | 治本在上游（location 发现失败不应 upsert project 行 + 补回收，ref §8 待办 issue）；本端 evict 是止血。dev HEAD 已把 idleTimeToLive 改回 `"60 minutes"`（#34119）但未进 v2.0.x 发行线，且内部刷新是否重置 idle 计时未活体复核 |

活体契约核对（2026-10-12，本机 15120 = 2.0.26——端点 2.0.18 pin → 2.0.26 存续）：
`GET /api/debug/location` 返回**裸数组** `[{directory}]`（盘点用，本端暂不消费）；
DELETE 带 deepObject query → 204，warm 集合即时移除该目录（GET 复核为证）。注意
DELETE 对**非 warm 目录同样返回 204**（幂等空 evict）——204 不是「确有 evict」的
确认信号，本设计不消费返回值，与此语义一致。

### 3.5 删除前 location 请求屏障（2026-10-13 增补，ref §3.4 三订的预防落地）

**问题**：伪行建档由「带 `location[directory]=<死目录>` 的请求」触发（§3.4 三订，
一发一行）。`removeWorkspace` 的作用域切换（回根 + `resetFileTree`）虽是同步先行，
但**在途**的 fs/vcs 请求（文件树展开、vcs 面板、diff）仍会落在 server 侧——删除
窗口内/后到达即建一行；neon-wizard 中招、quick-circuit 幸免即此差异。

**设计**：rest-client 层做「按目录的请求屏障」，`removeWorkspace` 在删除窗口启用：

| 项 | 决策 |
|---|---|
| 闸门（gate） | `suspendLocationRequests(dir)` 把目录加入挂起集：此后**所有**带该目录 location 参数的请求**立即拒绝**（抛错）——作用域已切走，此时还打向该目录的只能是迟到 timer/竞态漏网，拒绝即消灭；`resumeLocationRequests(dir)` 解除 |
| 屏障（barrier） | 按目录计数在途 location 请求；`awaitLocationIdle(dir, 1500ms)` 轮询等清零，**超时放行**（best-effort，同 evict 降级风格——慢请求（如 30s 超时的 vcs diff）不阻塞删除） |
| 覆盖面 | rest-client **全部 17 个**带 location 的 fetch 方法：`resolveLocation` / `createSession`（body location）/ `vcsStatus` / `listVcsDiff` / `listFiles` / `findFiles` / `readFileContent` / `listAgents` / `listModels` / `listIntegrations` / `connectIntegrationKey` / `createPty` / `updatePtySize` / `ptyConnectToken` / `listCommands`（command+skill 双源）/ `listPendingPermissionRequests` / `listPendingForms`。**豁免**：`evictLocation`（删除链路自身要用，且只 invalidate 不 boot）、`deletePty`（清理动作，挂起会拒绝清理——改由顺序保证，见下）、pty WS connect（不走 fetch 层，终端清理另有链路） |
| 接线 | `removeWorkspace`：`deletingWorkspaces.add` 后开 `try`（同步段抛错也走 finally）→ `suspend` → **pty 预杀**（`killPtyInDirectory`，目录存活期发 `deletePty` 无害；留到 DELETE 后 unload 再杀 = 确定性建一行——评审 blocker 修复，函数改幂等防 unload 二次重发）→ 级联删会话 → **`awaitLocationIdle` → `DELETE /api/worktree`** → evict/refresh/分支清理 → `finally` 里 `resume`（失败路径也解除） |
| 顺序 | suspend 早于作用域切换后的任何 await；`awaitLocationIdle` 紧贴 `deleteWorktree` 之前——等清零后到删除落地之间不再有新请求（gate 已挡） |
| 误伤面 | 挂起窗口 = 整个 removeWorkspace（亚秒级）；非当前项目删除时该目录的 file/diff Tab 在 unload 前仍在，窗口内事件驱动的重载会吃到拒绝、Tab 短暂呈错误态——与「目录正在被删除」的语义一致 |
| 兜底 | 漏网残留照旧按 ref §5.2 处置（本设计把概率压到接近零，不做删除后清行——无删除 API）。**已知残留**：他端删除（`syncWorktrees` 的 unload 路径）时目录在对账开始前已死，该路径的 pty 清理等 location 请求仍可能落死目录——由执行删除的一方防御（openbuilder 同构对齐中），本端接受偶发 |

与 §3.4 的关系：evict 治 warm 死驻留（保留），本节治请求触发（预防）——两者正交，
共同构成删除链路的伪行防御。

## 4. 边界与防御

| 场景 | 行为 |
|------|------|
| SSE 丢 `worktree.updated`（断连窗口内他端操作） | 重连时 `syncWorktrees` 兜底（refresh+list+diff） |
| 冷启动窗口（应用未运行期间的增删） | `connect()` 首轮库存即最新态（diff 基线为空，无卸载误报） |
| 外部 `rm -rf` worktree 目录 | 库存行残留 → refresh 清行 → 下轮 list 消失 → 卸载；删除按钮若先被点到，400 错误呈现 |
| 旧 server 无 /api/worktree 端点 | `loadWorktreeInventory` 容错回退 sandboxes 渲染（行为同 v0.4，库存缺失仅失去新数据源收益） |
| 幽灵目录（仅存冻结 sandboxes） | 不渲染、不可删（无库存行）；保留在内部 sandboxes 闸门放宽，卸载不触发（diff 双侧同含） |
| `syncWorktrees` 在途时 disconnect | `client !== client` 闸门丢弃（同 reconciler 模式） |
| 同一目录被多项目 sandboxes 共用 | `unloadWorktreeDirectory` 按 `projectId` 过滤，不误关他项目 Tab |
| 删除当前 worktree（当前作用域） | `currentWorkspaceId` 复位 null + `restoreScopeTabs(project.worktree)`（同 `removeWorkspace`） |
| `listProjects` 失败 | `syncWorktrees` 直接 return（不覆盖本地 projects；库存已载入则渲染不受影响） |

## 5. 涉及文件（2026-09-29 修订）

| 文件 | 改动 |
|------|------|
| `src/shared/api-v2-types.ts` | `WorktreeDirectory` wire 类型 |
| `src/shared/rest-client.ts` | `createWorktree` 裸响应修正；新增 `listWorktrees`/`refreshWorktrees`/`evictLocation`（§3.4）；location 请求屏障（§3.5）：`withLocation` 包装 + `suspendLocationRequests`/`resumeLocationRequests`/`awaitLocationIdle`，17 个带 location 的方法纳入 |
| `src/renderer/src/store/app-store.ts` | `worktreeDirs` 状态 + `loadWorktreeInventory`/`mergeWorktreeDirsIntoProjects`；`workspacesOfProject` 库存优先；`syncWorktrees` refresh+list+diff；`refreshAllOpenedProjects` 库存先行；`unloadWorktreeDirectory` sandboxes 剥离；`removeWorkspace` 删除成功后 evict location（§3.4）+ 删除窗口 location 屏障接线与 pty 预杀（§3.5，`killPtyInDirectory` 改幂等）；teardown 清理 |
| `src/shared/sse-subscriber.ts` | （不变；meta.project 透传沿用） |

## 6. 测试

- `rest-client.test.ts`：listWorktrees 裸数组/query、createWorktree 裸响应/name 透传、refreshWorktrees payload/204、evictLocation DELETE deepObject query/204（§3.4）——4 用例；location 屏障（§3.5）——gate 拒绝/豁免 evict/他目录不受影响/barrier 超时放行与清零即回/失败归零，5 用例
- `app-store.test.ts`：库存为准渲染（幽灵不渲染/新建可见/union）、createWorkspace 裸响应+切换、他端删除库存 diff 卸载、removeWorkspace 库存刷新——4 用例；removeWorkspace location evict（删除成功必调/失败不调/evict 失败不阻塞删除）——3 用例（§3.4）；location 屏障（§3.5）——顺序契约（suspend→idle→delete→resume）/失败路径也 resume/pty 预杀先于 DELETE 且幂等，3 用例；既有 worktree 用例（fake 缺省无库存端点 = 旧 server 回退路径）全数保留（非阻塞删除态一例因 DELETE 前多一跳 awaitLocationIdle 补 `setTimeout(0)` 宏任务拍）

## 7. 不做的事

- **不接 `worktree.failed` 做 busy UI**：v2.0.18 不发此事件；`createWorkspace` 同步 await，无 busy 态需复位。
- **不做乐观展示**：他端创建的 worktree 出现在列表底部不突兀，事件/对账延迟可接受。
- **不清理 server 侧冻结 sandboxes 列**：无写 API（PATCH /api/project 不含该字段）；
  客户端渲染已免疫，server 侧残留无消费者（官方 app 同样无视）。
- **不渲染无 strategy 的 checkout 根**：库存含主 checkout 行（项目 canonical），渲染层排除（与旧 sandboxes 语义对齐）。
- **不做对账批量 evict 兜底**（原 todo 可选项——`GET /api/debug/location` 盘点死目录
  逐个清）：本端删除路径已覆盖（§3.4）；他端删除的漏口由执行删除的一方负责
  （openbuilder 同构对齐中），外部 `rm -rf` 场景的 warm location 靠 server 重启/
  上游 idleTimeToLive 收敛——「死目录判定」客户端无权威源（磁盘存在性不可判），
  误 evict 活目录（他端在用）代价不对称，需要时再增。