# 专注模式输入 — 设计文档

> 需求（2026-10-18）：会话页与引导页新增「专注模式」，用于输入大段 prompt——
> ① 输入框内增加专注模式按钮，点击打开全屏输入框；② 相比普通输入框，专注模式
> 增加 markdown 语法高亮；③ 取消发送快捷键，Enter 由发送改为换行；④ 可切换回
> 普通模式，两种模式互相切换需要动画效果，且保留输入内容。
> 增补（同日）：⑤ 专注模式下不弹三种卡片（授权/问题/后台任务）；已有卡片时
> 打开专注模式应隐藏卡片（§6.1）。
> 增补二（同日）：⑥ 专注模式隐藏添加文件按钮与已添加的文件（引用/附件
> chips）、禁用文件拖放；右键文件引用仍生效，但专注模式下结果不可见（§6.2）。
> 增补三（同日）：⑦ 专注模式隐藏 Agent 切换、模型切换与思考强度切换（§6.3）。
> 增补四（同日）：⑧ 各抑制面（卡片/引用附件/切换条）隐藏与恢复须有渐隐/
> 渐显动画（§6.4）。
> 增补五（同日，交互改版）：⑨ 由全屏弹窗改为**嵌入 tab 内容区**的面板——
> 专注模式下 Tab 栏/左栏（项目、worktree）/右栏（文件树）保持可见可交互，
> 可切 Tab/开新 Tab/切项目，切走再回**原 Tab 仍处于专注模式**（§3.2b 记忆
> 语义）；⑩ 编辑列宽统一与会话页普通输入框同栅格（≤800px，§3.2）；⑪ 动画
> 改为输入框纵向展开——会话页（输入框在底部）向上展开、引导页（输入框在
> 上 1/3）向下为主展开，引导页面板铺满内容区（hero 被覆盖，§7）。
>
> 参考先例核查（按 AGENTS.md 约定检索 `../openbuilder`；移动端设计文档实际
> 布局是 `docs/design/design-*.md`，含 v1/v2 子目录——AGENTS.md 原文的
> `docs/design-*.md` 路径写法系既有偏差，此处按实际布局执行）：
> 移动端无同类设计（2026-10-18，关键词 focus/专注/全屏/expand input——移动端
> compose 恒小屏，无"放大编辑"场景）。可借鉴的近先例在**本仓库**：
> design-code-view §2.2/§2.4（CodeMirror 装配与 class 化语法主题——只读态已落地，
> 本设计首次引入**可编辑** CM）；openchamber 的可编辑 CM（选型实证来源，参考代码
> 只读不引入依赖）。

## 1. 现状

- ChatView / GuidePage 的输入区 = `<textarea>`（`.composer-input` 内，field-sizing
  自增高、上限 200px 后内滚）。大段 prompt 在 200px 高、约 800px 宽的小窗内滚动
  编辑，无语法结构反馈
- 两视图各自持有 `draft` useState，经 design-compose-draft 的同步 effect 落 store
  （chatDrafts / guideDrafts，切 Tab/重启不丢）
- Enter 语义：裸 Enter = 发送，修饰键（Ctrl/Shift/Alt/Meta）+ Enter = 换行
  （两视图 onKeyDown 同构）
- 仓库已有 CodeMirror 6 全套依赖：`@codemirror/lang-markdown`（cm-lang 静态映射
  在列）、cm-theme 的 class 化 HighlightStyle、app.css 的 `.cm-*` + `--syntax-*`
  语义令牌（当前 scope 挂 `.code-view-host` / `.diff-text`）

## 2. 方案总览

```
ChatView / GuidePage（局部 state：focusPhase 四相位，§6.4；初值经专注态记忆
                                store.focusModeFor 读回，§3.2b）
 ├─ 普通 composer（保持挂载，不变）
 │    └─ .composer-input 尾部新增「进入专注模式」icon 按钮
 └─ focusPhase !== "off" && <FocusComposer …/>（新组件，视图内嵌面板）
      ├─ 顶行（尾部右置「退回普通模式」icon 钮，lucide Minimize2，
      │    title = t.focusModeExit——与 Esc 同一 onClose 路径）
      ├─ CM6 编辑器（markdown 高亮，Enter 一律换行）
      └─ 底部操作行（发送按钮——无附件按钮、无 chips、无切换条，
           引用/附件/配置面整体隐藏 §6.2/§6.3）
```

- **状态单源不变**：`draft` 仍是视图局部 state + compose-draft 同步 effect。
  专注模式只是同一 state 的第二编辑面（textarea ↔ CM 双向摆渡），store 层
  （chatDrafts/guideDrafts/去抖落盘）**零改动**
- FocusComposer 为受控组件：`value`（= draft）+ `onChange`（= setDraft），
  CM 生命周期/doc 同步模式复刻 code-view.tsx（挂载创建/卸载销毁/长度快路径
  全量比对整体替换）
- 底层普通 composer 在专注模式期间**保持挂载**：关闭动画需要实时量测其
  rect（§7）；draft 已是同一 state，无第二数据通路。面板不透明覆盖其上，
  不可交互
