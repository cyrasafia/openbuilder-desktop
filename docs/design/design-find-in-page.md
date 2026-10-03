# 页面内搜索（markdown 预览 / 浏览器 Tab / PDF）— 设计文档

> 目标：三个「渲染内容不在 renderer DOM」或「无既有搜索」的预览视图补齐页面内搜索——markdown 文件预览态、浏览器 Tab、PDF 文件 Tab。Ctrl+F（mac ⌘F）唤起自建查找条，Esc 关闭；三视图同一套 UI 与交互语义。
>
> 参考先例（AGENTS.md 约定先行检索）：`../openbuilder` 全量 docs 检索无页面内搜索先例（移动端 markdown 走 webview、PDF 走系统打开，均无内嵌查找——本设计为桌面端新设计）；本仓库既有基建全部复用——代码视图 CodeMirror search（Ctrl+F 惯例键与 `scFileSearch` 文案）、浏览器 Tab 的 browser-view IPC 通道与 z-order/浮层对策（design-browser-tab）、PDF 专用 WebContentsView（design-pdf-preview）、文件操作条统一骨架（design-file-view-actions）。

## 1. 问题

- **代码视图有搜索（CM searchKeymap），markdown 预览态没有**：同为文件 Tab，`.md` 预览态 Ctrl+F 无动作（内容渲染在 DOM 但无搜索组件）；源码态可用 CM 搜索——同文件两态行为割裂；
- **浏览器 Tab / PDF Tab 内容在 main 进程原生视图**（WebContentsView），renderer DOM 完全不可见、不可扫——Electron 有原生 `webContents.findInPage` 但未接；PDF 自带的 PDFium 工具条在 PDFium 扩展查看器内，无应用内查找条。

## 2. 设计

### 2.1 统一查找条（自建，三视图共用）

- **UI 形态**：视图底部一条横向 bar（2026-09-09 修订统一居底，原「视图顶部/工具条下方」——与代码视图 CM 搜索面板同位同 idiom，四视图查找条视觉一致）：输入框（自动聚焦/全选，与 CM 面板搜索框等宽 220px）+ 匹配计数 `n/m` + 文案钮「下一个/上一个」（与 CM 搜索面板同文案同序——next 在前 prev 在后，文案精简为一般习惯用语，原 ▲▼ 图标钮同日弃用）+ 关闭 × ghost 方钮（右推条尾、无边框透明底 18×18 对齐 Tab 关闭钮，同 CM close）。无 replace（三视图均只读，无替换语义）。
- **交互语义**（三视图统一）：
  - Ctrl+F（mac ⌘F）唤起并聚焦输入框；已开时重新聚焦（不重复渲染）；
  - 输入即搜：markdown 侧防抖 150ms（DOM 扫描成本自担）；浏览器/PDF 侧逐键发起（`findInPage` 增量更新、Chromium 侧自持节流，无防抖）；Enter = 下一个、Shift+Enter = 上一个；
  - Esc 关闭并清除高亮；关闭钮同；
  - 计数文案无匹配时输入框描红（`--error` 边），有匹配恢复；
  - 空输入 = 无动作（不发起搜索、计数占位）。
- **组件落点**：新组件 `find-bar.tsx`（`FindBar`）——纯展示 + 回调驱动，不持有匹配状态本身（各视图自带匹配模型，见 §2.4/§2.5）；三视图复用同一组件，样式 `.find-bar` 全套在 app.css。
- **快捷键语义**：FindBar 输入框是 renderer DOM，`window` keydown 可达——Ctrl+F 全局分发新增分支：激活 Tab 已注册唤起回调即消费唤起，无注册回调 = 放行（消息流/终端/引导页无页面内搜索语义，维持放行）。**2026-09-09 修订：markdown 源码态与代码文件亦注册**——CM 未聚焦正文时 Ctrl+F 经回调 `openSearchPanel` 唤起 CM 搜索面板（原须先点击正文；CM 已聚焦时事件先被 searchKeymap 消费、到不了分发，两路互不干扰）。**浏览器/PDF Tab 原生视图持焦时**经既有 `before-input-event` 转发（browser-views.ts 已转发全部 Ctrl 系 keyDown）走同一分发——无新增转发面。

### 2.2 浏览器 Tab / PDF：`webContents.findInPage`

原生能力（Electron `webContents.findInPage(text, {forward, findNext, matchCase})` → `found-in-page` 事件 `{activeMatchOrdinal, matches, finalUpdate}`；`stopFindInPage("clearSelection")` 清除）：

