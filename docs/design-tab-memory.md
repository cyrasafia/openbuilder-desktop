# worktree 级 Tab 记忆 — 设计文档

> 需求：每个 worktree（含项目主工作区）记忆已打开的 Tab；首次打开全量开未归档会话；切走保存 / 切回恢复；关闭项目清除记忆。
> 修订 design-layout §4 的"自动以 Tab 打开（最近活跃优先，上限 8 个）"规则，由本文取代。

## 1. 现状与病灶

当前 `openScopeSessionTabs()`（app-store.ts）的行为：

- **每次**切入作用域都把"最近活跃前 8"补开为 Tab——不是记忆语义：用户关掉的 Tab（未归档场景不存在，但用户在另一客户端归档的、或切走后新建的会话）会在每次切换时被重新"补开"；切换不是幂等的状态恢复，而是反复的聚合操作
- 重启后 `this.tabs` 清零（Tab 不持久化），且 `connect()` 不打开任何 Tab——重启必然落到会话列表视图，与 `project.state`（持久化当前项目/工作区）不对称
- 无 per-worktree 状态：Tab 全集跨项目混排，切回某工作区时无法表达"这个工作区当时开着哪些"

## 2. 参考先例（openbuilder）

- `design-workspace-toggle.md`：**客户端本地态模式**——按 profile 命名空间隔离、load 先于使用（无异步竞态）、内存态与持久态同源、connect/disconnect 清内存不清持久。本设计的记忆同属"server 无此概念、纯客户端状态"（与项目打开/关闭一致）
- 该文档评审教训（WT-1 跨 profile 泄漏、WT-2 load/infer 竞态）对应到本设计：记忆按 profileKey 切片；启动恢复必须在快照落地**之后**

## 3. 语义定义

### 3.1 作用域键

- 记忆键 = `(profileKey, directory)`。directory 是 worktree 绝对路径；**主工作区 = `project.worktree`**（与项目行本身对应，沿用现有 scope 约定）
- directory 在单个 server 内唯一归属一个项目，无需再带 projectId；跨 server 由 profileKey 隔离

### 3.2 记忆结构

```ts
interface ScopeTabMemory {
  /** 写入时该 directory 所属项目——closeProject 整体清除 + 重建检测（§3.3） */
  projectId: string
  /** 有序 sessionID 列表（Tab 顺序，左→右） */
  tabs: string[]
  /** 该作用域最近激活的 chat sessionID；无则 null */
  active: string | null
}
// 持久化：Record<profileKey, Record<directory, ScopeTabMemory>>
```

- 只记 **chat Tab**。file Tab 虽作用域化（2026-08-25 修订，见 §18；原为跨作用域全局显示）但仍不参与记忆——只读视图重开成本为零，激活经 §7 回退。（**2026-09-03 修订**：file/diff/terminal/browser 实体经 [design-tab-session-restore.md](./design-tab-session-restore.md) 的**会话持久层**跨刷新/重启恢复；记忆结构不变、chat 语义不变，本节"不参与记忆"指不进 ScopeTabMemory）
- 顺序 = Tab 条顺序。v0.1 无拖拽排序，顺序即打开顺序；记忆结构预留顺序语义，拖拽（v0.2+）落地后天然兼容
- **运行期任意 kind 的最后选中态另经 `scopeActiveKeys` 内存记录**（2026-08-26，见 §7 规则 1.5 与 [design-tab-state-memory.md](./design-tab-state-memory.md) §2.1）——本记忆结构的 `active` 仍 chat-only，仅约束冷启动恢复

### 3.3 关键不变量

- **空记忆 ≠ 无记忆**：`tabs: []` 表示"用户已收敛到零 Tab"，必须保留——否则下次切入会重新落入"首次打开全量开"，违背用户意图
- **首次打开判定 = 记忆表中无该 directory 条目**，或条目 `projectId` 与当前所属项目不符（worktree 被删后在同路径重建、甚至归属其他项目的场景——旧记忆按失效丢弃，走首次打开，避免"继承陈旧记忆 → 收缩为空 → 永不触发首次打开"的死结）
- 记忆是 **live Tab 列表的派生投影**，不是第二权威：运行期间 live tabs 唯一权威，记忆在 Tab 变更点同步派生；仅重启时记忆作为重建 live tabs 的输入

## 4. 持久化

- 复用现有 IPC store（`userData/store.json`，main 侧内存缓存 + 写队列串行），key = `tabs.memory`
- `doInit` 与 `project.state` 一并整体加载；每次记忆变更整体写回（作用域数量级 = 打开项目 × worktree 数，很小）
- disconnect/teardown 只清 live tabs（现状），**不清持久记录**——重连/重启后按记忆恢复（与 project.state 同寿命）
- profile 切换天然隔离（按 profileKey 切片读写）

## 5. 记忆更新规则（派生模型）

