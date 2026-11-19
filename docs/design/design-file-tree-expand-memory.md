# 文件树展开状态跨作用域记忆 — 设计文档

> 目标：右栏文件树的目录展开状态按作用域目录记忆。切换工作区/项目后切回，展开状态恢复；切换到无记忆的新作用域保持全收起。修复「切换工作区即丢失展开状态」的问题。

## 问题

展开状态 `fileTreeExpanded: Map<相对路径, boolean>` 是纯内存单表（app-store.ts），`resetFileTree()` 在全部 7 个切换/清理路径上无条件 `clear()`：

| # | 路径 | 场景 |
|---|------|------|
| 1 | `teardownConnection` | 断连/切 profile |
| 2 | `relocateSession` followsActive 分支 | 会话移入工作区跟随激活 |
| 3 | `openProject` 同步段 | 开/切项目 |
| 4 | `setCurrentWorkspace` | 切工作区 |
| 5 | `switchProjectContext` | 切项目后台段 |
| 6 | `removeWorkspace` 删当前作用域 | 跳回项目根 |
| 7 | `unloadWorktreeDirectory` isCurrent | worktree 目录卸载 |

用户典型痛点：在工作区 WT-A 下钻展开 `src/`、`docs/` → 切到 WT-B 处理另一分支 → 切回 WT-A，树从全收起重来。文件树是右栏「agent 产出物目录」的导航入口（PRINCIPLES.md §三栏），展开布局是用户定位文件的手工投资，随切换清零等于每次切换重付。

两个决策记录冲突：`design-layout.md` §5（v0.1 原始设计）写「**展开态按项目记忆**」——从未实现；`design-tab-state-memory.md` §5（2026-08-26）把「文件树展开/滚动状态随作用域重置」记为既有语义不做。本文裁定：**兑现 layout §5 的记忆意图，语义按 v2 现实修订为按作用域（worktree）目录记忆**；滚动状态与节点缓存维持重置不变。

参考移动端：openbuilder `design-file-browser-collapse`（文件浏览栈收起/恢复，快照-restore 模型）——桌面端切换是常驻面板内的作用域重置，不需要快照收集协议；借鉴其两点：① 记忆按 `(会话/作用域)` 分域索引，不做全局单表；② 恢复时已下钻数据需重拉（其重 push 路由重下载数据，本端重拉 nodes）。

## 设计

### 状态模型

```
fileTreeExpandedMemory: Map<作用域 directory, Set<已展开相对路径>>   // 单一事实源
fileTreeExpanded: ReadonlySet<string>                                // getter：按当前作用域投影
```

- **key = 作用域 directory（绝对路径）**：即 `scopeQuery.directory`（主工作区 = 项目根，worktree = 其路径）。不用项目 ID——v2 中 worktree 即完整目录作用域（v2 无 workspace 参数），树按作用域重根，展开上下文属于「这个目录的浏览」而非「这个项目」。分支结构不同的两个 worktree 互不污染；同目录同名重建视为新作用域。
- **value = 相对路径 Set**：目录尾随 `/`，与渲染 key（`node.path`）/ `toggleFileNode` 入参同源。集合语义 = 仅记「已展开」；缺席 = 收起。旧 `Map<path, boolean>` 的显式 false 条目与缺席可观察行为等价，收敛为 Set 不损语义。相对路径跨 worktree 重名无碍——按 directory 分域后只在域内解释。
- **投影 getter**：组件读 `fileTreeExpanded.has(node.path)`，无记忆作用域返回模块级 `EMPTY_EXPANDED` 空集哨兵（不逐次分配）。

### 生命周期规则

