---
version: 1
name: openbuilder-desktop-design
description: |
  openbuilder-desktop 视觉设计令牌系统。按设计主题组织：配色 / 字体 / 排版 /
  图标 / 组件 / i18n，末章简述与移动端 openbuilder 的异同。
  token 唯一权威落点 src/renderer/src/styles/tokens.css。

inherited-from: openbuilder/DESIGN.md@v2
colors:
  seed-dark: "#4ADE80"
  seed-light: "#16A34A"
  scaffold-dark: "#0E0F12"
  scaffold-light: "#F7F8FA"
  # colorScheme dark/light 全量沿用 openbuilder v2（primary #98D4A3/#35693E 等，
  # 见 src/renderer/src/styles/tokens.css；桌面端偏离见「配色」章）
  # appColors（code/link/userBubble/border…）与 status（completed/running/error/pending）同上

typography:
  font-stack:
    sans: "system-ui"          # GNOME: Adwaita Sans/Cantarell → mac: SF → Win: Segoe
    mono: "ui-monospace, monospace"  # GNOME: Source Code Pro/Adwaita Mono 优先
  scale:
    ui-xs:    { size: 11, weight: 400, usage: Tab 徽标、时间戳、路径 meta }
    ui-sm:    { size: 12, weight: 400, usage: 面板标题/底部状态行（chrome 文字）、次级标签、chip 标签、面包屑 }
    ui-md:    { size: 13, weight: 400, usage: 界面正文基准（列表、表单、菜单） }
    title-sm: { size: 14, weight: 600, usage: 面板标题、卡片标题 }
    title-md: { size: 16, weight: 600, usage: 弹窗标题、空态标题 }
    hero:     { size: 24, weight: 300, usage: 空态/欢迎页大标题（仅 Light） }
    chat-md:  { size: 14, weight: 400, lineHeight: 1.6, usage: 聊天正文 }
    mono:     { size: 13, weight: 400, usage: 代码、路径、终端、diff }
  weights: [300, 400, 600]     # 三档制沿用，禁 500/700

density:
  grid: 4px
  row-tree: 26px
  row-list: 30px
  tabbar: 36px
  input: 32px
  button: 28px
  icon-chrome: 12px    # 与同排文字（ui-sm）同尺寸：面板标题/底部状态行/行内 chip
  icon-compact: 14px   # 紧凑功能区：Tab 条、标题栏窗口控制
  icon-main: 16px      # 树行/主功能区（列表行、工具条、卡片头）

rounded:
  chip: 6px
  card: 8px
  bubble: 12px
  dialog: 12px
---

## 概述

openbuilder-desktop 与移动端 openbuilder 共享品牌基因（绿色种子、令牌语义、三档字重、i18n 原则），但**不为移动端妥协**：信息密度、控件尺寸、交互形态全部按桌面习惯重新设计。本文按设计主题（配色、字体、排版、图标、组件……）组织；与移动端的关系概括为一句话——配色/i18n 单向继承（移动端 v2 为源），排版与组件各自独立演进——异同细节收敛在末章「与 openbuilder 移动端的异同」，各主题章节内的具体偏离就地标注。

## 配色

### 令牌构成与载体

- 三组令牌：
  - `colorScheme` —— dark/light 两套语义色（primary、surface 阶梯、outline 系、inverse 系）
  - `appColors` —— colorScheme 未覆盖的语义扩展色（code/link/codeBackground/border/quoteBar/userBubble 系）
  - `status` —— 工具四态色（completed/running/error/pending）
- 三组取值逐值沿用 openbuilder v2，定义收敛到 `tokens.css` 单文件
- 实现载体：`:root[data-theme=…]` 两套 CSS 自定义属性（移动端为 Flutter `ColorScheme.fromSeed()` + `ThemeExtension`）；跟随系统（`prefers-color-scheme`）+ 手动切换
- 深色为默认主题（开发者工具惯例，且主力环境 GNOME 多为深色）

### 桌面端偏离（2026-08-27 六项修订，未注明处 dark/light 分别处理）

