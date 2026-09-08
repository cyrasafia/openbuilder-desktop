# 文件 Tab markdown 预览 — 设计文档

> 目标：文件 Tab 打开 `.md` / `.markdown` 文件时默认渲染 markdown 预览，工具条可切换「预览 / 源码」二态；预览态左侧提供可折叠 TOC 大纲（§2.4）；非 markdown 文件行为不变。
>
> 参考来源（openbuilder 移动端，按 AGENTS.md 约定先行检索）：
> - `openbuilder/docs/design-file-view.md` —— FileView 按文件类型分发 Render Mode 的总设计（Markdown Mode：默认预览态、AppBar 源码/预览切换、渲染范围、不支持 mermaid）
> - `openbuilder/docs/design-markdown-webview.md` + `lib/features/files/markdown_html.dart` —— front matter 拆分与元数据卡（`splitFrontMatter`，§2.5 语义移植来源）；其链接侧 `_resolvePath`（§4.2.6，相对路径解析基准 = 当前文件目录）是 §2.8 图片解析的语义同源（移动端仅做链接点击解析，未做图片）
> - 本仓库 `markdown.tsx` —— 消息流 markdown 渲染组件（streamdown + tokens.css 语义令牌覆写），直接复用为预览渲染器（桌面端无 webview 一说，`design-markdown-webview.md` 的动机不适用）
> - TOC 无移动端先例（检索 openbuilder docs 未见大纲/TOC 设计），§2.4 为桌面端新设计；GFM alert（§2.6）移动端亦未做过，规格对齐 GitHub 官方（https://docs.github.com/en/get-started/writing-on-github/get-started-writing-to-format-your-message-using-markdown/alerts），样式复用 vendor github-markdown-css 自带的 `.markdown-alert` 系列

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

- **默认预览态**；`<FileView key={tabKey}>` 隔离——Tab 切换/重开、同实例换文件均重置（与 ChatView 草稿隔离同模式）。模式为组件局部 state，挂载时从 store 按文件路径恢复（2026-08-26 修订，原"不持久化、重开成本为零"——运行期切换体验要求状态连续，见 [design-tab-state-memory.md](./design-tab-state-memory.md) §2.2；跨重启仍不持久化，关 Tab 即清）。
- **工具条**：FileView 顶部右对齐的分段开关（预览 / 源码），markdown 文件**常驻渲染**（含 loading/error 态——避免内容落地时工具条弹入的布局跳动）。开关相对工具条**纵向居中**（上下等距 6px；2026-08-25 修订，原 `0` 底距使开关底对齐、与下方内容贴连）。分段控件复用 `.ms-segmented`/`.ms-seg`（单一来源）；语义用 `role="group"` + `aria-pressed` 分组按钮，不冒充 tabs（无方向键导航）。预览体复用消息流 `Markdown` 组件渲染。**TOC 收起/展开钮**（2026-08-25 增，见 §2.4）也在工具条：左对齐（`margin-right:auto` 推左，分段开关保持右对齐），仅在已扫出标题时出现，`aria-pressed` = 展开态。**open / open-with 图标钮**（2026-09-08 增，[design-file-view-actions.md](./design-file-view-actions.md)）：分段开关左侧、与文件树右键菜单动作同源；该修订同时把「工具条常驻」从 markdown 专属推广到全部文件视图（代码/图片/PDF/占位）。
- **源码态**：沿用现有 `<pre className="file-content mono">`（后续「代码浏览行号+语法高亮」功能覆盖文本文件后自然升级）。
- **布局**：FileView 根改为列 flex（工具条 + 滚动层）；预览体限宽居中（`max-width 820px`，与聊天区 `--chat-max: 800px` 同一阅读度量级）；覆写 `.md-pre` 高度上限（消息流 300px 内滚在文档预览中放开——渲染阅读优先，长代码块不套内滚）。

### 2.3 渲染范围与链接行为

