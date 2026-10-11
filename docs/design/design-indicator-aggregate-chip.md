# 聚合状态 chip 整体重设计 — 设计（design-indicator-aggregate-chip）

> 类型：design（纯 UI 视觉重设计，与协议契约无关，落 `docs/design/` 根）。
> 来源：未读标记分支（2026-10-11）目检发现的三问题——原记于
> `todo-indicator-aggregate-chip`（待办完成后已删，todo 仅记录未实施工作项），裁定另开
> 分支整体重设计；未读 chip 一并纳入本设计。
> 分支：`opencode/witty-planet`（2026-10-11 实施完毕）。
> 参考：openbuilder `AgentStatusCountChip`（`lib/ui/widgets.ts`）——结构借鉴（状态圆点
> 领头 + 计数 + 胶囊），数字颜色为分歧点（见 §6）；chip 渲染序对齐移动端
> design-unread-marker §5.1 的 2026-10-11 用户裁定（见 §5）。
> 静态预览：同目录 `design-indicator-aggregate-chip.preview.html`（浏览器打开，深浅两
> 主题并排：终案 × 行两态 + 旧版对照 + ≤4 逐点态参照 + 原生 4× 标本验形段）。
> 用户定案记录（2026-10-11，按目检轮次）：容器选**实体**且未选中行边界须可见 →
> 实底+描边案（surface-container-high + outline-variant）被**否**，改**反色填充**；
> 排序**对齐移动端**；圆点分数 DPR 变形、光晕切边、数字居中三轮目检后全部定稿
> （「现在都好了」）。

## 1. 问题（2026-10-11 目检，todo 归纳 + 实施中追加）

左栏项目/工作区行 `SessionIndicator` 在 >4 会话时收起为聚合数字 chip，问题清单：

1. **同色字压同色底**：变体 chip 用「状态色数字 + 同色 16% 淡染底」。实测（字对自家
   淡染底，文字需 ≥4.5:1）：浅色 waiting **2.35:1**、running 3.43:1、unread 3.50:1、
   error 4.16:1，全部不达标；深色 error/failed 3.46:1 亦不达标。
2. **深色空闲灰 chip 几乎读不出**：默认底 `--surface-container`（深 #222722）对行底
   `--surface-container-low`（#1e231e）仅 **1.05:1**，容器边界不可见；`--outline` 字
   整簇过弱。
3. **视觉关联性弱**：chip 只用「颜色 + 数字」，未继承逐点态的核心视觉特征（6px 圆点、
   光晕呼吸），≤4 / >4 两形态切换时语义连续性断裂。
4. **（实施中追加）圆点分数 DPR 变形**：Chromium 在分数 DPR（GNOME Wayland
   1.25/1.5 等）下对 border-radius 盒做「吸附后拉伸」光栅化，6px 圆点按位置亚像素
   相位变形为扁/竖椭圆（DevTools 布局尺寸仍 6×6；用户目检「绿/静态红/蓝变成胶囊
   形」）。**全 app 状态点族共有**（Tab 条/左栏逐点态/连接状态点），非 chip 独有。
5. **（实施中追加）光晕切边**：SVG 化后 `<svg>` 默认裁剪内容到自身视口（规范行为），
   呼吸最大 scale 1.15 = 12.65px 超出 12px 点盒被切边。
6. **（实施中追加）数字光学居中的引擎下限**：文字基线被 Chromium 吸附到整数设备
   像素，亚像素文字位移在分数 DPR 下无效（详见 §4.3）。

## 2. 方案总则

**继承指示器语法**：chip = **状态圆点领头（12px 盒，与 ≤4 逐点态同几何同动效，呼吸/
弱化全套继承）+ 中性数字**。状态色只落在圆点上；数字与容器全状态同一套中性样式——
**原 4 个状态变体类（`.session-count.{running,waiting,error,failed}`）整体删除**，从根上
解掉「同色字压同色底」（验收 grep：chip 处仅一条中性规则）。

与移动端 `AgentStatusCountChip` 结构同构（圆点领头 + 计数 + 胶囊）；分歧：移动端数字
用状态色、靠亮色档加深保对比；本端按 todo 方向取**中性数字**，状态语义单点承载在圆点。

## 3. 视觉规格（终案）

