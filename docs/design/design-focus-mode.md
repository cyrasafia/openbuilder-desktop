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
ChatView / GuidePage（各自局部 state：focusPhase 四相位，§6.4）
 ├─ 普通 composer（保持挂载，不变）
 │    └─ .composer-input 尾部新增「进入专注模式」icon 按钮
 └─ focusPhase !== "off" && <FocusComposer …/>（新组件，视图内浮层）
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
  rect（§7）；draft 已是同一 state，无第二数据通路。遮罩覆盖不可交互

## 3. 入口与层级

### 3.1 入口按钮

- 位置：`.composer-input` 内**尾部右侧**（与左侧 attach-pick 对称的后缀按钮，
  `.focus-enter`）。`align-self: flex-start` + `margin-top: 2px` 锚定首行——
  多行内容时不随行下沉（attach-pick 同惯例）
- 形态：`icon-btn` 系 + lucide `Maximize2` 16px，title = t.focusModeEnter；
  busy 不禁用（模式切换与发送状态正交）
- 两视图同款（ChatView / GuidePage 共用样式类，同 `.composer-input` 共用先例）

### 3.2 浮层层级

- FocusComposer 渲染为 `position: fixed`，`inset: 0; top: var(--titlebar-h)`，
  `z-index: 90`——**保留标题栏可见可交互**（frameless 窗口控制/拖拽区不可缺），
  覆盖 Tab 栏、左/右栏与中栏内容（沉浸语义）
- z 序核查：`.dialog-mask` 100 / `.popover` 200 / `.context-menu` 210 均在其上
  ——专注模式期间关 Tab 确认、右键菜单等照常浮于其上
- 面板几何：居中列，宽 `min(calc(100vw - 48px), var(--chat-max) + 48px)`、
  上下 inset 24px；`--surface` 底 + `--outline-variant` 边 +
  `--radius-dialog` 圆角 + 投影（`.dialog` 同惯例）；遮罩
  `rgba(0,0,0,0.5)`（`.dialog-mask` 同值）
- **不注册 overlayCount**：专注模式不是打断式弹窗，是编辑模式切换。全局快捷键
  （Ctrl+Tab 切 Tab、Ctrl+W 关 Tab、Alt 域、Ctrl+B）照常生效——切走即视图卸载，
  草稿经 compose-draft 暂存，切回重挂载回**普通模式**（focusPhase 是局部 state，
  不跨卸载记忆，§10）。Ctrl+W 流式确认弹窗（z 100）盖在专注模式上，语义不冲突
- aria：浮层根 `role="dialog"` + `aria-modal="true"` + `aria-label`；打开时焦点
  入 CM，关闭时焦点还给普通 textarea

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

## 7. 模式切换动画

**选型：FLIP grow-from-origin（transform + opacity 纯合成器动画）**。

- 打开：入口点击时量测 `.composer-input` rect（R1，含入口按钮的盒子）→
  挂载浮层 → layout effect 量测 `.focus-composer` 面板 rect（R2）→ 面板置
  初始 `transform: translate(R1↔R2 差) scale(sx, sy)`（transform-origin:
  top left）+ 内容（编辑器/操作行）opacity 0 → 强制回流后去 transform 过渡
  到 identity；遮罩 opacity 0→1
- 关闭：反向——重新量测底层 composer rect（保持挂载的原因，§2），面板过渡
  回 R1 位置尺寸，过渡结束卸载浮层
- 参数：面板 transform 200ms `cubic-bezier(0.2, 0, 0, 1)`（emphasized 系）；
  遮罩 120ms；内容淡入 140ms 延迟 40ms 起；抑制面渐隐/渐显 150ms 同窗
  （§6.4）。只动 transform/opacity——合成器属性，无布局抖动；sx≠sy 非均匀
  缩放允许（盒变形，内容另有淡入不参与拉伸观感）