单一方法 `syncScopeMemory(directory)`：从 live tabs 过滤 `kind === "chat" && directory === 作用域` 的 Tab，按序取 sessionID，与 active 一起写入记忆并持久化。调用点收敛在 Tab 变更处：

| 时机 | 动作 |
|---|---|
| `openChatTab`（含新建会话、会话列表点击） | 若是新 Tab → 追加进所属 directory 记忆尾部；激活 → 更新 active |
| `closeTab`（chat 分支，含关 Tab=归档、session.deleted、删会话） | 从所属 directory 记忆移除；若移除的是 active → 按激活回退结果更新 |
| `setActiveTab` | 激活 chat Tab → 更新所属 directory 的 active；**激活 file Tab 不改写**（保留该作用域最近 chat 激活，见 §7 激活规则） |
| 首次打开写入 / 恢复收缩（§6） | 整体写入 |
| `openChatTabPassive`（§17 修订 2026-09-02，实时补开） | 新 Tab 末尾追加进所属 directory 记忆；**active 不动**（不激活） |
| `closeProject(projectId)` | 删除记忆中**所有 `projectId` 匹配的条目**（不按当前 sandboxes 枚举——外部删除的 worktree 目录不在 sandboxes 里，按目录枚举会留孤儿条目永久残留 store.json）——需求明确：关闭项目清除记忆；重开项目即"首次打开" |
| `removeWorkspace(directory)` | 删除该 directory 条目（目录已死，记忆无意义）；并显式关闭该目录 live chat Tab（现状依赖 session.deleted 事件兜底，存在订阅已拆的窗口期）；删除的是当前 worktree 时作用域切回项目根 → 走 §6 恢复（与其他切换路径一致） |

- 恢复校验剔除的记忆变更（§6）同样走 `syncScopeMemory` 落盘
- **恢复路径不走同步钩子**：§6 的批量开 Tab 使用无激活副作用的开 Tab 路径（不经 `openChatTab` 的记忆同步/激活写入），记忆整体以 §6/§7 计算结果一次性写入——否则逐 Tab 经过 `openChatTab` 会把 mem.active 逐步改写成最后恢复的 Tab，覆盖 §7 激活规则
- 更新失败（IPC 写失败）仅内存态与持久态暂时不一致，重启后回退旧记忆——可接受（同 openbuilder WT-5 结论）

## 6. 切换恢复流程（restore-or-first-open）

替换现 `openScopeSessionTabs`，在 `switchProjectContext` / `setCurrentWorkspace` / 启动（§7）统一调用：

```
restoreScopeTabs(dir):
  sessions = sessionsInDirectory(project, dir)      // 未归档 + 非 subagent，来自已落地的快照
  mem = memory[profileKey][dir]

  if (!mem):                                        // —— 首次打开 ——
    ordered = sessions 按 time.created 升序          // 时间线左→右，新会话靠右（与新 Tab 追加右端的惯例一致）
    逐个开 Tab（复用已开）
    mem = { tabs: ordered.map(id), active: 最近活跃(updated 最大)的 id ?? null }
    写入并持久化（sessions 为空也写入空记忆——§3.3 不变量）
  else:                                             // —— 记忆恢复 ——
    valid = mem.tabs ∩ sessions                     // 剔除已被归档/删除/subagent 化的
    fresh = sessions − mem.tabs（created 升序）      // 记忆外可见会话——补开（2026-08-24 修订，原"不补开"，见 §17）
    按 valid ∘ fresh 顺序补齐 live Tab（复用已开）
    记忆更新：mem.tabs ← valid ∘ fresh（持久化）
    激活：见 §7（active 保持记忆值，失效按 §7 回退，不因补开顶替）
```

**防御闸门（快照不可信）**：`mem.tabs 非空 && sessions 为空 && 该目录在 sessionsByProject 中完全无记录` → 视为快照拉取失败（catch 兜底空快照，session-merge 保守保留后仍空），**不打开 Tab、不收缩记忆**，但激活清算：若当前激活的 Tab（任意 kind）不属于该作用域 → 置 null（Tab 条按作用域过滤不显示它、中栏却会渲染其内容；2026-08-25 起 file Tab 同样作用域化，见 §18）。恢复时机 = **下次切入该作用域或重启**；对账快照落地**不**自动重触发（避免引入"对账 → 恢复 → 激活变更"的副作用链，恢复只在显式切换路径发生）。区分依据：真"全部被归档"时本地目录会话集非空（只是被过滤），唯快照从未落地才是全空。**例外（第四轮）**：`snapshottedDirs` 含该目录时空态可信（整目录被他端清空时 store 清空快照会移除本地会话，"全空"是真实状态而非未落地），闸门放行、照常收缩收敛。