- **结构**：`<span class="session-count"><SessionDot state/><span class="session-count-num">{n}</span></span>`——
  圆点走共享 `SessionDot` 组件（见 §4.1），chip 容器与数字不再按状态分支。
- **几何**：chip 高 14、`padding: 0 3px`、`gap` 1px（点盒自带 3px 视觉边距，数字与
  6px 实心点净距 ≈4px）、`--radius-chip` 圆角、`--text-xs` 11px/400、`line-height: 12`、
  `font-variant-numeric: tabular-nums`（计数实时变化防抖宽）；chip 间沿用
  `.session-indicator` gap 3px。单 chip 宽 ≈28px（1 位数）。
- **数字**：`--on-surface-variant` + **1px 光学下移**（§4.3）。
- **容器 = 反色填充（用户定案「实体 + 未选中行边界可见」的解）**：胶囊取**行态对侧
  色**——未选中行上填「选中灰」（`color-mix(in srgb, var(--surface-container-highest)
  96%, var(--on-surface))`，与 `.tree-row.active` 同式），选中行上填行底色
  （`.tree-row.active .session-count { background: var(--surface-container-low) }`）。
  **边界对比恒等于选中信号步幅**（深 1.56:1 / 浅 1.26:1，两行态对称恒定）——借用系统
  内已验证可见的最强安静步级；无描边（实底+outline-variant 描边案在目检中被否）。
  实底另令内容对比不随行态漂移。
- **idle 点 0.55 弱化照旧**（与 ≤4 逐点态、Tab 条同档——连续性优先）。

### 3.1 容器候选与定案记录

| 候选 | 形态 | 结果 |
|---|---|---|
| A 初版 | 实底 `--surface-container` | 未选中行边界 1.05:1 被裁定不足 |
| B 描边案 | 实底 `--surface-container-high` + 1px `--outline-variant` 描边 | 曾为推荐案（数学约束：error 红点 3:1 门限钉死实底档位、纯底色边界 ~1.2:1 不足）→ **用户否**（不要描边） |
| C 裸排 | 无底无描边 | 弃：底随行底漂移 + 数字与路径文本形态趋同 |
| D 无底描边 | transparent + 描边 | 弃：同 C |
| **终案** | **反色填充**（行态对侧色，无描边） | 用户定案并目检通过；边界 = 选中步幅，两行态对称 |

### 3.2 对比度实测（WCAG 相对亮度，两主题；字 ≥4.5:1 / 非文字点 ≥3:1）

B1 = 选中灰（未选中行胶囊底）；B2 = container-low（选中行胶囊底）：

| 配对 | 深 B1 | 深 B2 | 浅 B1 | 浅 B2 |
|---|---|---|---|---|
| 数字 on-surface-variant | **4.92** | **7.65** | **6.19** | **7.78** |
| waiting 点 | 6.15 | 9.57 | 2.16 ※ | 2.72 ※ |
| error 点 | 2.62 ※ | 4.08 | **4.30** | 5.40 |
| running 点 | 3.53 | 5.49 | **3.33** | 4.19 |
| unread 点 | 4.07 | 6.33 | **3.45** | 4.34 |
| idle 点（0.55 合成） | 2.01 ※ | 2.53 ※ | 1.75 ※ | 1.93 ※ |
| 胶囊 × 行底（边界） | **1.56** | **1.56** | **1.26** | **1.26** |

※ 三条**既知接受例外**（红点对「选中灰」的例外为系统既有值，其余两条与 ≤4 逐点态
同源同值，连续性优先）：
- 深色 error 点 × B1（2.62）：**= ≤4 逐点态画在选中行上的既有值**（同一底色 B1——
  选中行上逐点态的红点本就是 2.62:1，红点亮度是全系统的既有容忍位，非本次引入）；
- 浅色 waiting 琥珀：tokens.css 2026-10-09 用户裁定「识别度优先，对比损失接受」；
- idle 点 0.55 弱化：三处呈现刻意降噪，计数信息由数字承载。

## 4. 渲染层三处修正（实施中目检发现，全端生效）

### 4.1 圆点 inline SVG 化（修分数 DPR 变形）

