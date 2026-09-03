# 工作区切换的扩展状态记忆 — 设计文档

> 需求：切换 worktree/项目作用域时，除已打开的 Tab（design-tab-memory 已实现：chat Tab 集合 + 顺序 + chat 激活）外，还需记住：**当前选中的 Tab（含 file/diff/引导页）**、**文件视图模式（预览/源码）**、**滚动位置（消息流/文件视图）**、**TOC 显隐选择与章节折叠**（2026-08-26 同日增补，§2.4）。
> 参考先例：移动端 `../openbuilder/docs/design-file-browser-collapse.md`（浏览状态收起/恢复：模式与滚动偏移成对生效、恢复用内容落地后的 jump、非激活模式偏移不保留）。本文按桌面 Tab 模型移植其语义。

## 1. 现状盘点（哪些已记住、哪些丢）

| 状态 | 现状 | 病灶 |
|---|---|---|
| chat Tab 集合/顺序 | ✅ design-tab-memory（记忆持久 + 运行期 live tabs 保序） | 无 |
| 激活 = chat Tab | ✅ 记忆 `active` + §7 规则 2 | 无 |
| 激活 = file/diff Tab | ❌ §7 明确"激活 file Tab 不改写记忆"，切回回退到记忆 chat 激活 | 用户最后选中的是文件/改动 Tab 时，切回被顶替成 chat |
| 激活 = 引导页（无激活 Tab） | ❌ 切回按记忆 chat 激活，引导页丢失 | 同上 |
| 文件视图模式（预览/源码） | ❌ FileView 局部 state，key 隔离重挂载即重置（design-markdown-preview §2.1 原决策"不持久化"） | 切回文件 Tab 回到默认预览态 |
| 消息流滚动位置 | ❌ ChatView 重挂载 `pinnedToBottom` 恒真，切回滚到底 | 上滚阅读历史时切走，切回丢失阅读位置 |
| 文件视图滚动位置 | ❌ 同上（`.file-view` 滚动层 / CodeMirror 内部滚动） | 同上 |
| TOC 显隐选择与章节折叠 | ❌ `tocUserMode`/`tocFolded` 局部 state，key 隔离重挂载即重置 | 切回文件 Tab 时 TOC 回到宽度默认态、折叠章节全展开 |

Tab 顺序无需新工作：运行期 live tabs 跨切换保留（全局数组顺序不变，Tab 条按作用域过滤显示），重启后 chat 顺序按记忆恢复；file/diff Tab 不参与记忆是 design-tab-memory §3.2 既有决策（只读视图重开成本为零），本文不改。

## 2. 方案总览

三项新状态全部**纯内存**（不落盘、不跨重启），与草稿（design-compose-draft D1）同一取舍：

- 需求场景是"切换 worktree 再切回"（运行期内）；重启后 file Tab 本就不恢复（§3.2），其模式/滚动跨重启无意义
- chat 滚动位置与任意 kind 激活若要跨重启，需持久化 + 与 §7 激活规则合流，属增量需求，不在本次
- （**2026-09-03 修订**：任意 kind 激活已随 [design-tab-session-restore.md](./design-tab-session-restore.md) 跨重启——`scopeActiveKeys` 冷启动播种；模式/滚动/TOC/diff 折叠仍纯内存）

写入一律**不 emit**（高频滚动事件不触发整树重渲染，同草稿 §2.2）；视图挂载时读一次，无渲染订阅。

### 2.1 任意 kind 的"最后激活"（app-store：`scopeActiveKeys`）

```ts
private scopeActiveKeys = new Map<string, string | null>()  // directory → 最后激活 tab key；null = 引导页
```

- **记录点**（用户意图产生的激活变更）：`setActiveTab`、`openChatTab`、`openFileTab`、`openDiffTab`（开即激活）、`closeTab` 激活回退（回退结果，含 `null` = 落到引导页）、`showGuidePage`（当前作用域 → `null`）
- **不记录**：恢复/清算路径（`restoreScopeTabs`、`clearCrossScopeActivation`）——它们是消费方，回写会让消费结果固化为"用户意图"
- **消费**：`restoreScopeTabs` 激活解析，插在 §7 规则 1 与规则 2 之间：
  ```
  规则 1   当前激活属于目标作用域 → 保持（不变）
  规则 1.5 scopeActiveKeys[dir] 有记录：
           null → 激活置 null（回引导页）
           key 仍在 live tabs 且 directory 匹配 → 激活之
           否则（已被关闭/死会话收敛）→ 落到规则 2
  规则 2-4 记忆 chat active → valid 末位 → null（不变）
  ```
