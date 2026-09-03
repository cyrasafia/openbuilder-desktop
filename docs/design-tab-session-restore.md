# Tab 会话跨刷新/重启恢复 — 设计文档

> 需求：打开的 Tab（全 kind）、选中状态、Tab 顺序在**刷新页面**（renderer 重载，main/server 存活）与**重启应用**（进程整体退出重进）后保留。
> 前置：chat Tab 已有 worktree 级记忆（[design-tab-memory.md](./design-tab-memory.md)，`tabs.memory` 按作用域持久化 chat 集合+顺序+chat 激活）；本文补齐其余维度——非 chat Tab、任意 kind 激活、全 kind 混排顺序。
> 参考先例：openbuilder 无桌面 Tab 模型直接对应物，但其客户端本地态模式（`design-workspace-toggle.md`：按 profile 命名空间、内存态与持久态同源、load 先于使用）是 `tabs.memory` 已沿用的同源模式，本文继续沿用。

## 1. 现状盘点（刷新/重启时丢什么）

| 状态 | 现状 | 刷新/重启后 |
|---|---|---|
| chat Tab 集合/顺序 | ✅ `tabs.memory`（design-tab-memory） | 按记忆恢复（§8 启动恢复） |
| chat 激活（记忆 active） | ✅ 同上 | 恢复 |
| file/diff Tab | ❌ 不持久化（design-tab-memory §3.2 原决策"只读视图重开成本为零"） | 全部丢失 |
| terminal Tab | ❌ 实体纯内存；pty 在 server 侧存活（quit 无 teardown 不杀） | Tab 丢失（pty 泄漏成孤儿） |
| browser Tab | ❌ 实体纯内存；WebContentsView 在 main 侧 | Tab 丢失；刷新后旧 view 成孤儿（若刷新时可见会绘制在新 DOM 之上——既有缺陷，本文顺带修复） |
| 任意 kind 激活 | ❌ `scopeActiveKeys` 纯内存（design-tab-state-memory §2 决策） | 落记忆 chat 激活（规则 2）；file/diff/终端/浏览器激活态与引导页选中丢失 |
| Tab 混排顺序 | 部分：chat 顺序按记忆恢复 | file/diff 与 chat 的相对位置丢失（file/diff 不存在） |

## 2. 语义定义

- **新增持久层 `tabs.session`**（IPC store，key 同名）：`Record<profileKey, TabSessionState>`，与 `tabs.memory` 同寿命（按 profile 隔离、disconnect 不清、closeProject 修剪）
- 运行期 **live tabs 唯一权威**，本层是派生投影（同 design-tab-memory §3.3 不变量）：在 Tab/激活变更点派生落盘，仅冷启动（connect 恢复段）作为重建输入消费
- 与 `tabs.memory` 的分账：**记忆管 chat**（集合/校验/补开/收缩/激活回退——既有语义全不动），**会话层管非 chat 实体 + 全局顺序 + 各作用域最后激活**。chat 在会话投影中仅作**顺序标记**（不参与实体重建，避免与记忆层双权威冲突）

```ts
interface PersistedTab {
  kind: "chat" | "file" | "diff" | "terminal" | "browser"
  key: string        // 与 TabEntity.key 同构
  projectId: string
  directory: string
  title: string
  url?: string       // browser 专用：持久化时的当前页 URL（key 恒为初始 URL，导航后两者不同）
}
interface TabSessionState {
  tabs: PersistedTab[]               // 全量 live Tab 的有序投影（全局混排顺序）
  scopeActive: Record<string, string | null>  // directory → 最后激活 tabKey；null = 引导页哨兵
}
```

- 顺序 = 全局 `tabs` 数组顺序原样投影。Tab 条按作用域过滤显示（§18 全 kind 作用域化），作用域内相对顺序由全局顺序投影天然保留；跨作用域的混排恢复保真（对 UI 无感但零成本）

## 3. 恢复管线（connect 内，design-tab-memory §8 扩展）