1. **前景降对比**——工作区（消息、文件浏览等大面积阅读区）正文对背景原 14.3:1(dark)/16.9:1(light) 过强：dark `on-surface`/`on-surface-variant` `#dfe4dc`/`#c1c9bf` → `#c8d0c4`/`#adb6ab`，light `on-surface` `#181818` → `#2e332e`；dark variant 同步降档防与新正文塌缩（light variant 原本低一截不动），`on-surface > on-surface-variant > outline` 三档层级与中性绿色相族不变，dark `inverse-surface` 维持与 `on-surface` 同值镜像
2. **实心强调面统一**——用户气泡、agent 分段（build/plan）激活态、enable 态主按钮（发送等）共用同一深绿底+浅字 `--emphasis-bg`/`--emphasis-fg`；`--color-user-bubble`/`--color-user-text` 改为其别名，`.ms-seg.active`（原 primary-container 对，亮色浅底深字）与 `.btn-primary`（原 --primary/--on-primary，暗色浅绿底深字）统一切换；`.ms-seg` 为 agent 二态与文件视图预览/源码共用组件，后者激活态同步同款。强调面默认 `#1f3d2a`+`#f0f5ee`，light 单独覆写 `#2b573c`（同色相 142°，L* 23→35——L*≈23 对浅色 surface L*≈95 跨 72 档过强）+`#f9fcf7`；文字对比按"气泡内 ≈ agent 正文对背景"校准——dark 10.8 vs 11.0:1（精确对齐），light 8.0 vs 11.4:1（气泡底较暗，纯白上限 8.3:1，已至物理上限的折中）
3. **次级钮同风格化**——`.btn-tonal` 由灰底填充（观感似禁用）改为与 primary 同风格的无描边浅绿底+深绿字（primary-container 对）——"次级"由明度对比表现（浅容器 vs 实心强调）；中间曾改描边次级钮，因与实心按钮族风格差异过大再修订为容器色方案；hover brightness 1.08
4. **危险钮浅色实心红**——`.btn-danger`（停止/拒绝）浅色覆写为 `--error`/`--on-error`（红底白字 `#ba1a1a`/`#ffffff`），与实心强调面样式协调；暗色保持 `--error-container` 对（深红底浅字，本即实心观感）
5. **dark 用户气泡文字对齐正文**——仅 `userText` `#dfe4dc` → `#c8d0c4`（对齐 on-surface，收敛与 agent 正文的文字明度差；气泡底与气泡内代码块底保持 openbuilder 原值——曾试降气泡底至 L*≈13.5 消块面明度断层，但与 surface（L*≈9）对比不足、轮廓难辨，回退）；light 的深底气泡是刻意倒装设计（同 openbuilder），不动
6. **背景跨应用明度衔接**——应用主题不必与系统/邻接应用一致（亮色浏览器 ↔ 暗色主题、深色终端 ↔ 亮色主题），背景避免走向明度极端以收窄切换跳变：dark 表面阶梯整体 +6/通道（base `#101510` → `#161b16`，L*≈6→9，向 VS Code/GNOME dark L*≈11–14 靠拢），light 阶梯整体 −9/通道（base `#f7fbf2` → `#eef2e9`，L*≈98→95，略低于浏览器白/GNOME light L*≈98–100）；阶梯档差与色相族不变，代码块底色随各自 base 同幅移动（dark `#161b22`→`#1a2027`、light `#f0f2f5`→`#e9edf0`）保持"dark 浮起/light 微沉"的块面关系；其余语义色仍逐值沿用

### 使用规范

- 优先语义角色，不硬编码 hex：`on-surface` 主文字、`on-surface-variant` 次级、`outline` 再次级、`surfaceContainer*` 容器背景
- `status` 四色是唯一硬编码豁免（语义固定的状态指示，不随主题变化）
- 新增色必须先走令牌；确需扩展时加入 tokens.css 并定义深浅两态

## 字体

### sans/mono 两轨制

| 轨 | 栈 | 平台实现 | 分工 |
|---|---|---|---|
| sans | `system-ui` | GNOME: Adwaita Sans/Cantarell → mac: SF → Win: Segoe UI | 正文、标签、标题、菜单——一切文案角色 |
| mono | `ui-monospace, monospace` | GNOME 下 Source Code Pro/Adwaita Mono 优先 | 代码、路径、终端、diff——仅内容角色 |

- mono 只出现在代码/路径/终端/diff 内容中，标签一律 sans，两者不混用——chip 外是标签，chip 内是代码
- 不引入 webfont，跟随各平台原生 UI 字体（移动端用 MiSans，见末章）

### 三档字重制

| 字重 | 名称 | 角色 |
|---|---|---|
| 300 | Light | 仅大号 hero 标题（空态/欢迎页），小号文字不用——发虚、层级不足 |
| 400 | Regular | 正文、标签、次级信息（默认档） |
| 600 | Semi Bold | 强调、标题、加粗（最重一档） |

