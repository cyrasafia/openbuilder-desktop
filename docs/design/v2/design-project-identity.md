# design-project-identity.md — 同路径多 projectID 的客户端归一化（项目身份分裂）

> 日期：2026-11-09｜状态：已实现，活体验证通过（scripts/dev.sh 连 15120：同路径双行收敛
> 为一行、「项目启动」及 fork 经 §17 补开找回 Tab——§4 存量自愈推演逐项兑现）；
> 实现增补：§3.1 签名落地为 buildProjectIdentityIndex（null = 无分裂快路径）+
> dedupeProjectsByIdentity，identity map 的「路径表/id 表」拆为双 Map；实现
> review 五项修订（2026-11-09）：doConnect 归一后置于 v1 迁移块（byDir 末行胜
> 兜底）、createSession/forkSession 实体 pid 归一、快照 docstring、
> session.deleted v1 回退分支归一、选择器双行夹具用例；设计稿 review 六项：
> 符号名/spec 指向/worktree 事件守卫 pid 归一/目录吞并防御（§3.3 新增，消化
> 「同目录异项目」边缘）/伪行措辞/行号校准——均已落入正文
> 关联：`design-worktree-sync.md` §0（worktree 库存权威源——本文的会话归属放宽以其目录集语义为基）；
> `design-v2-migration.md` D6/M1b（global 语义退役——本文的旧 id 归一化与 `migrateLegacyGlobalState`
> 同族，共享「连接期收敛持久化旧键」的先例与时机）；`design-tab-memory.md` §3.3/§17
> （空记忆哨兵与补开语义——存量自愈的依赖）
> 参考来源：官方 app `../opencode/packages/app/src/runtime/server/runtime.tsx`（同路径去重 + 旧 id
> 映射，行 258-279 注释**点名同场景**："a folder resolved before `.git` existed and again after a
> remote was added"）；`../opencode/packages/app/src/home/sessions/records.ts` 行 44-57（会话归属
> directory 优先）；移动端 openbuilder 无同类设计（docs/design 全目录 grep 无命中，2026-11-09 核）
> 实证背景：2026-11-09「发布管理平台」双行事故（§0.2 时间线；server 数据库/store.json 取证存档
> 于当日会话记录）

## 0. 问题：server 端项目身份分裂 + 客户端三处放大

### 0.1 分裂机制（server 上游行为，2.1.3/2.2.0 源码核）

server 对 git 仓库的 projectID 生成是**优先级链**（`../opencode/packages/core/src/project.ts`
`gitDiscover`，行 299-349）：`remote URL 哈希` > `.git/opencode` 缓存（`cached()` 行 290-297，
**只读不写**——core 全包无写入点，缓存不保证存在）> `root commit 哈希`。任一优先级输入
从无到有（加 remote）或失效（删 remote），下次 resolve 即产出**不同 projectID**，upsert 按
id 建行、不按 canonical 合并 → 同一 canonical 路径出现多行项目。`Project.sweep`（行 443-486）
只归档「canonical 目录已删除」的行——目录健在的僵尸行**永不清理**。

实测验证：`sha1("git-remote:codeup.aliyun.com/zlxt/zl-product/release-management")` =
`727c511c…`（新行 id）；root commit 全文 = `f82d9e5a…`（旧行 id，本地 init 时代产物）。

### 0.2 时间线（发布管理平台实证）

| 时刻 | 事件 |
|---|---|
| 11-04 21:30 | 仓库本地 `git init`（无 remote），首 commit root = `f82d9e5a…` |
| 11-04 21:31 | server 首次 resolve：无 remote → fallback rootCommit → 建旧行 `f82d9e5a…`（有 name）；会话「项目启动」及其 fork 创建于旧行（`session_v2.project_id` 实证） |
| 11-05 14:41 | `.git/config` 添加 origin（mtime 实证） |
| 11-05 16:14 | server 再次 resolve：remote 哈希生效 → 建新行 `727c511c…`（无 name，active 持续至今） |
| 此后 | `GET /api/project` 返回两行同 canonical；桌面端左栏/选择器各出现一个「发布管理平台」 |

### 0.3 客户端三处放大（会话两边都看不到的机制）

1. **快照按 projectID 过滤**：`refreshSessionsForProject` 按 directory 拉快照（app-store.ts
   行 3751-3772），`applySessionsSnapshot` 行 1449 `filter(s.projectID === projectId)` ——
   会话 pid 挂旧行 → 新行快照恒空 → 新行不可见。
