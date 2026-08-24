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

- 只记 **chat Tab**。file Tab 跨作用域全局显示、不受切换影响（design-layout §4 既有语义），不参与记忆
- 顺序 = Tab 条顺序。v0.1 无拖拽排序，顺序即打开顺序；记忆结构预留顺序语义，拖拽（v0.2+）落地后天然兼容

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
    按 mem.tabs 顺序补齐 live Tab（复用已开；不补开记忆外的新会话）
    记忆收缩：mem.tabs ← valid（持久化）
    激活：见 §7
```

**防御闸门（快照不可信）**：`mem.tabs 非空 && sessions 为空 && 该目录在 sessionsByProject 中完全无记录` → 视为快照拉取失败（catch 兜底空快照，session-merge 保守保留后仍空），**不打开 Tab、不收缩记忆**，但激活清算：若当前激活是其他作用域的 chat Tab → 置 null（Tab 条按作用域过滤不显示它、中栏却会渲染其会话；file Tab 保留）。恢复时机 = **下次切入该作用域或重启**；对账快照落地**不**自动重触发（避免引入"对账 → 恢复 → 激活变更"的副作用链，恢复只在显式切换路径发生）。区分依据：真"全部被归档/删除"时本地目录会话集非空（只是被过滤），唯快照从未落地才是全空。

**首次打开的空集写入前置校验**：区分"真实空目录"与"快照拉取失败"的信号是**快照失败标记**（refreshSessionsForProject 对失败目录不合并空快照、记入 failed 集合，成功即清除）——失败时跳过写入（下次切入重试，幂等），仅真实空目录才写空记忆哨兵。否则失败瞬间写入的 `{tabs: []}` 会让该作用域永不触发全量打开。

**不强制收敛 live tabs 到记忆**：live 中该作用域超出记忆的 Tab（理论上不该出现——运行期记忆由 live 派生；仅异常路径可产生）保持原样，不静默关闭（关 chat Tab 牵涉归档语义，宁可冗余展示）。

## 7. 激活规则

切入作用域后：

1. 当前激活是 **file Tab → 保持**（file Tab 全局可见，现状语义）
2. 否则 `mem.active ∈ valid` → 激活之（回到切走时的位置）
3. 否则 valid 末位 Tab（最右）
4. 否则 null → 中栏会话列表视图

- 首次打开的 active = 该作用域最近活跃会话（updated 最大），与"激活最新动态"直觉一致；顺序仍按 created 排
- 运行期激活 file Tab 不改写记忆 active：用户切走再切回时，若 file Tab 仍激活则继续file（规则 1），关掉后回退到记忆 active（规则 2）

## 8. 启动恢复

`connect()` 在 `refreshAllOpenedProjects()` 成功后、`startSse()` 前：

1. **逐作用域重建**：对每个打开项目的每个 directory（`worktree ∪ sandboxes`）有记忆条目的 → 按 §6 恢复分支补齐 live Tab（校验收缩），不改变激活
2. **当前作用域**再走一遍 `restoreScopeTabs`（含激活规则）——无记忆则首次打开
3. 消息不预取：ChatView 激活即重拉（现状），恢复的 Tab 仅建 Tab 实体

改变的行为：重启不再必然空 Tab——有记忆的作用域恢复，当前作用域首次则全量开。与 `project.state` 持久化对称，补齐"重启回到离开时上下文"的体验。

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
| 首次切入，0 个会话 | 空记忆写入，会话列表视图；此后外部新建会话**不**自动开 Tab |
| 开 3 Tab → 切另一 worktree → 切回 | 3 Tab 按记忆顺序恢复，激活切走时的 Tab |
| 切走期间某会话被他端归档 | 切回时该 Tab 不恢复，记忆收缩 |
| 切走期间他端新建会话 | 切回不自动开（记忆外）；会话列表可见、可点开（进记忆） |
| 关闭某 Tab（= 归档） | 记忆移除；切走再切回不再出现 |
| 关闭项目 | 项目 Tab 全关（不归档）+ 该项目记忆全清；重开 = 首次打开（全量按 created） |
| 删除 worktree | 该目录记忆删除 + live Tab 显式关闭 |
| 重启应用 | 打开项目各作用域按记忆恢复 Tab；当前作用域无记忆则首次打开 |
| 快照失败时切入 | 防御闸门：不开不收缩，下次成功快照恢复 |

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| **对账消息扇出**：`reconcileOnce` 对所有 chat Tab `Promise.all` 并行拉消息；全量开 Tab 后 N 可达几十，挤占 ~1 个 REST 空闲槽 → 整批超时 → 对账整体失败（Promise.all 一损俱损） | 消息快照拉取改并发受限（`runLimited` 3，与快照拉取同模式）；只改调度不改语义。附带：单个失败不再拖垮整批 |
| **Tab 条溢出**：全量开 Tab 可能数十个，`.tabbar` 现状无横向滚动处理（flex 挤压） | `tabbar` 加 `overflow-x: auto` + `.tab` 不收缩（min-width），纯 CSS |
| 消息惰性累积上限（20 容器）对有 Tab 会话无条件 | 全量开 Tab 后订阅目录内会话全部累积——受订阅集合（≤5 目录）天然约束，可接受；v0.1 已知限制不变 |
| **对账内存量级**：reconcile 对每个已开 chat Tab 拉 100 条消息窗口，N 个 Tab = N×100 条含 parts 的 `messagesBySession` 累积（SSE 路径按 Tab 数累积，不受 ≤5 目录约束） | 量级估算：几十 Tab × 100 条 ≈ 数千消息对象（~MB 级），桌面端可接受；`runLimited(3)` 已解决连接池饿死。若未来 Tab 数上百再考虑对非激活 Tab 降窗/跳过 |
| 记忆写放大（每次 Tab 点击 IPC 写盘） | 记忆体量极小（KB 级），main 侧写队列串行；不引入 debounce（复杂度不值） |

## 12. 测试计划

- 纯函数抽 `src/shared/scope-tab-memory.ts`（同 session-merge 模式）：
  - 首次打开排序（created 升序、active=updated 最大、空集写入空记忆）
  - 恢复校验（有效集收缩、记忆外不补开、防御闸门触发/不触发的三分支）
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
- **快照失败标记**（`snapshotFailed`）：refreshSessionsForProject 失败目录不合并空快照、记入失败集合；首次打开遇"空会话 + 失败标记"跳过写入（见 §6 前置校验）；teardown 清空
- **removeWorkspace 删当前 worktree**：作用域切回项目根后补 `restoreScopeTabs`（与其他切换路径一致）
- tabbar `scrollbar-gutter: stable`：溢出出现滚动条时 Tab 高度不跳变