- 守卫：动画期间重复开关由 `focusPhase` 相位机吸收（opening/closing 不再
  触发，§6.4——原 closingRef 职责并入）；`transitionend` + 300ms 超时兜底
  清理（transitionend 不保证必达）；`prefers-reduced-motion: reduce` 直接切换
  无动画（app.css 2933 行既有 media 惯例）
- **弃选 View Transitions API**（Electron 43 / Chromium 174 可用但不用）：
  快照动画需 `startViewTransition` 回调内 `flushSync` 保证 DOM 已变（React
  协调耦合）；每开一次全窗截图成本；关闭反向动画同样要包一层。FLIP 代码量
  约持平、行为确定、无生命周期耦合——Keep Lean

## 8. 决策记录

- **D1 浮层而非新 Tab kind**：专注模式是输入态不是导航目标——Everything is a
  tab 不适用于此（无独立内容/历史，退出即消亡；Tab 注册制的稳定标识无从谈起）。
  视图内 fixed 浮层 + 局部 state，卸载即重置
- **D2 z-index 90、保留标题栏**：窗口控制不可失（frameless）；遮 Tab 栏/侧栏
  足够沉浸。全局快捷键不闸（专注模式非打断弹窗，Ctrl+Tab 临时切走是合法操作，
  草稿有 compose-draft 兜底）
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

## 9. 场景验证表

| # | 场景 | 行为 |
|---|---|---|
| 1 | 会话页输入 → 点入口 | 浮层自输入框位置放大展开；文本/光标保留；markdown 高亮可见 |
| 2 | 专注模式编辑 → 退回（按钮/Esc） | 反向动画收拢回输入框；文本/选区保留；焦点回 textarea |
| 3 | 专注模式 Enter / Shift+Enter / Ctrl+Enter | 一律换行；无任何组合触发发送 |
| 4 | 专注模式点发送 | 走既有 send()；成功退回普通模式、气泡入流；失败退回、草稿回填 |
| 5 | busy 中专注模式补输并发送 | supplement 语义照常（不打断 run） |
| 6 | 专注模式 Ctrl+Tab 切走再回 | 草稿恢复（compose-draft）；回到普通模式（focusPhase 不跨卸载） |
| 7 | 专注模式 Ctrl+W（流式中） | ConfirmDialog（z 100）盖于浮层上，确认/取消语义不变 |
| 8 | `/cmd` 草稿进专注模式 | 无菜单按字面编辑；退回后菜单重现；发送分流不受影响 |
| 9 | 拖文件入浮层 / chips / 附件按钮 | 全部不进场：drop 零效果无导航；按钮与 chips 不渲染（§6.2） |
| 10 | fcitx5 中文输入（组合→上屏） | CM contenteditable 组合正常；组合中 Esc 取消组合不退出 |
| 11 | `prefers-reduced-motion` | 无动画直切，内容即时可用 |
| 12 | 窗口缩放/面板拖宽 | 浮层 fixed 不受布局影响；动画中 resize 至多畸变一帧（无守卫，接受） |
| 13 | 引导页全链路 | 入口/编辑/发送同构；成功开 Tab（浮层随卸载消失）；失败留页草稿回填 |
| 14 | 重启应用后进入 | 草稿经磁盘层恢复（§5 既有机制，无新面） |
| 15 | 授权/问题/后台任务卡在场 → 打开专注模式 | 卡片渐隐后卸载；退回先挂载再渐显，原样恢复（含详情窗开合态） |
| 16 | 专注模式期间新卡到达（asked/created/后台任务启动） | 不弹；退出后按最新状态呈现 |
| 17 | 专注模式期间 Ctrl+A / Ctrl+Enter / Ctrl+N 等 | 编辑语义（全选/换行/字面输入）——卡片未挂载，§1.1b 快捷键不劫持 |
| 18 | 专注模式期间卡片被他端应答 | 条目照常移除（SSE 事件）；退出后不重现 |
| 19 | 专注模式期间右键文件引用 | 生效但不可见；退出后 chip 呈现 |
| 20 | 隐藏态引用/附件随专注模式发送 | 照常携带（不可见但生效）；tooLarge 时发送按钮置灰 |
| 21 | 专注模式底部操作行 | 只有发送按钮；agent/模型/思考强度切换条渐隐隐藏（§6.3），退回渐显恢复 |
| 22 | 抑制面进/出动画 | 隐藏 = 渐隐 150ms、恢复 = 渐显，与浮层开合同窗；reduced-motion 直切 |

