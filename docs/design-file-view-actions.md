# 文件预览操作条（open / open with）— 设计文档

> 目标：文件 Tab 的所有预览视图统一常驻操作条——代码视图从无工具条到有操作条；全部文件视图（markdown/代码/图片/PDF/二进制占位，含加载/错误态）提供 open（系统默认应用打开）与 open with（指定应用打开）入口。动作语义与文件树右键菜单同源（[design-file-panel-context-menu](./design-file-panel-context-menu.md) §2.3/§2.4）。
>
> 参考先例（AGENTS.md 约定先行检索）：`../openbuilder` 移动端文件消费走应用内渲染 + 系统分享面板（design-file-view.md），无桌面工具条先例；本仓库既有基建全部复用——右键菜单动作通道（shell:openPath / shell:openWith，零新增 IPC）、Linux 自建选择器（[design-linux-open-with](./design-linux-open-with.md)）、markdown 工具条常驻决策（[design-markdown-preview](./design-markdown-preview.md) §2.2）、浮层计数 z-order 对策（[design-browser-tab](./design-browser-tab.md) §1.2）。本设计只做接入与结构统一。

## 1. 问题

- 代码/图片/PDF 预览是"裸"视图（无任何工具条）：文件已在 Tab 内可见，但"用系统应用打开 / 换应用打开"必须绕道文件树右键菜单（对象还得在树里找）；
- 文件已在预览中打开时，系统级消费（外部编辑器改图片、PDF 阅读器批注、二进制文件专属工具）是自然诉求，预览页内无出口是路径断裂。

## 2. 设计

### 2.1 操作条常驻于所有文件视图

| 视图 | 操作条内容 |
|---|---|
| markdown | TOC 钮（左，沿既有）+ open + open with + 预览/源码分段（右，沿既有） |
| 代码（含 .mdx/无扩展名/.html 源码态） | open + open with（**新增操作条**——原无任何工具条） |
| 图片 | open + open with（无模式切换，[design-image-preview](./design-image-preview.md) §2.2 决策维持） |
| PDF | open + open with（同上，[design-pdf-preview](./design-pdf-preview.md) §1） |
| 二进制占位 / 加载 / 错误态 | open + open with（常驻——防内容落地时 ~32px 工具条弹入布局跳动，沿 markdown 工具条常驻决策；且 open/open-with 只依赖路径，加载态即可用；二进制占位恰是 open 的主场景——应用内不可预览）。注：markdown 文件在这些态下预览/源码分段仍随 `previewable` 常驻（文件监听重拉翻转为文本时无工具条跳动；二进制嗅探占位下两模式渲染同一占位，分段暂不动作属预期取舍） |

- **FileView 重构为统一骨架**：`.file-view-wrap > .file-toolbar + content`（+ TOC 悬浮窗 / OpenWithDialog 挂点），各分支只产出 content。原实现 markdown 分支带 wrap、其余分支早退返回裸 div。
- 早退消除后 hooks 全部无条件执行：原滚动恢复 `useLayoutEffect` 位于图片/PDF 早退之后（仅文本文件注册——依赖「路径按实例恒定」才不违 Hook 规则），重构后不再依赖该前提；图片/PDF 分支下该 effect 为纯 no-op（fileScrollRef 未挂载、无恢复条目）。
- 各分支标记与原早退路径逐一等价；仅图片/PDF **加载态**容器类简化（image-view/pdf-view 于加载态无样式意义，统一走文本分支占位）。markdown 嗅探二进制的占位原不带工具条，现随骨架常驻（open/open-with 对不可预览文件恰是主出口，见上表）。

### 2.2 动作语义（与右键菜单同源，零新增通道/文案）

| 项 | 行为 | 可见性 |
|---|---|---|
| open | `shellOpenPath(absolutePath)`（系统默认应用；错误静默约定同菜单 §2.5） | 恒显示（同菜单） |
| open with… | linux → 应用内自建选择器 `OpenWithDialog`（design-linux-open-with 全量列表/搜索/上次使用，零改动复用）→ `shellOpenWithApp`；win32/darwin → `shellOpenWith` 系统对话框 | win32/darwin/linux（纯浏览器 shim 不显示——同 FileContextMenu 判定） |