- **IPC 扩展**（browser-views.ts，通道随既有 browser:* 家族）：
  - `browser:find-start(viewId, text, opts:{forward, findNext})` → `findInPage`；
  - `browser:find-stop(viewId)` → `stopFindInPage("clearSelection")`；
  - `found-in-page` 聚合推送 `browser:find-state(viewId, {requestId, active, matches, final})`——**只透传 `finalUpdate: true` 的末帧**（findInPage 对同一 query 会发多帧增量，直接透传会闪计数；末帧语义即最终 active/matches）。
- **会话状态机**（renderer 侧，BrowserTabView/PdfFrameView 共用逻辑，落在 `find-bar.ts` 同文件的 `useWebContentsFind(viewId)` hook）：
  - 输入变化 = 新 query：`findInPage(text, {findNext: false, forward: true})`；
  - Enter/下一处 = `{findNext: true, forward: true}`；Shift+Enter/上一处 = `{findNext: true, forward: false}`；
  - 清空文本/Esc/关闭 = `find-stop`；
  - **请求 id 守卫**：`found-in-page` 的 `requestId` 与最近一次 `findInPage` 返回值比对——旧请求迟到帧丢弃（快速改词时旧 query 的帧混入会错计数）；
  - **焦点收回**（review 二轮 #1 提出、三轮修正时机）：浏览器/PDF 视图持焦时 Ctrl+F 经转发唤起查找条，但 renderer 的 `element.focus()` 不与持焦的原生兄弟视图竞争键盘焦点（Electron 已知坑——跨 webContents 焦点转移须从 main 侧收回）——**收回挂在唤起时**（`useWebContentsFind.openFind` → `browser:focus-main` 通道 → `mainWindow.webContents.focus()`）：挂在 find-start 时机是循环依赖（焦点不回主窗口则键入落进页面，onValueChange 根本不触发，find-start 永不发出）。唤起时主窗口多半已持焦，收回幂等无害。需打包形态 CDP 实测验收；
  - **导航/刷新即失效**：浏览器 Tab 导航/刷新后 Chromium 自动作废搜索（页面重载，无 end-of-session 帧）——组件按 `state.url` 变化**或 loading false→true 翻转**清零计数（同 URL 刷新不发 url 变化，loading 翻转恒有；review 三轮 #3。查询词保留供重搜）；PDF 侧无导航面，不处理；
  - **会话闸门**（review 三轮 #2）：卸载兜底 stop 仅在确有在途会话时发（run 置位 / 关闭·清空·失效复位）——`stopFindInPage` 会清页面选区，用户手动选中的文本不能因切 Tab 被抹掉；
  - **viewId 未落地不注册唤起**（review 2026-09-09）：PDF 加载窗口内（view-create 在途）/纯浏览器 shim（恒 -1）下注册会开一个死查找条（输入 no-op、计数永不到）——Ctrl+F 语义为无动作（shim 验收口径）。
- **高亮渲染**：Chromium 原生选区高亮（findInPage 自带，当前匹配与全部匹配均由 PDFium/web 渲染层绘制，应用零 DOM 成本）——这正是浏览器/PDF 走原生 API 而非 DOM 扫描的理由。
- **PDF 注意**：PDFium 查看器对 findInPage 的响应同 web 页面（Chromium 统一实现）；若某 PDF 无文本层（扫描件）则 `matches: 0`，语义自洽。
- **浏览器 shim**：`browser:find-start/find-stop` 桩 no-op、`onBrowserFindState` 返回空订阅（同既有 browser:* 家族形态）。

### 2.3 markdown 预览态：DOM 文本扫描