- **嵌入几何（2026-10-18 交互改版）**：面板是视图根的绝对定位子元素
  （`.chat-view` / `.guide-view` 加 `position: relative`；引导页滚动下沉到
  内层 `.guide-scroll`，面板不随存档列表滚动），铺满 tab 内容区——Tab 栏、
  左栏、右栏保持可见可交互（弹窗语义退役）

## 3. 入口与层级

### 3.1 入口按钮

- 位置：`.composer-input` 内**尾部右侧**（与左侧 attach-pick 对称的后缀按钮，
  `.focus-enter`）。`align-self: flex-start` + `margin-top: 2px` 锚定首行——
  多行内容时不随行下沉（attach-pick 同惯例）
- 形态：`icon-btn` 系 + lucide `Maximize2` 16px，title = t.focusModeEnter；
  busy 不禁用（模式切换与发送状态正交）
- 两视图同款（ChatView / GuidePage 共用样式类，同 `.composer-input` 共用先例）

### 3.2 面板几何与层级（2026-10-18 交互改版改写，原「浮层层级」作废）

- 面板渲染为视图根的绝对定位子元素：`position: absolute; left/right: 24px;
  top: 0; bottom: 8px`（横向 24px 与 `.composer` 内边距同值、底部 8px 呼吸），
  列约束 = `max-width: var(--chat-max)`（800px）、`min-width:
  var(--chat-min)`（600px）、`margin: 0 auto` 居中——**与会话页普通输入框
  同一栅格且左缘右缘在全部宽度带对齐**（横向 inset 使窄带内面板宽 = 列宽 −
  48 = `.composer-input` 盒宽，FLIP 横向 sx 恒 1；引导页输入框 640，展开时
  横向微放 0.8→1）。两视图统一 800（需求 ⑩，用户 2026-10-18 裁定；review
  non-blocking 2 修订：原「inset 0」在 (648, 848) 带内面板比输入盒宽 48px）
- 视图根改造：`.chat-view` 增 `position: relative`；`.guide-view` 拆为
  「外层定位容器（relative + overflow hidden）+ 内层 `.guide-scroll` 承接
  原滚动」——面板不随存档列表滚动、恒覆盖引导页可视区
- 层级：面板 z 5，盖视图内全部内容（消息流/卡片槽位/composer）。Tab 栏、
  左栏、右栏在面板外——专注模式下切 Tab/开新 Tab/切项目 worktree/右栏浏览
  与打开文件照常可用，切走即视图卸载、切回复位（§3.2b）。`.dialog-mask`
  100 / `.popover` 200 / `.context-menu` 210 均在文档级其上——专注模式期间
  关 Tab 确认、右键菜单等照常浮于其上
- 视觉：`--surface-container-low` 底 + `--outline-variant` 边 +
  `--radius-card` 圆角（输入框材质的放大体，无投影——贴合内容区的面不是
  悬浮卡）；内容列（编辑器 + 操作行）在面板内 `max-width: 800px` 居中
- **不注册 overlayCount**：专注模式不是打断式弹窗，是编辑模式切换（改版后
  更名符实——面板都不出 tab 内容区）。全局快捷键（Ctrl+Tab 切 Tab、Ctrl+W
  关 Tab、Alt 域、Ctrl+B、Ctrl+T）照常生效
- aria：面板根 `role="region"` + `aria-label`（有标签的地标、非模态——无
  `role="dialog"`/`aria-modal`，Tab 栏/侧栏仍可达）；打开时焦点入 CM，
  关闭时焦点还给普通 textarea

### 3.2b 专注态记忆（2026-10-18 交互改版增）

- **语义**：专注态按编辑面键存内存 store（chat = sessionID、引导页 = 作用域
  目录，`focusModeFor`/`setFocusMode` 单 Map）——切 Tab/切作用域再回，
  视图重挂载直接以 `focusPhase === "on"` 复位（无开启动画）；退出意图
  （Esc/按钮/发送后收口）即清标记。**纯内存、不跨重启**（编辑模式是会话内
  现场不是文档内容；草稿仍由 compose-draft 落盘兜底）
- 清理挂点同 chatScrollTops/guideDrafts 惯例（五处）：closeTab 的 chat 分支、
  会话运行时卸载、项目关闭的目录卸载循环、worktree 删除、disconnect 清空
  ——防 Map 无界增长与僵尸标记
- 已知边界：重挂载不复原 CM 选区（textarea 选区不跨卸载存活）——光标置
  文末续编（§5 已知边界族）；opening/closing 动画窗内切走 = 按当刻标记
  复位（进入即置标记、退出意图即清，两窗语义自洽）；**发送在途切走再回**
  （review 留痕）：`await send()` 窗口内完成切走 + 切回时，旧 sendFromFocus
  闭包恢复执行会迟到清标记（setFocusPhase 对已卸载实例 no-op，面板仍在）——
  标记与面板一次性失配、再切走一次自愈，接受

## 4. 编辑器装配（CodeMirror）

### 4.1 扩展集

```
markdown()                // cm-lang 静态映射既有实例，同 .md 文件查看
cmSyntaxTheme             // class 化高亮（heading→cm-keyword、strong→600、
                          // emphasis→italic、strikethrough、link 等，
                          // 颜色由 app.css --syntax-* 令牌供给）
EditorView.lineWrapping   // 散文软换行（必装）
history() + defaultKeymap // undo/redo（textarea 原生 undo 的对位能力）
indentWithTab             // Tab 缩进、Shift+Tab 反向（不抢焦点离开编辑器）
EditorView.placeholder()  // t.focusPlaceholder
EditorState.tabSize 2 / 编辑区 contenteditable = CM 默认
```