- streamdown 解析集：标题/表格/列表/任务列表/代码块/链接等（同消息流，无额外配置）。
- 链接 → 系统浏览器（`Markdown` 组件既有 `target="_blank"` + main 进程 `shell.openExternal`）。
- ~~相对路径图片不支持~~ → 已做（2026-09-07，§2.8）：以 md 文件所在目录为基准解析，经 server `/file/content` 拉取渲染。

### 2.4 TOC 大纲（2026-08-25 增补；2026-08-25 三次修订：侧边栏 → 悬浮窗共同居中 → 滚动层内 sticky → 内容区居中 + 悬浮窗挂左侧）

预览态增加目录大纲（此前在 §3「不做」中标注"无用户诉求"，诉求出现后纳入）。初版为左侧全高侧边栏；一修改为悬浮窗（与内容区共同居中），但居中分组收窄了滚动容器，滚动条贴内容区右缘；二修改为滚动层内居中分组 + sticky 悬浮窗，滚动条回到窗口右缘；三修改为**内容区独立居中 + TOC 悬浮窗挂内容区左侧**。

- **内容区（2026-08-25 三修）**：预览体 `.file-md` 相对全窗居中，**动态宽度 [600, 800] 自适应**（同聊天区 [600, 800] idiom：`.file-view-wrap` 局部变量 `--file-md-min/--file-md-max`，`width: clamp(min, 100%, max)`）。**下限 600 为硬约束**（同日修订：初版 `min(100%, …)` 兜底使窄屏跌破下限）——可见区窄于 600 时内容区保持 600，滚动层横向滚动。滚动层仍是全宽 `.file-view`（滚动条贴窗口右缘，二修决策不变）；二修的居中分组随之移除（内容区不再为 TOC 让位）。
- **TOC 悬浮窗悬挂内容区左侧**：绝对定位于 `.file-view-wrap`（**滚动容器之外 → 天然常驻可见、无需 sticky**——二修的「滚动层内 sticky」随之废弃：归属更简，且不再需要 100vh 标题栏/Tab 栏高度补偿）。横向 `left: max(12px, 内容区左缘 − 窗宽 − 间距)`（内容区左缘 = `(100% − 内容宽) / 2`，纯 CSS 派生）：侧缘留白够宽时悬于内容区左侧，不够宽时自动收进可见区左缘（悬浮覆盖内容区，卡片不透明 + 阴影，重叠可读）。纵向 `top: 工具条高 + 12px`；**高度不超可见区**（`max-height: calc(100% - var(--file-toolbar-h) - 24px)`，100% = pane 高，上下各 12px 留白），超出由 `.md-toc-tree` 列内自滚。视觉为卡片（`surface-container-high` 底 + 边框 + 圆角 + 阴影）；窗宽/间距令牌化（`--toc-w: 240px`、`--toc-gap: 16px`，tokens.css）。
- **遮挡即默认收起**：内容区居中，其左缘 = `(可见宽 − 内容宽) / 2`；窗左缘按定位公式 `max(12px, 内容左缘 − 窗宽 − 间距)`，**窗右缘越过内容区左缘 = 遮挡 → 默认收起**，工具条按钮可显式展开（悬浮覆盖内容区）。判定与 CSS 定位公式同源（JS 纯函数 `tocOccludesContent`，常量 `--toc-w` / `--toc-gap` / `--file-md-max` / 12px 左缘兜底两侧同步）。初版阈值「内容下限 + 窗宽 = 840」按并排布局误算——居中后侧缘只有余宽一半，实际不遮挡的临界是可见宽 ≥ `800 + 2×(12 + 240)` ≈ 1304（2026-08-25 修订：用户反馈 840~1304 区间 TOC 显示但遮挡内容）。显隐为三态逻辑：用户显式选择（布尔）覆盖遮挡默认；未手动操作时随测宽默认；显式选择与章节折叠均按文件路径记忆、切走再回恢复（2026-08-26 修订，原"随 Tab key 隔离、不持久化"，见 [design-tab-state-memory.md](./design-tab-state-memory.md) §2.4）。宽度经 ResizeObserver 测 `.file-view-wrap`（useLayoutEffect 同步首测，防窄屏先闪显一帧）。无标题的文档不渲染 TOC 也不出现按钮。
- **数据来源**：预览体落地后 DOM 扫描 `h1–h6`（`collectHeadings`），不解析源文本、不侵入消息流共享的 streamdown 管道——标题元素即锚定目标，无 id 注入（streamdown 块级 memo 下渲染期注入序号 id 不可靠）。代码块内的 `#` 行不会被解析为标题元素，天然排除。若扫描时渲染未完成（streamdown 内部延迟），MutationObserver 观察 DOM 变更补扫。
- **章节树**：扁平标题按「更浅的最近前驱」归并为树（栈式，支持跳级：h1 后直接 h3 挂 h1 下）。有子节点的条目带折叠 chevron（默认全展开），叶子条目占位对齐。**折叠态由 FileView 持有**（2026-08-25 修订：悬浮窗收起即卸载 MdToc，状态上移后跨显隐保留），仅内容更换后重置（旧元素引用失效）。
- **收起/展开**：按钮在 **FileView 工具条**（原在 TOC 头部/窄轨，随悬浮窗化上移）——`ListTree` 图标 + `aria-pressed`（= 展开态），title 随态切「收起目录/展开目录」；窄屏默认隐藏时按钮仍在（供显式展开）。收起 = 悬浮窗整体移除（无窄轨残留）。
- **锚定**：点击条目 `scrollIntoView({ behavior: "smooth", block: "start" })`；标题 `scroll-margin-top: 8px` 留白。
- **不做滚动位置高亮（scrollspy）**：锚点是消费主体，active 追踪是增量收益，等真实诉求。