- **写**：`toggleFileNode` 写透——展开入集、折叠出集，落当前作用域域内。不做切换时快照收集（写透后任意时点切走，域内状态总是最新的，无「收起瞬间组装」问题）。
- **读**：`resetFileTree()` 不再清展开集；按新作用域投影。恢复的已展开目录子节点随 nodes 清空一并重拉（`repullExpandedDirs()` 逐目录 `loadFileNodes(path)`）——不重拉则呈「箭头展开但空壳」（children 渲染数据源 `fileTreeNodes` 已清），且不自愈（watcher 重列要求目录已在 nodes，design-file-watcher §3.2）。重拉走 `loadFileNodes` 既有作用域闸门（落地时作用域已切走则丢弃）；同作用域迟到落地为同源幂等覆写，无害。重拉调用点两处：`resetFileTree`（全部切换路径）与 **`doConnect` 恢复段**（重连不经 `setCurrentWorkspace`/`resetFileTree`——teardown 清节点时作用域为空、重拉已跳过，恢复段 projects 就位后须补拉，review 2026-11-19 #1）。
- **清**：唯一清除路径 = `unloadWorktreeDirectory`（worktree 删除/对账剥离/被动确证三条卸载路径共用）随目录删域。断连（teardown）**保留**记忆——重连/重开项目恢复；跨 profile 残留条目无害（无对应节点即不渲染）。
- **内存约束**：`Map<dir, Set<string>>` 纯标量，随打开过的作用域数线性增长，量级可忽略。

### 时序要点

全部 7 个 `resetFileTree()` 调用点，作用域 getter 在调用时已指向新作用域（切换先写 `ps.currentWorkspaceId` / `projects` 后 reset，「先切换后加载」既有约定）——reset 内重拉天然落在新作用域。唯一例外 `teardownConnection`：`projects = []` 先行（:1203），作用域为空 → 投影空集 → 重拉天然跳过，记忆保留；其缺口由 `doConnect` 恢复段补拉（`refreshAllOpenedProjects` + stale 闸门之后，projects/projectStates 已就位）。

### 与既有语义的边界

| 状态 | 切作用域 | 依据 |
|---|---|---|
| 展开状态 | **记忆恢复**（本文） | 用户意图态 |
| 节点缓存 `fileTreeNodes` | 清空重拉 | 作用域数据，离开期间文件可能已变 |
| 文件内容 `fileContents` | 清空 | 同上（Tab 重开重拉语义不变） |
| 树滚动位置 | 重置（不做） | design-tab-state-memory §5 维持 |
| 挂起树刷新定时器 | 作废 | design-file-watcher §3.2 维持 |

判据沿用 `persistLayout` 的「意图口径」：用户手工投资（布局宽、展开布局）记忆；派生/时效数据（节点、内容、滚动）重置。

## 场景验证

| # | 场景 | 预期 |
|---|------|------|
| 1 | 根作用域展开 `src/` → 切 WT1 → 切回根 | `src/` 仍展开，子节点已重拉 |
| 2 | 切到从未访问的 WT2 | 全收起（无记忆）；WT2 展开 `docs/` 后切走再回，`docs/` 恢复 |
| 3 | 展开 `src/` → 折叠 `src/` → 切走再回 | 收起（折叠写透出集，不复活） |
| 4 | WT-A 展开 `src/` → 切 WT-B（无 `src/` 目录） | B 全收起；A 的记忆不受 B 影响 |
| 5 | 展开 `src/` → 切走 → 回，期间 AI 新增 `src/new.ts` | 重拉后新文件出现在展开的 `src/` 下 |
| 6 | 删除当前 worktree（跳回项目根） | 该 worktree 记忆随目录卸载清除；重开同名目录从零展开 |
| 7 | 断连 → 重连 | 记忆保留，树按记忆恢复展开 |
| 8 | 展开深层目录（`src/` `src/a/` `src/a/b/`）→ 切走再回 | 三层全部展开，逐层重拉（并行 3 请求） |
| 9 | 切换后立即再切（A→B→A 快速连点） | 在途重拉被作用域闸门丢弃，最终展开与节点一致 |

## 关键设计决策

