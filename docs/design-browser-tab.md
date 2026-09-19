# 浏览器 Tab（WebContentsView）+ HTML 预览迁移 — 设计文档

> 对应 spec-v0.3 #6。main 进程 `WebContentsView` 内嵌浏览器（地址栏 + 前进/后退/刷新 + 打开本地文件），Tab 归作用域；**文件树点击 `.html/.htm` 默认在浏览器 Tab 打开（file:// URL）**，右键「查看源码」在文件 Tab 打开源码（FileView 的 iframe 预览分支废弃）。导航安全：远端页面禁跳 `file://`、外链走系统浏览器。
>
> 参考先例（AGENTS.md 约定先行检索）：`../openbuilder/docs/design-html-preview.md`（移动端 CSP 注入路线——桌面 WebContentsView 全能力渲染，不再需要 CSP 限制，但 iframe 预览方案在桌面被本设计**取代**）；`design-layout.md` Tab 表预研（browser = WebContentsView）。z-order 对策为本设计新增。

## 1. 架构

### 1.1 main 进程（WebContentsView 生命周期）

- `browser:view-create` → `new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })`，`mainWindow.contentView.addChildView(view)`，初始隐藏（bounds 0）。返回 viewId（自增）
- `browser:view-bounds(viewId, {x,y,w,h})` / `browser:view-show(viewId)` / `browser:view-hide(viewId)` / `browser:view-dispose(viewId)`（removeChildView + webContents.destroy）
- `browser:navigate(viewId, url)` / `browser:goBack/goForward/reload(viewId)`
- `shell:openExternal(url)`（**2026-09-08 增**，浏览器 Tab「在系统浏览器打开」按钮）：协议白名单 http/https/file（about: 交系统无意义拒收）；Linux/darwin 自管 spawn 净化 env（分支注记同 `shell:openPath`——dev 模式 NODE_ENV 泄漏事故，见 linux-open-with.ts 实证注释）、win32 `shell.openExternal`
- **事件推送** `browser:view-state`（viewId + {url, title, loading, canGoBack, canGoForward}）：`did-navigate`/`did-navigate-in-page`/`page-title-updated`/`did-start-loading`/`did-stop-loading` 聚合；**`did-fail-load`（主帧且非 ERR_ABORTED，2026-09-15 增）回填 `url = validatedURL`**——失败时 `did-navigate` 不发，agg.url 恒 ""，不回填则 renderer 侧 Tab 卡 untitled、地址栏空白且持久层丢 url（重启恢复场景实测，见 design-tab-session-restore §7 review 三轮）；失败页由 Chromium 自渲染，状态层只补目标地址
- **导航安全**（view 的 webContents）：
  - `will-navigate`：当前页面是 http(s) 且目标是 `file://` → preventDefault（远端页面禁读本地文件；file→file 本地页面互链放行，http(s) 链接放行）
  - `setWindowOpenHandler`：http(s) 外链 → `shell.openExternal` + deny（同主窗口既有策略）；其余 deny
  - `webContents.setWindowOpenHandler` 在 view 创建时挂
- 窗口关闭（mainWindow closed）→ 全部 view dispose
- **bounds 坐标系**：view bounds 相对 contentView（= 窗口内容区），renderer 的 getBoundingClientRect 同坐标系（frameless 下 renderer 铺满窗口）——DIP 一致，E2E 实测校准

### 1.2 z-order 对策（原生视图恒在 DOM 之上）