2. **目录归属解析命中当前行**：`findProjectOwningDirectory`（行 3341-3347）`projects.find`
   首个 worktree 命中。server 列表按 `time_active desc`（core/project.ts 行 243）→ 新行
   恒在前 → 该目录的一切按目录解析（Tab 记忆、作用域恢复）都以**新行身份**运行。
3. **Tab 记忆按 directory 键被覆盖清空**：`restoreScopeTabs`（行 3595）以新行身份算
   `visible = ∅`；`snapshottedDirs` 按 directory 键两行共用（行 1490）→ 死会话收敛
   （行 3641-3648）关掉该目录全部 chat Tab；`syncScopeMemory` → `deriveMemory(新行 id,…)`
   覆盖 `tabs.memory[canonical]` = `{projectId: 727c511c…, tabs: []}`（store.json 实证）。
   旧行打开也无效：归属解析仍指新行，中栏无 Tab = 引导页，引导页只列归档会话
   （`archivedSessions`），未归档会话无列表入口。

## 1. 官方方案与借鉴裁定

### 1.1 官方三件套（packages/app，桌面端 = 该 web 应用加壳）

| 机制 | 位置 | 语义 |
|---|---|---|
| `unique` | runtime.tsx 258-271 | 项目列表按 `pathKey(worktree)` 去重；**依赖 server 序（active desc）取每路径首行 = 当前行** |
| `used` | runtime.tsx 273-279 | 本端持久化 id 集合 → id 映射到路径 → 再取该路径**当前行**（"Using any ID of a path shows that path's current project"）；旧 id 使用量自动迁移，无状态搬运 |
| 会话归属 | records.ts 44-57 | `homeProjectForSession`：directory/worktree/sandboxes 精确匹配优先，projectID 仅在 worktree 库存未加载时兜底；**会话列表按 directory 过滤，不按 projectID** |

官方不在 server 侧合并行（upsert 按 id 不变），容忍分裂为数据常态，全部在客户端
数据层消化。

### 1.2 差异与本仓库裁定

官方持久化仅一个 `usedProjectIDs` id 集合，回显全走路径解析，翻转无成本。本仓库
按 projectId 键控的状态面显著更大：`projectStates.opened/currentProjectId`、
`tabs.memory[].projectId`、`tabs.session` 投影、运行时 `sessionsByProject`、
`worktreeDirs`、`provisionalWorktreeDirs`、`tab.projectId`。仅做显示去重会让旧 id
滞留这些键位（opened 指向不显示的行、事件按旧 pid 误判移出作用域）。

**裁定：引入归一化层（normalize），而非仅显示去重。** 显示、持久化、运行时三个
层面统一经身份映射收敛到「当前行 id」；旧 id 只存在于 server 数据与映射输入中，
对客户端一切逻辑透明。

**裁定（与官方的分歧点）：当前行 = 同路径 `time.created` 最大者**（同毫秒 tie-break
id 字典序），不采用官方的 active 序。理由：active 序会抖——旧行的会话若仍活跃，
server 会按 `session.projectID`（旧行）打点旧行 `time_active`（core/project.ts
`activate`），可能反超新行使「当前行」翻转；官方无所谓翻转（会话归属不经 id），
本仓库 sessionsByProject 等按键控，翻转需要全量重键。created 单调：每次真实身份
变化产出的行 created 必然更晚（加 remote、删 remote 均如此——后者产出的
rootCommit/`directory:` 行同样晚于 remote 行），映射稳定，仅在真实身份变化时翻转
（那是正确的翻转）。server 的 active 序仍用于**选择器「最近使用」排序**
（sidebar.tsx 行 663-673 渲染投影），两职责分离。

## 2. 语义裁定（实现不可走样）

1. **当前行**：同 canonical（字符串精确比较，与现有 sandboxes 匹配同构，不引入
   pathKey 规范化）多行中 `time.created` 最大者；created 同则 id 字典序小者。
2. **会话 ↔ 项目的纽带是 directory**：同路径下的会话无论 server 记录的 pid 是哪代
   id，一律归属当前行。pid 不再作为会话可见性的过滤条件。
3. **`this.projects` 保持 server 全量与返回序**（写点：app-store.ts 行 975/3137/4339/
   4590，不排序不去重）。去重只做派生投影（`uniqueProjects`）。旧行保留在全量中：
   事件面对旧 pid 的 `projects.some(p.id===pid)` 判定（行 2031）继续成立，不误触
   syncWorktrees。