- **实现落点**：FileView 内新子组件 `MdFind`（workspace.tsx，或独立文件——见 §5 决策：**落 workspace.tsx 内**，与 TOC 扫描同文件，避免为单一调用点拆文件）。查找条渲染在内容滚动层之下（wrap 列 flex 末行，2026-09-09 居底统一）；匹配模型自持（`useState` 纯局部，不入 store——关闭即清，切走重挂载重搜，与 TOC 状态记忆不同：搜索是瞬时任务态，无「切走再回恢复」诉求）。
- **扫描算法**：TreeWalker（`NodeFilter.SHOW_TEXT`）遍历 `.file-md` 内文本节点，收集命中区间 [start, end)（大小写不敏感、纯文本 indexOf——不支持正则/全字，与 CM search 基础档一致）；**跳过**：`script/style`（无此节点，防御）与已命中节点的属性（TreeWalker 天然只走 text node，无需处理）。
- **高亮渲染**：CSS Custom Highlighting API（`CSS.highlights.set("md-find", …)`，`new Highlight()` 后逐 range `add()` 登记——不用展开传参构造，spread 实参受 V8 ~65k 上限约束，大文件高频词命中数可越界抛 RangeError，2026-09-09 二轮复审 #3；`::highlight(md-find)`）——零 DOM 变更，不侵入 streamdown 渲染树（块级 memo 下 DOM 改写会破坏 React 托管，§2.8 MarkdownImage 同结论）；当前匹配单独 registry `md-find-active`（更强底色）。回退：`CSS.highlights` 不存在（旧 Chromium/jsdom）时降级为无高亮滚动定位（Chromium 105+ 支持，Electron 43 恒可用；jsdom 测试走降级断言结构）。
- **当前匹配定位**：命中区间 `Range.getBoundingClientRect()` → 滚动层 `scrollTop` 对齐（`scrollIntoView({block:"center"})` 不适用——Range 非 Element；手动算 rect 相对滚动容器偏移）。上一处/下一处环绕（wrap-around）。
- **范围**：仅预览体 `.file-md`（front matter 元数据卡 + markdown 正文）；工具条/TOC 不参与。源码态无 MdFind（**切模式即关闭查找条**——开着进源码是僵尸态：Range 全失联、CM 又自持搜索，review 2026-09-09）；切回预览重唤起 = 对新 DOM 重扫。切换预览/源码再切回 = 重新搜索（输入词随组件态丢失——瞬时任务态语义，见上）。
- **预览 DOM 重建即重扫（review 2026-09-09）**：模式切换与 `cached.content` 重拉（file watch / agent 改文件——本应用 agent 边改文件用户边看是常态）都会替换预览 DOM，已收集的 Range 全部失联——hook 以「预览态 + 内容引用」联合 scanKey 感知：变化即清失联高亮/计数，查找条仍开着且词非空时对新 DOM 自动重扫（**防僵尸**：切回预览/文件变更后无需手动改词）。
- **pending/在途语义**：**新 query 首扫**前匹配数为 null（idle 占位，不描红）——首扫落地才显示 `n/m`（避免先闪 `0/0` 红边再翻正，同浏览器侧 in-flight 语义；review 2026-09-09）。**改词精搜**（已有计数后再输入）防抖窗口内保留上一词的计数与高亮直至重扫落地（VS Code 式连续感，不闪 idle；2026-09-09 二轮复审 #2 修订——原稿「窗口内恒 null」体验更差，以实现语义为准）。
- **streamdown 延迟渲染补扫**（review 二轮 #4 提出、2026-09-09 二轮复审 #1 修订）：内容重拉后重扫时 streamdown 首帧可能未完成（内部延迟渲染）——+150ms 扫描后 MutationObserver 观察预览体变更持续补扫，**不因已有命中跳过/断开**（部分命中同样可能少计：迟渲染块内还有命中；原稿仅零命中时观察）；观察器随 effect 清理（词变/scanKey 变/关闭）断开，DOM 静止时零成本，同帧多次变更微任务合帧只扫一次（同 TOC 扫描先例）。
- **重聚焦**：查找条已开时再按 Ctrl+F = 重新聚焦并全选输入框（递增计数 prop 触发，非只 `setOpen` no-op——浏览器 Tab 下原生视图抢焦是常态；review 2026-09-09）。

### 2.4 三视图落点与键位汇总

| 视图 | 查找条位置 | 匹配来源 | Ctrl+F 唤起路径 |
|---|---|---|---|
| FileView markdown 预览态 | 内容滚动层下方（wrap 内末行） | DOM 扫描（§2.3） | window keydown → dispatch 分支（FileView 传唤起 ref 经 store 转发，见下） |
| FileView 源码态/代码文件 | CM 搜索面板（居底） | CM search（既有） | 同上；2026-09-09 起注册——CM 未聚焦时经回调 `openSearchPanel` 唤起（CodeView `onViewReady` 上报 EditorView），已聚焦时 keymap 先消费 |
| 浏览器 Tab | 内容宿主下方（列 flex 末行） | `findInPage`（§2.2） | 同上；视图持焦时经 browser:shortcut 转发 |
| PDF 文件 Tab | 内容宿主下方（列 flex 末行） | `findInPage`（§2.2，viewId 复用注册表） | 同上 |