- **根因**：Chromium 对 border-radius 盒做「吸附后拉伸」光栅化——分数 DPR 下 6px
  圆点的光栅盒按位置亚像素相位左右/上下各自取整，变形为扁/竖椭圆；**方向与幅度随
  位置相位变**（用户实测：缩小时 1/3/5 号位宽>高、放大时 1/2/4/6 号位高>宽——
  即相位现象）。DevTools 布局尺寸不变（6×6）。
- **变体实验**（16 个 x 相位 × DPR 1.25/1.1，无头 Chrome 像素实测）：border-radius
  （含 inset 定位去 transform）、radial-gradient、SVG data-URI 背景、clip-path
  circle——**全部随相位翻转**；唯 **inline SVG `<circle>`** 路径光栅化相位不敏感
  （16 相位全部同几何）。
- **落点**：新建共享组件 `session-dot.tsx`——`Record<SessionDotState, string>` 穷尽
  映射（新增状态缺映射即编译错，消除 sidebar/workspace 两处同构三元链对新增状态
  静默回落灰点的坑，即 unread 设计 §5.2 记录的坑）+ SVG（viewBox 12，core r=3、
  running/error 附 halo r=5.5 呼吸）。消费点：sidebar 逐点态/聚合 chip、workspace
  Tab 条与溢出菜单（`tabDotClass` 三元链改 `tabDotState` 直返状态）。**基类 6px
  裸点**（左栏连接状态点）同步 SVG 化（同一变形机制）。CSS 侧 `--session-dot-color`
  变量下发填充色，`::before/::after` 伪元素族全删。
- **光晕切边修复**：SVG 元素默认裁剪内容到自身视口（规范行为），呼吸最大 scale 1.15
  （12.65px）超 12px 盒被切——`.status-dot svg { overflow: visible }`。

### 4.2 4× 标本的渲染路径教训（预览工程）

预览的验形标本不可用 `transform: scale()` 放大——scale 路径的光栅舍入与原生路径
不同（实测放大标本中出现原生路径没有的 Δ2 变形），不能作验形载体；改为**原生 4×
尺寸**渲染（`.nc4` 等独立规格）。

### 4.3 数字 1px 光学下移（文字基线量化的取舍）

- 数字无降部，字形重心恒高于行盒中心（line-height 只缩放盒子、不移动行内字形）。
- **实测矩阵**（nudge × DPR，墨迹重心 − 圆点中心，css；本机 headless Chrome 像素实测）：

| nudge | DPR 1.25 | 1.5 | 2 | 4 |
|---|---|---|---|---|
| 0 | −0.76 | −0.60 | −0.89 | −0.42 |
| 0.5px | −0.33 | −0.32 | −0.51 | +0.08 |
| **1px（定案）** | **−0.33** | **−0.04** | **−0.13** | +0.58 |

- 结论：Chromium 把**文字基线吸附到整数设备像素**——分数 DPR 下亚像素文字位移被
  量化吸收（1.25 档 0.5/0.75/1px 落点实测完全相同），**1.25 档残余 −0.33 为引擎
  硬限**，任何 CSS 值不可再压；1px 为分数 DPR 场景数据最优。残差随字形墨迹分布
  摆动 ±0.2~0.5（"1" 旗衬偏上、"2"/"3" 圆碗偏下），字体固有，比例文本通用行为。

## 5. 排序（对齐移动端）

**running → error → failed → waiting → unread → idle**（openbuilder
design-unread-marker §5.1 2026-10-11 用户裁定，两端同序）。语义：生命周期自左向右
（绿/红呼吸 = 自发迁移源居左，经 failed/waiting 至 unread/idle 收尾）。本端原
「渲染序 = dotStateFor 优先级链」（waiting 居首）随之改序；与 title 列举序
（进行中/重试/失败/待输入/未读）一致。

## 6. 与移动端的同构与分歧

| 维度 | 移动端 `AgentStatusCountChip` | 本端终案 | 备注 |
|---|---|---|---|
| 结构 | 13px 盒圆点 + 数字 + 胶囊 | 12px 盒 SVG 圆点 + 数字 + 胶囊 | 同构（点盒径沿各自端几何） |
| 数字色 | 状态 accent 色（亮色档加深保 ≥4.5:1） | `on-surface-variant` 中性 | 分歧：todo 方向「状态色只落圆点」 |
| 底 | 12% 状态色淡染（idle 中性底） | 反色填充中性底（行态对侧色） | 分歧：中性底即问题 1 的根解 |
| 排序 | running → retry → failed → waiting → unread → idle | 同 | 对齐（2026-10-11 用户裁定） |
| 圆点渲染 | Flutter 自绘（无此变形） | inline SVG（Chromium 分数 DPR） | 平台差异各自的解 |

