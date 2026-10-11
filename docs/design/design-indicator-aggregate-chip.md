# 聚合状态 chip 整体重设计 — 设计（design-indicator-aggregate-chip）

> 类型：design（纯 UI 视觉重设计，与协议契约无关，落 `docs/design/` 根）。
> 来源：未读标记分支（2026-10-11）目检发现的三问题——原记于
> `todo-indicator-aggregate-chip`（待办完成后已删，todo 仅记录未实施工作项），裁定另开
> 分支整体重设计；未读 chip 一并纳入本设计。
> 分支：`opencode/witty-planet`（2026-10-11 实施完毕，待办文件随之删除）。
> 参考：openbuilder `AgentStatusCountChip`（`lib/ui/widgets.dart`）——结构借鉴（状态圆点
> 领头 + 计数 + 胶囊），数字颜色为分歧点（见 §5）；chip 渲染序对齐移动端
> design-unread-marker §5.1 的 2026-10-11 用户裁定（见 §6）。
> 静态预览：同目录 `design-indicator-aggregate-chip.preview.html`（浏览器打开，深浅两主题
> 并排：终案 × 行两态 + 旧版对照 + ≤4 逐点态参照）。
> 用户定案（2026-10-11）：容器选**实体**，且要求未选中行上胶囊边界对比可见（纯
> `surface-container` 实底对行底仅 1.05:1 不足）；排序**对齐移动端**。

## 1. 问题（2026-10-11 目检，todo 归纳）

左栏项目/工作区行 `SessionIndicator` 在 >4 会话时收起为聚合数字 chip，现状三问题：

1. **同色字压同色底**：变体 chip 用「状态色数字 + 同色 16% 淡染底」，把状态色本来就偏低的
   对比进一步压低。实测（字对自家淡染底，文字需 ≥4.5:1）：浅色 waiting **2.35:1**、running
   3.43:1、unread 3.50:1、error 4.16:1，全部不达标；深色 error/failed 3.46:1 亦不达标
   （waiting 6.65:1 达标——问题主要在浅色档与红/绿/蓝深色档边缘）。
2. **深色空闲灰 chip 几乎读不出**：默认底 `--surface-container`（深 #222722）对行底
   `--surface-container-low`（#1e231e）仅 **1.05:1**，容器边界不可见；`--outline` 字（#8b938a）
   对 chip 底 4.81:1 名义达标但整簇过弱（用户目检「几乎读不出」）。
3. **视觉关联性弱**：chip 只用「颜色 + 数字」，未继承逐点态的核心视觉特征（6px 圆点、
   光晕呼吸），≤4 / >4 两形态切换时语义连续性断裂。

## 2. 方案总则

**继承指示器语法**：chip = **`session-*` 状态圆点领头（12px 盒、6px 实心点、呼吸动效全套免费
继承）+ 中性数字**。状态色只落在圆点上；数字与容器全状态同一套中性样式——**原 4 个状态
变体类（`.session-count.{running,waiting,error,failed}`）整体删除**，从根上解掉「同色字压
同色底」（验收 grep 无残留，chip 处仅剩一条中性规则）。

与移动端 `AgentStatusCountChip` 结构同构（圆点领头 + 计数 + 胶囊）；分歧：移动端数字用
状态色、靠亮色档加深保对比；本端按 todo 方向取**中性数字**，状态语义单点承载在圆点
（圆点即逐点态语法，不新增第二套「色字」语义）。

## 3. 视觉规格（终案）

- **结构**：`<span class="session-count"><span class="status-dot session-{state}"/>{n}</span>`——
  圆点复用既有 `session-*` 全套（12px 盒 / 6px 实心点 / running 与 error 的 11px 光晕呼吸 /
  idle 0.55 弱化 / unread 蓝静态），**chip 容器与数字不再按状态分支**。