```
refreshAllOpenedProjects()（快照落地）
  → 逐作用域记忆恢复（restoreScopeTabs(dir, applyActivation=false)，既有）
  → restoreTabSession()（新增，async）
      · 播种 scopeActiveKeys：session.scopeActive 中目录 ∈ 打开目录全集的条目
        （陈旧目录条目丢弃——重开的项目不得被旧激活记录误导）
      · 逐模板条目重建非 chat 实体（chat 跳过——记忆层已恢复或已判定死会话）：
          file:     实体 + 按 Tab 归属 directory 预拉内容（同 doFileReload 重拉口径，不带 workspace）
          diff:     实体（DiffView 挂载自加载，design-diff-view §3）
          terminal: 实体 + ptyRuntimes 播种 {exited:false}（挂载即 connect-token + WS 全量回放；
                    pty 已亡（server 重启/被回收）→ token 404 走既有 gone 终态，呈已退出只读空视图）
          browser:  实体 + browserViewCreate 新建 view + 导航到 entry.url（缺省回退 key 初始 URL）
        条目闸门：目录 ∈ 打开目录全集 && 目录归属 projectId 与持久化值一致
        （findProjectOwningDirectory 解析；global 无会话目录以 openedGlobalDirectories 兜底认领——
          worktree 同路径重建的失配语义与记忆 §3.3 对齐，失配丢弃走首开）
      · 模板序合并：orderTabsByTemplate(live, templateKeys)——模板中仍存活的按模板序在前，
        模板外（补开会话、记忆漂移）按现有相对序追加尾部
  → restoreScopeTabs(当前作用域, applyActivation=true)（既有）
      规则 1.5（design-tab-state-memory §2.1）在此自然消费播种记录：任意 kind 激活/引导页
      哨兵跨重启生效；无记录/记录失效落规则 2（chat 记忆激活）——既有激活链路零改动
  → persistTabSession() 收尾落盘一次（恢复期 guard 内的变更在此统一固化）
```

- 恢复期间 `restoringTabs` 置位：persistTabSession 挂点静默（恢复中间态不落盘，收尾一次固化）
- **激活跨重启的实现选择**：不新增全局 activeTabKey 字段，而是持久化 `scopeActive`（各作用域最后激活）并播种进既有 `scopeActiveKeys`——当前作用域激活经规则 1.5 恢复，其他作用域切回时同样经规则 1.5 恢复（运行期语义与冷启动语义合一，mem.active chat-only 约束不变）

## 4. 刷新路径的孤儿视图清理（既有缺陷顺带修复）

- doInit 起步调用新增 IPC `browserViewDisposeAll`（main 侧 `disposeAllBrowserViews`）：renderer 重载后旧 WebContentsView 注册表在 main 存活但 renderer 丢失映射，全量 dispose（含浏览器 Tab view 与 PDF 文件 Tab view——后者激活重挂载时懒建）
- 刷新后 pty 不经 teardown（新 store 的 teardown 时 live tabs 为空、无 pty 可杀）→ server 侧存活 → 会话恢复重连全量回放
- 至此**刷新与重启行为合流**：都走 disposeAll + 会话恢复重建（browser 按持久化 URL 重开导航，terminal 重连回放）

## 5. 写入挂点（派生模型）

单一方法 `persistTabSession()`：live tabs + scopeActiveKeys → 投影，**序列化比对去重**（无变化不写盘——多挂点同帧触发只落一次）；**空 live 守卫**（2026-09-03 review 修订）——`client == null`（断连窗口）或 `restoringTabs`（connect 的 client 落位到恢复段结束整程）时静默，防空 live 派生覆写持久切片（详见 §11 review 一轮）。

| 时机 | 动作 |
|---|---|
| `openChatTab` / `openChatTabPassive` / `openFileTab` / `openDiffTab` / `openTerminalTab` / `doOpenBrowserTab` | 新实体入投影 |
| `closeTab` | 实体移除（恢复期 guard 豁免） |
| `recordScopeActive` | 激活变更（全 kind 挂点的公共漏斗：setActiveTab/open*Tab 开即激活/closeTab 回退/showGuidePage） |
| `applyTabOrder` | 顺序变更（chat 序另经记忆派生，既有） |
| `applyBrowserState` | browser 当前页 URL/标题变更（导航后 entry.url 跟随；loading 等瞬态不触发） |
| `closeProject` / `closeGlobalDirectory` / `unloadWorktreeDirectory` | 关 Tab 循环 + scopeActiveKeys 删除 + 记忆修剪后整体派生（条目自然修剪；顺序约束同记忆——须在关 Tab 循环之后） |
| connect 恢复段收尾 | 一次固化（首开/补开结果的最终态） |