- **不装**：lineNumbers / foldGutter / search（纯写作面，见 §10）
- 依赖事实（2026-10-18 实施修正）：`@codemirror/commands`（history/
  defaultKeymap/historyKeymap/indentWithTab/insertNewlineAndIndent）原不在
  依赖树（code-view 只用 language/search/view）——实施时新增
  `@codemirror/commands@^6`，与既有 CM 6.x 系同版本段；Enter 修饰变体
  （Mod/Alt/Shift+Enter）显式前置绑 `insertNewlineAndIndent`——defaultKeymap
  的 Mod-Enter 绑 `insertBlankLine`（插空行，非单换行），裸 Enter 才是
  insertNewlineAndIndent
- 样式作用域：app.css 语法 token 块（§2434 起）的选择器组从
  `.code-view-host .cm-x, .diff-text .cm-x` 扩为含 `.focus-editor-host .cm-x`
  ——同一令牌体系，data-theme 切换即时生效（cm-theme 注释的既定架构）
- 排版：字号/行高沿用 composer（`--text-chat` × 1.5）；内容列
  `max-width: calc(var(--chat-max) + 48px)` 居中——与消息列同一视觉栅格，
  行长约 70–80 字符，长文读写两宜

### 4.2 键位语义（差异面）

| 键 | 普通模式 | 专注模式 |
|---|---|---|
| 裸 Enter | 发送 | **换行** |
| Ctrl/Shift/Alt/Meta+Enter | 换行 | **换行**（一律换行） |
| 发送快捷键 | Enter | **无**——按钮是唯一发送入口 |
| Esc | 关命令菜单/@ 浮层 | **退回普通模式** |
| Ctrl+Z/Y 等 | textarea 原生 | CM history（defaultKeymap） |

- 「取消发送快捷键」动机：长文误触代价高（回填不可靠的路径），宁可用按钮；
  placeholder 文案同步改写（不含"Enter 发送"提示，见 §11 i18n）
- Enter 一律换行的实现：CM 不为 Enter 绑定任何命令（defaultKeymap 的
  insertNewlineAndIndent 即换行+缩进续行，语义正确）——**没有发送路径就没有
  例外分支**，比 textarea 侧改写 onKeyDown 更少状态
- Esc 退出：CM keymap `Prec.highest` 绑 Escape → onClose（压过 defaultKeymap
  的选区折叠）；焦点在浮层其他位置（按钮）时由浮层根的 **bubble** keydown
  监听兜底——bubble 保证内层先消费并 preventDefault，浮层不抢（"已
  preventDefault 不处理"既有约定；§6.3 后浮层内无 popover，bubble 仍为
  防御性正确）。`isComposing` 守卫同全局约定（fcitx5 组合中 Esc 是取消
  组合，不退出）

## 5. 内容与光标保留

- **文本**：同一 `draft` state 双向摆渡，切换即保留（无拷贝/无第二存储）。
  外部改值路径（回滚种子回填、发送清空、引导页 pendingSession 回填）经
  `value` prop 回流 → CM doc 同步 effect 整体替换（code-view 同款，长度快路径）
- **光标/选区**：切换时按偏移 1:1 映射（两编辑面持同一纯文本，无换行符
  归一化差异）。打开 = 读 textarea `selectionStart/End` 作 CM 初始选区 +
  `scrollIntoView` 光标；关闭 = `onClose({ start, end })` 携带 CM 主选区，
  父级切回普通模式后 rAF `setSelectionRange` + focus
- **undo 历史**：跨切换不保留（CM history 与 textarea 原生 undo 随各自实例
  生灭；textarea 的 value 编程设置本就清原生栈）。已知边界，接受（§10）
- 已知边界：退出后普通框是 200px 上限内滚区，长文光标可能不在首屏——不做
  光标行对齐（Keep Lean；退出后通常直接发送或继续编辑首屏）
- 重挂载复位（§3.2b，2026-10-18 交互改版）：切回复位时光标置文末——
  textarea 选区不跨卸载存活，无映射源（同族已知边界，接受）

## 6. 发送与生命周期联动

- 发送逻辑**零新路径**：专注模式发送按钮走视图既有 `send()`（空守卫/超限守卫/
  斜杠分流/supplement 语义全复用）。按钮禁用条件同普通模式（空草稿+无引用附件/
  tooLarge/sending）；busy 不隐藏（无 stop 替位，停止经 Esc 退回普通模式操作）
- 发送包装 = `await send()` 后**无条件退回普通模式**：
  - 成功：结果反馈（消息流/乐观气泡）在普通视图，留在专注模式看不见
  - 失败：错误呈现归既有错误面（design-error-message，消息流/左栏状态行），
    草稿已由 send() 回填——专注模式不复制第二套错误 UI
- 引导页同构：成功路径 `openChatTab` 使引导页整个卸载（浮层随之消失），
  无需显式退出
- 斜杠命令草稿（`/` 开头）带入专注模式：无命令菜单（§10），按字面编辑；
  退回普通模式后菜单按既有规则重现。发送仍走 sendSlash 分流（字面/命令
  判定在发送时，与编辑面无关）