**首次打开的空集写入前置校验**：区分"真实空目录"与"快照未落地"的信号是**快照落地标记**（`snapshottedDirs` 成功集合：applySessionsSnapshot 落地即加入，refresh 失败不加，关项目/删工作区随目录清除）——未落地时跳过写入（下次切入重试，幂等），仅真实空目录才写空记忆哨兵。否则未落地瞬间写入的 `{tabs: []}` 会让该作用域永不触发全量打开。（2026-08-24 修订：原为失败集合 `snapshotFailed`，先切换后加载引入"从未拉取"目录后改为成功集合——失败集合无法覆盖"从未尝试"与"关项目后重开"两种未落地形态）

**切入作用域的两阶段恢复（先切换后加载，2026-08-24）**：`openProject`/`setCurrentWorkspace` 点击后同步段立即生效并渲染（左栏高亮/标题跟手、文件树即刻重置重载、SSE 重订、有记忆的作用域即时恢复 Tab+激活）；快照刷新在后台落地后再跑一遍完整恢复（含首次全量打开与激活收敛，闸门：在途时已切走则不动作）。同步段**不做**首次全量打开——内存快照可能滞后，此刻全量打开会把滞后集合固化为记忆（空/滞后目录与真实状态不可区分），首次打开只认快照落地后的完整恢复；同步段无记忆时仅清算跨作用域激活。有记忆路径的补开是幂等增量（§17 修订后）：本地已有者即时段即开，滞后漏开的会话由完整恢复补齐，无固化风险。

**死会话 Tab 收敛（2026-08-24 第四轮）**：完整恢复段（immediate=false 且 `snapshottedDirs` 含该目录）关闭"会话已不可见（他端归档/subagent 化，或已从快照消失——窗口删除/整目录清空）"的本作用域 live chat Tab——未订阅目录收不到归档事件，否则死会话 Tab 常驻且会经 `syncScopeMemory` 写回记忆。只关会话不可见/已消失的 Tab；可见会话的 Tab 一律保留（§17 修订后记忆外可见会话由恢复补开吸收进记忆）；失败快照轮保守保留旧数据（不会误关）。

**不强制收敛 live tabs 到记忆**：live 中该作用域超出记忆的 Tab（理论上不该出现——运行期记忆由 live 派生；仅异常路径可产生）保持原样，不静默关闭（关 chat Tab 牵涉归档语义，宁可冗余展示）。唯一例外见下方"死会话 Tab 收敛"——会话本身已不可见的 Tab 不在此保护范围。

## 7. 激活规则

切入作用域后：

1. 当前激活**属于目标作用域（任意 kind，按 `activeTab.directory` 判定）→ 保持**（覆盖两阶段恢复异步窗口内用户已在新作用域打开的 file/diff 或点选的 chat——不得被记忆解析顶替；2026-08-25 修订，原规则 1 为"激活是 file Tab → 保持"，file Tab 全局化后废除，见 §18）
1.5. **作用域最后激活记录命中（2026-08-26 增补，见 [design-tab-state-memory.md](./design-tab-state-memory.md) §2.1）**：`scopeActiveKeys[dir]` 为纯内存记录（用户意图激活变更，任意 kind，含引导页 `null` 哨兵）——`null` → 落引导页；记录 Tab 仍存活且属本作用域 → 激活之；失效/无记录（冷启动恒无）→ 落规则 2
2. 否则 `mem.active ∈ valid` → 激活之（回到切走时的位置）
3. 否则 valid 末位 Tab（最右）
4. 否则 null → 中栏会话列表视图

- 首次打开的 active = 该作用域最近活跃会话（updated 最大），与"激活最新动态"直觉一致；顺序仍按 created 排
- ~~运行期激活 file Tab 不改写记忆 active：切走后激活随新作用域清算；切回时激活回退到记忆 active（规则 2），file Tab 恢复可见但不占据激活（2026-08-25 修订）~~（2026-08-26 修订：切回经规则 1.5 恢复任意 kind 最后选中态，file/diff Tab 重新占据激活；记忆 `active` 仍 chat-only、只约束冷启动——重启无运行期记录自然落规则 2，见 design-tab-state-memory §2.1）
- 保持分支的 chat 激活仍回写记忆 `active`：死会话收敛的 `closeTab` 可能已经同步钩子派生了新 active，恢复收尾的 `setMemory` 不得用陈旧解析结果覆写（实现约束，2026-08-25）

## 8. 启动恢复

`connect()` 在 `refreshAllOpenedProjects()` 成功后、`startSse()` 前：

1. **逐作用域重建**：对每个打开项目的每个 directory（`worktree ∪ sandboxes`）有记忆条目的 → 按 §6 恢复分支补齐 live Tab（校验收缩），不改变激活
2. **会话层恢复**（2026-09-03 增补，[design-tab-session-restore.md](./design-tab-session-restore.md) §3）：非 chat 实体重建 + 模板序合并 + scopeActive 播种
3. **当前作用域**再走一遍 `restoreScopeTabs`（含激活规则）——无记忆则首次打开；规则 1.5 在此消费播种记录（任意 kind 激活/引导页跨重启）
4. 消息不预取：ChatView 激活即重拉（现状），恢复的 Tab 仅建 Tab 实体