- 层级靠「字号 + 三档字重」组合表达，需要强调从 400 直跳 600，不设中间字重
- 禁 500（次级标签与正文争抢注意力）、禁 700（小号文字笔画黏连）、禁 `bold`/`normal` 语义别名，一律写数值
- Markdown 加粗显式 600，不依赖浏览器默认 bold (700)

## 排版

### 字号标度

| 令牌 | 字号 | 字重 | 行高 | 用途 |
|---|---|---|---|---|
| `ui-xs` | 11 | 400 | – | Tab 徽标、时间戳、路径 meta |
| `ui-sm` | 12 | 400 | – | 面板标题/底部状态行（chrome 文字）、次级标签、chip 标签、面包屑 |
| `ui-md` | 13 | 400 | – | 界面正文基准（列表、表单、菜单） |
| `title-sm` | 14 | 600 | – | 面板标题、卡片标题 |
| `title-md` | 16 | 600 | – | 弹窗标题、空态标题 |
| `hero` | 24 | 300 | – | 空态/欢迎页大标题（仅 Light） |
| `chat-md` | 14 | 400 | 1.6 | 聊天正文 |
| `mono` | 13 | 400 | – | 代码、路径、终端、diff |

- 界面基准字号 **13px**（VS Code/Electron 惯例）；聊天正文 14 保持阅读舒适
- 强调用 600 直跳；次级信息用 `ui-sm` + `outline` 降权，不加中间字重

### 密度与间距

- 4px 网格：4/8/12/16/24；面板内边距 12，弹窗 16/24
- 控件与行高令牌：树行 26 / 列表行 30 / Tab 条 36 / 输入框 32 / 按钮 28——鼠标精度密度（移动端 48px 触控目标不适用，见末章）
- 状态点 8px（`status` 色）

## 图标（lucide 单一体系）

- **来源唯一**：全部图标来自 `lucide-react`，线性 outline 风格，`strokeWidth` 一律默认 2 不自定义。**禁用 Unicode 字符/emoji 充当图标**（✕ ✓ ⚙ ⚠ ✎ + × 等）——字形随系统字体漂移（粗细/基线跨平台不一致）、笔触与线性体系不协调（2026-08-29 已全量替换清零，后续新增图标不得回退）
- **尺寸三档**（token `--icon-chrome/compact/main`，落点 tokens.css）：
  - **12**：与同排 `ui-sm` 文字同尺寸——面板标题（左栏/右栏）、底部状态行、chip 行内（如 file-ref 移除钮）
  - **14**：紧凑功能区——Tab 条（关闭/新建）、标题栏窗口控制、diff/浏览器工具条
  - **16**：树行与主功能区——项目/worktree 行操作钮、卡片头、列表行
- **明度与颜色**：图标颜色一律继承所在文字的语义色（`currentColor`），与同排文字同明度，不单独设色；语义强调例外（如连接错误 `TriangleAlert` 套 `--status-error`）。面板 chrome 区（标题/底部）文字与图标统一 `onSurfaceVariant`——曾出现文字 `outline` 比同排图标暗一档的明度倒挂，已修订
- **可访问性**：装饰性图标一律 `aria-hidden`；纯图标按钮必须带 i18n 词条的 `title` + `aria-label`

## 组件

### 圆角

圆角令牌不独立成篇，随组件落位：

| 令牌 | 值 | 落位 |
|---|---|---|
| `chip` | 6px | 折叠条、代码块、按钮 |
| `card` | 8px | 卡片 |
| `bubble` | 12px | 用户气泡 |
| `dialog` | 12px | 弹窗 |

### 规格表

桌面组件族按 design-layout.md 的结构推导，规格：