- 引用/附件/切换面在专注模式**整体隐藏**（添加按钮/chips/拖放/切换条均不
  进场，§6.2/§6.3）——写作面只留文本编辑与发送

### 6.1 卡片抑制（授权/问题/后台任务，2026-10-18 增补）

三种卡片 = **授权卡 / 问题卡**（design-pending-cards，ChatFooter 面板）+
**后台任务卡**（design-subagent-background，`.bg-task-slot`：BackgroundTaskBar
与 TaskDetailPanel 详情窗同槽位互斥渲染）。

- 规则：专注稳态（`focusPhase === "on"`，§6.4）两处槽位**均不渲染**——
  ChatFooter 提前 return null、bg-task-slot 渲染条件并入相位。已有卡 →
  打开时**渐隐后卸载**；在途到达（SSE `permission.asked` / `form.created`、
  子会话后台启动）→ 不弹（稳态无渲染面）。退出时**先挂载再渐显**恢复
- 状态零改动：pendingPermissions / pendingQuestions 是 store 级跨 Tab 存活
  （design-pending-cards），后台任务列表来自子会话运行态、详情窗开合是
  ChatView 局部 state——抑制只作用渲染层，无清理、无丢失，退出原样恢复
  （含详情窗开合态）
- **硬动机是快捷键冲突，不止视觉**（遮罩本就盖住卡片）：卡片快捷键
  （design-keyboard-shortcuts §1.1b）挂在卡片组件内的 window 监听，"卡存在且
  展开期间焦点无关恒为卡动作"——专注模式是编辑面，Ctrl+A（全选）/
  Ctrl+Enter（换行，本设计 D4）/ Ctrl+N 等会被劫持成应答/提交动作。卸载卡片
  组件 = 监听随之消亡，编辑键安全（§1.1b 既有先例："卡片收起不渲染，快捷键
  同样不动作"）
- 已知边界：专注期间 run 因待处理卡挂起**无任何提示**（状态行/指示器均在
  遮罩下）——接受，退出即见；卡片阻塞不超时，等待无损失。他端在抑制期间
  应答（SSE replied/cancelled）照常移除条目，退出后不重现
- GuidePage 无卡片（卡片是会话域 UI），不涉及

### 6.2 引用与附件抑制（2026-10-18 增补二）

- **隐藏面**：附件「+」按钮（`attachInput.pickerButton`）、附件 chip 条
  （`attachInput.chips`）、引用 chip 条（`refInput.chips`）——浮层底行不渲染；
  普通 composer 内的原件加抑制类（opacity 0，§6.4）——透过半透明遮罩亦
  不可见。浮层底部操作行只剩发送按钮（ModelSwitcherBar 随 §6.3 一并隐藏）
- **拖放禁用**：浮层根**不挂** `fileDragProps` / `dragProps`，改挂「吞掉不
  处理」的 dragover/drop（preventDefault + stopPropagation、无添加动作）——
  落文件零效果、无导航尝试。main 的 `will-navigate` 通用防线
  （src/main/index.ts:84）是兜底而非依赖
- **外部添加路径照常生效**：右键文件引用（design-file-panel-context-menu）
  等直接写 store（`addFileRef` / `addAttachments`），不感知专注模式——结果
  **不可见**（无渲染面），退出后 chip 呈现。@ 引用浮层本就不进专注模式
  （D8），与隐藏 chips 一致
- **发送仍携带隐藏的引用/附件**：数据在 store，send() 的空守卫/tooLarge
  守卫/斜杠分流照常消费——**不可见但生效**（与右键引用同语义）。已知边界：
  tooLarge 置灰在专注模式只见发送按钮灰、不见原因——退回普通模式可见

### 6.3 切换条隐藏（Agent/模型/思考强度，2026-10-18 增补三）

- **隐藏面**：ModelSwitcherBar（design-agent-model-switch 的 composer 工具
  条——agent 分段/pill、模型 pill+popover、思考强度 pill+popover 三组控件
  一体）浮层底行不渲染；普通 composer 内的原件加抑制类（opacity 0，§6.4）
  ——透过半透明遮罩不可见。ChatView / GuidePage 同构（引导页 defaults 会话
  模式亦同）
- **数据层不动**：切换读写会话/全局默认的 agent/model/variant 配置（next
  语义，下一条消息生效）。隐藏只是无 UI 入口：配置保持进入前的值，专注
  模式发送照常按该值生效；退回后切换条渐显恢复（§6.4），已设值原样
- **动机**：与 §6.1/§6.2 同一句——写作面只留文本与发送。三组切换是配置
  动作不是写作动作，需要时退回普通模式操作（两模式互切是低成本显式动作）
- 附带收敛：其 popover（`.popover` z 200）随抑制不可开——浮层内无内层
  浮层，§4.2 Esc 的 bubble 监听降为纯防御

### 6.4 抑制面的渐隐/渐显（2026-10-18 增补四）

所有被抑制面（§6.1 卡片两槽位、§6.2 chips/附件钮、§6.3 切换条）的隐藏与
恢复走 **opacity 150ms 渐隐/渐显**，与浮层开合动画同窗（§7：面板 200ms、
遮罩 120ms）——不做瞬时消失/瞬时弹回。