- **与记忆 `active` 的关系**：记忆 `active` 仍只记 chat（冷启动恢复语义不变——file Tab 不跨重启，重启后规则 1.5 无记录自然走规则 2）；规则 1.5 命中时**不改写** `mem.active`（保持分支不回写，同 §7 末条实现约束）
- 修订 design-tab-memory §7："激活 file Tab 不改写记忆"的**依据变化**——运行期切回不再回退到 chat，而是经规则 1.5 恢复原选中；记忆 chat-only 仅约束冷启动
- **跨重启（2026-09-03 修订，[design-tab-session-restore.md](./design-tab-session-restore.md)）**：`scopeActive`（各作用域最后激活）随会话持久层 `tabs.session` 落盘，冷启动 `restoreTabSession` 播种进本 Map（仅已打开目录）——规则 1.5 的"任意 kind 激活/引导页跨重启"由此生效；运行期语义（记录点/不记录/消费规则）不变

### 2.2 文件视图模式 + 滚动（app-store：`fileViewStates`）

```ts
private fileViewStates = new Map<string, { mode: "preview" | "source"; top: number }>()  // key = 文件绝对路径
```

- FileView 挂载初始化：`mode` 从条目读（缺省 `"preview"`）；`top` 作为一次性待恢复偏移
- **模式与偏移成对**（移动端 design-file-browser-collapse §4 语义）：条目记录的是**当前激活模式**的滚动偏移；模式切换即写 `{新模式, top: 0}`（非激活模式的偏移不保留，两模式坐标系不可换算——预览是 `.file-view` 容器、源码是 CodeMirror 内滚）
- 捕获：预览态 `.file-view` 容器 `onScroll`；源码态 CodeMirror `scrollDOM` 滚动回调（CodeView 增加 `onScrollTop` 传出）；写入 `{当前模式, top}`
- 恢复：内容落地后一次性应用——预览态设 `.file-view.scrollTop`；源码态经 CodeView 新增 `initialScrollTop` 在 EditorView 创建后设 `scrollDOM.scrollTop`（应用后清待恢复标记；content 后续重拉的 doc 同步本就保滚动，不受影响）
- **已知限制**：html 预览是 `sandbox=""` iframe（opaque origin，滚动不可达）——条目记容器值（恒 0），恢复 no-op；DiffView、TOC 悬浮窗滚动不做（无诉求）
- **一次性应用时序**：预览偏移在 `cached` 落地 commit 应用一次，无重试——markdown 首挂载是同步出块（评审实证：`useState(fe)` 初始化即渲染，transition 只作用于后续更新），落地帧 `scrollHeight` 即终值。异步加载图片使内容后续增高 → 恢复点轻微漂移，clamp 兜底、可接受误差（移动端 design-file-browser-collapse 同款取舍）
- **模式切换弃待恢复偏移**：内容未落地的加载窗口内切模式，残留 `pendingScroll` 会在落地后错灌入新模式——切换处理器显式置空（与"归零"写入同步）
- 修订 design-markdown-preview §2.1/§3 原决策"模式不持久化、重开成本为零"→ 运行期内按文件路径记忆（重开成本仍为零，但切换体验要求状态连续）

### 2.3 消息流滚动位置（app-store：`chatScrollTops`）

```ts
private chatScrollTops = new Map<string, { top: number; headId: string | null }>()  // key = sessionID
```