- renderer 任何"覆盖全局的浮层"（设置弹窗 / 右键菜单 / 模型选择浮层 / @ 引用浮层等 portal 到 body 的 fixed 层）会被 browser view 挡住
- **对策**：store `overlayCount`（设置弹窗 openSettings/closeSettings、文件树右键菜单挂/卸、**面板拖拽调宽起止**时 +1/-1）；Workspace 布局 effect 监听：`overlayCount > 0` → 隐藏全部 browser view；= 0 → 恢复激活 Tab 的 view。终态保守：宁闪不挡
- **欢迎页态隐藏（2026-09-18 增）**：激活浏览器 Tab 停留 about:blank（新开未导航/恢复空白，`isBrowserWelcome`）时原生视图同样隐藏——内容区是 DOM 欢迎页而非 web 内容（§1.3）；显隐协调的额外触发源 = `applyBrowserState` 的 url 变化（欢迎 ↔ 内容边界翻转；loading 等瞬态不触发——既有 Workspace effect 依赖 activeTabKey/overlayCount，不含 url，须在状态入口补挂）
- 拖拽调宽期间经 overlay 计数隐藏（原生视图不受 CSS `:root.resizing` 影响——拖拽路径上的 pointer 事件会被 webContents 吞掉中断拖拽）
- **页面聚焦后的快捷键**：原生 webContents 抢走键盘焦点，renderer 的 window keydown 不可达——view 的 `before-input-event` 把 Ctrl 系按键经主窗口转发（`onBrowserShortcut`），shortcuts hook 订阅后走与 window keydown **同一分发函数**（转发全部 Ctrl 系 keyDown + 裸 Alt / Alt+↑/↓ keyDown 与 Alt/Meta/Control keyUp——作用域遍历预览-提交所需，shortcuts §3 修订 2026-09-06，载荷 `up` 字段区分；顶层窗口失焦经 `browser:window-blur` 补发作废预览——视图持焦时 renderer 的 window 已 blur 态、无 DOM blur 可听；renderer 未映射组合不消费即无动作——页面自身快捷键不受影响）；**Ctrl/⌘+W 例外吞键（2026-09-19 增）**：转发"无 preventDefault 语义"对 Ctrl+W 是漏洞——页面不消费的键回流 Chromium `HandleKeyboardEvent` 命中 Electron 默认菜单 Window>Close 的 `CommandOrControl+W` 加速键（实测 Electron 43 Linux，autoHideMenuBar 不摘除默认菜单），视图持焦时 Ctrl+W 伴随整窗关闭（本地 file:// 页面实测复现；主窗口 renderer 聚焦时由 shortcuts.ts window keydown 的 preventDefault 拦住，视图持焦该路径不可达）。修复：before-input-event 对命中组合 `preventDefault` 切断加速键路径、转发照旧驱动关 Tab——判定抽 `src/main/tab-close-shortcut.ts` 纯函数，按 code `KeyW` 匹配（布局无关，KeyB 先例）+ key 字面双保险（非拉丁布局 key 非 "w"、dispatch 不识别时加速键仍按物理键位触发，必须吞）；Shift/Alt 组合不吞（Ctrl+Shift+W 非应用映射，默认菜单亦无对应加速键）；浏览器/PDF 视图同路径（PDF 文件 Tab 经同一 `browser:view-create` 创建，一并覆盖）。其余未映射组合仍不吞——页面快捷键（Ctrl+S 等）与默认菜单浏览器惯例加速键（Ctrl+R 刷新 / Ctrl+0 缩放 / Ctrl+A 全选）不受影响

### 1.3 renderer