- **相位机**：`focusMode` 布尔升级为
  `focusPhase: "off" | "opening" | "on" | "closing"`——点击入口置 opening
  （浮层展开 + 抑制面渐隐），动画窗（200ms 兜底）毕置 on；退回动作置
  closing（浮层收拢 + 抑制面渐显），毕置 off。opening/closing 期间重复
  开关由相位吸收（原 §7 closingRef 职责并入）
- **卡片面（需卸载灭监听）两段式**：渐隐完成后才卸载（opening→on 时点）；
  恢复时先挂载（opacity 0 初态、无过渡）再下一帧渐显（closing 起点）。
  代价：打开动画窗内（≤200ms）卡片监听仍活——用户手在入口钮上，键盘应答
  概率可忽略，接受；关闭窗口对称——closing 起点卡片已重挂载而 CM 至过渡
  结束仍可编辑（§7），Esc 后 ≤200ms 内按 Ctrl+A/Ctrl+Y 等会命中卡片 capture
  监听且 overlayCount 闸门不拦（§3.2 未注册）——与打开窗口同级的低概率，
  接受（review nit 1 修订，原「无风险」口径作废）
- **composer 内面（恒挂载）单类双向**：chips/附件钮/切换条不卸载——视图根
  （或各槽位元素）挂抑制类（phase ∈ opening/on 时在），CSS
  `opacity: 0 + transition 150ms`——类挂上即渐隐、移除即渐显，无需两段式
- **抑制 ≠ 遮罩压暗**：遮罩是 rgba(0,0,0,0.5) 半透明，未抑制内容（消息流、
  composer-input 本体）呈压暗的上下文；抑制面 opacity 0 = 彻底不可见——
  两层视觉语义不同（§6.1–§6.3 的「隐藏」指后者）
- `prefers-reduced-motion: reduce`：无渐变直切（卸载/挂载即时，同 §7 惯例）

## 7. 模式切换动画（2026-10-18 交互改版改写）

**选型不变：FLIP grow-from-origin（transform + opacity 纯合成器动画）**——
遮罩层随弹窗形态退役，动画主体 = 面板自输入框盒纵向展开。

- 打开：入口点击时量测 `.composer-input` rect（R1，含入口按钮的盒子）→
  挂载面板 → layout effect 量测 `.focus-composer` 自然 rect（R2，§3.2 列盒）
  → 面板置初始 `transform: translate(R1↔R2 差) scale(sx, sy)`
  （transform-origin: top left）+ 内容（编辑器/操作行）opacity 0 → 强制回流
  后去 transform 过渡到 identity。会话页输入框在底部 → 面板上缘位移远大于
  下缘 = **向上展开**；引导页输入框在上 1/3 → 下缘位移大于上缘 = **向下
  为主展开**（横向 sx：会话页恒 1——面板左右 24px inset 与 .composer 内边距
  同值，全部宽度带与输入盒对齐，展开纯纵向；引导页 0.8→1 微放）
- 关闭：反向——重新量测底层 composer rect（保持挂载的原因，§2），面板过渡
  回 R1 位置尺寸，过渡结束卸载面板
- 参数：面板 transform 200ms `cubic-bezier(0.2, 0, 0, 1)`（emphasized 系）；
  内容淡入 140ms 延迟 40ms 起；抑制面渐隐/渐显 150ms 同窗（§6.4）。只动
  transform/opacity——合成器属性，无布局抖动；sx≠sy 非均匀缩放允许（盒
  变形，内容另有淡入不参与拉伸观感）
- 守卫：动画期间重复开关由 `focusPhase` 相位机吸收（opening/closing 不再
  触发，§6.4——原 closingRef 职责并入）；`transitionend` + 300ms 超时兜底
  清理（transitionend 不保证必达）；`prefers-reduced-motion: reduce` 直接切换
  无动画（app.css 既有 media 惯例）
- **弃选 View Transitions API**（Electron 43 / Chromium 174 可用但不用）：
  快照动画需 `startViewTransition` 回调内 `flushSync` 保证 DOM 已变（React
  协调耦合）；每开一次全窗截图成本；关闭反向动画同样要包一层。FLIP 代码量
  约持平、行为确定、无生命周期耦合——Keep Lean

## 8. 决策记录

- **D1 视图内嵌面板而非新 Tab kind（2026-10-18 交互改版改写）**：专注模式是
  输入态不是导航目标——Everything is a tab 不适用于此（无独立内容/历史，退出
  即消亡；Tab 注册制的稳定标识无从谈起）。面板是视图根的绝对定位子元素
  （§3.2），不出 tab 内容区；专注态经内存 store 记忆跨切换复位（§3.2b）。
  原「fixed 浮层 + 局部 state、卸载即重置」方案作废（用户改版需求 ⑨）
- **D2 弹窗沉浸语义退役（2026-10-18 交互改版改写）**：原「z-index 90 遮
  Tab 栏/侧栏」作废——专注模式下 Tab/项目/worktree/右栏照常可用（切走再回
  原地专注），沉浸面收敛为「tab 内容区被写作面占满」。全局快捷键不闸
  （专注模式非打断弹窗，Ctrl+Tab 临时切走是合法操作，草稿有 compose-draft
  兜底）；标题栏可达性不再是问题（面板本就不出内容区）