### 2.5 YAML front matter 元数据卡（2026-08-27 增）

`.md` 文件头部的 `---\nkey: value\n---` 块不再当正文渲染（此前会呈现为两条分隔线夹一段裸 YAML），拆分为元数据卡 + 正文：

- **拆分语义移植 openbuilder** `markdown_html.dart:splitFrontMatter`（不重新发明）：起始 `---` 必须在首字节、闭合线 trim 后恰为 `---`、块内至少一条任意缩进层级的 `key: value`（纯 `---` 夹心 = 分隔线，不是 front matter）；判定成立后 YAML 头恒从正文剥离，元数据卡为尽力提取——只收**顶层标量**条目（含 `|`/`>` 块标量、引号解包、空值 em dash 占位），嵌套容器成员不入卡、纯嵌套容器时无卡但正文仍剥离。实现落 `markdown-frontmatter.ts`（+ 同名测试，用例随移动端移植）。**已知局限**（继承自 openbuilder，review 记录）：闭合围栏按首条 trim 后 `---` 判定，块标量内嵌 `---` 行会被误认闭合线——修需两端口同步偏离，暂记录不修。
- **卡渲染**：FileView 预览态、内容区 `.file-md` 内、markdown 体之上；`<dl>` 键左值右两列 grid（键 mono 弱色，值保留块标量换行）——移动端是上下堆叠，此处按桌面密度改两列。卡在 `.markdown-body` 之外，样式自成一体（`--surface-container` 底 + `--outline-variant` 边）。源码态/TOC 不受影响；拆分结果 memo（同 htmlDoc/imageSrc 决策）。
- **仅文件预览生效**：拆分在 FileView 做，不进共享 `Markdown` 组件——消息流内容以 `---` 开头时（分隔线夹心）不得被误吞。

### 2.6 GFM alert（`[!NOTE]` 系引用块，2026-08-27 增）

GitHub Alerts 规范：blockquote 首段以 `[!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`（大小写不敏感）开头 → 渲染为对应语义提示卡；标记不在首段首块（如普通段落后的引用块）按普通引用块字面渲染。

