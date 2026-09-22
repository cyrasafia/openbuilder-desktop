# Tab 条溢出（挤压 + overflow 菜单）— 设计文档

> 2026-09-22。全量开 Tab 后 Tab 条宽度不足的终案。前两轮滚动方案（可见滚动条、
> 隐藏滚动条+交互三件套）均实测推翻，迭代史见 design-tab-memory §11 与本文 §1。
>
> 参考先例（按 AGENTS.md 约定检索 `../openbuilder` 与 `../openchamber`）：均无
> 横向 Tab 条溢出处理可抄（移动端单会话路由；openchamber 用纵向 shadcn Tabs）。
> 行为语义对齐桌面浏览器 Tab 条（Chrome/Firefox）：先等比例挤压、最小宽兜底、
> 余量入溢出菜单、新建/溢出钮常驻。

## 1. 问题（滚动方案为什么死）

- **经典滚动条**：Chromium 自绘滚动条恒占位 8px——溢出出现瞬间 Tab 内容区
  35→27 跳变（`scrollbar-gutter: stable` 只作用纵向条挡不住横向占位；
  `padding-bottom` 车道实测无效，占位记在内容盒上）；且全局 thumb 色
  （outlineVariant 1.7:1、与 Tab 分隔线同色、轨道透明）画得出看不见（CDP 像素
  分析实证），提对比后又高又挤。
- **隐藏滚动条 + wheel/渐隐/滚入三件套**：零占位零跳变，但溢出 Tab 可发现性
  依赖边缘渐隐、纵向 wheel 被劫持为横滚（认知反直觉）、新开 Tab 靠自动滚入
  才可见——用户实测判"不可见 + 横向滚动困难"。
- 根因：Chromium 没有纯 CSS 的 overlay 滚动条开关，经典条的空间成本不可免。

## 2. 两段式溢出策略

- **第一段·挤压**：`.tab` 从 `flex-shrink: 0` 改 `1`（min-width 96 / max-width
  220 不变）——flexbox 收缩按 flex-basis 等比例缩减（宽 Tab 缩得多、相对比例
  保持），全体缩到 96 止。此段**纯 CSS**，无 JS。
- **第二段·溢出菜单**：全体到最小宽仍放不下 → 尾部 Tab 藏入 overflow 菜单。
  切片 = **纯公式，无 DOM 测量反馈环**：溢出态每个 Tab 恰为 min-width
  （border-box），`capacity = floor((barWidth - 72) / 96)`（72 =「+」（lucide
  Plus）32+4 与 overflow 钮（lucide ChevronsRight）32+4 两常驻钮，见
  workspace.tsx `TABBAR_CHROME_W`/`TAB_MIN_W`，与
  app.css 尺寸注释互为同步锚点）；`barWidth` 经 ResizeObserver 维护（0 = 未测得
  = 无限容量，防挂载首帧闪空），窗口缩放/侧栏收展/增删 Tab 即时重算。
- **可见集 = 前 `capacity` 个 ∪ 保位集**，渲染序 = 原序过滤（DOM 相对序不动）：
  - **激活保位**：激活 Tab 恒占一个可见槽（在溢出区时前缀少一位让位）——
    激活态（下划线/底色/状态点）不可隐入菜单，且**不改 store 顺序**（保
    drag-reorder「所见即所得 DOM 序提交」语义）。
  - **拖拽保位**：拖拽中项被预览重排推出当前前缀时同样占位保源节点不卸载
    ——dragend 在源元素上恒派发，节点被切片移除则 dragend 失派发、残留
    dragKey（既有「拖拽中 Tab 被移除」守卫只覆盖 store 侧移除）。
  - **保位判定按定点迭代收敛**（review 2026-09-22 修订）：不能按
    `idx >= capacity` 一刀切——先序保位项（激活）把前缀缩一位后，恰落
    `capacity-1` 的拖拽项漏保被卸载（dragend 失派发卡死拖拽态）；同理后
    加入的保位项可能把刚落在旧前缀边缘的先序保位项挤出。收敛式：某项若
    不入保位集则仅当 `i < capacity - 已保位数` 才可见，循环至无新增（保位
    项至多 2 个、每轮只增不删，两轮收敛）。
  - 退化角：capacity 极小（0/负）+ 多保位项 > capacity 时可见数可能超出容量
    一个——overflow: hidden 兜底裁切（min 窗口宽 680 下中栏 ≥ ~122px，
    capacity=0 仍保钮可见；实际不可达）。