- 写失败仅内存/持久暂不一致，下次变更自愈（同 `tabs.memory` 取舍）
- 写放大：与 `tabs.memory` 同频（每次 Tab 点击两条 KB 级写，main 侧写队列串行；§11 既有"不引入 debounce"结论沿用）

## 6. 生命周期与 teardown 修剪（外科式）

| 场景 | 动作 |
|---|---|
| `disconnect()` / 切 profile（connect 起步 teardown） | teardown 杀 pty + dispose view 后，terminal/browser 实体**不可恢复**——从持久层**外科式剔除对应 kind 条目**（chat/file/diff 保留，重连恢复），指向被剔除实体的 scopeActive 悬挂指针同步清除（review 二轮：规则 1.5 虽会校验失效，但残留指针会被反复播种/派生回持久层）。按**连接归属的 profile 切片**修剪（`sessionProfileKey` 在 connect 成功段落位——切 profile 时 activeProfileId 已变，不能用它定位旧切片）；剔除条件 = 该连接确有对应实体（`hadTerminalTabs`/`hadBrowserViews` 捕获于清空前，后者只认 browser Tab 注册——PDF 文件 Tab 视图共用注册表不计入） |
| **刷新路径**（新 store 的 teardown：live 空、无 pty 可杀无 view 可 dispose） | 不剔除（pty/view 实际存活）→ `sessionProfileKey == null` 即天然跳过 |
| app quit（无 teardown） | 持久层原样保留 → 重启恢复（pty 存活则回放；server 也重启过则 terminal 走 gone 终态） |
| closeProject / closeGlobalDirectory / removeWorkspace | 派生修剪（§5）；重开 = 首开语义（既有），陈旧非 chat 实体不复活 |

## 7. 场景验证表

| # | 场景 | 行为 |
|---|---|---|
| 1 | 开 chat+file+diff 混排 → 重启 | 实体全恢复、顺序 = 持久化顺序、激活 = 离开时 Tab（规则 1.5） |
| 2 | 激活 file Tab → 重启 | file Tab 恢复并占据激活（原落规则 2 chat） |
| 3 | 停留引导页 → 刷新/重启 | 引导页恢复（null 哨兵），草稿不恢复（纯内存，既有） |
| 4 | 开终端 → 刷新 | Tab 恢复，pty 重连全量回放（滚动历史在） |
| 5 | 开终端 → 重启（server 存活） | 同上；server 也重启过 → 已退出只读空视图（关 Tab 清理） |
| 6 | 开浏览器 Tab 导航数页 → 刷新/重启 | Tab 恢复，view 新建导航到持久化当前页 URL |
| 7 | 刷新时浏览器 Tab 正在显示 | 旧 view 被 disposeAll 清掉，无幽灵视图；恢复后正常显示 |
| 8 | 显式断开 → 重连 | chat/file/diff 恢复；terminal/browser 不恢复（pty 已杀/view 已 dispose） |
| 9 | 关项目 → 重启 → 重开项目 | 首开语义（全量按 created），关项目前的 file Tab 不复活 |
| 10 | 删 worktree → 重启 | 该目录持久层条目已修剪，不恢复 |
| 11 | 模板中会话在他端已归档/删除 | chat 跳过（记忆层校验），顺序自动收紧；file/diff 不受影响 |
| 12 | 持久化 JSON 损坏/字段非法 | 逐条 sanitize，坏条目/坏切片丢弃，等效无记录走既有路径 |
| 13 | 切到其他作用域再切回 | 规则 1.5 命中播种记录（跨重启的"最后选中态"），与运行期语义一致 |