- **实现位置：共享 `markdown.tsx` 的 blockquote 覆写层**——组件层检查首段文本（streamdown 给每个组件传 hast `node`，但标记剥离在 React children 上做，不动 remark 管道、不传自定义插件替换 streamdown 默认插件集（默认集含 gfm/sanitize/harden，替换有丢失风险））。识别后剥离标记文本、克隆首段，输出 `blockquote.markdown-alert.markdown-alert-{kind}` + 标题行 `p.markdown-alert-title`（lucide 线性图标 16px + canonical 英文标签——标签是文档语义而非 UI chrome，不做 i18n）。**消息流与文件预览同时生效**（同组件，行为一致）。
- **样式**：vendor github-markdown-css 自带 `.markdown-alert` 全套（明暗主题、五色边框与标题色），零新增配色；本地仅补标题图标 8px 间距，并把本地 blockquote 覆写改为 `:not(.markdown-alert)` 让路（原覆写的引用条配色会覆盖 alert 彩边）。

### 2.7 mermaid 图渲染（2026-08-27 增）

` ```mermaid ` 代码块渲染为图（此前在 §3「不做」中标注"引入 mermaid 运行时收益低"——该决策作废：mermaid 本就是 streamdown 依赖树中的传递依赖（锁文件已含，无新增安装成本），桌面端磁盘/内存预算也与移动端不同）。

- **为什么不用 streamdown 内建路径**：streamdown 自带 mermaid 支持，但其分发在默认 `code` 组件内部且 UI 是 Tailwind 样式——本项目 `mdComponents` 全量覆写 code/pre（无 Tailwind），其路径不可达也不合视觉语言。改为 `renderPre` 按语言分发到自建 `MermaidDiagram`（mermaid-diagram.tsx）。openbuilder/opencode session-ui 均未做过 mermaid 渲染，无先例可借，桌面端新设计。
- **懒加载 + 显式依赖**：`import("mermaid")` 动态导入（模块级缓存），electron-vite 自动分包——无 mermaid 块的会话/文档不付出 ~1.4MB chunk 加载成本；因直连导入，`package.json` 显式声明 `mermaid`（^11.17.0，与 streamdown 传递依赖同版本树）。
- **渲染管线**：`mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme })`——strict 级 mermaid 内置 DOMPurify 清洗 SVG（`dangerouslySetInnerHTML` 注入的安全前提）；render 走模块级串行队列（mermaid 内部经全局测量元素排版，并发互相踩踏）+ 递增唯一 id。**主题**（light→default / dark→dark）读取 `document.documentElement[data-theme]` + MutationObserver 监听，切换即重渲染（app 无 store 级主题订阅，属性观察是唯一直连源）。
- **流式友好**：源/主题变化防抖 200ms（流式期间逐 emit render 既昂贵又必然失败）；stale-while-revalidate 保留旧图直到新图落地，不闪加载态。**失败回落代码块外壳**（renderPre 预构建同一 `md-codeblock` 作为 fallback 传入）——流式中图未画完是常态，回落源码比报错卡友好；语法错误同样回落（GitHub 无效 mermaid 亦显示源码），复制按钮/语言标签俱全。
- **样式**：`.md-mermaid` 与代码块同视觉家族（同底色/边框/圆角），居中、svg 限宽自适应（覆盖 mermaid 内联固定尺寸）；消息流 max-height 300px 同 `.md-pre` 内滚，`.file-md` 下放开（同代码块覆写）。加载态为语言标签 + 呼吸骨架（无文案，不引 i18n）。
- **消息流与文件预览同时生效**（共享 `Markdown` 组件）。

### 2.8 相对路径图片（2026-09-07 增）

原 §2.3 标注「相对路径图片不支持」，诉求落地后纳入：预览态 `<img src>` 相对路径以 **md 文件所在目录**为基准解析，经 server `GET /file/content` 拉取（位图 base64 → data URL；svg 文本 → utf8 data URL），复用文件 Tab 图片预览（[design-image-preview.md](./design-image-preview.md)）的 `fileContents` 缓存与 `imageSrcFor` 构建——单一数据通路，无第二份图片状态。

**两段式架构**（管线实测结论所迫，见下）：

1. **remark 阶段预重写**：`Markdown` 增可选 `remarkPlugins` prop（整体替换默认集语义，FileView 拼回默认件 + `relativeImageRewrite`）；插件遍历 mdast `image` 节点与 `definition` 节点（reference 语法 `![alt][ref]` 的 url 在定义上——不改写则 harden 折叠后被覆写消费成错误路径；definition 兼服务 linkReference，扩展名闸门下非图 url 不动、链接行为不变），把可解析的相对 url 改写为 `/` 文件系统绝对路径。mdast 层天然跳过代码块/行内代码（其内容是文本节点）；raw html `<img>` 不经 image 节点，不覆盖；引用与定义跨 streamdown 块时解析本就落回字面文本（既有行为）。
2. **img 覆写消费**：`Markdown` 增可选 `img` prop，FileView 传入模块级 `MarkdownImage`（引用恒稳，streamdown 块级 memo 不失效）；组件识别 `/` 绝对路径 + 图片扩展（`markdownRewrittenImagePath`，解码 `%20` 等 URL 规范化编码）走拉取渲染，其余字面透传 `<img>`。

**管线实测事实（决定上述形态）**：

- streamdown 默认 rehype 管线含 `rehype-harden`（wildcard 配置）+ `rehype-sanitize`（扩展 schema，src 协议白名单 http/https）。harden 会把 `./a.png`/`../a.png` 按 dummy origin（`http://example.com`）折叠成 `/a.png`——`..` 段的基准信息**在 img 组件收到 src 前已丢失**；裸 `a.png`（无 `./` 前缀）直接被拦为占位节点（img 覆写不可达）。而 `/` 开头的输入原样透传（pathname 回写）——故预重写为 `/` 绝对路径可无损穿过整条管线；自定义 scheme 标记（如 `mdimg:`）不可行（sanitize 的 src 协议白名单会剥掉）。
- **streamdown processor 缓存按插件源码文本生成 key**：返回闭包的工厂（`make(baseDir)` 形态）源码恒同，不同基准目录的 md 会撞 key、复用首个文件创建的处理器（实测：先渲染 `/repo` 下的 md，再开 `/repo/docs/` 下的，后者图片按 `/repo` 基准重写出错）。必须以 `[plugin, { baseDir }]` **元组形态**挂载——数组形态的 options 参与 `JSON.stringify` 进 key，基准目录得以区分。