- **锚定模型**：存 `{scrollTop, 头部消息 id}` 而非消息锚点偏移——切走期间的变化几乎恒为**底部增长**（流式/乐观消息排尾），绝对 scrollTop 对底部增长免疫；头部变化仅分页 prepend（挂载中才会发生）与远端删最旧（罕见，回落兜底）。比"首条可见消息 + 偏移"锚点简单一个量级，覆盖现实场景
- **捕获**：`onScroll` 更新 ref（`{el.scrollTop, headIdOf(visibleEntries)}`，廉数值读取）；**卸载 cleanup 落 store**：`pinnedToBottom`（吸附底部）→ 删条目（切回贴底是正确默认），否则写 ref 值。cleanup 在卸载时必然执行、DOM 读取经 ref 缓存规避（不依赖 cleanup 时 DOM 存活，见草稿同 commit 卸载陷阱的区分——cleanup 本身会运行，丢的是待定新 effect）。**复活闸门**：关 Tab 路径 `closeTab` 先清条目、ChatView 随后卸载——cleanup 须验「Tab 仍在」方可写，否则已清条目被卸载写复活（重开归档会话会冒出陈旧滚动位置）
- **恢复**：挂载时读条目初始化 `pinnedToBottom = 无条目`；条目存在 → 布局 effect 在 entries 落地且 `headId` 匹配时 `scrollTop = min(top, 可滚范围)` 并消费待恢复标记；`headId` 不符（远端窗口变化）→ 放弃恢复回落贴底（原行为），不呈现错位
- 恢复后 `pinnedToBottom=false`，后续分页 prepend 走既有视口锚定补差（design-message-history-pagination §4.3）；恢复位置接近顶部触发的链式加载是预期行为（用户当时就在那阅读）
- 用户切回后手动滚到底（重新吸附）→ 下次切走按吸附删条目——状态恒收敛到"最后离开时的位置"

### 2.4 TOC 状态（app-store：`tocStates`）

```ts
private tocStates = new Map<string, { visible?: boolean; folded: string[] }>()  // key = 文件绝对路径
```

- `visible`：用户显式显隐选择（三态中的布尔态；缺省 = 未手动操作、随宽度默认）。点击工具条收起/展开钮即写
- `folded`：折叠章节的**标题文本**列表。标题元素（`TocHeading.el`）不可跨挂载存活，文本是稳定标识——重挂载后标题重扫描，按文本匹配仍存活的章节恢复折叠；章节同名则同折叠（可接受）；内容更换导致标题集变化时，挂载内重置语义不变（原 §2.4 决策）
- **恢复时序**：标题扫描可能晚于首帧（异步 MutationObserver 路径）——恢复以「标题数组引用」记账（`tocFoldInitFor`），空标题落地不消耗恢复机会；该引用已初始化后 StrictMode 双跑/重复触发不再重置（否则恢复结果被二次触发的重置覆盖）
- 低频写入（仅点击触发），不 emit；与 §2.2 分账（滚动捕获高频），两 Map 互不牵动

### 2.5 diff 视图状态（app-store：`diffViewStates`）

```ts
private diffViewStates = new Map<string, { foldOpen: boolean; closedFiles: ReadonlySet<string>; scrollTop: number }>()  // key = diffTabKey(directory)
```

- `foldOpen`：全局折叠意图（工具条「全部折叠/展开」按钮方向）。true = 展开态；手动折叠/展开单文件块不回写——按钮在两种意图间交替，手动操作不改变标签
- `closedFiles`：手动折叠的文件路径集（`file.file` 相对路径）。恢复时 `foldOpen=true` → 集合内文件收起、其余展开；`foldOpen=false` → 全部收起（全局意图优先，手动展开的单文件不跨卸载保留——取舍：全局意图 + 集合已足够覆盖主要场景，逐文件精确状态需追踪手动展开与全局意图的交叉态，复杂度不值）
- `scrollTop`：滚动容器（`.diff-view.scroll`）偏移。`onScroll` 写 ref（不触发重渲染）；卸载落 store
- **恢复时序**：foldOpen/closedFiles 经 `useState` 初始化值恢复（挂载即生效）；scrollTop 经 `useLayoutEffect` 在 `data.files` 落地后一次性应用（内容未渲染时 scrollHeight=0，设值被 clamp）
- **卸载落 store**：`useEffect(() => { return cleanup }, [])` 经 ref 读最新值（foldOpen/closedFiles 的 state 闭包在挂载时捕获、不随 state 更新）；**复活闸门**——Tab 仍在（`store.tabs.some`）才写，否则 closeTab 已清的条目被卸载写复活（同 §2.3 chatScrollTops 模式）
- 写入不 emit（滚动高频 + 折叠低频同 §2.2 fileViewStates 模式）
- **首次挂载跳过 foldOpen 覆盖**：FileDiffBlock 的 `useLayoutEffect([foldOpen])` 在首次挂载时跳过（`firstMount` ref 标记），避免全局意图覆盖从 closedFiles 恢复的逐文件状态；仅在 foldOpen **变化**（工具条按钮触发）时覆盖所有文件块