| 组件 | 规格 |
|---|---|
| 三栏容器 | 面板分隔线 1px `outlineVariant`；栏标题 `ui-sm` + `onSurfaceVariant` 色（2026-08-29，原 `outline` 与同排 Plus 图标钮明度倒挂） |
| 标题栏（Linux） | 高 36，`surfaceContainerLow` 底 + 1px `outlineVariant` 下边、标题「OpenBuilder」`ui-sm` 整栏水平居中（2026-08-26，绝对定位铺满 + `pointer-events:none`）；整体拖拽区，右侧控制钮 44×36（lucide 14px `onSurfaceVariant`，hover `surfaceContainerHigh`，关闭钮 hover `error` 底 + `onError` 图标）；仅 Linux frameless 渲染，深/浅主题随 token 切换 |
| Tab 条 | 高 36；Tab：图标 16 + 标题 `ui-md`，激活态底部 2px `primary` 指示线 + `surfaceContainerLow` 底；流式中 Tab 标题前置 8px running 状态点 |
| 项目/工作区树（左栏） | 项目行自适应高（≥30，常态 ~40）：26px 圆角头像（`icon.override` > `icon.url` 图片（data:/https:，失败回退）> 名称首字母；色 = `icon.color` 命名色 > 名称哈希，与 openbuilder ProjectAvatar 跨端同色，调色板 token `--avatar-*`；色框/淡染底仅字母瓷片有，自定义图片态裸图（2026-08-24，同移动端））+ 右侧两行——名称 `ui-md` 600 + 路径 `ui-xs` `outline`（行内截断，title 全量）；worktree 行 26（16px 线性 worktree 图标（lucide `folder-git-2`）+ `ui-md` 名称 + 分支，名称文本与项目名文本左对齐（2026-08-24，行 padding-left 16 = 项目行 6+26 头像+6 间距 − 22 图标占位））；行三态纯背景色（2026-08-24 修订，弃用原左侧 2px `primary` 竖线）：未选中透明（承左栏 `surfaceContainerLow` 底）、hover `surfaceContainerHigh`、选中 `surfaceContainerHighest` 叠 4% `onSurface` 微加深（浅色主题 high/highest 色差过小，背景是唯一选中信号）——选中底取中性 surface 而非 `primary` 淡染，避免与行内四色指示器（琥珀/绿/灰/红状态点及聚合 chip）争色，深/浅主题均适用；行内操作钮 = 绝对定位带背景 overlay（2026-08-29 修订，`.row-actions`：右缘 4px + 内衬 2px，左起 40px 渐变淡出区由透明渐入行底色 + 实底胶囊，终点色 = 行当前 hover 底色，hover 行时显、默认隐）不占行内流式空间，名称/路径截断只看行宽与其自身的省略，行尾文本被渐隐遮盖；会话状态指示器为行内流式元素（名称/路径行尾，hover 行时隐藏让位 overlay） |
| 会话列表 | 行 30；标题 `ui-md` 400，hover `surfaceContainerLow`，激活 `surfaceContainer`；归档区折叠头 `ui-sm` `outline` |
| 文件树 | 行 26，`ui-md`；目录/文件图标 16 线性；行三态与项目/工作区树同款（共享 `.tree-row`，2026-08-24 起） |
| 消息流 | assistant：无底色全宽块，`chat-md`；user：`userBubble` 色块 + `rounded.bubble`，内边距 12×16，用户文字 `userText` |
| 输入中提示（TypingSlot） | 消息流末尾常驻固定高 28px 槽位（idle 时兼作底部留白）：busy = 三点脉冲（6px/间距 4/`outline` 色，opacity 0.3↔1.0、900ms、相位差 300ms）；retry = 旋转图标 + 单行截断文案；显隐只动 opacity，禁止布局属性（见 docs/design-typing-indicator.md） |
| 消息 markdown（assistant 正文/reasoning） | 块间距 8（flex gap）；标题两档：h1/h2=`title-md` 600、h3+ =`title-sm` 600；行内代码 `code` 色 + `codeBackground` 底 + 4px 圆角 + 0.92em mono；代码块与 chip 展开体同款（`codeBackground` 底 + `border` 边 + `rounded.chip`，头部高 26 含语言标签 `ui-xs` `outline` + 复制按钮）；引用 3px `quoteBar` 左栏 + `onSurfaceVariant`；表格 `border` 全框 + 表头 600 + `surfaceContainerLow` 底；链接 `link` 色；任务列表去符号 + checkbox `primary` |
| 输入区 | min-height 32 自增高，`surfaceContainerLow` 底 + 1px `outlineVariant` 边，focus 1px `primary`；发送按钮 28×28 |
| 焦点环（全局，2026-08-24 二次修订） | 键盘焦点（`:focus-visible`）**复用各控件 hover 样式**（hover 规则以 `, :focus-visible` 并列扩展），不设独立焦点环——描边环在贴边控件（标题栏钮/Tab 条）被裁剪只剩竖线、在自带边框控件（ms-pill/ms-seg）上成双框；UA 默认环全局压制；文本输入类沿用 1px `primary` 边框；原生 checkbox 无 hover 可复用，保留 2px `primary` 环；原无 hover 的可聚焦控件（status-cluster/pending-card-header/settings-tabs 钮/profile-row 钮/settings-defaults 清除钮）按同层 idiom 补齐 hover |
| 设置弹窗 | 640×min(480, 80vh)，`rounded.dialog`，遮罩 rgba(0,0,0,.5)；表单标签 `ui-sm`，控件 32 |
| 服务器状态行（左栏底部） | 高 30（22 控件 + 上下 4 padding），`ui-sm`（2026-08-29，原 `ui-xs` 比同排 12px 齿轮小、且与标题档位割裂）；状态点 8px：streaming=`status.running`、degraded=`status.pending`、offline=`status.error`、对账中=running 闪烁；连接错误为 `TriangleAlert` 12px `status.error`（2026-08-29，原 `⚠` 字符）；左状态右设置齿轮（lucide `Settings` 12px 同文字），置底常驻不随项目区变化；服务器版本不展示（2026-08-24 收编自原全宽状态栏） |