## 10. 不做的事

- CM 内斜杠命令菜单、@ 引用浮层（D8；退回普通模式即得）
- 围栏代码块内嵌语言高亮（markdown 的 codeLanguages——静态全量引入增包体、
  动态注册表已被 cm-lang 明确弃用；围栏内容纯文本着色）
- 字数统计、专注模式内的错误/流式状态呈现（D7）
- 专注模式状态跨卸载记忆（重挂载恒普通模式——与"打开 Tab = 恢复现场"的 Tab
  记忆体系无关，编辑模式不是现场）
- 光标行对齐到普通框可视区（§5 已知边界）
- 跨模式 undo 历史保留（§5 已知边界——两编辑面的历史随各自实例生灭）
- OS 窗口全屏（fullscreen）联动、暗色加深的"打字机模式"等氛围功能
- 授权/问题卡到达时联动退出——**已被 D9 取代**（2026-10-18 增补需求改为抑制
  渲染，见 §6.1；原条目"卡片保持可见、用户显式退出即可见"不再成立）
- 卡片抑制期间的到达/挂起提示（专注期间 run 因卡片阻塞无感知——退出即见，
  Keep Lean）

## 11. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/focus-composer.tsx` | 新：FocusComposer（CM 生命周期/doc 同步/FLIP/Esc/操作行插槽、onClose 携选区；拖放吞掉层） |
| `src/renderer/src/components/workspace.tsx` | ChatView/GuidePage：`.focus-enter` 按钮 + `focusPhase` 四相位 state + 浮层挂载 + send 包装退回；composer-input ref 供动画量测；ChatFooter / bg-task-slot 渲染并入相位（§6.1/§6.4 两段式）；composer 抑制面挂抑制类（§6.2/§6.3） |
| `src/renderer/src/styles/app.css` | `.focus-overlay` / `.focus-composer` / `.focus-editor-host` / `.focus-enter`；语法 token 选择器组并入 `.focus-editor-host`；抑制类 opacity 渐变 + reduced-motion 块（§6.4） |
| `src/renderer/src/i18n/index.ts` | focusModeEnter / focusModeExit / focusPlaceholder（zh+en，提示 Enter 换行） |
| `src/renderer/src/components/focus-composer.test.tsx` | 渲染冒烟（jsdom + RO stub，code-view.test 惯例）：初始 doc/选区、markdown token class、doc 同步不重建、Enter 换行无发送路径、Esc onClose |
| `docs/design/v2/design-pending-cards.md` / `docs/design/design-keyboard-shortcuts.md` | 实施时同步补注：卡片渲染/快捷键适用条件加「专注模式抑制期间不渲染不响应」（§1.1b"恒为卡动作"的条件边界，§6.1） |
| `docs/spec/spec-v0.6.md`（实施时开篇） | 功能范围补录；design-layout 输入区条目指向本文 |

## 12. 验证要点（实施门）

- vitest 全绿（新增约 10–12 用例，卡片抑制 gate 含 1–2 例）+ typecheck 双侧
- 联调（本机 server）：场景表 #1–#22 手动过；重点 ③ Enter 组合矩阵、⑩ fcitx5
  （可编辑 CM + enable-wayland-ime 为本仓库首例，openchamber 有实证）、
  #15–#17 卡片抑制（渐隐/不弹/编辑键不劫持）、#9/#19/#20 引用附件面
  （拖放禁用/右键不可见/发送携带）、#21/#22 切换条与抑制面渐隐渐显、
  动画双向 + reduced-motion
- 动画帧率目测（Wayland 合成器）：200ms 内无可感知掉帧；输入延迟与普通模式
  无感差异（长草稿 ≥20KB 打字对比）