## 3. 生命周期清理（与草稿同构，防无界增长/跨作用域残留）

**顺序约束（实现实测）**：目录卸载路径对 `scopeActiveKeys` 的清除**必须在关 Tab 循环之后**——被关的是激活 Tab 时，`closeTab` 回退钩子会 `recordScopeActive`，回退链末端无邻可退写 `null` 哨兵；先删会被写回，重开经规则 1.5 误落引导页（与 `tabMemory` 删除的同款顺序约束同源）。

| 状态 | 清理点 |
|---|---|
| `scopeActiveKeys[dir]` | `closeProject`（项目各目录）/ `closeGlobalDirectory` / `removeWorkspace`（该目录），均在关 Tab 循环之后；`teardownConnection` 全清 |
| `fileViewStates[path]` | `closeTab` file 分支（关 Tab 即弃，重开回到默认预览——同草稿"关闭 = 决断"语义）；`teardownConnection` 全清（关项目/删工作区经 `closeTab` 覆盖） |
| `chatScrollTops[id]` | `closeTab` chat 分支 + `cleanupSessionState`（同草稿挂点）；`teardownConnection` 全清 |
| `tocStates[path]` | 同 `fileViewStates`（`closeTab` file 分支 + `teardownConnection`） |
| `diffViewStates[diffTabKey]` | `closeTab` diff 分支（关 Tab 即弃，重开回到缺省全展开 + 顶部）；`teardownConnection` 全清 |

**双行目录边角（已知取舍）**：`closeTab` 激活回退候选按 directory 取样、不区分 projectId——双行目录下项目 X 卸载关 Tab 时，可能把同目录项目 Y 的存活 Tab 键写进 `scopeActiveKeys[X 的目录]`，重开 X 经规则 1.5 激活 Y 的 Tab。行为尚可接受（该 Tab 确实在此目录可见），不引入 projectId 维度（与 §2.1 键选择一致）。

## 4. 场景验证表

| # | 场景 | 行为 |
|---|---|---|
| 1 | 作用域 A 激活 file Tab → 切 B → 切回 A | file Tab 重新激活（规则 1.5） |
| 2 | A 停留在引导页 → 切 B → 切回 A | 仍显示引导页（null 哨兵），引导页草稿同恢复（design-compose-draft） |
| 3 | A 激活 chat → 切 B → 切回 A | 不变（规则 1.5 命中 chat，等价规则 2） |
| 4 | A 激活 file Tab → 该 Tab 被关（他端删会话/文件所在目录卸载）→ 切回 | 记录失效落规则 2（记忆 chat 激活） |
| 5 | 重启应用 | ~~规则 1.5 无记录（内存态），按记忆 chat 恢复~~（2026-09-03 修订：scopeActive 经会话持久层播种，规则 1.5 恢复原选中；见 design-tab-session-restore） |
| 6 | md 文件源码模式滚到中段 → 切走再回 | 恢复源码模式 + 原偏移（模式成对） |
| 7 | 预览模式滚到中段 → 切走再回 | 恢复预览模式 + 原偏移 |
| 8 | 预览滚到中段 → 切源码 → 切走再回 | 源码模式 + 顶部（模式切换写 `{source, 0}`，预览偏移弃） |
| 9 | 关文件 Tab → 重开 | 默认预览态、顶部（条目随关闭清除） |
| 10 | 消息流上滚阅读 → 切走再回（期间回复流式增长） | 停在原阅读位置（底部增长不影响 scrollTop） |
| 11 | 贴底状态切走再回 | 贴底（无条目，原默认） |
| 12 | 上滚切走 → 他端删除窗口内消息致头部变化 → 切回 | headId 不符，回落贴底（不错位） |
| 13 | 上滚切走 → 切回 → 手动滚到底 → 再切走再回 | 贴底（重新吸附后条目已删） |
| 14 | html 文件预览切走再回 | 模式恢复；滚动不可达（沙箱），顶部 |
| 15 | 窄屏显式展开 TOC + 折叠甲章 → 切走再回 | 显隐选择与折叠均恢复（visible 覆盖宽度默认态；甲章按文本匹配重新折叠） |
| 16 | 折叠甲章 → 文件内容更新（甲章仍在）→ 切走再回 | 甲章仍折叠（文本标识跨内容更新存活）；挂载内标题集更换的重置语义不变 |
| 17 | 关文件 Tab → 重开 | TOC 回宽度默认态、章节全展开（条目随关闭清除） |