改变的行为：重启不再必然空 Tab——有记忆的作用域恢复，当前作用域首次则全量开。与 `project.state` 持久化对称，补齐"重启回到离开时上下文"的体验。（2026-09-03 起"上下文"扩展至非 chat Tab 与任意 kind 激活，见会话层文档）

## 9. 与锁定语义的关系（AGENTS.md）

| 锁定语义 | 本设计 |
|---|---|
| 关 chat Tab = 归档 | 不变。关 Tab 即时从记忆移除；**外部归档**（他端/会话列表菜单）的记忆条目在下次恢复校验时剔除 |
| 切项目/工作区不关不归档 Tab | 不变。恢复只补齐/校验当前作用域，不动其他作用域 Tab |
| 关闭项目仅关该项目 Tab（不归档） | 不变，另加：清除该项目全部记忆条目 |
| Tab 注册制（kind + 稳定标识复用） | 不变。恢复即按 sessionID 幂等开 Tab |
| 打开/关闭项目纯客户端状态 | 记忆同属纯客户端状态，同寿命（按 profile 持久化） |

## 10. 场景验证表

| 场景 | 行为 |
|---|---|
| 首次切入 worktree（无记忆），3 个未归档会话 | 3 个 Tab 按 created 升序，激活最近活跃 |
| 首次切入，0 个会话 | 空记忆写入，会话列表视图；此后外部新建会话**驻留期间实时补开为 Tab**（§17 修订 2026-09-02），SSE 丢失时下次切入/重启/快照恢复补开 |
| 开 3 Tab → 切另一 worktree → 切回 | 点击即时恢复（记忆 + 已有快照，先切换后加载），快照刷新后再收敛 |
| 切走期间某会话被他端归档 | 切回时该 Tab 不恢复，记忆收缩；若 Tab 一直未关，完整恢复凭新快照关闭（§16 第四轮） |
| 切走期间该目录会话被他端全部删除 | 空快照清除本地死会话，Tab 收敛、记忆收缩至空（§16 第四轮） |
| 切走期间他端新建会话 | 驻留其他作用域期间不开（实时补开只覆盖当前作用域）；切回补开（§17）：记忆序在前、新会话按 created 升序追加尾部；active 保持记忆值 |
| **驻留期间他端在当前作用域新建会话** | **实时补开**（§17 修订 2026-09-02）：Tab 末尾追加、不激活不抢焦点、记忆即时吸收（subagent 子会话/建即归档不开） |
| **驻留期间他端归档会话（任意作用域）** | **实时收敛**（§17 修订二）：Tab 立即关（激活回退/记忆收缩走 closeTab 既有路径）；本端关 Tab=归档的 SSE 回环被在途集合抑制（保关闭栈） |
| **驻留期间他端取消归档（当前作用域）** | 实时补开回归（契约 `archived:0`，实测 `null` 不生效）；非当前作用域切回补开 |
| 关闭某 Tab（= 归档） | 记忆移除；切走再切回不再出现 |
| 关闭项目 | 项目 Tab 全关（不归档）+ 该项目记忆全清；重开 = 首次打开（全量按 created） |
| 删除 worktree | 该目录记忆删除 + live Tab 显式关闭 |
| 重启应用 | 打开项目各作用域按记忆恢复 Tab；当前作用域无记忆则首次打开 |
| 快照失败时切入 | 防御闸门：不开不收缩，下次成功快照恢复 |

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| **对账消息扇出**：`reconcileOnce` 对所有 chat Tab `Promise.all` 并行拉消息；全量开 Tab 后 N 可达几十，挤占 ~1 个 REST 空闲槽 → 整批超时 → 对账整体失败（Promise.all 一损俱损） | 消息快照拉取改并发受限（`runLimited` 3，与快照拉取同模式）；只改调度不改语义。附带：单个失败不再拖垮整批 |
| **Tab 条溢出**：全量开 Tab 可能数十个，`.tabbar` 现状无横向滚动处理（flex 挤压） | `tabbar` 加 `overflow-x: auto` + `.tab` 不收缩（min-width）+ `scrollbar-gutter: stable`（滚动条出现时 Tab 高度不跳变），纯 CSS |
| 消息惰性累积上限（20 容器）对有 Tab 会话无条件 | 全量开 Tab 后订阅目录内会话全部累积——受订阅集合（≤5 目录）天然约束，可接受；v0.1 已知限制不变 |
| **对账内存量级**：reconcile 对每个已开 chat Tab 拉 100 条消息窗口，N 个 Tab = N×100 条含 parts 的 `messagesBySession` 累积（SSE 路径按 Tab 数累积，不受 ≤5 目录约束） | 量级估算：几十 Tab × 100 条 ≈ 数千消息对象（~MB 级），桌面端可接受；`runLimited(3)` 已解决连接池饿死。若未来 Tab 数上百再考虑对非激活 Tab 降窗/跳过 |
| 记忆写放大（每次 Tab 点击 IPC 写盘） | 记忆体量极小（KB 级），main 侧写队列串行；不引入 debounce（复杂度不值） |