- **几何**：chip 高 14（border-box：1px 描边 × 2 + 12px 点盒）、`padding: 0 3px`、`gap` 1px
  （点盒自带 3px 视觉边距，数字与 6px 实心点净距 ≈4px）、`--radius-chip` 圆角、`--text-xs`
  11px/400、`line-height` 12（数字居于描边内 12px 内容盒正中）、
  `font-variant-numeric: tabular-nums`（计数实时变化防抖宽）；chip 间沿用
  `.session-indicator` gap 3px。单 chip 宽 ≈28px（1 位数），较现状 ≈16px 增宽——行内流式
  元素本就在其前省略文本，可接受；6 状态齐呈 ≈150px 为极端态，常态 1–3 chip 更短。
- **数字**：`--on-surface-variant`（次级标签角色，DESIGN.md 排版表「chip 标签」档）。
- **容器（用户定案「实体 + 边界可见」的解）**：`--surface-container-high` 实底 +
  1px `--outline-variant` 细描边。**数学约束**：error 红点 ≥3:1 非文字门限把深色档实底亮度
  钉死在 ~high 档以内（再提档红点即破 3:1），纯底色对未选中行底的边界上限仅 ~1.2:1
  （1.05 → 1.2 不构成「可见」）——**边界由描边承载**（对未选中行底深 1.7:1 / 浅 1.4:1），
  实底同步提一档补强。实底使 chip 底色**不随行态漂移**（内容对比与行选中/hover 无关；
  行 hover 时指示器整体隐藏，实底与 hover 行底同档不构成冲突）。
- **idle 点 0.55 弱化照旧**（与 ≤4 逐点态、Tab 条同档——连续性优先）。

### 3.1 候选与定案记录

| 候选 | 形态 | 结果 |
|---|---|---|
| A | 实底 `--surface-container` | 用户选「实体」的方向，但未选中行边界 1.05:1 被裁定不足 → 终案在其上提档+描边 |
| **终案** | 实底 `--surface-container-high` + 1px `--outline-variant` 描边 | 全部对比门限通过，两行态边界均可见 |
| C | 裸排（无底无描边） | 弃：chip 底随行底漂移，深色选中行 error 红点 2.62:1 破 3:1；数字与路径文本形态趋同 |
| D | 无底描边（transparent + 描边） | 弃：同 C 的行底漂移问题 |

### 3.2 对比度实测（WCAG 相对亮度，两主题；字 ≥4.5:1 / 非文字点 ≥3:1）

对 chip 实底 `--surface-container-high`（实底恒定，不随行态漂移）：

| 配对 | 深 | 浅 |
|---|---|---|
| 数字 on-surface-variant × 实底 | **6.35** | **6.96** |
| waiting 点 × 实底 | 7.95 | 2.43 ※ |
| error 点 × 实底 | **3.39** | **4.84** |
| running 点 × 实底 | 4.56 | 3.75 |
| unread 点 × 实底 | 5.25 | 3.88 |
| idle 点（0.55 合成）× 实底 | 2.31 ※ | 1.84 ※ |
| 描边 outline-variant × 未选中行底 | **1.71** | **1.40** |
| 实底 × 未选中行底 | 1.21 | 1.11 |
| （现状对照）waiting 字 × 自家 16% 淡染底 | 6.65 | 2.35 ✗ |

※ 两条**既知接受例外**（非本次引入，与 ≤4 逐点态同源同值，连续性优先）：
- 浅色 waiting 琥珀：tokens.css 2026-10-09 用户裁定「识别度优先，对比损失接受」（#b8860b）；
- idle 点 0.55 弱化：三处呈现（≤4 逐点 / Tab 条 / chip）刻意降噪，计数信息由数字承载。

## 4. 计数与未读纳入

- `dotStateFor` 六态全量进 chip 白名单：`running / error / failed / waiting / unread / idle`，
  各自为 0 时省略；**chip 数字之和 = 会话总数**（idle = 总数 − 其余五态，原「未读计入
  空闲」的过渡口径废止——todo 裁定未读 chip 随本重设计落地）。
- 悬停 title（`sessionIndicatorTitle`）已含 `{unread}`，不动。
- 点类名映射收拢为 `Record<SessionDotState, string>` 常量（chip / 逐点两分支共用）：
  Record 键穷尽使新增状态缺映射即编译错，替代两处同构三元链（后者对新增状态静默
  回落灰点——unread 设计 §5.2 记录过的坑）。