## 8. 不做的事

- 视图状态跨重启：fileViewStates/TOC/滚动/diff 折叠仍纯内存（design-tab-state-memory §2 原决策维持——实体恢复但视图回到默认态；后续增量）
- revealLine / diff segment 选中（diffSelectedTypes）跨重启：瞬态/视图态，缺省值兜底
- 关闭栈（Ctrl+Shift+T）持久化：纯内存不变（重启场景由本恢复覆盖）
- 跨 profile 恢复：会话层按 profileKey 切片，无跨切片读取
- terminal 的 buffer 序列化跨重启：exited pty 的 buffer 缓存仍纯内存（重启后 gone/空视图兜底）

## 9. 决策修订（同步既有文档）

- **design-tab-memory §3.2/§18**："file/diff Tab 不参与记忆，冷启动不恢复" → 修订：file/diff 仍不进**记忆结构**（ScopeTabMemory 不变），但经本文会话层持久化恢复；§8 启动恢复管线插入 restoreTabSession 步骤
- **design-tab-state-memory §2/§5**："scopeActiveKeys 纯内存、激活跨重启留作增量" → 修订：scopeActive 随会话层持久化并在冷启动播种（规则 1.5 跨重启生效）；视图状态（模式/滚动/TOC/diff 折叠）仍纯内存
- **spec-v0.3**：功能范围增补"Tab 会话恢复"条目

## 10. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/shared/tab-session.ts` | 新增：PersistedTab/TabSessionState 类型、sanitize/derive/orderTabsByTemplate 纯函数 |
| `src/shared/ipc.ts` | StoreShape 扩 `tabs.session`；DesktopApi 增 `browserViewDisposeAll` |
| `src/main/browser-views.ts` | `browser:dispose-all` IPC（复用 disposeAllBrowserViews） |
| `src/preload/index.ts` / `src/renderer/src/browser-shim.ts` | expose/no-op browserViewDisposeAll |
| `src/renderer/src/store/app-store.ts` | tabSession 加载/派生落盘（挂点 §5）/restoreTabSession/teardown 外科修剪/doInit disposeAll/connect 恢复段接线/loadFileContent 可选 directory 参数 |
| `src/shared/tab-session.test.ts` / `src/renderer/src/store/app-store.test.ts` | 纯函数 + store 级用例 |
| `docs/design-tab-memory.md` / `docs/design-tab-state-memory.md` / `docs/spec-v0.3.md` | 决策修订与范围同步 |

## 11. 验证记录（2026-09-03）

- 按 §10 落地，无偏差。纯函数 `src/shared/tab-session.test.ts`（derive 投影/browser url 省略、模板序合并三分支、sanitize 逐条剔除/坏切片丢弃 8 组）；store 级 12 用例（冷启动全 kind 恢复+模板序+规则 1.5 file 激活、引导页哨兵、死 chat 跳过/模板外尾追、条目闸门（目录未开/projectId 失配）、browser view 重建+当前页导航、落盘挂点+序列化去重、browser URL 变更落盘/loading 瞬态不触发（含首导航前空 URL）、teardown 外科修剪（terminal/browser 剔除 file 保留）、空 live teardown 不动持久层（刷新路径）、空 live 守卫（断连/恢复期两窗口）、teardown 修剪清 scopeActive 悬挂指针、closeProject 修剪+scopeActive 不残留）。vitest 623/623；typecheck 双侧、build 全绿
- E2E（CDP/真机重启）未随本次跑：验收项已入 spec-v0.3（混排恢复/终端回放/浏览器当前页/断连不恢复终端/无幽灵视图），沿用 design-tab-memory §15 的作用域确定性信号断言方法

实现备注（评审自查要点）：