### 按钮（五类可复用样式，2026-08-29）

实现落点 `src/renderer/src/styles/app.css`「通用按钮族」区块，取值全部走 tokens.css（`--control-h` 28、`--radius-chip` 6、`--icon-toolbar` 20）。五类之外不新造按钮样式，变体通过在既有类上追加修饰类扩展：

| 类型 | 类名 | 形态 | 用途（选型口径） |
|---|---|---|---|
| 主要 | `.btn-primary` | 实心强调面：`emphasis-bg`/`emphasis-fg` 底字对（2026-08-27 统一），28 高、chip 圆角、水平内边距 14、`ui-md`；hover 抬亮 1.08 | 一屏/一流程的唯一主动作（发送、确认、同意） |
| 次要 | `.btn-tonal` | 浅绿容器：`primary-container`/`on-primary-container`（无描边，"次级"由明度对比表现），同骨架，hover 抬亮 1.08 | 次级/辅助动作（撤销、总是允许、diff 折叠切换） |
| 危险 | `.btn-danger` | dark `error-container`/`on-error-container`（本即实心观感）；light 覆写实心红 `error`/`on-error`（2026-08-27）；hover 抬亮 1.1（略强一档） | 停止/拒绝/删除等破坏性动作 |
| 图标钮 | `.icon-btn` | 透明底 22×22、4px 圆角、`onSurfaceVariant`；hover `surfaceContainerHighest` 底 + `onSurface` | 行内/工具栏图标操作（关 Tab、行删除、消息复制、TOC 开关）；尺寸/底色按场景加变体类覆写（tab-close/tabbar-new/msg-action 等）；左栏树行操作钮置于 `.row-actions` overlay 胶囊内（2026-08-29，见左栏树行） |
| 磁贴 | `.btn-tile`（名称用 `.btn-tile-label`） | 96px 等宽、5:4 比例，`surfaceContainerLow` 底 + 1px `outlineVariant` 边；icon 20（`--icon-toolbar`）在上、名称 `ui-sm` 在磁贴内 icon 下方（间距 8）；hover `surfaceContainerHigh` | 大目标入口（引导页 Tab 入口），不用于 28 高行内场景 |

通用规则：

- 文本三兄弟（主要/次要/危险）骨架（高/圆角/内边距/字号）收敛在一条共享规则，改一处三钮同步；全局 button reset（tokens.css）已含字体继承、无边框、pointer 光标
- 三钮统一禁用态：opacity 0.5 + not-allowed；「焦点即 hover」原则同样适用（`:focus-visible` 并列进 hover 规则）
- 一次交互只放一个主要钮；授权卡同排多钮从左到右 = 危险｜次要｜主要（once/always/reject 语义序）
- 弹窗内无类按钮沿用 `.dialog-actions button` 灰底兜底（quiet 档），主要钮覆写见 app.css 该区块注释（特异性修复，2026-08-27）

## Agent 行为的呈现原则（参考 Agentic Design Patterns）

设计原则级约定，先于具体组件规格——聊天组件设计以"忠实呈现 agent 行为模式"为准绳：