- **D3 编辑器选 CodeMirror 6、复用既有装配**：markdown 语言包与 class 化主题
  已在依赖树内（.md 文件查看同源）；不引 basicSetup 封装，扩展集白盒列举
  （code-view 同风格）
- **D4 Enter 一律换行、发送无快捷键**：需求原文；实现面 CM 侧"不绑发送命令"
  即达成，无例外分支
- **D5 内容保留 = 状态单源摆渡**：不为专注模式建第二草稿存储（含选区偏移的
  1:1 映射），compose-draft 机制零改动自然覆盖"切 Tab/重启也不丢"
- **D6 动画用手写 FLIP**：见 §7 弃选理由
- **D7 发送后无条件退回普通模式**：反馈面（成功气泡/失败错误）都在普通视图，
  专注模式不复制呈现
- **D8 斜杠菜单/@ 浮层不进专注模式**：CM 内重做浮层定位映射（视口坐标↔doc
  偏移）成本高；两模式可互切，需要时退回即得（交互面小、路径单一）
- **D9 三种卡片在专注模式抑制渲染（2026-10-18 需求增补）**：授权/问题/后台
  任务卡专注稳态不渲染不响应——组件卸载使 §1.1b 卡片快捷键监听消亡
  （编辑键 Ctrl+A/Ctrl+Enter 与"恒为卡动作"的冲突是硬动机）；store 状态零
  改动，退出即恢复。取代原「卡片到达不联动退出」取舍——该条目假定卡片
  保持可见，与增补需求冲突，§10 已改写
- **D10 引用/附件面整体隐藏、数据层不动（2026-10-18 增补二）**：添加按钮/
  chips/拖放在专注模式全部不进场——写作面只留文本与发送；右键引用等外部
  添加路径照常写 store（结果不可见、退出后呈现），发送仍携带（不可见但
  生效，用户明确接受）
- **D11 ModelSwitcherBar 整条隐藏（2026-10-18 增补三）**：agent/模型/思考
  强度三组切换（同组件一体，design-agent-model-switch）在专注模式不进场
  ——配置动作与写作动作分离；store 配置零改动、发送按进入前值生效、退出
  渐显恢复
- **D12 抑制面显隐走渐隐/渐显（2026-10-18 增补四）**：所有被抑制面的隐藏/
  恢复用 opacity 150ms 渐变，与浮层开合同窗，不做瞬时切换——卡片面因需
  卸载灭监听采用两段式（渐隐后卸载/先挂载再渐显），composer 内面恒挂载
  单类双向；focusMode 布尔升级为四相位机统一驱动（§6.4）
- **D13 编辑列宽统一 800px 栅格（2026-10-18 交互改版，用户裁定）**：两视图
  专注面板同一列约束（§3.2）——引导页输入框 640，展开带 0.8→1 横向微放；
  字面满足「与会话页普通输入框相同」，编辑行长与消息列栅格一致
- **D14 专注态记忆 = 内存级 per 编辑面（2026-10-18 交互改版）**：切 Tab/
  切作用域再回原 Tab 仍专注（§3.2b）；不落盘不跨重启（编辑模式是会话内
  现场不是内容，草稿另有 compose-draft 兜底）；清理挂点同 chatScrollTops
  惯例防僵尸标记

## 9. 场景验证表

| # | 场景 | 行为 |
|---|---|---|
| 1 | 会话页输入 → 点入口 | 面板自输入框盒向上展开（§7）；文本/光标保留；markdown 高亮可见 |
| 2 | 专注模式编辑 → 退回（按钮/Esc） | 反向动画收拢回输入框；文本/选区保留；焦点回 textarea |
| 3 | 专注模式 Enter / Shift+Enter / Ctrl+Enter | 一律换行；无任何组合触发发送 |
| 4 | 专注模式点发送 | 走既有 send()；成功退回普通模式、气泡入流；失败退回、草稿回填 |
| 5 | busy 中专注模式补输并发送 | supplement 语义照常（不打断 run） |
| 6 | 专注模式 Ctrl+Tab 切走再回 | 草稿恢复（compose-draft）；**仍处专注模式**（§3.2b 记忆复位，光标置文末） |
| 7 | 专注模式 Ctrl+W（流式中） | ConfirmDialog（z 100）盖于浮层上，确认/取消语义不变 |
| 8 | `/cmd` 草稿进专注模式 | 无菜单按字面编辑；退回后菜单重现；发送分流不受影响 |
| 9 | 拖文件入浮层 / chips / 附件按钮 | 全部不进场：drop 零效果无导航；按钮与 chips 不渲染（§6.2） |
| 10 | fcitx5 中文输入（组合→上屏） | CM contenteditable 组合正常；组合中 Esc 取消组合不退出 |
| 11 | `prefers-reduced-motion` | 无动画直切，内容即时可用 |
| 12 | 窗口缩放/面板拖宽 | 面板随列宽自适应（列约束 §3.2）；动画中 resize 至多畸变一帧（无守卫，接受） |
| 13 | 引导页全链路 | 入口/编辑/发送同构（向下为主展开，hero 被覆盖）；成功开 Tab（面板随卸载消失）；失败留页草稿回填 |
| 14 | 重启应用后进入 | 草稿经磁盘层恢复（§5 既有机制，无新面） |
| 15 | 授权/问题/后台任务卡在场 → 打开专注模式 | 卡片渐隐后卸载；退回先挂载再渐显，原样恢复（含详情窗开合态） |
| 16 | 专注模式期间新卡到达（asked/created/后台任务启动） | 不弹；退出后按最新状态呈现 |
| 17 | 专注模式期间 Ctrl+A / Ctrl+Enter / Ctrl+N 等 | 编辑语义（全选/换行/字面输入）——卡片未挂载，§1.1b 快捷键不劫持 |
| 18 | 专注模式期间卡片被他端应答 | 条目照常移除（SSE 事件）；退出后不重现 |
| 19 | 专注模式期间右键文件引用 | 生效但不可见；退出后 chip 呈现 |
| 20 | 隐藏态引用/附件随专注模式发送 | 照常携带（不可见但生效）；tooLarge 时发送按钮置灰 |
| 21 | 专注模式底部操作行 | 只有发送按钮；agent/模型/思考强度切换条渐隐隐藏（§6.3），退回渐显恢复 |
| 22 | 抑制面进/出动画 | 隐藏 = 渐隐 150ms、恢复 = 渐显，与面板开合同窗；reduced-motion 直切 |
| 23 | 专注模式切项目/切 worktree/右栏打开文件 | 左右栏与 Tab 栏照常交互；原 Tab 卸载、切回复位仍专注（§3.2b） |
| 24 | 引导页专注态切作用域再回 | 按目录键记忆复位（仍专注）；项目关闭/worktree 删除随目录清标记 |