- **常驻钮**：溢出入口（lucide ChevronsRight，仅存在溢出时渲染）+「+」新建
  （lucide Plus），均 `flex-shrink: 0`
  永不挤出视野——用户明确要求。

## 3. 溢出菜单

- 入口钮（ChevronsRight 14px）点开，锚点 = 钮位快照（左下角 +4px，钳制视口
  内）；再点同钮 = 关闭——菜单的 capture 级外部 mousedown 对锚点钮**豁免**
  （先于 click 关掉再被 click 的 toggle 重开，同 model-switcher Popover 锚点
  处理；review 2026-09-22 修订）。列表**随渲染实时**（关 Tab 即收缩，溢出清空
  则父级卸载菜单自然关闭）——区别于右键菜单的目标快照语义（那是单 Tab 动作
  菜单，这是活列表）。
- 行 = 激活钮（状态点 + 展示标题，复用条内 `tabDotClass`/`displayTabTitle` 单一
  来源）+ 行内「×」（`closeTabInteractive` 统一关闭路径：chat 流式确认/入关闭
  栈；菜单保持开放可连续关闭）。激活项高亮（surfaceContainerHighest）。
- 键盘 ↑/↓ 只遍历激活钮（× 为鼠标域）；Esc/外部 mousedown/滚动/失焦关闭
  （capture 四触发，TabContextMenu 模式第 5 处实例）；浮层计数进
  browser-view z-order 协调。限高 60vh/420px 纵向滚动（数十 Tab 全溢出）。
- 溢出清空时**复位开合态**（review 2026-09-22 二轮）：菜单经渲染守卫卸载（行内
  × 关掉最后一个溢出 Tab / 他端 SSE 关闭 / 窗口放宽容量增大）时任何关闭回调都
  不经走——残留态会在溢出复现时自发重挂菜单（过期锚点 + 抢焦点 + 压浮层）且
  overflow 钮 toggle 方向反转（首点变关）；effect 监听溢出集清零即复位，开合恒为用户
  显式动作。
- 菜单项**不可拖拽**（v1 裁剪：从菜单拖出排序的语义复杂——先激活再拖即可）。

## 4. 与拖拽重排的兼容

- dragover 几何判定天然只见可见 Tab（读 `.tab` DOM）——滞回带/末位判定不变；
  但**命中元素经 key 反查其在 base（拖拽预览坐标系）的真实下标**（review
  2026-09-22 修订：原 `i < slot ? i : i-1` 位置算术只对连续前缀成立，保位项
  穿插/中段项移除后 DOM 序 ≠ base 序，位置算术会落错槽甚至静默 no-op）。
- dragend 提交读**可见子集** DOM 序，`applyTabOrder` 槽位回填语义对子集安全
  （可见槽按 keys 序逐槽回填，溢出槽/跨作用域槽相对序不动）——零 store 改动。

## 5. 测试

- `workspace-tab-overflow.test.tsx`（组件级，jsdom + ResizeObserverStub 注入
  barWidth）：容量公式（足量/不足两态）、激活保位（前缀让位 + DOM 序保持）、
  菜单选中激活收起、行内 × 连续关闭、再点 overflow 钮 toggle 关闭（capture mousedown
  竞争）、拖拽 × 溢出（保位收敛 + key 槽位映射 + dragend 提交，2026-09-22
  review 三缺陷回归）。
- 挤压段（flex 等比收缩）为纯 CSS，无 jsdom 可测性（无布局），由隔离渲染
  harness 视觉验证 + 容量公式组件测试覆盖边界。

## 6. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/renderer/src/components/workspace.tsx` | 溢出切片（容量公式 + 保位集）、overflow 钮 + 菜单、`tabDotClass`/`displayTabTitle` 抽取共用；移除滚动三件套 |
| `src/renderer/src/styles/app.css` | `.tab` flex-shrink 1、`.tabbar` overflow:hidden、`.tabbar-overflow` 钮 + `.tab-overflow-*` 菜单样式；移除 mask/滚动条规则 |
| `src/renderer/src/i18n/index.ts` | `overflowTabs` 键（zh/en） |