- `TabKind` 扩 `"browser"`；key = `browser:<初始 URL>`（稳定标识；导航后 URL 变化不改 key，Tab 条标题取当前页 title）；**新开空白 Tab 例外（2026-09-15 修订）**：引导页磁贴 / Ctrl+3 走 `openNewBrowserTab()`，键 = `browser:new:<N>`（序号唯一、每次调用新开，**不按 URL 去重**——原入口恒 `browser:about:blank`，开过一次后再按磁贴/快捷键只会切回旧 Tab，无法开第二个网页 Tab）；url 态 = about:blank，持久化时 url 恒 ≠ 键内标识 → `url` 字段必落盘（含僵尸兜底：双行目录关一行残留的 view 已 dispose Tab，派生回落 url:about:blank；恢复遇 url 缺失的 new:N 条目同样回落，不导航键内字面量），重启按它恢复；重启后序号归零重计，撞恢复条目即跳号（循环校验唯一）。"打开指定地址"入口（文件树 .html、关闭栈按 URL 重开）仍用 `openBrowserTab(url)` 的 URL 键去重语义
- `store.openBrowserTab(url)`：建 Tab（directory = 当前作用域）+ `browser:view-create` + `navigate`；**浏览器 shim（无 IPC）不可用**：入口隐藏（platform === "browser" 时引导页网页按钮 disabled、file 树 .html 点击回退文件 Tab）
- `BrowserTabView` 组件（激活时挂载）：工具条（后退/前进/刷新或停止、地址输入框（Enter 导航、**无 scheme 输入分流补全（2026-09-19 增）**——裸点分域名（末段字母 TLD，label 允许 Unicode 字母/数字即 IDN 如 `中文.com`（punycode 转换由 Chromium GURL 承担），可带端口与 `/?#` 尾部，如 `www.google.com`、`example.com:8080/x?q=1`）补 `https://`；`localhost` 与 IP 字面量（IPv4 / `[IPv6]`，可带端口）补 `http://`（本地服务无 TLS，https 必败）——两者对齐 Chromium omnibox 默认；显式 scheme（http/https/file/about 等）原样；其余维持字面 file 路径补 scheme（相对路径 `repo/x.html` 首段无点不命中域名形态）。原 §2「不做地址栏自动补全」据此收窄为不做搜索联动、**仅新开 Tab 时聚焦并全选**——2026-09-18 修订，原 2026-09-15「切入 Tab 挂载即聚焦」使切回既有 Tab 也抢焦点：组件按 key 隔离重挂载，挂载与切入无法区分，改由 store 传递意图——`doOpenBrowserTab` **新建路径**登记待聚焦标记（`browserOpenFocusKey` 单槽，连开后开覆写先开——Ctrl+3 连按只留最后一个），组件挂载一次性消费（`consumeBrowserOpenFocus`），复用既有 Tab（openBrowserTab 既有键分支）与重启恢复路径不登记 = 不聚焦；**作废闸门**（review 2026-09-18）：新开后激活被顶替（连开/作用域切换/点 Tab 等）而组件未及挂载时，残留标记会让首次切入误抢焦点——Workspace 激活变化 effect 调 `invalidateBrowserOpenFocusUnless(activeTabKey)`，激活移出待聚焦 Tab 即作废（任何激活路径最终都经 emit → 该 effect；正常新开流中子组件挂载先消费，闸门空转）；聚焦后全选，输入即整替 URL（Ctrl+L 惯例））、打开本地文件按钮 → `openPathPicker` 选 .html → `navigate(file://…)`、**「在系统浏览器打开」按钮（2026-09-08 增，`shell:openExternal` 当前页 URL——store 权威非 key 初始 URL；仅 http/https/file 可用（白名单同 main 侧 handler，about: 等禁用）；纯浏览器 shim 不显示）**）+ 内容宿主 div；ResizeObserver → `view-bounds`；**卸载 = 隐藏 view**（Tab 切走/作用域切换，view 与内容保留）
- view 状态：store `browserStates: Map<viewId, BrowserState>`（SSE 无关，纯 IPC 事件驱动）；**空 url 推送不回退已知 url/title（2026-09-15 修订）**——agg.url 只由 did-navigate/did-fail-load 落值，首次导航在途/失败后恒 ""，整包覆写会清掉恢复/打开时种入的 url（地址栏闪空、标题闪落 untitled、会话派生抹掉磁盘 url 字段），`applyBrowserState` 对空 url 推送保留上一份非空值
- **欢迎页（2026-09-18 增）**：新开空白 Tab（磁贴/Ctrl+3）、恢复 url 回落空白的条目、关闭栈重开空白，**不再加载 about:blank**（`doOpenBrowserTab`/`restoreBrowserTab` 对 about:blank 跳过 navigate——webContents 本就空白）；`isBrowserWelcome(key)`（url === about:blank）时原生视图隐藏（§1.2），内容宿主内渲染 DOM 欢迎页（Globe 图标 + 本地化标题「新标签页」+ 提示 + 「打开本地文件…」按钮，与工具条同 `openLocalFile` 路径；样式对齐 .workspace-empty 语言）。地址栏展示归一：欢迎态显示空（placeholder 引导）而非字面 about:blank（种子/回写/失焦还原/Esc 还原统一走 `addressOf`）；Enter 导航**乐观展示**所输 URL（2026-09-18 review 增——blur 还原的是 store 当前页，欢迎态为空、常规态为旧页，在途期间闪空/回旧页读作"输入被丢弃"；did-navigate/失败回填到达后回写接管为规范 URL）；导航（did-navigate/失败回填）即离开欢迎态，后退回 about:blank 重新进入。标签条标题展示层映射为本地化「新标签页」——store title 仍为 about:blank（持久化/关闭栈机器依赖它，仅展示层映射）。Ctrl+F 等页面内搜索维持现状（空页面 0 匹配，无欢迎态特判）
- 关闭 Tab：`view-dispose` + 关闭栈（恢复 = 按 key 中 URL 重开——URL 取**当前页 URL**（关 Tab 时的 browserState.url），不是初始 key）