- **`sessionProfileKey` 而非 `activeProfileId` 定位 teardown 修剪切片**：切 profile 时 connect 起步的 teardown 里 activeProfileId 已指向新 profile，按它修剪会误剔新切片、漏剔旧切片（pty 属旧连接）
- **teardown 修剪是外科式（直接 filter 持久层）而非派生重写**：teardown 末尾 live 已清空，派生会连 chat/file/diff 一起清掉；且空 live 的新 store teardown（刷新路径）凭 `sessionProfileKey == null` 天然跳过
- **`restoringTabs` guard 包住 connect 恢复段全程**（记忆循环 + 会话恢复 + 当前作用域激活），收尾 `persistTabSession()` 一次固化——恢复中间态（逐 Tab closeTab 死收敛等）不逐段落盘
- **模板 chat 条目仅作顺序标记**：实体/校验/补开全由记忆层负责，恢复侧不 `openChatTab`（避免双权威与激活副作用）；`orderTabsByTemplate` 对未恢复键自然跳过
- **file 内容预拉按 Tab 归属目录**（`loadFileContent` 增可选 directory 参数，同 doFileReload 重拉口径不带 workspace）——当前作用域 scopeQuery 会把跨作用域 Tab 拉错目录

review 一轮修订（2026-09-03）：

- **空 live 覆写修复（medium）**：`persistTabSession` 原仅 `restoringTabs` 一道守卫，两个窗口内用户动作（Ctrl+T / Tab 条 "+" → `showGuidePage`；Workspace 恒挂载、快捷键无连接闸门）会以空 live 态派生并**覆写**持久切片——① 断连窗口（teardown 已清 live 但外科修剪特意保留的条目被清掉，重连无物可恢复）；② connect 的 client 暴露后到恢复段结束前的网络窗口（发现/默认项目/快照拉取多轮 await，覆写的正是 `restoreTabSession` 即将读取的切片）。修复：`persistTabSession` 增加 `client == null` 守卫（窗口一）+ `restoringTabs` 提前到 client/sessionProfileKey 落位后、包住整段网络与恢复（窗口二）；两窗口内 live tabs 恒空，静默不丢合法写入。补「空 live 守卫」回归用例（两窗口各驱动 showGuidePage/openFilePage 断言持久层原样）
- **teardown 的 browser view 计数只认 browser Tab**：原 `browserViewIds.size > 0` 把 PDF 文件 Tab 视图（`registerFileView` 同注册表）也计入——恰因修剪 filter 只删 `kind === "browser"` 条目而无实害，但标记正确性依赖巧合；改为按 Tab kind 过滤（PDF 视图属 file 条目、重连可恢复且激活懒建，不推高 browser 修剪标记）
- 测试方法备注：store 级用例以 `coldStart()` 手工复刻 connect 恢复段，真实 guard 时序（connect 内）未直接驱动——空 live 守卫用例以 client 注入 + `restoringTabs` 直置覆盖两窗口语义

review 二轮修订（2026-09-03）：

- **首导航前空 URL 推送不算落盘变更（low）**：新建/恢复视图的首个 `did-start-loading` 推送 `agg.url` 恒 `""`（main 侧聚合在 `did-navigate` 才有值），原判定 `prev?.url !== state.url` 必真——瞬态即触发派生，而此刻 `browserStates.url` 已被覆写为 `""`、派生省略 falsy url，**刚持久化的当前页 url 字段被丢掉**（窗口内崩溃/退出则恢复回退初始 URL；`did-navigate` 落地后自愈，亚秒级）。修复：`sessionDirty = !!state.url && (…)`——mid-session 导航不受影响（loading 推送携带旧 URL 无 delta），首导航后的 did-navigate/did-stop-loading 携带真实 URL 照常落盘。补「空 URL 推送不触发 + 后续导航恢复」用例
- **teardown 修剪同步清除 scopeActive 悬挂指针（nit）**：原只滤 tabs，指向被剔除 terminal/browser key 的 `scopeActive[dir]` 残留——规则 1.5 校验失效虽使其无害，但会在每次重连/重启被重新播种、再被下次派生写回持久层，直到该作用域发生真实激活才消解（与 closeProject 显式删除 scopeActive 的处理不一致）。修复：修剪时同帧删除命中被剔除 key 的 scopeActive 条目（null 哨兵/指向存活 Tab 的不动）。补「终端激活态断连 → scopeActive 随剔除清除」用例
