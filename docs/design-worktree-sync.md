# design-worktree-sync.md — 他端创建/删除 worktree 的同步

> 日期：2026-08-28；2026-09-29 修订（§0 数据源切换）
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
| 本端操作 | `createWorkspace`/`removeWorkspace` → `refreshWorkspacesForProject`（定向 list） | server 状态已随 mutation 更新，无需 refresh |

**连接拆除**：`teardownConnection` 清空 `worktreeDirs`（重连重载）并停定时器。

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
| `src/shared/rest-client.ts` | `createWorktree` 裸响应修正；新增 `listWorktrees`/`refreshWorktrees` |
| `src/renderer/src/store/app-store.ts` | `worktreeDirs` 状态 + `loadWorktreeInventory`/`mergeWorktreeDirsIntoProjects`；`workspacesOfProject` 库存优先；`syncWorktrees` refresh+list+diff；`refreshAllOpenedProjects` 库存先行；`unloadWorktreeDirectory` sandboxes 剥离；teardown 清理 |
| `src/shared/sse-subscriber.ts` | （不变；meta.project 透传沿用） |

## 6. 测试

- `rest-client.test.ts`：listWorktrees 裸数组/query、createWorktree 裸响应/name 透传、refreshWorktrees payload/204——3 用例
- `app-store.test.ts`：库存为准渲染（幽灵不渲染/新建可见/union）、createWorkspace 裸响应+切换、他端删除库存 diff 卸载、removeWorkspace 库存刷新——4 用例；既有 worktree 用例（fake 缺省无库存端点 = 旧 server 回退路径）全数保留

## 7. 不做的事

- **不接 `worktree.failed` 做 busy UI**：v2.0.18 不发此事件；`createWorkspace` 同步 await，无 busy 态需复位。
- **不做乐观展示**：他端创建的 worktree 出现在列表底部不突兀，事件/对账延迟可接受。
- **不清理 server 侧冻结 sandboxes 列**：无写 API（PATCH /api/project 不含该字段）；
  客户端渲染已免疫，server 侧残留无消费者（官方 app 同样无视）。
- **不渲染无 strategy 的 checkout 根**：库存含主 checkout 行（项目 canonical），渲染层排除（与旧 sandboxes 语义对齐）。