其余要点：

- **解析纯函数** `resolveMarkdownImage(baseDir, src)`（`markdown-image.ts`）：先剥 query/hash（GitHub 口径）；带 URL scheme（`http:`/`data:`/`file:` 等）或协议相对 `//` → 返回 null **不拦截**（字面交给 `<img>`，外链图照常经网络加载）；`/` 开头视作文件系统绝对路径；`decodeURIComponent` 解包（坏 `%` 序列保留原样，不整体失败）；POSIX join + normalize（`.`/`..`/空段折叠）；**扩展名闸门**复用 `isImagePath` 集合（png/jpg/jpeg/gif/webp/avif/bmp/ico/svg，随 `IMAGE_MIME_BY_EXT` 一并自 workspace.tsx 迁入 markdown-image.ts 单一来源）——非图片扩展不解析（维持破图，与「分发只按扩展名，不嗅探内容」同哲学）。
- **数据通路守 D4**（renderer 直连 server，不经 main/IPC）：`store.ensureFileImage(absolutePath)` singleflight 拉取（非 error 缓存命中且不在途才跳过；同图多次引用并发只发一次请求）→ `readFileContent`（作用域取当前 `scopeQuery` directory+workspace，与 FileView 首拉 md 同口径）→ 落 `fileContents` 缓存。与文件 Tab 图片同缓存：先在 md 里看过、再单开图片 Tab 即首帧命中，反向亦然。**error 条目不短路**——瞬时失败（agent 尚未写出图片、server 抖动）在组件重挂载（重开 Tab / 切回预览态）时即重试；error 落地不触发组件 effect 重跑（依赖不变），无重试风暴。**内存注记**：缓存值是兆字节级 base64，无淘汰上限、仅随作用域切换清空——文件 Tab 场景由用户逐个打开天然有界，md 引用是内容驱动自动拉取，一篇多图文档会拉全并常驻（阅读场景接受，未做 LRU）。
- **组件更新环必须自持**：streamdown 块级 memo 下，store emit 引发的父层重渲染到不了块内组件实例——`MarkdownImage` 以 `useSyncExternalStore(store.subscribe, () => fileContents.get(path))` 直订缓存条目（快照 = 条目对象引用，`set` 换引用即触发重渲染；App 层 rAF emit 合帧不影响此通路）；挂载 effect 触发 `ensureFileImage`。
- **消息流不启用**（不传 img/remarkPlugins）：会话文本的相对路径无基准目录语义（消息非文件产物），维持现状；components 引用恒为模块级 `mdComponents`，既有 memo 语义不变。
- **状态渲染**：在途/无条目 → 内联占位 chip（alt 文本，无 alt 用文件名）；失败（server 错误 / 内容构建不出 data URL）→ 占位 chip + `mdImageFailed` 文案（title 悬浮看错误详情，不静默破图）；成功 → `<img src=data URL>`。解码失败不可能在占位路径外发生（src 已是 data URL，非 data 路径均被解析层放行给浏览器）。
- **不跟随 file watch**：图片文件自身变更不触发重拉（监听只覆盖打开的 file Tab，md 引用的图片不是 Tab）；成功条目重开 Tab 也不重拉（缓存命中），**error 条目重开 Tab 即重试**（见上），重启全量刷新。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| ~~mermaid 图表渲染~~ | 已做（2026-08-27，§2.7）：mermaid 是 streamdown 既有传递依赖，懒加载零增量成本 |
| ~~模式偏好持久化（记住上次源码/预览）~~ | 已做运行期按文件记忆（2026-08-26，见 [design-tab-state-memory.md](./design-tab-state-memory.md) §2.2）；per-profile 跨文件偏好仍不做 |
| 消息流相对路径图片 | 消息文本非文件产物，无基准目录语义（可按会话 directory 解析，等真实诉求再评） |
| 相对图片跟随 file watch 重拉 | 监听仅覆盖打开的 file Tab（design-file-watcher）；重开 Tab / 重启即刷新 |
| raw html `<img>` 相对路径 | 不经 mdast image 节点（预重写不可达）；仅支持 markdown 图片语法 |
| 非 POSIX（Windows 盘符 `C:\`）src | 主力环境 Linux（GNOME/Wayland，打包 arch/fedora）；该形态 src 罕见 |
| 内部相对链接跳转（md → md 导航） | nice-to-have（openbuilder 同标注），等真实需求 |
| TOC 滚动位置高亮（scrollspy） | 见 §2.4：锚点是消费主体，增量收益有限 |
| 预览内容键盘可达（放开链接/复制按钮 tabIndex） | 复用 `Markdown` 继承消息流「内容不入焦点序列」决策（review P3 备注）；后续需要时给组件加 interactive 变体 |
| mermaid 图交互（缩放/平移/导出 PNG） | streamdown 内建有 zoom/pan/下载控件（Tailwind 样式，不合本项目视觉语言）；渲染阅读优先，交互等真实诉求 |

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/workspace.tsx` | FileView：扩展名分发 + markdown mode（工具条 + 预览/源码 + TOC 收起态与工具条按钮）+ TOC 标题扫描与布局 + front matter 拆分 memo 与元数据卡（§2.5）+ MarkdownImage 组件与注入（§2.8；`isImagePath`/`IMAGE_MIME_BY_EXT` 迁出） |
| `src/renderer/src/components/markdown-image.ts` | `resolveMarkdownImage` 解析 + `relativeImageRewrite` remark 预重写插件 + `markdownRewrittenImagePath` 覆写侧消费 + `isImagePath`/`IMAGE_MIME_BY_EXT` 迁入（§2.8，单一来源）+ 同名测试 |
| `src/renderer/src/components/markdown-frontmatter.ts` | `splitFrontMatter`（语义移植 openbuilder）+ 同名测试（用例随移动端移植） |
| `src/renderer/src/components/markdown.tsx` | 消息流共享渲染器：blockquote 覆写增加 GFM alert 识别/标记剥离（§2.6）+ 可选 `img` 覆写 prop（§2.8）+ 测试用例 |
| `src/renderer/src/components/mermaid-diagram.tsx` | mermaid 懒加载/串行渲染/主题跟随/失败回落（§2.7）+ markdown.test.tsx 用例（vi.mock mermaid） |
| `src/renderer/src/components/md-toc.tsx` | TOC 悬浮窗：标题收集/章节树/按章节折叠/点击锚定（收起态由 FileView 控制） |
| `src/renderer/src/store/app-store.ts` | `ensureFileImage`：md 相对图片 singleflight 拉取落 `fileContents`（§2.8） |
| `src/renderer/src/i18n/index.ts` | `preview` / `source` / TOC / `mdImageFailed` 文案 |
| `src/renderer/src/styles/tokens.css` | `--file-toolbar-h`（工具条高度单一来源）、`--toc-w` / `--toc-gap` |
| `src/renderer/src/styles/app.css` | `.file-view-wrap`（`--file-md-min/max`、TOC 绝对定位锚）/ `.file-toolbar(.file-toolbar-toc)` / `.file-md` / `.md-toc*` / `.md-img-pending`/`.md-img-failed`（§2.8） |
| `src/renderer/src/components/resize-observer-stub.ts` | ResizeObserver 测试 stub（jsdom 缺失；测宽用例手动触发） |
| `src/renderer/src/components/file-view.test.tsx` / `md-toc.test.tsx` | FileView 分发与二态切换 + TOC 行为测试（含窄屏默认隐藏）+ 相对图片用例（§2.8） |

