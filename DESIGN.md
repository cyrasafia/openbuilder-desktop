---
version: 1
name: openbuilder-desktop-design
description: |
  openbuilder-desktop 视觉设计令牌系统。配色与 i18n 原则沿用 openbuilder（移动端），
  字体/字号/字重与信息密度遵循桌面端习惯，组件为桌面端全新设计。

inherited-from: openbuilder/DESIGN.md@v2
colors:
  seed-dark: "#4ADE80"
  seed-light: "#16A34A"
  scaffold-dark: "#0E0F12"
  scaffold-light: "#F7F8FA"
  # colorScheme dark/light 全量沿用 openbuilder v2（primary #98D4A3/#35693E 等，
  # 见 src/renderer/src/styles/tokens.css，此处为唯一权威定义点）
  # appColors（code/link/userBubble/border…）与 status（completed/running/error/pending）同上

typography:
  font-stack:
    sans: "system-ui"          # GNOME: Adwaita Sans/Cantarell → mac: SF → Win: Segoe
    mono: "ui-monospace, monospace"  # GNOME: Source Code Pro/Adwaita Mono 优先
  scale:
    ui-xs:    { size: 11, weight: 400, usage: 状态栏、Tab 徽标、时间戳 }
    ui-sm:    { size: 12, weight: 400, usage: 次级标签、chip 标签、面包屑 }
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
  statusbar: 24px
  input: 32px
  button: 28px
  icon-inline: 16px
  icon-toolbar: 20px

rounded:
  chip: 6px
  card: 8px
  bubble: 12px
  dialog: 12px
---

## 概述

openbuilder-desktop 与移动端 openbuilder 共享品牌基因（绿色种子、令牌语义、三档字重、i18n 原则），但**不为移动端妥协**：信息密度、控件尺寸、交互形态全部按桌面习惯重新设计。两份 DESIGN.md 的关系——配色/i18n 单向继承（移动端 v2 为源），排版与组件各自独立演进。

## 沿用自 openbuilder 的部分

### 配色（全量沿用，CSS 变量为载体）

- `colorScheme`（dark/light 两套语义色）、`appColors`（code/link/userBubble/border 等语义扩展色）、`status` 四态色（completed/running/error/pending）**逐值沿用**，定义收敛到 `tokens.css` 单文件
- 实现差异：Flutter `ColorScheme.fromSeed()` → CSS 自定义属性两套 `:root[data-theme=…]`；跟随系统（`prefers-color-scheme`）+ 手动切换
- 使用规范同源：优先语义角色，不硬编码 hex；`status` 四色是唯一豁免
- 深色为默认主题（开发者工具惯例，且主力环境 GNOME 多为深色）

### i18n（原则与文案库沿用）

- 中/英双语，三条原则照搬：**英文是重写不是翻译**、**用单复数不敏感的句式**（`session: 4` 而非 "4 sessions"）、**图标优先但警惕跨文化歧义**
- 文案 key 尽量与移动端 ARB 对齐（同场景同 key），便于双端文案统一维护；实现从 ARB 改为 ts/json catalog（轻量 ICU，不引 i18n 框架）
- 时间格式：相对时间（3 min ago / 3 分钟前）规则与移动端一致

### 设计原则（组件层约束）

- 层级靠「字号 + 三档字重」组合，最重 600，需要强调从 400 直跳 600
- sans/mono 两轨分工：mono 只出现在代码/路径/终端/diff 内容中，标签一律 sans
- 语义色优先；新增色必须先走令牌

## 桌面端重新设计的部分

### 排版与密度（遵循桌面习惯，与移动端的差异）

| 维度 | openbuilder（移动） | desktop |
|---|---|---|
| 界面基准字号 | 12–14，偏小屏优化 | **13px**（VS Code/Electron 惯例） |
| 聊天正文 | 14 | 14（保持阅读舒适） |
| 密度 | 触控目标 48px | **树行 26 / 列表行 30 / 按钮 28**，鼠标精度密度 |
| mono | 13 + DejaVu 回退栈 | 13 + `ui-monospace`（GNOME 下 Source Code Pro/Adwaita Mono） |
| 字体 | MiSans（小米） | `system-ui`（各平台原生 UI 字体） |