## 10. 不做的事

- CM 内斜杠命令菜单、@ 引用浮层（D8；退回普通模式即得）
- 围栏代码块内嵌语言高亮（markdown 的 codeLanguages——静态全量引入增包体、
  动态注册表已被 cm-lang 明确弃用；围栏内容纯文本着色）
- 字数统计、专注模式内的错误/流式状态呈现（D7）
- 专注态跨**重启**持久化（内存 Map，重启回普通模式——会话内跨切换已记忆
  §3.2b；**原「状态不跨卸载记忆」条目已被 2026-10-18 交互改版取代**）
- 重挂载的 CM 选区复原（textarea 选区不跨卸载存活，光标置文末——§5 已知
  边界族）
- 光标行对齐到普通框可视区（§5 已知边界）
- 跨模式 undo 历史保留（§5 已知边界——两编辑面的历史随各自实例生灭）
- OS 窗口全屏（fullscreen）联动、暗色加深的"打字机模式"等氛围功能
- 授权/问题卡到达时联动退出——**已被 D9 取代**（2026-10-18 增补需求改为抑制
  渲染，见 §6.1；原条目"卡片保持可见、用户显式退出即可见"不再成立）
- 卡片抑制期间的到达/挂起提示（专注期间 run 因卡片阻塞无感知——退出即见，
  Keep Lean）