4. **持久化归一范围 = 全 profile**（与 `migrateLegacyGlobalState` 行 986 同范围）：
   `projectStates` 各 profile 的 `opened`/`currentProjectId`、`tabs.memory` 全部
   `projectId` 字段、`tabs.session` 投影 `projectId`。`opened` 内旧 id 替换为当前
   id 后**去重保位**（保留首次出现位置——用户经 `applyEntryOrder` 排过的序不因
   归一重排）。
5. **server 旧行不清理**（sweep 不覆盖、无删除端点；上游合并行为待议，§7）。
   客户端归一化后旧行对用户透明。

## 3. 实现

### 3.1 身份映射纯函数（`src/shared/project-entries.ts` 扩展）

同文件既有职责即「持久化项目键的版本迁移」（v1 global → v2 id），本文新增同族
函数（实现增补：设计稿的单 Map 签名落地为「null = 无分裂」的索引对象 + 去重
函数，快路径判定更直白）：

```ts
/** 身份索引：仅分裂路径入表（无分裂返回 null，调用方走快路径） */
interface ProjectIdentityIndex {
  currentByPath: Map<string, string>   // 路径 → 当前行 id（仅多行路径）
  legacyToCurrent: Map<string, string> // 旧 id → 当前行 id（不含自身）
}
buildProjectIdentityIndex(projects): ProjectIdentityIndex | null
isNewerProjectIdentity(a, b): boolean  // created 大者新；同 created id 字典序小者新
normalizeProjectId(index, id): string  // 未命中（当前/未知 id/无索引）原样返回
normalizeOpenedIds(index, opened): string[] // 归一去重保位；无变化返回原引用
dedupeProjectsByIdentity(projects): T[] // uniqueProjects 的纯函数核心（首见序）
```

### 3.2 store 归一化例程 `normalizeProjectIdentities()`

接线点 = `this.projects` 的每个写点之后（行 975 doConnect、3137 createProjectFromDirectory、
4339 syncWorktrees、4590 refreshWorkspacesForProject；行 1193 清空无需）。快路径：映射
无重复路径时 no-op（常态零开销，不 emit）。

有分裂时的动作序列（一次完成，末尾统一 emit + 异步落盘）：

| 状态 | 处理 |
|---|---|
| `sessionsByProject` | 键重映射（旧 id map 合并入当前 id map，同 id 实体后者胜——快照/事件会再对账）；实体 `projectID` 字段重写 |
| `worktreeDirs` / `provisionalWorktreeDirs` | 键/值归一 |
| 运行时 `tabs` | `tab.projectId` 重写（chat/file/diff/terminal/browser 全 kind） |
| `sessionLocationVersions` | 记录的 `projectID` 重写（版本比较键空间统一） |
| `projectStates`（全 profile） | `opened` 走 `normalizeOpenedIds`；`currentProjectId` 映射；`currentWorkspaceId` 是目录，不动 |
| `tabMemory` / `tabs.session`（持久化投影） | `projectId` 字段映射 |
| 持久化 | 复用既有 `persistProjectState`/记忆/`persistTabSession` 钩子落盘 |

`openProject(projectId)` 入口对入参做一次 `normalizeProjectId`（防御：关闭栈/Tab
恢复等路径可能送入旧 id）。

### 3.3 会话实体归一、快照过滤放宽与目录吞并防御

- **`applySessionsSnapshot`（行 1443）**：行 1449 的 `filter(s.projectID === projectId)`
  **删除**（directory 查询的返回即该目录全集；行 1446 的目录闸门保留）。入口处对
  sessions 统一归一 `projectID`（含 `shouldApplySnapshotLocation`/`relocateSession`
  的版本与 location 比较——键空间统一后语义不变）。
- **目录吞并防御**（过滤删除的配套，防「同目录异项目」双登记，§5 边缘行）：
  `refreshSessionsForProject` 的目录集（行 3751）排除「其他项目的 canonical」——
  `dirs.filter(d => d === project.worktree || !uniqueProjects.some(u => u.worktree === d))`。
  `applySessionsSnapshot` 的目录闸门（行 1446）同款兜底。判别精确：普通 worktree
  目录无独立 ProjectTable 行（不在任何 canonical 集内）不受影响；独立 `.git` 目录
  自成项目行（canonical 命中）被排除——项目 A 的作用域不吞并独立项目 B 的会话。