- 图标钮 `.icon-btn`（22×22，同 TOC 钮 idiom）：open = `ExternalLink`、open with = `AppWindow`（lucide 16px），title/aria-label 复用既有 i18n `fileOpen` / `fileOpenWith`。
- 工具条布局：`.file-toolbar` 增 `gap: 8px`（右组内间距；TOC 钮 margin-right:auto 推左不受影响）；open/open-with 位于分段开关左侧，**跨文件类型右缘同位**（代码/图片/PDF 无分段时即为最右）。

### 2.3 OpenWithDialog 自持浮层计数（修订：既有缺口修复）

- 弹窗是 DOM，盖不住浏览器 Tab / PDF 文件 Tab 的原生 WebContentsView（OS 层在 DOM 之上）——存续期间必须 `pushOverlay` 计数隐藏（design-browser-tab §1.2）。
- 原组件**不计数**：文件树入口下右键菜单卸载（pop）与弹窗挂载之间计数归零，浏览器/PDF Tab 激活时从文件树打开选择器，弹窗被原生视图盖住属既有缺口。本次把 push/pop 收进弹窗组件（mount/unmount，同 ConfirmDialog 模式），两处入口（文件树菜单 / 文件预览操作条）一并修复——PDF Tab 上从操作条弹选择器不再被 PDFium 视图遮挡。

### 2.4 PDF 原生视图适配

操作条占位列布局后，`.pdf-host` 矩形天然缩小，既有 ResizeObserver → `browserViewBounds` 链路自动跟随，无额外处理。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| 复制路径 / 引用到会话入操作条 | 文件树右键菜单已覆盖；操作条保持最小动作集（Keep Lean） |
| 动作成功/失败反馈（toast） | 静默约定同右键菜单（§2.5），无全局 toast 基建 |
| 图片/PDF 预览/源码切换 | 原决策维持（位图/PDF 源码无阅读价值/无意义）；本次仅修订「无工具条」为「有操作条、无模式切换」 |
| 操作条键盘快捷键 | 无诉求；Alt 系已被项目/工作区管理专域占用（design-keyboard-shortcuts §0） |

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/renderer/src/components/workspace.tsx` | FileView 统一骨架（分支解析为 content 赋值）+ 操作条 open/open-with 钮 + OpenWithDialog 挂载；滚动恢复 hook 转无条件执行 |
| `src/renderer/src/components/open-with-dialog.tsx` | 浮层计数 push/pop 自持（§2.3） |
| `src/renderer/src/styles/app.css` | `.file-toolbar` gap: 8px + 注释更新 |
| `src/renderer/src/components/file-view.test.tsx` | desktop/i18n/store 桩扩展 + 操作条用例（常驻/平台分支/浮层计数） |
| `src/renderer/src/components/open-with-dialog.test.tsx` | useStore 桩 + 浮层计数用例 |
| 修订标注 | design-image-preview §2.2、design-pdf-preview §1、design-code-view §2.5、design-markdown-preview §2.2、design-linux-open-with §1.3 |
| `docs/spec-v0.4.md` | 范围表 #8 + 验收项 |

## 5. 验收

- 任意类型文件 Tab（代码/图片/PDF/二进制占位/加载/错误态）操作条常驻；open 以系统默认应用打开当前文件；
- open with 平台分支与右键菜单一致：Linux 弹自建选择器（全量列表/搜索/上次使用）、选择后对应应用打开；win32/darwin 系统对话框；纯浏览器 shim 不显示该项（open 仍恒显）；
- markdown 操作条四类控件共存（TOC/open/open with/预览-源码分段），TOC 悬浮窗定位与限高不受影响；
- PDF Tab 打开选择器期间原生视图让位（浮层计数），关闭恢复；
- `npm run test` / `typecheck` / `build` 全绿。