1. **按作用域 directory 分域，不做全局单表、不按项目 ID**。相对路径跨目录重名，分域后键只在域内解释；分支结构不同的 worktree 互不污染。与 `tabs.memory`（profile → directory → 状态）分域模式同构。
2. **写透而非切换时快照**。切换路径有 7 处，切换瞬间组装旧作用域快照要求每处先读后清，易漏；写透后内存恒为最新，reset 只做「换投影 + 重拉」，时序鲁棒。
3. **单一事实源 + 投影 getter**，不留双 Map 同步。`fileTreeExpanded` 从字段变 getter，组件读法 `.get(p) ?? false` → `.has(p)` 一处适配。
4. **恢复 = 重拉子节点**，不做节点缓存记忆。节点是作用域数据，离开期间磁盘可变（AI 改文件、外部改动）；只有展开意图跨切换存活。重拉复用 `loadFileNodes` 闸门，无新增竞态面。
5. **清除只挂目录卸载**。断连/关项目保留记忆（重开恢复）；死目录记忆无观察面（无节点即不渲染），不做 TTL/LRU。

## 不做的事

- 跨重启持久化（落 `store.json`）。同 design-tab-state-memory 各状态口径（重启后展开无宿主损失可接受）；若未来要做，挂 `StoreShape` 新键、仿 `tabs.memory` 按 profile → directory 分域，另开文档。
- 文件树滚动位置恢复（design-tab-state-memory §5 维持不做）。
- 展开状态跨端同步（移动端 openbuilder 文件列表无树展开概念，无对齐对象）。
- 记忆条目 LRU/TTL 上限（量级可忽略，见状态模型）。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/store/app-store.ts` | `fileTreeExpandedMemory` 表 + `fileTreeExpanded` 投影 getter；`toggleFileNode` 写透；`resetFileTree` 去掉展开集清空、加重拉；`unloadWorktreeDirectory` 删域 |
| `src/renderer/src/components/file-panel.tsx` | `FileRow` 展开读法 `.get(p) ?? false` → `.has(p)` |
| `src/renderer/src/store/app-store.test.ts` | 新增 4 用例（写透、切回恢复+重拉、无作用域/断连保留、目录卸载清除） |
| `src/renderer/src/components/file-panel.test.tsx` | mock store `fileTreeExpanded` Map → Set |
| `docs/design/design-tab-state-memory.md` | §5 修订：展开状态拆出「不做」，指向本文 |
| `docs/design/design-layout.md` | §5「展开态按项目记忆」按 v2 语义改写为按作用域目录记忆 |
| `AGENTS.md` | 已锁定语义行同步（文件树重置 = 节点/内容重置，展开状态记忆） |

## 验证记录（2026-11-19）

- 按 §涉及文件落地。`app-store.test.ts` 480/480、`file-panel.test.tsx` 11/11，typecheck 双侧全绿（全量 vitest 见提交前实跑）。

## 评审记录（2026-11-19，reviewer 一轮）

| # | 优先级 | 问题 | 结论 |
|---|--------|------|------|
| 1 | 🔴 | 重连恢复路径缺口：`doConnect` 不经 `resetFileTree`、无人重拉记忆的展开目录——恢复后「箭头展开但空壳」且不自愈（watcher 重列要求目录已在 nodes），场景 7 只兑现「箭头恢复」一半 | **已修复**。重拉循环抽为 `repullExpandedDirs()`，`doConnect` 恢复段（`refreshAllOpenedProjects` + stale 闸门后）补调；用例实证（临时移除修复行则用例红）；§生命周期规则/§时序要点同步 |
| 2 | 🟡 | 切回用例的重拉断言假绿：`toggleFileNode` 阶段已有同参调用，`toHaveBeenCalledWith` 恒过 | **已修复**。切换切回前 `mockClear()`，断言只能来自 reset 重拉 |
| 3 | 🟢 | 场景 8（深层并行重拉）/场景 9（A→B→A 快连竞态）无用例 | **接受不改**。场景 9 竞态经代码核查封闭（闸门按 directory 判别丢跨作用域迟到落地；同作用域迟到为同源幂等覆写），补用例锁的是既有闸门机制而非本次增量，代价不抵收益 |