## 12. 测试计划

- 纯函数抽 `src/shared/scope-tab-memory.ts`（同 session-merge 模式）：
  - 首次打开排序（created 升序、active=updated 最大、空集写入空记忆）
  - 恢复校验（有效集收缩 + 记忆外可见会话补开、防御闸门触发/不触发的三分支）
  - 派生（live tabs → 记忆，含 file Tab 混排过滤、active 派生）
- store 级（vitest）：切换保存/恢复、关 Tab 移除、关项目清记忆、removeWorkspace 清记忆、空记忆保留不触发首次打开
- E2E（CDP）：worktree 开 3 Tab → 切走 → 切回（顺序+激活恢复）→ 重启（记忆恢复）→ 关项目 → 重开（全量按 created）

## 13. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/scope-tab-memory.ts` | 新增：排序/校验/派生纯函数 |
| `src/shared/run-limited.ts` | 新增：`runLimited` 从 AppStore private static 抽出（reconciler 复用，app-store 原调用点改引） |
| `src/shared/ipc.ts` | `StoreShape` 扩展 `tabs.memory` key（封闭类型，不扩展则 storeGet/storeSet 编译不过） |
| `src/renderer/src/store/app-store.ts` | 记忆加载与持久化；`restoreScopeTabs` 替换 `openScopeSessionTabs`；`syncScopeMemory` 挂点；`closeProject`/`removeWorkspace` 清记忆；启动恢复；对账 `getActiveSessions` 限并发 |
| `src/shared/reconciler.ts` | 消息快照拉取 `runLimited` 并发受限 |
| `src/renderer/src/styles/app.css` | tabbar 横向滚动 |
| `docs/design-layout.md` | §4 自动开 Tab 规则改指向本文（同步修订） |

## 14. 文档同步说明

- design-layout §4 的"最近活跃优先，上限 8 个"规则由本文取代（已在 design-layout 内修订标注）
- spec-v0.1 不含该细节（已核实，Tab 打开策略只在 design-layout），无需改动；若后续 spec 再版，将"Tab 记忆"纳入功能范围清单

## 15. 实现与验证记录（2026-08-24）

已按 §13 落地，偏差说明：

- `runLimited` 抽出为 `src/shared/run-limited.ts`；reconciler 消息快照拉取 `runLimited(3)`（会话快照 ≤5 目录保持 Promise.all 不变）
- E2E 驱动中发现并规避的测试陷阱：Tab 数量断言在作用域切换异步链落地前会即时通过（弱断言），导致在错误作用域点击 close 误归档真实会话——断言必须用作用域确定性信号（期望 Tab 标题 + 记忆内容轮询）。此为测试方法论，非产品缺陷
- vitest 43/43（含 scope-tab-memory 14 用例：首次排序/收缩/闸门三分支/派生/激活规则）；typecheck 双侧、build 全绿
- CDP E2E（真实窗口 + server 1.18.20，openbuilder 项目 3 作用域）24 项全过：首次打开（空集写空记忆/非空集激活最近活跃）、切走保存/切回恢复（Tab+顺序+active）、关 Tab=归档记忆收缩、空记忆切回不触发首次打开、三作用域记忆并存（projectId 正确）

实现后 code review 三项修复（2026-08-24 第二轮）：

- **闸门路径激活清算**：闸门 return 前若激活是其他作用域 chat Tab → 置 null（防跨作用域 ChatView 残留渲染——Tab 条过滤不显示但中栏仍渲染）
- **快照失败标记**（`snapshotFailed`）：refreshSessionsForProject 失败目录不合并空快照、记入失败集合；首次打开遇"空会话 + 失败标记"跳过写入（见 §6 前置校验）；teardown 清空（2026-08-24 第三轮起由 §16 的成功集合 `snapshottedDirs` 取代）
- **removeWorkspace 删当前 worktree**：作用域切回项目根后补 `restoreScopeTabs`（与其他切换路径一致）

## 16. 切换跟手改造（2026-08-24 第三轮）

**问题**：切 worktree 不跟手——`setCurrentWorkspace`/`openProject` 把 `persistProjectState`（IPC 落盘）与 `refreshSessionsForProject`（逐目录 REST，根 ∪ 全部 sandboxes）全部 `await` 完才 `emit`，点击后 UI（左栏高亮/中栏标题/右栏文件树）要等整轮网络才动。

**方案（先切换后加载）**：