1. **工具调用（tool use）= 可折叠 chip**：沿用移动端 chip 骨架概念，桌面版为行内折叠条（高 28，chevron 16 + 工具名 `ui-sm` sans + 状态点）；展开体 = 输入/输出两个 mono 块（`appColors.codeBackground` + `border`），长输出内部滚动不撑高消息
2. **推理/思考（reflection）= 弱化呈现**：斜体 + `outline` 色展开体，与正文明确区分"内部推理"地位
3. **进行中的活动 = 状态可见**：running 态在 Tab、会话列表、chip 三处同步呈现（status 色 + 指示点），离屏也能从边缘感知
4. **人机协同（human-in-the-loop）= 权限卡占位**：v0.1 仅占位呈现（拒绝/同意按钮置灰），v0.2 补交互
5. **错误（exception）不静默**：`errorContainer` 底色卡片 + onErrorContainer 文案，附重试入口（对账层联动）

## i18n

- 中/英双语（实现方案同源移动端 `docs/design-i18n.md`），三条原则照搬：
  1. **英文是重写，不是翻译**——按 UI 场景用英文习惯重新表达，不逐字翻译
  2. **用单复数不敏感的句式**——`session: 4` 而非 "4 sessions"，减少 plural 分支
  3. **图标优先但警惕跨文化歧义**——✓/✗ 同符不同义，含义可能歧义时辅以文字消歧
- 文案 key 尽量与移动端 ARB 对齐（同场景同 key），便于双端文案统一维护；实现从 ARB 改为 ts/json catalog（轻量 ICU，不引 i18n 框架）
- 时间格式：相对时间（3 min ago / 3 分钟前）规则与移动端一致

## Do / Don't

### Do

- 新组件先查 tokens.css 语义色；状态色只用 `status.*`
- 按钮从五类可复用样式（§按钮）选型，新场景先复用既有类再加修饰类，不写一次性按钮样式
- 强调用 600 直跳；次级信息用 `ui-sm` + `outline` 降权，不加中间字重
- 文案新增 key 时同步中英两份 catalog，并对照移动端 ARB 是否已有同场景 key
- 长列表（会话、消息、文件树）一律虚拟化渲染
- 新增图标从 lucide-react 现有集中选取，按三档落位（12 同文字 / 14 紧凑 / 16 主区），颜色继承所在文字语义色

### Don't

- 不从移动端 DESIGN.md 抄组件规格（48px 触控、AppBar、Material 图标尺寸均不适用）
- 不在标签/标题用 mono；不在代码块用 sans
- 不引入 500/700 字重与第四档强调
- 不硬编码 hex（status 四色与遮罩黑除外）
- 不用 Unicode 字符/emoji 充当图标；不改 lucide 默认 strokeWidth；图标不脱离所在文字单独配色

## 与 openbuilder 移动端的异同

两份 DESIGN.md 的关系是**单向继承**：配色与 i18n 以移动端 v2 为源，桌面端只做局部偏离（见「配色」章，偏离均在本文内记录依据，不改源头）；排版、密度、图标与组件由桌面端独立演进。两件套各改各的，不追求规格同步。

**相同（共享品牌基因）**

- 绿色种子（`#4ADE80` dark / `#16A34A` light）与 scaffold 底色
- `colorScheme` 语义角色体系、`appColors` 扩展、`status` 四态色
- 三档字重制（300/400/600，禁 500/700）与「字号 + 字重」层级法
- sans/mono 两轨分工
- i18n 三原则与 ARB 对齐策略
- 关键组件概念：可折叠 chip 骨架、用户气泡深底倒装、ProjectAvatar 跨端同色

**不同（按桌面习惯重设计）**

| 维度 | openbuilder（移动） | desktop |
|---|---|---|
| 正文字体 | MiSans（小米） | `system-ui`（各平台原生 UI 字体） |
| mono 回退 | DejaVu Sans Mono → Menlo → Courier New | `ui-monospace`（GNOME: Source Code Pro/Adwaita Mono） |
| 界面基准字号 | 12–14，偏小屏优化 | **13px**（VS Code/Electron 惯例） |
| 密度 | 触控目标 48px | 树行 26 / 列表行 30 / 按钮 28，鼠标精度密度 |
| 图标 | Material，24px 标准档 | lucide 线性，12/14/16 三档 |
| 实现载体 | Flutter `ColorScheme.fromSeed()` + `ThemeExtension`，ARB 文案 | CSS 自定义属性（tokens.css 单点），ts/json catalog |
| 组件规格 | AppBar、48px 命中区、Material 图标 | 标题栏/Tab 条/三栏树组件，见「组件」章 |

配色层面的六项桌面偏离（前景降对比、实心强调面、按钮同风格化、背景明度衔接等）详见「配色」章，不在此重复。