- **唤起通道**：dispatch 是全局单点，视图组件在挂载时注册「唤起回调」——`useFindRequester` hook（find-bar.tsx，§2.4 表内的 `useFindBarController` 为初稿名，实现即它）：组件树内自持 `open` 状态 + 挂载时向 store 注册回调（`store.registerFindRequester(tabKey, fn)`，切走/卸载注销）。dispatch 分支：激活 Tab 有注册回调即消费唤起，无注册回调 = 放行；**overlay 闸门**（review 二轮 #5）：弹窗/右键菜单遮挡时（overlayCount>0）仅消费不动作——查找条会开在弹窗之下且其挂载聚焦抢走弹窗控件焦点（同 Alt 域四键闸门语义）。**不复用事件总线**：三视图都是受 React 生命周期管理的组件，回调注册制与 Tab 注册制（AGENTS.md「Tab 注册制」精神）同构，且卸载自动清理。
  - FileView 特例（2026-09-09 review 三轮修订；同日扩至代码态）：kind=file 的 Tab 可能是 markdown 预览/源码/图片/代码——**markdown 恒注册**（Tab 存续期；回调按态分发：预览态且内容落地 → 开 FindBar，源码态 → `openSearchPanel` 开 CM 面板）；**代码/文本文件内容落地即注册**（`codeViewLive` = 内容分支渲染期镜像；2026-09-09 起未聚焦正文也能 Ctrl+F，原「CM 自持、不注册」语义修订——未聚焦时事件无人消费，必须先点正文是缺陷）；**PDF/图片/二进制不注册**（`file:` 注册键让给 PDF 分支的 PdfFrameView——父子组件共用键会后注册覆盖前者，PDF Ctrl+F 即失效；图片/占位无页面内搜索语义）。
  - 浏览器/PDF 视图的注册以 viewId 落地为前提（PDF 加载窗口/shim 不注册，Ctrl+F 无动作）。
- **Esc 冒泡**：FindBar 输入框 Esc 先关查找条（不冒泡成全局语义——`stopPropagation`；全局 Esc 关弹窗/菜单语义不受扰）。关闭后焦点回落视图。
- **焦点守卫**：查找条开着时 Ctrl+F 重新聚焦（不动作）；Tab 切走即卸载（组件随视图卸载），无跨 Tab 残留。

### 2.5 布局细节