## 5. 不做的事

- ~~跨重启持久化（开篇决策；重启后 file/diff Tab 不存在，模式/滚动/折叠无宿主；激活/消息滚动留作增量）~~（**2026-09-03 修订**：激活经 [design-tab-session-restore.md](./design-tab-session-restore.md) 跨重启——scopeActive 随 `tabs.session` 落盘冷启动播种，且 file/diff/terminal/browser 实体重建后模式/滚动/折叠有了宿主，但其跨重启持久化仍不做，回默认态；消息滚动持久化仍留作增量）
- ~~DiffView~~ 滚动位置（**2026-08-27 修订**：已实现 §2.5 diff 视图状态——foldOpen + 文件折叠 + 滚动位置）
- TOC / 侧栏滚动位置
- html 沙箱 iframe 内部滚动（不可达）
- 文件树展开/滚动状态（右栏随作用域重置是既有语义）
- Tab 拖拽排序（v0.1 无；顺序语义由 design-tab-memory 记忆结构预留）

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/store/app-store.ts` | 五个内存 Map + 读写方法（不 emit）；记录点（setActiveTab/open*Tab/closeTab 回退/showGuidePage）；restoreScopeTabs 规则 1.5；清理挂点 |
| `src/renderer/src/components/workspace.tsx` | ChatView 滚动捕获/恢复（pinned 初始化、卸载落 store、布局效果恢复）；FileView 模式/滚动恢复（含非预览文件分支）+ TOC 显隐/折叠恢复（标题引用记账防 StrictMode 覆盖） |
| `src/renderer/src/components/diff-view.tsx` | diff 视图状态恢复（foldOpen/closedFiles useState 初始化 + scrollTop useLayoutEffect）+ 卸载落 store（ref 读最新值 + 复活闸门） |
| `src/renderer/src/components/code-view.tsx` | `initialScrollTop` / `onScrollTop` 接线（创建后设 scrollDOM + 滚动监听） |
| `src/renderer/src/store/app-store.test.ts` | store 级用例 |
| `docs/design-tab-memory.md` / `docs/design-markdown-preview.md` / `docs/spec-v0.1.md` | 决策修订与范围同步 |

## 7. 验证记录（2026-08-26）

- 按 §6 落地，无偏差。vitest 318/318（新增 9 用例：规则 1.5 file Tab 恢复激活/引导页哨兵/失效回退、文件状态读写+关 Tab 清、滚动位置读写+关 Tab/删会话清、关项目/拆连接清空、激活态关项目再重开回归；file-view 组件新增模式恢复+滚动上报+预览滚动恢复用例；既有 §18「切回回退记忆 chat」用例按新语义更新期望）；typecheck 双侧、build 全绿
- CodeMirror 偏移恢复经 rAF 等布局落定（创建当帧 scrollHeight 未建立，直接设被 clamp 到 0）

review 一轮修订（2026-08-26）：

- **顺序约束修复（medium）**：三处目录卸载路径原在关 Tab 循环**前**删 `scopeActiveKeys`，被关激活 Tab 的回退钩子（末端 `null` 哨兵）随即写回——重开项目经规则 1.5 误落引导页。清除移至循环后（同 `tabMemory` 既有顺序约束），补「激活态关项目再重开」回归用例
- 字段注释修订：记录点含 `closeTab` 回退（含死会话收敛连带），非仅"用户意图"
- 补记双行目录边角（§3）；补预览态滚动恢复组件用例

同日增补 §2.4 TOC 状态：vitest 321/321（新增 3 用例：写读往返合并/关 Tab 清、显隐与折叠落 store、挂载恢复覆盖默认态）；design-markdown-preview §2.4「选择不持久化」决策同步修订

review 二轮修订（2026-08-26）：

- **加载窗口竞态修复（low）**：内容未落地时切模式，残留待恢复偏移会在落地后错灌入新模式——模式切换处理器显式清 `pendingScroll`（§2.2 补记），补「加载窗口切模式」回归用例（vitest 322/322）
- 预览偏移一次性应用无重试的依据补记（§2.2）：markdown 首挂载同步出块（评审实证），异步图片漂移为可接受误差（移动端同款取舍）
- 清理：`scopeActiveKeyFor` 接入规则 1.5（原无调用方）；FileView 头注释同步模式记忆语义
