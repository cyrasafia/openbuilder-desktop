# 浏览器 Tab（WebContentsView）+ HTML 预览迁移 — 设计文档

> 对应 spec-v0.3 #6。main 进程 `WebContentsView` 内嵌浏览器（地址栏 + 前进/后退/刷新 + 打开本地文件），Tab 归作用域；**文件树点击 `.html/.htm` 默认在浏览器 Tab 打开（file:// URL）**，右键「查看源码」在文件 Tab 打开源码（FileView 的 iframe 预览分支废弃）。导航安全：远端页面禁跳 `file://`、外链走系统浏览器。
>
> 参考先例（AGENTS.md 约定先行检索）：`../openbuilder/docs/design-html-preview.md`（移动端 CSP 注入路线——桌面 WebContentsView 全能力渲染，不再需要 CSP 限制，但 iframe 预览方案在桌面被本设计**取代**）；`design-layout.md` Tab 表预研（browser = WebContentsView）。z-order 对策为本设计新增。

## 1. 架构

### 1.1 main 进程（WebContentsView 生命周期）

- `browser:view-create` → `new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })`，`mainWindow.contentView.addChildView(view)`，初始隐藏（bounds 0）。返回 viewId（自增）
- `browser:view-bounds(viewId, {x,y,w,h})` / `browser:view-show(viewId)` / `browser:view-hide(viewId)` / `browser:view-dispose(viewId)`（removeChildView + webContents.destroy）
- `browser:navigate(viewId, url)` / `browser:goBack/goForward/reload(viewId)`
- **事件推送** `browser:view-state`（viewId + {url, title, loading, canGoBack, canGoForward}）：`did-navigate`/`did-navigate-in-page`/`page-title-updated`/`did-start-loading`/`did-stop-loading` 聚合
- **导航安全**（view 的 webContents）：
  - `will-navigate`：当前页面是 http(s) 且目标是 `file://` → preventDefault（远端页面禁读本地文件；file→file 本地页面互链放行，http(s) 链接放行）
  - `setWindowOpenHandler`：http(s) 外链 → `shell.openExternal` + deny（同主窗口既有策略）；其余 deny
  - `webContents.setWindowOpenHandler` 在 view 创建时挂
- 窗口关闭（mainWindow closed）→ 全部 view dispose
- **bounds 坐标系**：view bounds 相对 contentView（= 窗口内容区），renderer 的 getBoundingClientRect 同坐标系（frameless 下 renderer 铺满窗口）——DIP 一致，E2E 实测校准

### 1.2 z-order 对策（原生视图恒在 DOM 之上）

- renderer 任何"覆盖全局的浮层"（设置弹窗 / 右键菜单 / 模型选择浮层 / @ 引用浮层等 portal 到 body 的 fixed 层）会被 browser view 挡住
- **对策**：store `overlayCount`（设置弹窗 openSettings/closeSettings、文件树右键菜单挂/卸、**面板拖拽调宽起止**时 +1/-1）；Workspace 布局 effect 监听：`overlayCount > 0` → 隐藏全部 browser view；= 0 → 恢复激活 Tab 的 view。终态保守：宁闪不挡
- 拖拽调宽期间经 overlay 计数隐藏（原生视图不受 CSS `:root.resizing` 影响——拖拽路径上的 pointer 事件会被 webContents 吞掉中断拖拽）
- **页面聚焦后的快捷键**：原生 webContents 抢走键盘焦点，renderer 的 window keydown 不可达——view 的 `before-input-event` 把 Ctrl 系按键经主窗口转发（`onBrowserShortcut`），shortcuts hook 订阅后走与 window keydown **同一分发函数**（转发全部 Ctrl 系 keyDown，renderer 未映射组合不消费即无动作——页面自身快捷键不受影响）

### 1.3 renderer

