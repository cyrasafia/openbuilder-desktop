# 快捷键体系 — 设计文档

> 对应 spec-v0.3 #2。Tab 新建/关闭/切换、关闭栈恢复（Ctrl+Shift+T）、左栏作用域遍历（非 mac `Alt+↑/↓` / mac `⌘⌥↑/↓`，2026-09-04 修订；**2026-09-06 再修：遍历改预览-提交模型（§3）**）。原纯 renderer 改动，2026-09-06 起浏览器视图转发过滤（main，browser-views.ts）亦涉（§3）。2026-09-06 增：引导页磁贴快捷键 Ctrl+1/2/3（页面局部，见 §1.1）。
>
> 参考先例：按 AGENTS.md 约定检索 `../openbuilder/docs/design-*.md`——移动端无硬件键盘快捷键体系（TUI 无从借鉴），无同类设计。

## 1. 快捷键表

| 键 | 动作 |
|---|---|
| Ctrl+T | 新建 Tab = `showGuidePage()`（与 Tab 栏 "+" 同路径） |
| Ctrl+O | 打开项目选择器（与左栏 "+" 同路径 = `openProjectPicker()`；picker 开着时重复按下仅消费不动作，防 overlay 计数失衡） |
| Ctrl+W | 关闭激活 Tab；**无激活 Tab 时仅消费不动作**（放行会命中默认菜单关窗，见 §1 修订）；chat Tab 流式中先 confirm（复用 `confirmCloseStreamingTab`），确认后 abort+归档——与 Tab 栏关闭按钮**同一代码路径**（§4 tab-actions） |
| Ctrl+Shift+T | 恢复刚关闭的 Tab（§2 关闭栈） |
| Ctrl+1 / Ctrl+2 / Ctrl+3（**仅引导页**，2026-09-06 增，§1.1） | 分别开 diff / 终端 / 网页 Tab（与引导页磁贴点击同路径、同禁用态）；Ctrl 按住期间磁贴右上角显示对应数字角标 |
| Ctrl+Tab / Ctrl+PageDown | 下一个可见 Tab（作用域内循环；Shift 反转方向；**仅非 macOS**） |
| Ctrl+Shift+Tab / Ctrl+PageUp | 上一个可见 Tab（循环；Shift+PgUp/PgDn 同样反转；**仅非 macOS**） |
| ⌘⌥→ / ⌘⌥←（macOS） | 下/上一个可见 Tab（2026-09-03 修订：macOS 浏览器惯例主键；⌘Tab/⌘⇧Tab 是系统应用切换器，永远到不了应用） |
| ⌘⇧] / ⌘⇧[（macOS） | 下/上一个可见 Tab（浏览器惯例别名；**按 code 匹配** `BracketRight`/`BracketLeft`——US 布局 shift+[ 的 key 是 `"{"`，code 布局无关。浏览器视图转发载荷因此增加 `code` 字段） |
| Alt+↓ / Alt+↑（mac ⌘⌥↓ / ⌘⌥↑） | 左栏项目/工作区行**预览-提交**遍历（§3，循环）：按下修饰键左栏显光标，↑/↓ 只移动光标不切换，松开修饰键一次切换到光标行；鼠标点击切换行为不变。2026-09-06 修订（原逐按立即切换）。键位沿革：2026-09-04 替换原 `Ctrl+Alt+↑/↓`——GNOME/KDE 合成器抢作工作区切换（Wayland 下应用收不到，gsettings `switch-to-workspace-up/down` 实测），`Ctrl+Alt+Shift+↑/↓` 亦被 GNOME `move-to-workspace` 占用；mac 不用裸 ⌥↑/↓（NSText 段落首/尾移动惯例，劫持破坏输入框打字），维持 ⌘⌥↑/↓ |
| Ctrl+B（mac ⌘B） | 收起/展开**左栏**（翻转，与标题栏开关同路径 `toggleLeftPanel()`；2026-09-04 修订替换原 Ctrl+[） |
| Ctrl+Alt+B（mac ⌥⌘B） | 收起/展开**右栏**（翻转，`toggleRightPanel()`；替换原 Ctrl+]） |

- 注册：Shell 内 `useShortcuts()`，window keydown（bubble）；`e.isComposing` 守卫（fcitx5）；已 preventDefault 的事件不再处理
- **无激活 Tab 的 Ctrl+W 也消费**（2026-08-29 修订，推翻原"无加速键冲突"断言）：Electron 默认菜单并未因 autoHideMenuBar 消失，其 role:close 的 Ctrl+W 加速键对 **renderer 未消费**的按键生效（Chromium 对 renderer 未处理的键回调 `HandleKeyboardEvent` 触发加速键）——实测无 Tab 时 Ctrl+W 直接把窗口关掉。故 dispatch 对无激活 Tab 的 Ctrl+W 返回"已消费"（preventDefault、不动作）；其余未映射组合仍放行。Ctrl+数字跳转不做（用户决策，系统/输入法易冲突）
- 修饰键判定以 ctrlKey 为准（macOS 开发态 Cmd 亦生效——metaKey 等价 Ctrl，成本零）；Alt+↑/↓ 与 AltGr 的组合风险仅限"AltGr+方向键产生字符"的场景，不存在（方向键非字符键）；裸 Alt 组合仅方向键进分发（`useShortcuts` 入口守卫放行 alt+arrow），Alt+字母仍页面/输入框自用
- **macOS 切 Tab 仅惯例键**（2026-09-03 修订 + 2026-09-04 用户决策，`window.desktop.platform === "darwin"`）：darwin 只绑 ⌘⌥←/→ 与 ⌘⇧[/]，**Ctrl+Tab / ⌘PgUp/PgDn 不绑定**——mac 下切 Tab 不留非惯例组合；linux 上 Ctrl+Alt+←/→ 是 GNOME/KDE 工作区切换（不可占用），Ctrl+Shift+[/] 维持原放行语义；macOS 上 ⌘⌥↑/↓（作用域遍历）与 ⌘⌥←/→（切 Tab）按轴分工，与浏览器惯例一致
- **面板开关键冲突核查结论**（2026-09-04 修订：全平台统一 VS Code 系 `Ctrl+B` / `Ctrl+Alt+B`，替换原 `Ctrl+[/]`——mac ⌘[ 是浏览器后退惯例且 BrowserView 内与面板开关双触发，⌘B/⌥⌘B 无此冲突；原"欧陆 AltGr 产生 `[` 上报 ctrl+alt"的误触顾虑对新键不成立，B 无常见 AltGr 字符映射，VS Code 同绑定先例）：Electron 默认菜单加速键无 `B` 系（无 Ctrl+W 式放行风险）；Chromium 在 Linux/Win/mac 均无 Ctrl+B/⌘B 绑定（富文本编辑器的加粗是页面内行为）；**按 code `KeyB` 匹配**——mac ⌥B 的 key 是 `"∫"`（Option 产特殊字符），key 不可靠，code 布局无关；code-view 只装 searchKeymap 无 defaultKeymap，无 Mod-B 冲突。**终端 Tab 聚焦时 xterm 在 textarea capture 监听器内 `cancel(e, force)` → preventDefault+stopPropagation 抢先消费 Ctrl+B（STX 0x02 归 pty，readline backward-char）**，事件到不了 window 分发——快捷键在终端内不生效，与 Ctrl+T/W 同行为，属预期而非缺陷，且保住了终端用户习惯

### 1.1 引导页磁贴快捷键（2026-09-06 增）

- **作用域 = 引导页存活期**：监听（window keydown/keyup/blur）挂 `GuidePage` 组件内，随页面挂载/卸载——**不经全局 `useShortcuts` 分发**（Ctrl+数字对全局仍是未映射组合，§5"跳 Tab 不做"决策不变；此为引导页局部开入口动作，非按序号切 Tab）
- **动作与磁贴一致**：Ctrl+1 → `openDiffTab()`、Ctrl+2 → `openTerminalTab()`、Ctrl+3 → `openBrowserTab("about:blank")`，与磁贴点击同路径、**同禁用态**（无 activeProfile 时 2/3 不动作；browser shim 平台 3 不动作）
- **角标提示**：Ctrl（或 macOS Cmd，metaKey 等价惯例）按住期间三个磁贴右上角显示数字角标（`.btn-tile-badge`）；禁用磁贴不显示（快捷键同样不动作）。keyup Control/Meta 或窗口失焦清（失焦后 keyup 不再派发，不清会残留）
- **守卫**：`isComposing` 不触发（fcitx5）；已 preventDefault 的事件不处理（同全局 useShortcuts 约定，防未来内层组件消费后双触发）；Shift/Alt 组合不触发；`repeat` 不触发（终端每次调用新建 pty，按住不放不得连开）；按 code `Digit1/2/3` 匹配（布局无关）；消费即 preventDefault
- **键冲突核查**：Chromium 对 renderer 未消费的 Ctrl+数字无默认行为（Linux 桌面快捷键是合成器层，应用收不到不构成劫持）；输入区聚焦时 Ctrl+数字无文本语义，劫持无损

## 2. 关闭栈与恢复

```ts
interface ClosedTabEntry { kind: TabKind; key: string; projectId: string; directory: string; title: string }
private closedTabs: ClosedTabEntry[] = []   // push 尾 / pop 尾，上限 20（满则弃最旧）
```

- **入栈 = 仅用户主动关闭**：`closeChatTab` 成功路径（归档成功 / 会话已消失）与 `closeTab(key, { pushClosed: true })`（非 chat 的 UI/快捷键路径）。卸载路径（关项目/删工作区/死会话收敛/session.deleted）不传 pushClosed，不入栈——恢复一个所属项目已关闭的 Tab 没有落点
- **恢复**（`restoreClosedTab()`）：自栈顶逐项弹出尝试，失败（不可恢复）继续弹下一项，直到成功或栈空；**全 kind 先过作用域落点判定（§2.1）**——恢复的 Tab 必须落在其所属作用域（chat 恢复到别的作用域会打破“激活 Tab 属于当前作用域”不变式；所属项目已关时还会在 server 侧产生取消归档副作用）：
  - `chat`：落点可达 → `openChatTab`（自带取消归档，与"打开 Tab = 取消归档"锁定语义对称）；会话已删除 → 跳过
  - `file` / `diff`：落点可达 → `openFileTab(path)` / `openDiffTab()`（diff 每作用域单 Tab，openDiffTab 复用）
  - `terminal` / `browser`：栈结构兼容，M3/M4 落地时接入（终端 = 原 cwd 新建 pty；浏览器 = 原 URL 重开）
- 纯内存不持久化（重启场景由 Tab 记忆覆盖）

### 2.1 跨作用域恢复的落点判定（ensureScopeFor）

恢复项 `directory` ≠ 当前作用域时**同步段**切过去（切换函数在首个 await 前写入作用域状态，随后开 Tab 时 `scopeDirectory()` 已就位）：

1. 属当前项目（**仅普通项目**——global 项目 sandboxes 恒空，global 跨目录恢复须走分支 2，否则误判不可达）：项目根 → `setCurrentWorkspace(null)`；worktree（在 sandboxes 内）→ `setCurrentWorkspace(dir)`
2. 属其他**已打开** entry（`openedEntries` 按 projectId + directory/sandboxes 匹配）：entry 根/global 目录 → `openEntry(key)`；**普通项目的 worktree 一步直达 `setCurrentProject(projectId, dir)`**（= `openProject` 单次切换，同步段即落位 worktree——先 openEntry 再补 setCurrentWorkspace 的两段式会把 Tab 开在项目根作用域）
3. 所属项目/entry 已关闭 → 不可达，跳过该栈项

## 3. Alt+↑/↓（mac ⌘⌥↑/↓）作用域遍历——预览-提交模型

> 键位沿革：2026-09-04 原 `Ctrl+Alt+↑/↓` 在 GNOME/KDE 被合成器抢作工作区切换（Wayland 下应用收不到 keydown，等价绑定不存在），`Ctrl+Alt+Shift+↑/↓` 亦被 GNOME `move-to-workspace` 占用——改绑裸 `Alt+↑/↓`（GNOME/KDE/Chromium/CodeMirror/fcitx5 均无占用）；mac 维持 `⌘⌥↑/↓`（裸 ⌥↑/↓ 是 NSText 段落移动惯例）。
>
> 2026-09-06 修订（预览-提交，用户决策）：按下修饰键左栏即时显示光标，↑/↓ 只移动光标**不切换**，松开修饰键才一次切换到光标行——替代原"逐按立即切换 + design-tab-memory §21 连按防抖"。中间作用域按构造消除（预览期零切换零请求，连 §20 的 latest-wins 断路都不需要），且光标提供明确的"将切换到哪"预览；§21 机制（`SCOPE_CYCLE_WINDOW_MS` 防抖窗口）随之移除。鼠标点击切换行为不变。

- **状态机**（store `scopePreview`；行**描述符**而非下标——拖拽重排/快照刷新中列表变化不失位）：
  - **begin**（按下修饰键）：`beginScopePreview()` 光标落当前行；已在预览中 no-op（第二个 Alt 键 keydown 不复位光标）。非 mac 进入条件 = 裸 Alt keydown 且无 Ctrl/⌘（Ctrl+Alt+B 等组合不显光标）；mac = ⌘⌥ 弦凑齐（任一后到修饰键的 keydown 触发，用户按压顺序不定）。当前行瞬态消失（作用域行刚消失）时光标不落（null，无高亮），首步 move 按虚拟边界起步
  - **move**（Alt+↑/↓，经 §1 分发表）：`moveScopePreview(dir)` 只移动光标并 emit——**零切换零请求**（无文件树重置/Tab 恢复/快照）。从预览行起步；预览未落退回当前行；两者皆失按虚拟边界起步（dir=1 落首行、dir=-1 落末行，与原单步语义一致）。未 begin 直接 move 亦合法（等价 begin+move，浏览器视图转发丢 begin 时兜底）
  - **commit**（松开修饰键）：`commitScopePreview()` 一次切换到光标行并清预览。no-op 条件：未预览 / 未移动（光标 = 当前行）/ 光标行已消失（关项目/删工作区竞态）；当前行瞬态消失**不算**（光标行有效即用户明确所指）。激活复用侧栏点击语义：entry → `openEntry`；工作区行 → 当前项目 `setCurrentWorkspace`、跨项目 `setCurrentProject`（一步直达）
  - **cancel**：鼠标等其他作用域操作介入（`openEntry`/`openProject`/`setCurrentWorkspace`/`closeEntry`/`closeProject` 入口先 `cancelScopePreview()`）作废预览不切换；窗口失焦同样作废——Alt+Tab/⌘Tab 被合成器抢走后 keyup 不再来，不清高亮残留
- **提交键**：非 mac = Alt keyup；mac = ⌘ 或 ⌥ 任一 keyup（弦解散即提交）。commit 入口恒开，store 侧无预览时 no-op
- **平铺序列** = 左栏显示顺序：每个 `openedEntries` 行 +（普通项目）其 `workspacesOfProject` 行；序列空 no-op
- **侧栏渲染**：光标行 `.tree-row.scope-cursor`（highest + 8% primary 淡染——"待提交"信号，与 hover（high）、active（highest + 4% on-surface）区分；仍背景单信号无描边环，2026-08-24 idiom），`scrollIntoView({block:"nearest"})` 跟随移出视口的光标
- **监听挂点**：`useShortcuts` 内 window keydown（begin）/ keyup（commit）/ blur（cancel），与分发同 effect。浏览器 Tab 聚焦时的转发（browser-views.ts）相应扩展：keyDown 增裸 Alt、新增 keyUp 转发（仅 Alt/Meta/Control），载荷加 `up` 字段区分；**顶层窗口失焦经 main 补发**（`browser:window-blur`）——视图持焦时 renderer 的 window 已是 blur 态，应用失活（Alt+Tab 被合成器抢走、keyup 不再来）无 DOM blur 事件可听，cancel 信号缺失会残留高亮。不用视图自身 webContents 的 blur——焦点回宿主 UI（点侧栏）时也触发，该路径宿主 keyup 监听正常接管，cancel 会误杀按住中的预览
- **已知边界**：live 终端内 Alt+↑/↓ 归 pty（既定语义，design-terminal-tab §1.4）——裸 Alt keydown/keyup 本就冒泡，光标显示但不移动、松开 no-op，属预期；mac ⌥⌘B（右栏开关）与遍历弦同修饰组合，按住期间光标短暂可见（B keyup 不触发提交，无害瞬态）

## 4. 用户关闭路径的收敛（tab-actions）

`closeTabInteractive(store, tab, t)`（新模块 `src/renderer/src/components/tab-actions.ts`）：chat 流式确认 + abort + 归档；非 chat 直接 `closeTab(key, { pushClosed: true })`。Tab 栏关闭按钮与 Ctrl+W 共用，语义单一来源（原 Tab 栏内联逻辑迁出）。

## 5. 不做的事

- Ctrl+数字跳转 Tab（按序号切 Tab；用户决策不做，系统/输入法易冲突）——与 §1.1 引导页 Ctrl+1/2/3 开入口不冲突：后者是引导页局部动作且页面存活期绑定，不引入全局 Ctrl+数字语义
- ~~Ctrl+B（用户决策不做）~~（2026-09-04 反转原决策：全平台统一 VS Code 系面板开关键 Ctrl+B / Ctrl+Alt+B，见 §1 修订）
- MRU 切换顺序（Ctrl+Tab 用线性循环；浏览器 MRU 依赖"最近使用"栈，复杂度不值）
- 快捷键自定义/冲突检测 UI
- 关闭栈持久化
- 设置页快捷键列表的逐视图穷举（只收用户可感知的局部键：Enter 系/搜索/终端复制粘贴/Esc，见 §8；各弹窗内 ↑/↓/Enter 选择属通用 UI 惯例不列）

## 6. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/renderer/src/store/app-store.ts` | `closedTabs` + `restoreClosedTab` + `ensureScopeFor`；`closeTab` pushClosed 选项；`closeChatTab` 入栈；`cycleTab(dir)`；`scopePreview` + begin/move/commit/cancelScopePreview + `scopeNavRows`/`currentScopeRow`/`activateScopeRow`（§3 修订，原 `cycleScopeEntry` 移除） |
| `src/renderer/src/components/shortcuts.ts` | 新：`useShortcuts()`（window keydown 分发表 + keyup/blur 预览-提交监听） |
| `src/renderer/src/components/tab-actions.ts` | 新：`closeTabInteractive` |
| `src/renderer/src/components/sidebar.tsx` | 光标行 `.scope-cursor` + `data-scope-cursor`（scrollIntoView 跟随） |
| `src/renderer/src/styles/app.css` | `.tree-row.scope-cursor`（§3 修订） |
| `src/main/browser-views.ts` / `src/shared/ipc.ts` / `src/preload/index.ts` | 转发扩展（2026-09-06）：keyDown 增裸 Alt、新增 Alt/Meta/Control keyUp（载荷 `up` 字段）、顶层失焦 `browser:window-blur` 补发 |
| `src/renderer/src/app.tsx` | Shell 挂 `useShortcuts()` |
| `src/renderer/src/components/workspace.tsx` | Tab 关闭按钮改经 tab-actions；§1.1 引导页磁贴快捷键 + 角标（GuidePage 内监听） |
| 测试 | store（关闭栈入/弹/跳过/跨作用域/上限、cycleTab 循环、scopePreview 预览-提交/环游/no-op/作废/虚拟边界）；shortcuts 按键分发表 + begin/commit/cancel + 转发 up；workspace-guide（§1.1 分发/禁用态/角标/卸载） |

## 7. 验收

- spec-v0.3 #2 验收行全过：Ctrl+T/W/Tab/Shift+Tab/PgUp/PgDn、Ctrl+Shift+T 依次恢复（chat 取消归档、已删会话跳过）、Alt+↑/↓（mac ⌘⌥↑/↓）预览-提交（按下显光标、↑/↓ 循环移动不切换、松开一次切到光标行；未移动/光标行消失 no-op；鼠标介入作废、点击切换不变）
- §1.1：引导页 Ctrl+1/2/3 开 diff/终端/网页 Tab（禁用态不动作）；Ctrl 按住三磁贴显数字角标、松开/失焦消失；离开引导页后按键无动作
- `npm run test` / `typecheck` / `build` 全绿

## 8. 设置页快捷键列表（2026-09-06）

> 可发现性补齐：快捷键体系已成型但无应用内入口，新用户无从得知。设置弹窗新增「快捷键」页签（现有四页签后追加）。移动端无硬件键盘（头部已述），无同类先例可参考。

- **数据源单一**：渲染数据 `SHORTCUT_GROUPS` 定义在 `shortcuts.ts`（与 `dispatch` 同文件维护，防表-码漂移）；行结构 `{ keys, macKeys?, action(i18n key), only?: "mac" | "non-mac" }`，" / " 分隔的等效键拆独立 chip
- **平台分支渲染**：`window.desktop.platform === "darwin"` 时显示 `macKeys`（缺省回退 `keys`）；`only` 行互斥——mac 切 Tab 惯例键（⌘⌥←/→、⌘⇧[/]）与非 mac Ctrl+Tab/PgUp/PgDn 系各只在本平台展示，与 §1 分发表绑定语义一致
- **范围**：全局组 = §1 表全量；「输入与视图」组收分发之外的局部键——Enter/Shift+Enter（聊天输入）、Ctrl+F（code-view，CodeMirror searchKeymap）、终端复制/粘贴（Linux Ctrl+Shift+C/V、mac ⌘C/⌘V，键位随平台展示）、Esc（关闭弹窗/菜单）
- 设置页签本地类型为 store `settingsInitialTab` 的超集（store 不加宽——无 shortcuts 直达调用方）
- 样式：`.sc-row`（动作左、键位 chip 右）+ `.sc-kbd`（mono chip），组间 gap 呼吸，token 全复用（DESIGN.md 无新增 token）