- **通用**（2026-09-09 居底统一修订；同日按钮文案/位置/关闭钮统一）：`.find-bar` 居视图底部，密度对齐 CM 搜索面板 idiom——28 高控件（`--control-h`）+ 上下 6 padding（条高 = `--file-toolbar-h`，与文件操作条等高衔接）；背景 `--surface-container-low` + **顶边框**（底部行的分隔线，同 `.cm-panels-bottom`）；输入框 `.find-input` 同 CM cm-textfield idiom（`--surface-container-lowest` 底、`--outline-variant` 边、`--radius-chip` 圆角、28 高、**宽 220px 两侧统一**——CM 侧覆写 `input.cm-textfield` 等宽，原内建 intrinsic 默认宽）；「下一个/上一个」为文案钮（`.find-btn`，t.findNext/findPrev 文案）同 CM 面板 button idiom（container 底 chip 圆角、next 在前 prev 在后）；关闭 × 钮为 **ghost 方钮对齐 Tab 关闭钮 idiom**（无边框透明底 **22×22** = `.icon-btn` 工具栏标准尺寸（原 18 偏小同日上调；tab 内为紧凑区 18）、radius 4、hover container-highest 底，`margin-left:auto` 右推条尾；CM 侧 × 文本字形字号 20px 补偿至与 14px lucide 图标视觉等高）。**文案两侧同源**：CM 侧 phrases 的 Find/next/previous 与本条 i18n 同文案（zh「查找…/下一个/上一个」、en "Find…/Next/Previous"，见 code-view cmPhrasesZh/cmPhrasesEn；文案取一般习惯用语，原「下一处/上一处」「Next match/Previous match」同日精简弃用）；计数 `n/m` 用 mono 字体弱色（本条特有，CM 无匹配计数），**idle 空串不渲染 span**（2026-09-09 移除原 min-width 48px 占位——空计数在输入框与按钮间留一段空白）；无匹配计数为 `0/0` + 输入框 `--error` 边。
- **浏览器 Tab**：`.browser-tab` 列 flex 末行（browser-host 之后），常驻结构（开着才渲染）。
- **PDF**（2026-09-09 review 三轮修订；同日居底修订）：查找条渲染在 **PdfFrameView 内部**（`.file-view.pdf-view` 列 flex，查找条为宿主下方末行）——find 会话状态机与 viewId 同属 PdfFrameView（懒建/复用），拆到 wrap 层会跨组件借 viewId（原生视图 bounds 随宿主 div，插入行使宿主自动缩短，ResizeObserver 链路天然跟随——同 §2.4 先例）。
- **markdown**：同 wrap 层插入位（内容滚动层之下、wrap 末行），不占 `.file-md` 宽度。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| replace（替换） | 三视图均只读内容，无替换语义（CM readonly 同自动隐藏 replace） |
| 正则/全字匹配开关 | 基础档与 CM search 默认档一致；findInPage 仅 matchCase，语义面取交集（大小写不敏感纯文本）；等真实诉求 |
| 大小写敏感开关 | 同上，恒不敏感（浏览器/PDF 原生 API 有档但 UI 不暴露，统一三视图语义） |
| 消息流 markdown 搜索 | 消息流是累积流式场景，搜索对象语义不明（全部消息？当前视口？），等真实诉求 |
| 查找条内打开文件/链接跳转 | 超范围 |
| 高亮持久化/搜索词记忆 | 瞬时任务态（§2.3），与 TOC 状态记忆不同物 |
| webview/iframe 方案的 DOM 扫描（浏览器/PDF） | 内容不在 renderer DOM（原生视图），DOM 扫描不可达；原生 findInPage 语义/性能双优 |
| jsdom 下 CSS.highlights 断言 | jsdom 无 Highlight API，测试断言扫描区间结构（纯函数）而非视觉高亮 |

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/main/browser-views.ts` | `browser:find-start`/`browser:find-stop` IPC + `found-in-page` 聚合推送（finalUpdate 过滤） |
| `src/shared/ipc.ts` | `DesktopApi` 扩 `browserFindStart/browserFindStop/onBrowserFindState` + `BrowserFindState` 类型 |
| `src/preload/index.ts` | 暴露通道 |
| `src/renderer/src/browser-shim.ts` | find 桩（no-op/空订阅） |
| `src/renderer/src/components/find-bar.tsx` | 新：`FindBar` 组件 + `useWebContentsFind(viewId)` hook + `useFindBarController` 注册制 |
| `src/renderer/src/components/workspace.tsx` | FileView markdown 预览态接 FindBar + DOM 扫描高亮（MdFind 逻辑）；PDF 分支接 FindBar（viewId 复用） |
| `src/renderer/src/components/browser-tab-view.tsx` | 查找条渲染 + useWebContentsFind 接线 |
| `src/renderer/src/components/pdf-frame-view.tsx` | 查找条渲染 + useWebContentsFind 接线（宿主布局微调） |
| `src/renderer/src/components/shortcuts.ts` | dispatch Ctrl+F 分支（找激活 Tab 的注册回调）；SHORTCUT_GROUPS Ctrl+F 两行分列（scFileSearch 文件内查找 = code-view CM / scPageSearch 页面内查找 = 三视图共用查找条）+ 查找条 Enter/Shift+Enter 行 |
| `src/renderer/src/store/app-store.ts` | `findRequesters` 注册表（tabKey → 唤起回调；挂/卸生命周期由组件管理） |
| `src/renderer/src/i18n/index.ts` | `findPlaceholder/findIdle/findMatchCount/findPrev/findNext/findClose` 文案（无匹配态为类描红，无独立文案键；2026-09-09 复审修订——原稿误列 `findNoMatch`） |
| `src/renderer/src/styles/app.css` | `.find-bar` 全套（输入框/计数/按钮/红边态） |
| 测试 | find-bar 组件 + browser-tab-view find 接线 + file-view markdown find 扫描 + shortcuts Ctrl+F 分发 + store 注册表 |

## 5. 验收

- markdown 预览态 Ctrl+F：查找条出现在视图底部、输入即高亮全部匹配（当前匹配深色）、计数正确、Enter/Shift+Enter 环绕跳转且滚动定位、Esc 关闭清高亮；源码态/代码文件 Ctrl+F **无需先聚焦正文**即唤起 CM 搜索面板（2026-09-09 修订；已聚焦时仍由 keymap 先消费）；图片/二进制文件 Ctrl+F 放行无动作（无注册回调）；
- 浏览器 Tab：页面内 Ctrl+F（视图持焦，经转发）与应用侧 Ctrl+F 均唤起查找条；输入即原生高亮 + 计数；Enter/上一处跳转；Esc 清除；导航到新页面后计数清零、旧词重输即搜；
- PDF Tab：Ctrl+F 唤起、findInPage 高亮计数正常（含多页跳转）；扫描件 PDF 计数 0 输入框描红；
- 三视图查找条开合无布局跳动（常驻位预留与否——查找条不常驻，开合有 ~32px 行高变化，同 CM 面板先例，接受）；浏览器/PDF 原生视图 bounds 随开合自动跟随；
- 浏览器 shim（纯浏览器 dev）Ctrl+F 无动作（无注册回调，PDF 分支 shim 下无 viewId 不渲染）；
- `npm run test` / `npm run typecheck` 全绿。