- `TabKind` 扩 `"browser"`；key = `browser:<初始 URL>`（稳定标识；导航后 URL 变化不改 key，Tab 条标题取当前页 title）
- `store.openBrowserTab(url)`：建 Tab（directory = 当前作用域）+ `browser:view-create` + `navigate`；**浏览器 shim（无 IPC）不可用**：入口隐藏（platform === "browser" 时引导页网页按钮 disabled、file 树 .html 点击回退文件 Tab）
- `BrowserTabView` 组件（激活时挂载）：工具条（后退/前进/刷新或停止、地址输入框（Enter 导航）、打开本地文件按钮 → `openPathPicker` 选 .html → `navigate(file://…)`）+ 内容宿主 div；ResizeObserver → `view-bounds`；**卸载 = 隐藏 view**（Tab 切走/作用域切换，view 与内容保留）
- view 状态：store `browserStates: Map<viewId, BrowserState>`（SSE 无关，纯 IPC 事件驱动）
- 关闭 Tab：`view-dispose` + 关闭栈（恢复 = 按 key 中 URL 重开——URL 取**当前页 URL**（关 Tab 时的 browserState.url），不是初始 key）

### 1.4 HTML 预览迁移

- `FilePanel` 点击 `.html/.htm` → `openBrowserTab(file://<absolute>)`（Electron 内）；shim 回退 `openFileTab`
- 文件树右键菜单加「查看源码」项（仅 .html/.htm 文件行）→ `openFileTab(absolute)`；FileView 的 html 分支删 iframe 预览（`isHtmlPath` 预览态不再命中——**html 文件在 FileView 恒源码态**），`html-preview.ts` CSP 扫描器与用例删除；`will-frame-navigate` 拦截保留（防御，browser view 是独立 webContents 不经此 handler）
- design-html-preview.md 标注废弃指向本文档

## 2. 不做的事

- 书签/历史/下载、缩放、devtools 入口、多窗口
- browser Tab 参与作用域 Tab 记忆（非 chat，同 file/diff 取舍；重启不恢复）
- file:// 页面的 CSP/沙箱强化（WebContentsView 默认安全配置；本地页面视为可信内容——与"打开本地文件"功能定位一致）
- 地址栏自动补全/搜索联动（输入 URL/字面路径直接导航，非法输入 no-op）

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/main/browser-views.ts` | 新：WebContentsView 注册表 + IPC handlers + 事件推送 + 导航安全 |
| `src/main/index.ts` | 注册 browser IPC；窗口关闭清理 |
| `src/shared/ipc.ts` | DesktopApi 扩 browser:* 方法与 BrowserState 类型 |
| `src/preload/index.ts` | 暴露通道 |
| `src/renderer/src/browser-shim.ts` | browser:* 不可用桩（unsupported） |
| `src/renderer/src/store/app-store.ts` | TabKind 扩 browser；openBrowserTab/closeBrowserTab/browserStates/overlayCount；restoreClosedTab browser 分支 |
| `src/renderer/src/components/browser-tab-view.tsx` | 新：工具条 + 宿主 + ResizeObserver + 激活/隐藏协调 |
| `src/renderer/src/components/workspace.tsx` | Tab 分发 browser 分支；引导页网页入口解禁；overlayCount 挂点（settings） |
| `src/renderer/src/components/file-panel.tsx` | .html 点击路由 + 右键「查看源码」 |
| `src/renderer/src/components/file-view.tsx`（含 workspace 内 FileView） | html 预览分支移除 |
| 删除 | `src/renderer/src/components/html-preview.ts` + `html-preview.test.ts` |
| `src/renderer/src/i18n/index.ts` | browserBack/Forward/Reload/Stop/Address/OpenFile/ViewSource 等 |
| 测试 | store（openBrowserTab/关闭栈含未导航/并发重入/dispose/shim 回退）；browser-tab-view 组件（工具条/地址导航/文件选择器）；file-panel .html 路由与查看源码；shortcuts 转发用例。main 侧为薄 IPC 装配层（视图/事件表驱动），逻辑收敛 renderer，不另立 node 单测 |

## 4. 验收（对齐 spec #6）

- 点击 .html 开浏览器 Tab 渲染正确（本地相对资源加载）；右键「查看源码」在文件 Tab 打开源码
- 地址栏导航/前进/后退/刷新/打开本地文件可用；Tab 切走隐藏（内容保留）切回恢复
- 远端页面（http 页内链接 file://）被拦；window.open 走系统浏览器
- 设置弹窗/右键菜单打开时浏览器视图隐藏，关闭恢复
- 浏览器 shim（纯浏览器 dev）入口隐藏/回退；`npm run test`/`typecheck`/`build` 全绿
- 打包形态 CDP 实测（Wayland 真窗口）：bounds 对齐、缩放、HTML 文件渲染