- 同步段（点击即生效）：作用域状态写入 + 立即登记 projectStates + 文件树清空（FilePanel 侦听 workspace 变化自动重载右栏）+ SSE 重订到新 scope + `restoreScopeTabs(…, immediate=true)` + emit
- 异步段（后台加载）：persist → 快照刷新 → 闸门（projectId + scope 未变）→ 完整 `restoreScopeTabs`（含首次全量打开）
- `restoreScopeTabs` 新增 `immediate` 参数：只做有记忆的即时恢复；无记忆仅清算跨作用域激活（首次全量打开必须等快照落地，理由见 §6 两阶段恢复）
- `snapshotFailed`（失败集合）改为 `snapshottedDirs`（成功集合，applySessionsSnapshot 统一维护含对账路径；closeProject/removeWorkspace 随目录清除）——immediate 恢复使"从未拉取"目录可达恢复路径，失败集合无法区分"从未尝试"
- `loadFileNodes` 加作用域闸门：在途请求落地时若 scope 已切走，旧目录节点丢弃（旧实现此竞态窗口已存在，切换即时化后窗口变大，顺手封堵）
- sidebar 跨项目点工作区行：原 `openProject().then(setCurrentWorkspace())` 两轮串行改为 `openProject(projectId, directory)` 单次直达；点项目行不再尾随 `setCurrentWorkspace(null)`（openProject 本身归位主工作区）

**验证**：vitest 60/60、typecheck 双侧全绿（E2E 未重跑；§15 的作用域确定性信号断言方法不受影响——两阶段都在切换路径内写记忆）。

实现后 code review 修复（2026-08-24 第四轮，先切换后加载改造复审）：

- **死会话 Tab 收敛**：未订阅目录收不到他端归档事件，immediate 恢复会从滞后快照开 Tab 且完整恢复只收缩记忆不关 Tab——死会话 Tab 常驻，点击还会经 `syncScopeMemory` 写回记忆。修复：完整恢复段凭可信快照（`snapshottedDirs` 闸门）关闭"会话已不可见"的本作用域 live chat Tab（会话仍可见但记忆外的 Tab 按"不强制收敛"照旧保留）；immediate 段数据滞后，保守不动。删除覆盖 = 订阅目录的 `session.deleted` 事件 / merge 层窗口删除（updated 落快照 (min,max) 开区间内）/ 下方空快照清除；窗口外（最旧/最新会话被删、单条快照）仍是保守保留（merge 层既有取舍，服务端分页 limit 50 下"不在快照 = 已删除"不成立）
- **空快照清除（applySessionsSnapshot）**：他端把整目录会话删光时快照成功返回 `[]`，merge 层 <2 条无开区间永远删不掉。修复：空快照逐条清除本地同目录会话。安全性依据（server 源码核实 `V2Session.list`）：到达 store 的快照必为成功响应；列表不过滤 archived（空 ≠ 全被归档，GuidePage 恢复列表不受影响）；分页按 created desc，首页空即全表空。附带：§6 防御闸门加 `snapshottedDirs` 例外——空快照清除后"本地全空"是可信状态而非"快照未落地"，闸门须放行（否则清空目录的死 Tab 永不收敛）
- **setCurrentWorkspace 幻影 directory 防御 + 同值早退**：与 openProject 对齐——不在 sandboxes 内的目录视为主工作区；同值早退（不刷新不恢复），需要重同步须切走再切回
- **补 store 级单测**（`src/renderer/src/store/app-store.test.ts`，8 用例）：同步段即时生效、首次全量打开只在快照落地后、异步段过期闸门、死会话收敛（含记忆外可见 Tab 保留）、幻影 directory 防御（在有效 worktree 上传入幻影，分支真实执行）、整目录清空收敛、openProject 直达 worktree + 幻影落回——注入 fake client + 手动 deferred 快照，SSE 不启动（activeProfileId 为空时 startSse 直接返回）。vitest 67/67、typecheck 双侧、build 全绿

## 17. 恢复补开记忆外可见会话（2026-08-24 第五轮）

**问题**（kind-engine worktree 实测）：目录有 2 个未归档顶层会话，本端切入后只见 1 个 Tab。根因链：

- SSE `session.created` 只写 `sessionsByProject`，不开 Tab、不写记忆（记忆仅在 §5 三挂点从 live tabs 派生）——他端（TUI/CLI 等）新建的会话永不进入本端记忆
- §6 记忆恢复分支"记忆外不补开"使其切入作用域时不补开
- 且该会话在本端**无任何打开入口**：无 Tab 引导页仅列归档会话（`archivedSessions`），未归档但无 Tab 的会话不可点；左栏指示器只显数量

**决策**：记忆恢复分支由"只收缩"改为"收缩 + 增量吸收"——`shrinkMemoryTabs` 更名 `reconcileMemoryTabs`：valid = mem.tabs ∩ 可见（保序）在前，"可见但不在记忆中"的会话按 created 升序追加尾部；active 保持记忆值（失效置 null，由 §7 回退，不因补开顶替）。created 排序在**单次恢复内**成立；跨两阶段恢复（immediate 先吸收部分、快照落地后再吸收）时首趟已写入记忆、后见会话续排尾部，不重排——仅影响 Tab 位置不影响可达性（用户序与补开序的区分写入记忆后不可恢复，重排需复杂化记忆结构，不做）。空记忆（零 Tab 哨兵）同样补开——哨兵防的是"重新全量打开已收敛的旧会话"，它们已归档不可见，不受影响；否则空作用域中新会话不可达（引导页无入口）。