- **`applySessionEvent`（行 1640）**：入参 info 的 `projectID` 归一后落 map。
- **`relocateSession`（行 1339）**：`next.projectID` 归一——旧行 pid 的 session.moved
  不再落入「targetProject 不在 openedProjects → closeTab」分支（行 1356-1379 的误关
  Tab 正是存量 Tab 消失的潜在路径之一）；`provisionalWorktreeDirs.set` 的值同步归一。
- 入口清单以 `sessionsByProject.set`/`.get` 的写读点为准实现时逐一核对（当前三主
  入口 + `mergeSessionsSnapshot` 调用点）。

### 3.4 显示层

- 新增 `get uniqueProjects(): Project[]`：`this.projects` 按 §2.1 规则去重。
- **ProjectPicker**（sidebar.tsx 行 663-673）：candidates 基底换 `uniqueProjects`
  （排序 active desc 的渲染投影不变）——「发布管理平台」两行收敛为一行。
- **`findProjectOwningDirectory`（行 3341）**：find 基底换 `uniqueProjects`——同路径
  多行时不再依赖 `this.projects` 序碰运气（旧行 active 反超时全量序会命中旧行）。
- 左栏 `openedEntries`：opened 已归一（§3.2），天然单行，无改动。
- `workspacesOfProject`（行 4601）以库存为准且排除 canonical，无改动。

### 3.5 事件面

SSE 会话事件闸门按 directory（`openedDirectories()`，行 1603），directory 键不受
pid 分裂影响，无改动。`worktree.ready/failed/updated` 的守卫（行 2038-2043）是
**pid 依赖**（`!openedProjects.some(p.id === projectId) → return`）：归一化后
opened 只含当前行 id，携带旧 pid 的事件会被跳过——守卫处对 `projectId` 补一次
`normalizeProjectId`（与 §3.2 末 `openProject` 入参归一同款防御；触发面 = 他端
以旧行 id 发起 worktree 操作，罕见，且有 60s list-diff 兜底，但成本一行）。

## 4. 存量自愈推演（发布管理平台案例，不手工修数据）

归一化落地后首次连接：

1. doConnect 拉回 61 行 → 映射检出 canonical 路径双行 → 当前行 = `727c511c…`
   （created 11-05 16:14 > 11-04 21:31）。
2. `opened` `[…, 727c511c, f82d9e5a, …]` → 归一去重 → 只剩 `727c511c…`（保位）；
   `tabs.memory[canonical].projectId` 已是 `727c511c…`（事故期被覆盖的副作用恰好
   是当前行，无需迁移）；`tabs: []` 保留。
3. `refreshSessionsForProject(当前行)`：directory=canonical 快照拉回 2 会话
   （pid=旧行）→ **过滤已删** → 归一登记 `sessionsByProject[727c511c]` → 左栏指示点、
   `visibleSessions` 恢复。
4. `restoreScopeTabs(canonical)`：`findProjectOwningDirectory` → 当前行；
   `mem.projectId === project.id` 成立 → `reconcileMemoryTabs(空记忆, 2 可见会话)` →
   **§17 补开**（scope-tab-memory.ts 行 52-63：空记忆哨兵同样补开记忆外可见会话）
   → 2 个 chat Tab 恢复，「项目启动」找回。
5. 旧行 `f82d9e5a…` 从此不出现在任何列表；其会话继续可用（归属当前行）。

前置依赖成立性：§17 补开语义已实现（design-tab-memory 2026-08-24 修订），空记忆
哨兵防的是「重新全量打开已归档旧会话」，本例 2 会话未归档（`session_v2` 实证
`time_archived` null），不受哨兵影响。

## 5. 边界与风险