## 5. 与移动端的同构与分歧

| 维度 | 移动端 `AgentStatusCountChip` | 本端终案 | 备注 |
|---|---|---|---|
| 结构 | 13px 盒圆点 + 数字 + 胶囊 | 12px 盒圆点 + 数字 + 胶囊 | 同构（点盒径沿各自端 session-* 几何） |
| 数字色 | 状态 accent 色（亮色档加深保 ≥4.5:1） | `on-surface-variant` 中性 | 分歧：todo 方向「状态色只落圆点」，避免第二套色字语义 |
| 底 | 12% 状态色淡染（idle 中性底） | `container-high` 中性实底 + 细描边 | 分歧：中性底即问题 1 的根解 |
| 排序 | running → retry → failed → waiting → unread → idle | 同 | 对齐（2026-10-11 用户裁定） |

## 6. 排序（对齐移动端）

**running → error → failed → waiting → unread → idle**（openbuilder design-unread-marker §5.1
2026-10-11 用户裁定，两端同序）。语义：生命周期自左向右——绿/红呼吸（自发迁移源，会自行
变为其他态）居左，经 failed/waiting 至 unread/idle 收尾。本端原「渲染序 = dotStateFor
优先级链」（waiting 居首）随之改序；与 title 列举序（进行中/重试/失败/待输入/未读）一致。

## 7. 涉及文件（已实施）

| 位置 | 改动 |
|---|---|
| `src/renderer/src/components/sidebar.tsx` | `SessionIndicator` >4 分支：chip 内嵌 `session-*` 圆点、六态计数数组化（移动端序）、idle 计数扣未读；`DOT_CLASS` Record 收拢两分支点类名映射；导出供测试；注释同步 |
| `src/renderer/src/styles/app.css` | `.session-count` 重写为中性实底+描边胶囊；**删除 `.session-count.{running,waiting,error,failed}` 全族**；`.tree-row.active` 与 `.error-card` 注释中 session-count 淡染先例引用清理 |
| `src/renderer/src/components/sidebar.test.tsx` | 新增：≤4 逐点类名序、>4 chip 序/省略/圆点领头/变体类清零、未读纳入与总数守恒 |
| `DESIGN.md` | 项目/工作区树行：聚合 chip 规格同步 |
| `docs/design/design-layout.md` | §3 会话状态指示器：>4 聚合 chip 描述改写 |
| `docs/design/v2/design-unread-marker.md` | §5.1/§7/§8/§9 前向引用落定（重设计已实施，未读 chip 生效） |
| `docs/spec/spec-v0.5.md` | §11 未读标识行：聚合 chip 重设计纳入本版范围 |
| `docs/todo/todo-indicator-aggregate-chip.md` | 待办完成，删除 |

## 8. 验收（已核）

- 深浅两主题：chip 数字对容器底 ≥4.5:1 / 状态点对容器底 ≥3:1（§3.2，两条既知例外除外）；
- ≤4 与 >4 形态并排目检：圆点几何/呼吸/弱化一致，语义连续（预览并列可核）；
- `rg session-count app.css` 仅一条中性规则，无「同色字压同色底」残留；
- 六态计数之和 = 会话总数（测试断言）；未读 chip 呈现/消点随 `time.viewed` 水位收敛；
- `npm run typecheck` 通过；`npm run test` 1227 passed / 1 skipped（既有 skip 不变）。

## 9. 已知 gap（明确不做）

- **指示器 title 失效**：行 hover 隐藏指示器（visibility:hidden 无指针事件）致
  `sessionIndicatorTitle` 悬停不可达——现状既有，与本重设计无关，不在此修。
- **workspace.tsx（chat Tab）点类名三元链未收拢**：本设计只动 sidebar；Tab 条的
  映射链坑已在 unread 设计 §5.2 记录，待其自身改动时再收。
- **移动端数字色分歧不回传**：两端数字色策略不同（状态色 vs 中性），为各自终案，
  不互相同步。