**为什么不复活用户关掉的 Tab**：关 chat Tab = 归档（锁定语义），归档会话不可见、不进 valid/fresh；"可见且无 Tab"的形态有三——他端新建、外部取消归档（两者都应展示），以及引导页发送失败的 pending 会话（`openTab:false` 先建后发，第五轮 review 补记）：作用域往返后 GuidePage 卸载、草稿与 `pendingSession` 复用引用已丢失，"重试复用同一会话"本已不可达，补开使其从"永久不可见的孤儿会话"变为可达可管理（可在 Tab 内继续对话或关 Tab 归档）——是最优可得结果，不做 ID 豁免（豁免会重新制造本节刚修复的不可见类缺陷）。

**已知后果**：补开的 Tab 只能以"归档"收场——对他端创建的会话执行 close=archive 是跨客户端副作用（会话在创建端也消失）。此为锁定语义（关 Tab = 归档）与"两者都应展示"决策的必然推论，有意为之。另：每次恢复补开全部可见会话，外部维护大量未归档会话的作用域 Tab 数随之增长——与首次打开语义一致，实践观察。

**幂等性**：immediate 段与完整恢复段跑同一 reconcile——本地已有者即时段即开（SSE 单全局流下他端新建事件已实时入 `sessionsByProject`），滞后漏开由完整恢复补齐，无固化风险（对比：首次打开仍须等快照落地，空/滞后目录与真实状态不可区分）。

**修订（2026-09-02）：实时补开——Tab 集 = 当前作用域未归档会话的投影**。原设计里本节补开只在切入作用域时发生（上面问题清单第 1 条"SSE `session.created` 只写 map 不开 Tab"即根因之一）；用户需求修订为：**处于某作用域期间，该作用域的未归档会话应实时反映到 Tab 条**。落地：`session.created` 事件到达且满足「`directory === 当前作用域` && 无 `parentID` && 未归档」（口径同 `visibleSessions`）→ `openChatTabPassive`：末尾追加 Tab，**不激活不抢焦点**（他端新建不打断当前工作，§5 挂点表已补），记忆即时吸收（重启/切回顺序保持）。边界：

- **非当前作用域目录不开**：其他 worktree/global 目录仍走本节切入补开——后台作用域不被实时事件推高 Tab 基线，零 Tab 哨兵（用户已收敛的旧作用域）不被未察看的新会话扰动
- **SSE 丢失的补偿路径不变**：切入作用域的完整恢复补开（本节）+ 重连对账快照合并后切回补开；即本节从"唯一入口"降级为"补偿 + 非当前作用域入口"
- **本端新建的可见时点提前**：引导页 `openTab:false` 流程（先建会话再发首条消息）中，会话建立即经本修订实时开 Tab（原"发送成功才开 Tab、失败不产生空 Tab"的保证不再成立）——与投影语义一致，且与本节既有推论（pending 会话经补开可达可管理）同向；发送失败时 Tab 留存（空会话可管理，关 Tab = 归档清理）
- **fork 协同**（design-session-tab-context-menu 修订四）：fork 亦经本分支被动开
  （同他端新建一条路径，不激活）——REST↔事件的标题关联（getForkedTitle 模式）因
  v1 无来源字段、同名/并发场景误报不可控已废弃，fork 改 fire-and-forget，REST
  响应仅做数据收敛 + 同路径幂等补开。E2E 实测：fork 点击 → Tab 0.3s 末尾出现、
  active 保持

**修订二（2026-09-02）：实时收敛——他端归档立即关 Tab**（投影语义的双向闭合）。实测契约（server 1.18.20）：归档 = `PATCH {time:{archived:<ts>}}`、取消归档 = `{time:{archived:0}}`（**`null` 不生效**——解码层丢弃，PATCH 原样返回旧值），两者均发 `session.updated` 事件（`info.time.archived` 带 0/时间戳，truthiness 判定与 `!s.time.archived` 口径一致）。落地（`session.created`/`session.updated` 共用分支，fork 关联优先）：

- **`info.time.archived` truthy → `closeTab(archive:false)` 立即关**，**跨作用域**（同 `session.deleted` 处置——归档/删除都不该在任何作用域留 Tab；激活回退/草稿引用清理/记忆收缩走 closeTab 既有路径）。不额外做 `cleanupSessionState`（归档 ≠ 删除，会话仍存在，引导页恢复后状态可复用；对照：§16 死会话收敛也只经 closeTab）
- **`session.updated` 且未归档且当前作用域 → 实时补开（上述 passive）**：覆盖他端取消归档（tab 回归）与 touch/重命名（有 Tab 幂等跳过，仅付一次 `tabs.some`）；取消归档在非当前作用域不开（切回补开）
- **本端关 Tab=归档的回环抑制**：`closeChatTab` 是"先 PATCH 归档、后 `closeTab(pushClosed)` 入关闭栈"，SSE 回环可能先到——实时收敛抢先关会丢 Ctrl+Shift+T 关闭栈条目。`closingChatSessions` 在途集合（try/finally 维护）抑制窗口内的回环关闭，交本地路径收尾。archiveSession 全仓唯一调用方是 closeChatTab，守护面闭合
- E2E 实测：curl 归档 → Tab **0.3s** 消失、active 不受扰；取消归档 → Tab 回归