## 11. 涉及文件（初版 + 2026-10-18 交互改版增量）

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/focus-composer.tsx` | FocusComposer（CM 生命周期/doc 同步/FLIP/Esc/操作行插槽、onClosed 携选区；拖放吞掉）。改版：`.focus-overlay` 遮罩退役，面板根直接绝对定位（§3.2）；FLIP 去遮罩支路；aria 非模态化 |
| `src/renderer/src/components/workspace.tsx` | ChatView/GuidePage：`.focus-enter` 按钮 + `focusPhase` 四相位 state + 面板挂载 + send 包装退回；卡片槽位/抑制类接线（§6.1–§6.4）。改版：专注态记忆接线（初值读回/进入置/退出意图清/引导页 settle 清，§3.2b）；GuidePage 根拆 `.guide-scroll` 承接滚动（面板不随存档滚动） |
| `src/renderer/src/store/app-store.ts` | 改版增：`focusModes` 内存 Map + `focusModeFor`/`setFocusMode`；五处清理挂点（closeTab chat 分支、会话运行时卸载、项目关闭目录循环、worktree 删除、disconnect，§3.2b） |
| `src/renderer/src/styles/app.css` | `.focus-composer` / `.focus-editor-host` / `.focus-enter`；语法 token 选择器组；抑制类渐变 + reduced-motion（§6.4）。改版：`.chat-view` relative；`.guide-view` 拆层；`.focus-composer` 列约束 + 材质（§3.2）；删 `.focus-overlay` 块 |
| `src/renderer/src/i18n/index.ts` | focusModeEnter / focusModeExit / focusPlaceholder（zh+en，提示 Enter 换行）——改版无新增文案 |
| `src/renderer/src/components/focus-composer.test.tsx` | 渲染冒烟（jsdom + RO stub）：初始 doc/选区、markdown token class、doc 同步、Enter 换行、Esc、相位回调 |
| `src/renderer/src/components/workspace-guide.test.tsx` | 专注模式集成（入口/退出/Enter 换行）+ 改版增：记忆复位用例；`.focus-overlay` 断言改 `.focus-composer`。ChatView 卡片闸门留联调（#15/#21） |
| `src/renderer/src/store/app-store.test.ts` | 改版增：focusModeFor/setFocusMode + 卸载清理用例（§3.2b） |
| `package.json` / `package-lock.json` | `@codemirror/commands@^6.11.1`（§4.1 依赖事实，初版已入） |
| `docs/design/v2/design-pending-cards.md` / `docs/design/design-keyboard-shortcuts.md` | 初版补注：卡片渲染/快捷键适用条件加「专注模式抑制期间不渲染不响应」（§1.1b 边界，§6.1）——改版无变化 |
| `docs/spec/spec-v0.6.md`（实施时开篇） | 功能范围补录；design-layout 输入区条目指向本文（两版合并处理） |

## 12. 验证要点（实施门）

- vitest 全绿（新增约 10–12 用例，卡片抑制 gate 含 1–2 例）+ typecheck 双侧
- 联调（本机 server）：场景表 #1–#22 手动过；重点 ③ Enter 组合矩阵、⑩ fcitx5
  （可编辑 CM + enable-wayland-ime 为本仓库首例，openchamber 有实证）、
  #15–#17 卡片抑制（渐隐/不弹/编辑键不劫持）、#9/#19/#20 引用附件面
  （拖放禁用/右键不可见/发送携带）、#21/#22 切换条与抑制面渐隐渐显、
  动画双向 + reduced-motion
- 动画帧率目测（Wayland 合成器）：200ms 内无可感知掉帧；输入延迟与普通模式
  无感差异（长草稿 ≥20KB 打字对比）

## 13. 验证记录（2026-10-18 实施）

- vitest 1348/1348（新增 10 用例：focus-composer 7 + workspace 集成 3）；
  typecheck 双侧、build 全绿
- review 一轮修订（reviewer 子代理）：
  - major 1：退出选区恢复被 selection-restore 默认分支（rAF 置末尾）覆盖
    ——改 focusExitSel 旁路（onFocus 优先消费，同步 setSelectionRange 无
    rAF 竞态），ChatView/GuidePage 同修
  - minor 2：opening 窗口内关闭的 FLIP retarget 以中途视觉盒为基准致落点
    偏移——缓存 opening 首帧的自然盒 rect 作 closing 基准
  - minor 3：opening 的 transitionend/兜底回调在 closing 抢跑后仍可能报
    onOpened——组件内 phaseRef 守卫 + 父级 onOpened 函数式相位闸
  - minor 4：附件 notice 行（.form-note）不在渐变过渡组——补入（含
    reduced-motion 侧）
  - minor 5：design-pending-cards / design-keyboard-shortcuts §1.1b 补注
    「专注模式抑制期间不渲染不响应」边界
- 已知留联调：ChatView 卡片闸门（§6.1 focusPhase !== "on"）无组件级测试
  （ChatView 未导出、渲染 harness 成本高）——场景表 #15/#21 手动过；
  spec-v0.6 开篇补录（§11）待版本规划时一并处理
- 二轮 review（reviewer 子代理，2026-10-18）：可以合入、无阻塞——非阻塞 1
  （sendFromFocus 在途退出重进的代际串扰）已修（focusGenRef 代际守卫，
  两视图同构）；design-layout 输入区条目与 spec-v0.6 一并延期至版本开篇
  （原 §11 计划口径在此留痕对齐）；焦点圈闭不 trap 与仓库既有弹窗一致，
  忽略（nit 2）

## 14. 验证记录（2026-10-18 交互改版）

- 范围：§3.2/§3.2b/§7/D1/D2/D13/D14、场景表 #6/#12/#13/#23/#24——浮层改
  tab 内嵌、专注态跨切换记忆、列宽统一 800、纵向展开动画
- vitest 1364/1364 全绿（新增 4 用例：guide 记忆复位 1 + ChatView 记忆
  复位 1 + store 写读/清理 1 + 既有断言随改）；typecheck 双侧、build 全绿
- review（reviewer 子代理，2026-10-18）：可以合入、无阻塞。修订落点：
  - non-blocking 1（发送在途切走再回的迟到清标——一次性失配、再切自愈）
    接受并 §3.2b 已知边界留痕
  - non-blocking 2（(648, 848) 带内面板比输入盒宽 48px、FLIP 带横向缩放）
    ——已修：面板左右改 24px inset（与 .composer 内边距同值），全部宽度
    带与输入盒对齐、会话页 sx 恒 1，§3.2/§7 措辞同步
  - nit 3（aria-label 挂无 role 的 div 读不到）——已修：`role="region"`
  - nit 4（清理挂点计数不全）——已修：§3.2b/§11 列全五处
  - nit 5（--chat-min/max 双视图重复定义）——保留（注释已自认同值，
    上提 workspace-body 收益有限）
- 二轮 review（reviewer 子代理，2026-10-18）：可以合入、无阻塞——复位
  挂载相位机、sendFromFocus 清标时序、CSS 全宽度带对齐、键空间无碰撞均
  逐一核对通过；non-blocking 2（requestFocusClose 闭包直读是隐性契约）
  已修：两视图函数注释点明「调用方须经最新闭包（requestCloseRef 模式）」，
  non-blocking 1（发送在途迟到清标）维持 §3.2b 已知边界留痕口径
- 已知留联调：动画帧率/展开方向手感（Wayland 实机）、fcitx5 组合、
  #15–#17 卡片抑制在嵌入形态下的观感——场景表手动过