### 1.4 HTML 预览迁移

- `FilePanel` 点击 `.html/.htm` → `openBrowserTab(file://<absolute>)`（Electron 内）；shim 回退 `openFileTab`
- 文件树右键菜单加「查看源码」项（仅 .html/.htm 文件行）→ `openFileTab(absolute)`；FileView 的 html 分支删 iframe 预览（`isHtmlPath` 预览态不再命中——**html 文件在 FileView 恒源码态**），`html-preview.ts` CSP 扫描器与用例删除；`will-frame-navigate` 拦截保留（防御，browser view 是独立 webContents 不经此 handler）
- design-html-preview.md 标注废弃指向本文档

### 1.5 最近访问（2026-09-19）

- **语义**：每作用域（profileKey → directory，跟项目/目录走）维护 MRU URL 列表，**上限 5**，重复 URL 去重置顶；持久化 `"browser.recents"`（逐切片校验：坏切片丢弃、URL 过滤非串、截断 5）
- **每 Tab 只记打开后首个地址**——防单次浏览（页内链接连续跳转）刷屏。三源汇聚 `recordBrowserVisit(tabKey, url)`：
  1. `doOpenBrowserTab` 初始导航（文件树 .html 点击、关闭栈按 URL 重开）——即该 Tab 首地址
  2. 地址栏 Enter（`BrowserTabView.navigate`）——欢迎页 Tab（新开空白）的首个导航在此记录
  3. 打开本地文件（`openLocalFile`）——同上
  页内链接/后退/后续地址栏输入不经过 renderer 导航分发或标记已消费，天然不入列；Tab 内首个地址消费标记（`browserVisitRecorded`）**随任何关闭路径清除**（closeTab 兜底卸载路径——关项目/删工作树/死会话收敛等；review 2026-09-19：URL 键复用，残留标记会吞掉重开 Tab 的首地址记录；teardown 全清——tabs 已清而键跨 profile 复用）。欢迎页 Tab（新开/恢复空白）标记留空——首个导航记录
- **恢复不重排**：`restoreBrowserTab` 恢复真实 URL 时直接置已记录标记（上个会话已记过首地址），不调 record——重启恢复全部 Tab 不打乱既有 MRU 顺序；恢复空白（new:N 回落）留待首个导航记录
- **复用语义**：`openBrowserTab` 复用既有 Tab（URL 键去重）= 切换语义不记录；关闭后重开 = 新 Tab 首地址（置顶去重）
- **切片修剪**（review 2026-09-19）：目录卸载（关项目/关 global 目录/删工作树）时删除该目录切片——**重开 = 首开语义，同 tabs.memory 取舍**，防已死目录在 store.json 无限累积；双行目录对侧 entry 仍打开则保留（recents 无 projectId 字段，以"已打开 entry 认领查询"替代 memory 的归属守卫）
- **展示**：欢迎页（§1.3）下方「最近访问」列表（空列表不渲染）；file 条目显示解码 basename、web 显示 host（根路径省略 pathname），title 悬浮完整 URL；点击在**当前 Tab** 导航（经 `navigate`——欢迎页 Tab 的首地址记录同路）
- **不做**：完整历史（时间戳/访问次数/标题）、手动清除、跨目录聚合、菜单栏入口（Keep Lean——欢迎页即入口）

