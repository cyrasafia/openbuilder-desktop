# 快捷键体系 — 设计文档

> 对应 spec-v0.3 #2。Tab 新建/关闭/切换、关闭栈恢复（Ctrl+Shift+T）、左栏作用域遍历（Ctrl+Alt+↑/↓）。纯 renderer 改动。
>
> 参考先例：按 AGENTS.md 约定检索 `../openbuilder/docs/design-*.md`——移动端无硬件键盘快捷键体系（TUI 无从借鉴），无同类设计。

## 1. 快捷键表

| 键 | 动作 |
|---|---|
| Ctrl+T | 新建 Tab = `showGuidePage()`（与 Tab 栏 "+" 同路径） |
| Ctrl+O | 打开项目选择器（与左栏 "+" 同路径 = `openProjectPicker()`；picker 开着时重复按下仅消费不动作，防 overlay 计数失衡） |
| Ctrl+W | 关闭激活 Tab；**无激活 Tab 时仅消费不动作**（放行会命中默认菜单关窗，见 §1 修订）；chat Tab 流式中先 confirm（复用 `confirmCloseStreamingTab`），确认后 abort+归档——与 Tab 栏关闭按钮**同一代码路径**（§4 tab-actions） |
| Ctrl+Shift+T | 恢复刚关闭的 Tab（§2 关闭栈） |
| Ctrl+Tab / Ctrl+PageDown | 下一个可见 Tab（作用域内循环；Shift 反转方向） |
| Ctrl+Shift+Tab / Ctrl+PageUp | 上一个可见 Tab（循环；Shift+PgUp/PgDn 同样反转） |
| Ctrl+Alt+↓ / Ctrl+Alt+↑ | 左栏项目/工作区行按显示顺序向下/上切换作用域（§3，循环） |
| Ctrl+[ | 收起/展开**左栏**（翻转，与标题栏开关同路径 `toggleLeftPanel()`） |
| Ctrl+] | 收起/展开**右栏**（翻转，`toggleRightPanel()`） |

- 注册：Shell 内 `useShortcuts()`，window keydown（bubble）；`e.isComposing` 守卫（fcitx5）；已 preventDefault 的事件不再处理
- **无激活 Tab 的 Ctrl+W 也消费**（2026-08-29 修订，推翻原"无加速键冲突"断言）：Electron 默认菜单并未因 autoHideMenuBar 消失，其 role:close 的 Ctrl+W 加速键对 **renderer 未消费**的按键生效（Chromium 对 renderer 未处理的键回调 `HandleKeyboardEvent` 触发加速键）——实测无 Tab 时 Ctrl+W 直接把窗口关掉。故 dispatch 对无激活 Tab 的 Ctrl+W 返回"已消费"（preventDefault、不动作）；其余未映射组合仍放行。Ctrl+数字跳转不做（用户决策，系统/输入法易冲突）
- 修饰键判定以 ctrlKey 为准（macOS 开发态 Cmd 亦生效——metaKey 等价 Ctrl，成本零）；Ctrl+Alt+↑/↓ 与 AltGr 的组合风险仅限"AltGr+方向键产生字符"的场景，不存在（方向键非字符键）
- **Ctrl+[ / Ctrl+] 冲突核查结论**（2026-09-03，实现前核查）：Electron 默认菜单加速键无 `[`/`]`（无 Ctrl+W 式放行风险）；Chromium 在 Linux/Win 无绑定（macOS 的 Cmd+[ /] = 后退/前进，metaKey 视同 Ctrl 下 BrowserView 内会双触发——仅 macOS 开发态，主环境 Linux 无影响）；**终端 Tab 聚焦时 xterm 在 textarea capture 监听器内 `cancel(e, force)` → preventDefault+stopPropagation 抢先消费**（Ctrl+[=ESC 字节 0x1b、Ctrl+]=0x1d 归 pty），事件到不了 window 分发——快捷键在终端内不生效，与 Ctrl+T/W 同行为，属预期而非缺陷，且保住了 vim 用户的 Ctrl+[=Esc；code-view 只装 searchKeymap 无 defaultKeymap（Mod-[ /] 缩进绑定不存在），将来上可编辑编辑器时 CM preventDefault 在先、窗口层跳过 defaultPrevented，自然共存。匹配要求裸 Ctrl（Shift/Alt 组合放行）——AltGr 在部分欧陆布局产生 `[` 时会上报 ctrl+alt，排除 alt 防误触

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

## 3. Ctrl+Alt+↑/↓ 作用域遍历

- 平铺序列 = 左栏显示顺序：每个 `openedEntries` 行 +（普通项目）其 `workspacesOfProject` 行
- 当前位置：worktree 激活命中工作区行（projectId + directory 双匹配），否则命中激活 entry 行；序列空则 no-op
- ±1 循环；激活复用侧栏点击语义：entry → `openEntry`；工作区行 → 当前项目 `setCurrentWorkspace`，跨项目 `setCurrentProject`

## 4. 用户关闭路径的收敛（tab-actions）

`closeTabInteractive(store, tab, t)`（新模块 `src/renderer/src/components/tab-actions.ts`）：chat 流式确认 + abort + 归档；非 chat 直接 `closeTab(key, { pushClosed: true })`。Tab 栏关闭按钮与 Ctrl+W 共用，语义单一来源（原 Tab 栏内联逻辑迁出）。

## 5. 不做的事

- Ctrl+数字跳转、Ctrl+B（用户决策不做）
- MRU 切换顺序（Ctrl+Tab 用线性循环；浏览器 MRU 依赖"最近使用"栈，复杂度不值）
- 快捷键自定义/冲突检测 UI
- 关闭栈持久化

## 6. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/renderer/src/store/app-store.ts` | `closedTabs` + `restoreClosedTab` + `ensureScopeFor`；`closeTab` pushClosed 选项；`closeChatTab` 入栈；`cycleTab(dir)`；`cycleScopeEntry(dir)` + `scopeNavRows` |
| `src/renderer/src/components/shortcuts.ts` | 新：`useShortcuts()`（window keydown 分发表） |
| `src/renderer/src/components/tab-actions.ts` | 新：`closeTabInteractive` |
| `src/renderer/src/app.tsx` | Shell 挂 `useShortcuts()` |
| `src/renderer/src/components/workspace.tsx` | Tab 关闭按钮改经 tab-actions |
| 测试 | store（关闭栈入/弹/跳过/跨作用域/上限、cycleTab 循环、cycleScopeEntry 遍历）；shortcuts 按键分发表 |

## 7. 验收

- spec-v0.3 #2 验收行全过：Ctrl+T/W/Tab/Shift+Tab/PgUp/PgDn、Ctrl+Shift+T 依次恢复（chat 取消归档、已删会话跳过）、Ctrl+Alt+↑/↓ 循环切换
- `npm run test` / `typecheck` / `build` 全绿