## 5. 验收

- 打开 `.md` 文件默认渲染预览；切换源码显示原文；非 md 文件无工具条、行为不变；
- 带 YAML front matter 的 `.md`：预览态顶部呈现元数据卡（键左值右，块标量保留换行），正文不再出现裸 YAML/双分隔线；纯嵌套容器 front matter 无卡但正文已剥离；无映射的 `---` 夹心按普通分隔线渲染；源码态原样显示全文；消息流中 `---` 开头的消息不受影响；
- `[!NOTE]`/`[!TIP]`/`[!IMPORTANT]`/`[!WARNING]`/`[!CAUTION]` 引用块渲染为对应颜色的 alert 卡（标记剥离、标题行图标 + 标签）；未知标记或标记不在首段按普通引用块字面渲染；消息流同样生效；
- ` ```mermaid ` 块：懒加载后渲染为图（明暗主题跟随 `[data-theme]`，切换重渲染）；语法错误/流式未完成回落代码块外壳（源码可见、可复制）；无 mermaid 块的文档不加载 mermaid chunk；消息流同样生效；
- 有标题的 `.md` 预览：内容区 [600, 800] 自适应居中；侧缘够宽时 TOC 悬浮窗挂内容区左侧；滚动条贴窗口右缘、滚动时悬浮窗常驻可见、高度不超可见区（超出自滚）；悬浮窗会遮挡内容区时默认收起、工具条按钮可显式展开（悬浮覆盖内容区）；可按章节收起/展开、工具条按钮可整体收起/展开悬浮窗、点击条目平滑滚动锚定到对应标题；无标题文档无 TOC 无按钮；源码态无 TOC；
- 相对路径图片（§2.8）：`![](./img/a.png)` 先占位 chip 后渲染图；`../` 上跳、`%20` 空格、svg 相对路径均正确解析渲染；引用不存在的图呈错误占位（title 可看详情，不静默破图）；同图多次引用只发一次请求（singleflight）；外链 `http(s)`/data URL 图照常渲染不经拉取；消息流 markdown 图片行为不变；
- `npm run test` / `npm run typecheck` 全绿。