| 风险 | 评估与对策 |
|---|---|
| 「当前行」判定与 server resolve 实际产出不一致 | created desc 对「加 remote」「删 remote」两类身份变化都取到最新产出（§1.2）；若 server 未来引入新优先级输入，pin 升级审计时复核（ref-pin-bump 惯例） |
| 归一化翻转（新一次身份变化） | `normalizeProjectIdentities` 幂等且全量重键（§3.2），翻转 = 再跑一次归一，状态自洽 |
| 非 git 伪项目行 | 伪行 id 由路径哈希派生，路径即身份，伪行之间不产生同路径多行；伪行与后续 git 行同路径共存（§0.1 机制形态之一，官方注释的 "before `.git` existed" 场景）由 §2.1 一般规则覆盖，**不做伪行特判** |
| worktree 目录（canonical 之外）出现多行认领 | 不处理：worktree 行不进 `uniqueProjects` 的去重键（去重只按 `worktree` 字段 = canonical）；sandboxes union 逻辑不变 |
| 快照过滤放宽引入他项目会话 | 同路径 = 同项目（归一后）无「同目录异项目」；唯一边缘 = 项目 A 的 sandbox 目录内另有独立 `.git` 自成项目 B（该目录是 B 的 canonical）——已由 §3.3 目录吞并防御排除（拉取目录集与闸门均排除其他项目 canonical）。双登记即使漏网亦良性（review 2026-11-09 #4 核实）：`chat:{id}` Tab 全局唯一，`closeProject` 按 project 键清 `sessionsByProject`（行 3167），关 A 不动 B |
| 旧 id 从外部输入漏进（关闭栈/深链） | `openProject` 入参归一（§3.2 末）+ worktree.* 事件守卫归一（§3.5）；其余入口以 §3.3 清单收口 |

## 6. 测试计划（vitest）

纯函数（project-entries.test.ts 扩展）：
- 映射构造：双行同路径取 created 大者；created 同取 id 小者；单行/空集不入表；
  `normalizeProjectId` 未命中原样返回。
- `normalizeOpenedIds`：旧 id 归一去重保位（`[新, 旧, X]` → `[新, X]`，新占旧的首现位）。

store 集成（app-store.test.ts 扩展，分裂数据夹具 = 双行同 canonical + 会话 pid 挂旧行）：
- 连接期归一：opened/currentProjectId/memory/projectId/tabsession 投影全部收敛；快照
  落地后 `sessionsByProject[当前行]` 含旧行 pid 会话；`visibleSessions` 非空。
- 快照放宽：新行 refreshSessionsForProject 后旧行 pid 会话可见（原用例断言「滤掉」
  的反转）。
- relocate：pid=旧行的 session.moved 不关 Tab、不 cleanup（targetProject 经归一命中）。
- restoreScopeTabs：空记忆 + 2 可见会话 → 补开 2 Tab（§17 既有用例补分裂数据夹具）。
- ProjectPicker：双行项目夹具下 candidates 只含当前行一行。
- 目录吞并防御：A 的 sandbox 目录 = 独立项目 B 的 canonical（B 目录拉快照不进 A 的
  目录集；闸门兜底同判）；普通 worktree 目录（无独立行）不受排除影响。
- worktree.updated 携旧 pid：守卫归一后仍触发 syncWorktrees（不静默跳过）。
- 幂等：归一连跑两次状态不变（快路径 no-op 路径覆盖）。

回归：现有 app-store/project-entries 全量用例不破（尤其 migrateLegacyGlobalState、
worktree 库存 union、死目录收敛族）。

## 7. 非目标与上游待办

- 不改 server 数据（不删僵尸行、不迁移 `session_v2.project_id`、不写 `.git/opencode`）。
- 不做「项目已合并/身份已变化」的用户提示 UI（旧行对用户透明，无感知即无提示必要）。
- 不处理符号链接/大小写路径别名（canonical 为 server resolve 产物，逐字节比较够用）。
- **上游待办**：`anomalyco/opencode` resolve 在同 canonical 已有其他 id 行时可考虑迁移
  会话或合并行（根治数据面）；`.git/opencode` 身份缓存的写入时机也值得上游明确。
  本仓库侧视上游动作决定是否留 todo 文档（`docs/todo/`），归一化层作为常态防御保留
  （官方 app 同样长期保留 `unique`/`used`）。

## 8. spec 同步

`spec-v0.5.md` 变更两处（实现合入时一并提交；review 2026-11-09 #2 修正指向——
API 映射表无项目域行，语义最近的是范围内表 #9）：
- 范围内表 #9（global 语义退役）补语：「同路径多 projectID（加/删 remote 致身份
  分裂，2026-11-09 实证）客户端归一化——当前行 = created 最新，会话归属按
  directory，旧 id 全状态透明迁移（design-project-identity）」。
- 验收口径补一条：「构造同路径双行项目（旧行挂会话）：左栏/选择器仅一行，会话可见
  可开 Tab；重启后状态保持归一」。