**验证**：vitest 125/125（纯函数新增：补开排序/active 不顶替/全失效等价首次打开/零哨兵补开；store 级新增：kind-engine 场景同步段即补开 + active 保持、快照滞后幂等补齐、零哨兵可达；"死会话收敛"用例期望更新——记忆外可见 Tab 由补开吸收进记忆而非仅保留）；typecheck 双侧全绿。

## 18. file Tab 作用域化（2026-08-25 修订）

**问题**：file Tab 原为"跨作用域全局显示、不受切换影响"（design-layout §4 原语义，§7 原规则 1"激活是 file Tab → 保持"）。实测病灶：非聊天 Tab 激活时切换 worktree，Tab 条与中栏**不随作用域变化**——旧作用域的 file Tab 常显且仍占据激活，与"切 worktree = 切上下文"的直觉冲突；其跨作用域残留渲染与 chat Tab 同根源（Tab 条按作用域过滤不显示、中栏却渲染其内容），而 chat 侧已经闸门清算、file 侧豁免，语义不一致。

**决策**：file Tab 与 chat/diff 一律作用域化：

- `openFileTab` 记 `directory` = 打开时作用域目录；复用已开的同路径 Tab 时归属当前作用域（嵌套 global 目录下同文件可从两个作用域打开，显式重开 = 要在当前作用域看）
- Tab 条过滤统一 `tab.directory === scopeDir`（全 kind，不再豁免 file）
- §7 规则 1 由"激活是 file Tab → 保持"改为"激活**属于目标作用域**（任意 kind，按 directory 判定）→ 保持"；`resolveRestoreActive` 去掉 kind 参数，退化为纯记忆解析——作用域归属判定收敛在 store（它才有 live tab 的 directory）
- 闸门激活清算（`clearCrossScopeActivation`）覆盖任意 kind（原仅 chat）
- `closeTab` 激活回退限同作用域（原 file Tab 走全局候选，可回退到其他作用域的 Tab）；顺带修原实现缺陷——splice 后再 `findIndex` 恒得 -1、回退恒落候选取样首位，改为 splice 前取相邻（左邻优先、无则右邻）
- 目录卸载随关 file Tab：`closeProject`（目录归属匹配）/`closeGlobalDirectory`（directory + projectId=global——双行目录下不误关 git 项目的 Tab）/`removeWorkspace`（directory 匹配）；否则关闭后它们成永久不可见的孤儿
- 关项目条目同步修订（design-layout §4）：关项目随关 file/diff Tab（原"其余 Tab 不动"）

**不变**：

- file Tab 仍不参与记忆（§3.2）——只读视图重开成本为零；冷启动不恢复、切走不关闭（隐藏，切回恢复显示，与 chat Tab 的"切换不关不归档"一致）
- 激活 file Tab 不改写记忆 active（§5）；关 file Tab 无归档副作用
- chat Tab 的全部语义（记忆/补开/死会话收敛/两阶段恢复）不动

**验证**：vitest 231/231（纯函数 `resolveRestoreActive` 签名简化 3 用例；store 级新增 6 用例：file Tab 激活时切 worktree 激活随作用域走 + 切回恢复、闸门清算覆盖 file、关 file Tab 回退限同作用域、关 Tab 回退取相邻（左邻优先/pos=0 取右邻）、关项目随关 file Tab 且不误伤他项目、删 worktree 随关 file Tab）；typecheck 双侧全绿。

## 19. 会话持久层增补（2026-09-03）

file/diff/terminal/browser Tab、任意 kind 激活、全 kind 混排顺序的跨刷新/重启持久化由
[design-tab-session-restore.md](./design-tab-session-restore.md) 承接（新持久层 `tabs.session`，
与本文记忆分账：记忆管 chat 的集合/校验/补开，会话层管非 chat 实体 + 全局顺序 + 各作用域
最后激活）。对本文的修订点：

- §3.2 "file/diff 不参与记忆、冷启动不恢复" → 记忆结构不变（ScopeTabMemory 仍 chat-only），
  但非 chat 实体经会话层冷启动恢复；§8 启动管线插入会话层步骤
- §18 "冷启动不恢复" 的不变量随上条解除；运行期语义（切换不关不归档、关项目随关）全部不变
- §7 规则 1.5 的 `scopeActiveKeys` 由纯内存改为冷启动播种（跨重启），规则本身与 mem.active
  的 chat-only 约束不变