## 2. 不做的事

- 书签/完整历史/下载、缩放、devtools 入口、多窗口（轻量「最近访问」除外，见 §1.5——MRU ≤5、每 Tab 只记首地址，非完整历史）
- browser Tab 参与作用域 Tab 记忆（非 chat，同 file/diff 取舍；重启不恢复）
- file:// 页面的 CSP/沙箱强化（WebContentsView 默认安全配置；本地页面视为可信内容——与"打开本地文件"功能定位一致）
- 地址栏搜索联动/引擎猜测（2026-09-19 收窄：裸域名/localhost/IP 的 scheme 补全**已做**，规则见 §1.3；搜索引擎兜底不做，非法输入按字面 file 路径处理）

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/main/browser-views.ts` | 新：WebContentsView 注册表 + IPC handlers + 事件推送 + 导航安全 |
| `src/main/index.ts` | 注册 browser IPC；窗口关闭清理 |
| `src/main/ipc.ts` | `shell:openExternal` handler（2026-09-08 增，平台分支同 `shell:openPath`） |
| `src/shared/ipc.ts` | DesktopApi 扩 browser:* 方法与 BrowserState 类型 |
| `src/preload/index.ts` | 暴露通道 |
| `src/renderer/src/browser-shim.ts` | browser:* 不可用桩（unsupported） |
| `src/renderer/src/store/app-store.ts` | TabKind 扩 browser；openBrowserTab/closeBrowserTab/browserStates/overlayCount；restoreClosedTab browser 分支 |
| `src/renderer/src/components/browser-tab-view.tsx` | 新：工具条 + 宿主 + ResizeObserver + 激活/隐藏协调 |
| `src/renderer/src/components/workspace.tsx` | Tab 分发 browser 分支；引导页网页入口解禁；overlayCount 挂点（settings） |
| `src/renderer/src/components/file-panel.tsx` | .html 点击路由 + 右键「查看源码」 |
| `src/renderer/src/components/file-view.tsx`（含 workspace 内 FileView） | html 预览分支移除 |
| 删除 | `src/renderer/src/components/html-preview.ts` + `html-preview.test.ts` |
| `src/renderer/src/i18n/index.ts` | browserBack/Forward/Reload/Stop/Address/OpenFile/OpenExternal/ViewSource 等 |
| 测试 | store（openBrowserTab/关闭栈含未导航/并发重入/dispose/shim 回退）；browser-tab-view 组件（工具条/地址导航/文件选择器）；file-panel .html 路由与查看源码；shortcuts 转发用例。main 侧为薄 IPC 装配层（视图/事件表驱动），逻辑收敛 renderer，不另立 node 单测 |

## 4. 验收（对齐 spec #6）

- 点击 .html 开浏览器 Tab 渲染正确（本地相对资源加载）；右键「查看源码」在文件 Tab 打开源码
- 地址栏导航/前进/后退/刷新/打开本地文件可用；Tab 切走隐藏（内容保留）切回恢复
- 「在系统浏览器打开」按钮：当前页（导航后随动）交系统默认浏览器打开；纯浏览器 shim 不显示该按钮
- 远端页面（http 页内链接 file://）被拦；window.open 走系统浏览器
- 设置弹窗/右键菜单打开时浏览器视图隐藏，关闭恢复
- 浏览器 shim（纯浏览器 dev）入口隐藏/回退；`npm run test`/`typecheck`/`build` 全绿
- 打包形态 CDP 实测（Wayland 真窗口）：bounds 对齐、缩放、HTML 文件渲染