- 间距 4px 网格：4/8/12/16/24；面板内边距 12，弹窗 16/24
- 图标：线性图标（lucide），内联 16px、工具栏 20px；状态点 8px（`status` 色）

### 组件（全新设计，v0.1 首批）

桌面组件族按 design-layout.md 的结构推导，规格：

| 组件 | 规格 |
|---|---|
| 三栏容器 | 面板分隔线 1px `outlineVariant`；栏标题 `ui-sm` + `outline` 色 |
| Tab 条 | 高 36；Tab：图标 16 + 标题 `ui-md`，激活态底部 2px `primary` 指示线 + `surfaceContainerLow` 底；流式中 Tab 标题前置 8px running 状态点 |
| 项目/工作区树（左栏） | 项目行 30（`title-sm` sans + 活跃时间 `ui-xs`）；worktree 行 26（`ui-md`，缩进 16）；当前项左侧 2px `primary` 竖线 |
| 会话列表 | 行 30；标题 `ui-md` 400，hover `surfaceContainerLow`，激活 `surfaceContainer`；归档区折叠头 `ui-sm` `outline` |
| 文件树 | 行 26，`ui-md`；目录/文件图标 16 线性；激活行 `surfaceContainerLow` 底 |
| 消息流 | assistant：无底色全宽块，`chat-md`；user：`userBubble` 色块 + `rounded.bubble`，内边距 12×16，用户文字 `userText` |
| 输入区 | min-height 32 自增高，`surfaceContainerLow` 底 + 1px `outlineVariant` 边，focus 1px `primary`；发送按钮 28×28 |
| 设置弹窗 | 640×min(480, 80vh)，`rounded.dialog`，遮罩 rgba(0,0,0,.5)；表单标签 `ui-sm`，控件 32 |
| 状态栏 | 高 24，`ui-xs`；状态点 8px：streaming=`status.running`、degraded=`status.pending`、offline=`status.error`、对账中=running 闪烁 |

### Agent 行为的呈现原则（参考 Agentic Design Patterns）

聊天组件设计以"忠实呈现 agent 行为模式"为准绳：

1. **工具调用（tool use）= 可折叠 chip**：沿用移动端 chip 骨架概念，桌面版为行内折叠条（高 28，chevron 16 + 工具名 `ui-sm` sans + 状态点）；展开体 = 输入/输出两个 mono 块（`appColors.codeBackground` + `border`），长输出内部滚动不撑高消息
2. **推理/思考（reflection）= 弱化呈现**：斜体 + `outline` 色展开体，与正文明确区分"内部推理"地位
3. **进行中的活动 = 状态可见**：running 态在 Tab、会话列表、chip 三处同步呈现（status 色 + 指示点），离屏也能从边缘感知
4. **人机协同（human-in-the-loop）= 权限卡占位**：v0.1 仅占位呈现（拒绝/同意按钮置灰），v0.2 补交互
5. **错误（exception）不静默**：`errorContainer` 底色卡片 + onErrorContainer 文案，附重试入口（对账层联动）

## Do / Don't

### Do

- 新组件先查 tokens.css 语义色；状态色只用 `status.*`
- 强调用 600 直跳；次级信息用 `ui-sm` + `outline` 降权，不加中间字重
- 文案新增 key 时同步中英两份 catalog，并对照移动端 ARB 是否已有同场景 key
- 长列表（会话、消息、文件树）一律虚拟化渲染

### Don't

- 不从移动端 DESIGN.md 抄组件规格（48px 触控、AppBar、Material 图标尺寸均不适用）
- 不在标签/标题用 mono；不在代码块用 sans
- 不引入 500/700 字重与第四档强调
- 不硬编码 hex（status 四色与遮罩黑除外）