## 7. 计数与未读纳入

- `dotStateFor` 六态全量进 chip 白名单：`running / error / failed / waiting / unread /
  idle`，各自为 0 时省略；**chip 数字之和 = 会话总数**（idle = 总数 − 其余五态，原
  「未读计入空闲」的过渡口径废止）。
- 悬停 title（`sessionIndicatorTitle`）已含 `{unread}`，不动。

## 8. 涉及文件（已实施）

| 位置 | 改动 |
|---|---|
| `src/renderer/src/components/session-dot.tsx` | **新增**：共享 SessionDot 组件（Record 穷尽映射 + inline SVG 圆点 + halo） |
| `src/renderer/src/components/sidebar.tsx` | `SessionIndicator` chip/逐点两分支消费 SessionDot、chip 数字 span、idle 扣未读、六态计数数组化（移动端序）；ServerStatus 基点 SVG 化；注释同步 |
| `src/renderer/src/components/workspace.tsx` | `tabDotClass` 三元链改 `tabDotState` 直返；Tab 条与溢出菜单消费 SessionDot |
| `src/renderer/src/styles/app.css` | `.session-count` 反色填充 + `.tree-row.active` 对侧底 + `.session-count-num` 1px 光学下移；**状态点全族 SVG 化**（`::before/::after` 伪元素族删、halo-breathe 改纯 scale、基类/变体统一 `--session-dot-color` 填充） |
| `src/renderer/src/components/sidebar.test.tsx` | chip 测试增 SVG 结构（core/halo 圆数量）与 `.session-count-num` 断言 |
| `DESIGN.md` | 左栏行规格 chip 终案 + 状态点 SVG 渲染规则 |
| `docs/design/design-layout.md` | §3 会话状态指示器：chip 终案描述 |
| `docs/design/v2/design-unread-marker.md` | §5.2 三元链坑收拢注记（已由共享 Record 消除） |
| `docs/spec/spec-v0.5.md` | §11 未读标识行：聚合 chip 重设计呈现（首版已写入，无增量） |

## 9. 验收（已核）

- 深浅两主题：数字对胶囊底 ≥4.5:1（4.92–7.78）；状态点 ≥3:1（§3.2 三条既有例外除外）；
  边界 1.56:1 / 1.26:1 两行态对称；
- 圆点形状：DPR 1.25 全部 7×7、1.5 全部 8×8、1.1 全部 5×5（像素级实测，逐位置同几何）；
- 数字光学居中：DPR 1.5 墨迹均值 +0.02 css（1.25 档 −0.33 为基线量化引擎下限，已记）；
- ≤4 与 >4 形态并排目检：圆点几何/呼吸/弱化一致，语义连续（用户定稿「现在都好了」）；
- `rg session-count app.css`：chip 处一条中性规则 + 选中行覆盖 + 数字位移，无变体族残留；
- 六态计数之和 = 会话总数（测试断言）；未读 chip 呈现/消点随 `time.viewed` 水位收敛；
- `npm run typecheck` 通过；`npm run test` 1227 passed / 1 skipped（既有 skip 不变）。

## 10. 已知 gap（明确不做）

- **指示器 title 失效**：行 hover 隐藏指示器（visibility:hidden 无指针事件）致
  `sessionIndicatorTitle` 悬停不可达——现状既有，与本重设计无关，不在此修。
- **1.25 档数字 −0.33 css 残余**：文字基线量化引擎下限（§4.3），不可 CSS 压制；
  可选缓解 = 加大数字字号摊薄比例，未采纳（改动排版档位代价大于收益）。
- **移动端数字色/容器分歧不回传**：两端策略各自终案，不互相同步。
- **scale() 放大光栅路径与原生不同**：预览工程教训（§4.2）已记，后续任何「放大验形」
  类标本一律原生尺寸渲染。
