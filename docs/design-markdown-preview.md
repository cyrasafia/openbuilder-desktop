# 文件 Tab markdown 预览 — 设计文档

> 目标：文件 Tab 打开 `.md` / `.markdown` 文件时默认渲染 markdown 预览，工具条可切换「预览 / 源码」二态；预览态左侧提供可折叠 TOC 大纲（§2.4）；非 markdown 文件行为不变。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-file-view.md` —— FileView 按文件类型分发 Render Mode 的总设计（Markdown Mode：默认预览态、AppBar 源码/预览切换、渲染范围、不支持 mermaid）
> - 本仓库 `markdown.tsx` —— 消息流 markdown 渲染组件（streamdown + tokens.css 语义令牌覆写），直接复用为预览渲染器（桌面端无 webview 一说，`design-markdown-webview.md` 的动机不适用）
> - TOC 无移动端先例（检索 openbuilder docs 未见大纲/TOC 设计），§2.4 为桌面端新设计

## 1. 问题

`FileView`（workspace.tsx）目前对所有文本文件渲染 `<pre>` 源码。`.md` 文件在桌面端只能看源码，阅读体验差——仓库内大量设计文档/README 的首要消费方式就是渲染阅读。

## 2. 设计

### 2.1 渲染分发（dispatch）

| 扩展名（大小写不敏感） | Render Mode |
|---|---|
| `.md` / `.markdown` | **markdown**：默认预览态 + 工具条二态切换 |
| 其他（现状） | 纯文本源码（v0.2 后续功能再引入代码高亮） |

- 扩展名取 basename 最后一个**非前导**点的后缀：无扩展名、点文件（名字恰为 `.md`）不命中；`.mdx` 不识别（openbuilder 同决策）。
- 分发只按扩展名，不嗅探内容（`GET /file/content` 返回 `{type:"text", content}` 包装，服务端已判定文本性）。

### 2.2 markdown mode

- **默认预览态**；`<FileView key={tabKey}>` 隔离——Tab 切换/重开、同实例换文件均重置（与 ChatView 草稿隔离同模式），模式为组件局部 state，不持久化（与移动端 peek 封存模式不同，桌面端文件 Tab 生命周期短，重开成本为零）。
- **工具条**：FileView 顶部右对齐的分段开关（预览 / 源码），markdown 文件**常驻渲染**（含 loading/error 态——避免内容落地时工具条弹入的布局跳动）。开关相对工具条**纵向居中**（上下等距 6px；2026-08-25 修订，原 `0` 底距使开关底对齐、与下方内容贴连）。分段控件复用 `.ms-segmented`/`.ms-seg`（单一来源）；语义用 `role="group"` + `aria-pressed` 分组按钮，不冒充 tabs（无方向键导航）。预览体复用消息流 `Markdown` 组件渲染。**TOC 收起/展开钮**（2026-08-25 增，见 §2.4）也在工具条：左对齐（`margin-right:auto` 推左，分段开关保持右对齐），仅在已扫出标题时出现，`aria-pressed` = 展开态。
- **源码态**：沿用现有 `<pre className="file-content mono">`（后续「代码浏览行号+语法高亮」功能覆盖文本文件后自然升级）。
- **布局**：FileView 根改为列 flex（工具条 + 滚动层）；预览体限宽居中（`max-width 820px`，与聊天区 `--chat-max: 800px` 同一阅读度量级）；覆写 `.md-pre` 高度上限（消息流 300px 内滚在文档预览中放开——渲染阅读优先，长代码块不套内滚）。

### 2.3 渲染范围与链接行为

- streamdown 解析集：标题/表格/列表/任务列表/代码块/链接等（同消息流，无额外配置）。
- 链接 → 系统浏览器（`Markdown` 组件既有 `target="_blank"` + main 进程 `shell.openExternal`）。
- **相对路径图片不支持**（`<img src>` 相对路径无 base URL 可解析，openbuilder 亦未支持）——坏图即 broken icon，不在本功能内解决。

### 2.4 TOC 大纲（2026-08-25 增补；2026-08-25 三次修订：侧边栏 → 悬浮窗共同居中 → 滚动层内 sticky → 内容区居中 + 悬浮窗挂左侧）

预览态增加目录大纲（此前在 §3「不做」中标注"无用户诉求"，诉求出现后纳入）。初版为左侧全高侧边栏；一修改为悬浮窗（与内容区共同居中），但居中分组收窄了滚动容器，滚动条贴内容区右缘；二修改为滚动层内居中分组 + sticky 悬浮窗，滚动条回到窗口右缘；三修改为**内容区独立居中 + TOC 悬浮窗挂内容区左侧**。

- **内容区（2026-08-25 三修）**：预览体 `.file-md` 相对全窗居中，**动态宽度 [600, 800] 自适应**（同聊天区 [600, 800] idiom：`.file-view-wrap` 局部变量 `--file-md-min/--file-md-max`，`width: clamp(min, 100%, max)`）。**下限 600 为硬约束**（同日修订：初版 `min(100%, …)` 兜底使窄屏跌破下限）——可见区窄于 600 时内容区保持 600，滚动层横向滚动。滚动层仍是全宽 `.file-view`（滚动条贴窗口右缘，二修决策不变）；二修的居中分组随之移除（内容区不再为 TOC 让位）。
- **TOC 悬浮窗悬挂内容区左侧**：绝对定位于 `.file-view-wrap`（**滚动容器之外 → 天然常驻可见、无需 sticky**——二修的「滚动层内 sticky」随之废弃：归属更简，且不再需要 100vh 标题栏/Tab 栏高度补偿）。横向 `left: max(12px, 内容区左缘 − 窗宽 − 间距)`（内容区左缘 = `(100% − 内容宽) / 2`，纯 CSS 派生）：侧缘留白够宽时悬于内容区左侧，不够宽时自动收进可见区左缘（悬浮覆盖内容区，卡片不透明 + 阴影，重叠可读）。纵向 `top: 工具条高 + 12px`；**高度不超可见区**（`max-height: calc(100% - var(--file-toolbar-h) - 24px)`，100% = pane 高，上下各 12px 留白），超出由 `.md-toc-tree` 列内自滚。视觉为卡片（`surface-container-high` 底 + 边框 + 圆角 + 阴影）；窗宽/间距令牌化（`--toc-w: 240px`、`--toc-gap: 16px`，tokens.css）。
- **遮挡即默认收起**：内容区居中，其左缘 = `(可见宽 − 内容宽) / 2`；窗左缘按定位公式 `max(12px, 内容左缘 − 窗宽 − 间距)`，**窗右缘越过内容区左缘 = 遮挡 → 默认收起**，工具条按钮可显式展开（悬浮覆盖内容区）。判定与 CSS 定位公式同源（JS 纯函数 `tocOccludesContent`，常量 `--toc-w` / `--toc-gap` / `--file-md-max` / 12px 左缘兜底两侧同步）。初版阈值「内容下限 + 窗宽 = 840」按并排布局误算——居中后侧缘只有余宽一半，实际不遮挡的临界是可见宽 ≥ `800 + 2×(12 + 240)` ≈ 1304（2026-08-25 修订：用户反馈 840~1304 区间 TOC 显示但遮挡内容）。显隐为三态逻辑：用户显式选择（布尔）覆盖遮挡默认；未手动操作时随测宽默认；选择随 Tab key 隔离、不持久化（同预览/源码模式）。宽度经 ResizeObserver 测 `.file-view-wrap`（useLayoutEffect 同步首测，防窄屏先闪显一帧）。无标题的文档不渲染 TOC 也不出现按钮。
- **数据来源**：预览体落地后 DOM 扫描 `h1–h6`（`collectHeadings`），不解析源文本、不侵入消息流共享的 streamdown 管道——标题元素即锚定目标，无 id 注入（streamdown 块级 memo 下渲染期注入序号 id 不可靠）。代码块内的 `#` 行不会被解析为标题元素，天然排除。若扫描时渲染未完成（streamdown 内部延迟），MutationObserver 观察 DOM 变更补扫。
- **章节树**：扁平标题按「更浅的最近前驱」归并为树（栈式，支持跳级：h1 后直接 h3 挂 h1 下）。有子节点的条目带折叠 chevron（默认全展开），叶子条目占位对齐。**折叠态由 FileView 持有**（2026-08-25 修订：悬浮窗收起即卸载 MdToc，状态上移后跨显隐保留），仅内容更换后重置（旧元素引用失效）。
- **收起/展开**：按钮在 **FileView 工具条**（原在 TOC 头部/窄轨，随悬浮窗化上移）——`ListTree` 图标 + `aria-pressed`（= 展开态），title 随态切「收起目录/展开目录」；窄屏默认隐藏时按钮仍在（供显式展开）。收起 = 悬浮窗整体移除（无窄轨残留）。
- **锚定**：点击条目 `scrollIntoView({ behavior: "smooth", block: "start" })`；标题 `scroll-margin-top: 8px` 留白。
- **不做滚动位置高亮（scrollspy）**：锚点是消费主体，active 追踪是增量收益，等真实诉求。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| mermaid 图表渲染 | openbuilder 同决策；引入 mermaid 运行时收益低 |
| 模式偏好持久化（记住上次源码/预览） | 文件 Tab 生命周期短；需要时再加 per-profile 偏好 |
| 内部相对链接跳转（md → md 导航） | nice-to-have（openbuilder 同标注），等真实需求 |
| TOC 滚动位置高亮（scrollspy） | 见 §2.4：锚点是消费主体，增量收益有限 |
| 预览内容键盘可达（放开链接/复制按钮 tabIndex） | 复用 `Markdown` 继承消息流「内容不入焦点序列」决策（review P3 备注）；后续需要时给组件加 interactive 变体 |

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/workspace.tsx` | FileView：扩展名分发 + markdown mode（工具条 + 预览/源码 + TOC 收起态与工具条按钮）+ TOC 标题扫描与布局 |
| `src/renderer/src/components/md-toc.tsx` | TOC 悬浮窗：标题收集/章节树/按章节折叠/点击锚定（收起态由 FileView 控制） |
| `src/renderer/src/i18n/index.ts` | `preview` / `source` / TOC 文案 |
| `src/renderer/src/styles/tokens.css` | `--file-toolbar-h`（工具条高度单一来源）、`--toc-w` / `--toc-gap` |
| `src/renderer/src/styles/app.css` | `.file-view-wrap`（`--file-md-min/max`、TOC 绝对定位锚）/ `.file-toolbar(.file-toolbar-toc)` / `.file-md` / `.md-toc*` |
| `src/renderer/src/components/resize-observer-stub.ts` | ResizeObserver 测试 stub（jsdom 缺失；测宽用例手动触发） |
| `src/renderer/src/components/file-view.test.tsx` / `md-toc.test.tsx` | FileView 分发与二态切换 + TOC 行为测试（含窄屏默认隐藏） |

## 5. 验收

- 打开 `.md` 文件默认渲染预览；切换源码显示原文；非 md 文件无工具条、行为不变；
- 有标题的 `.md` 预览：内容区 [600, 800] 自适应居中；侧缘够宽时 TOC 悬浮窗挂内容区左侧；滚动条贴窗口右缘、滚动时悬浮窗常驻可见、高度不超可见区（超出自滚）；悬浮窗会遮挡内容区时默认收起、工具条按钮可显式展开（悬浮覆盖内容区）；可按章节收起/展开、工具条按钮可整体收起/展开悬浮窗、点击条目平滑滚动锚定到对应标题；无标题文档无 TOC 无按钮；源码态无 TOC；
- `npm run test` / `npm run typecheck` 全绿。
