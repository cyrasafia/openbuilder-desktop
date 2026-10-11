# 聚合状态 chip 整体重设计 — 待办（todo-indicator-aggregate-chip）

> 类型：todo（暂时不做、未来另开分支实施的工作项记录；与 plan 的区别见
> AGENTS.md 文档分类——plan 是即将实施的较大改动的分步执行计划）。
> 来源：2026-10-11 未读标记（design-unread-marker）第一版目检——用户指出聚合 chip 可用性问题。
> 结论：**聚合 chip 需整体重新设计**，不在未读标记分支上做，另开分支实施。
> 关联：未读标记的 >4 会话行未读呈现**依赖本重设计**，故在未读分支上**不做**未读 chip
> （左栏只呈现 ≤4 的逐会话状态点）。

## 现状机制（app.css / sidebar.tsx）

左栏项目/工作区行右侧状态指示器（`sidebar.tsx` `SessionIndicator`）二选一呈现：

- **≤4 个会话** → 逐会话画 12px 状态点（`session-*`：12px 盒 + 6px 实心点；running/error 带
  11px 光晕呼吸）。
- **>4 个会话** → 收起为**聚合数字 chip**（`.session-count`：min-width 16 / 高 14 / `--radius-chip`
  的小胶囊，`数字`）；现状 5 种变体：待输入琥珀 / 重试红 / 运行绿 / 失败红 / 空闲灰。

## 问题清单（用户目检，2026-10-11）

1. **对比不足（放大既有问题）**：chip 用「状态色字 + 同色 16% 淡染底」——琥珀字压在琥珀淡底上，
   把 `--status-waiting` 本来就偏低的对比进一步压低（现 `--status-waiting` 亮色仅 ~2.9:1，
   见 tokens.css 注记）。
2. **深色底对比过低**：空闲灰 chip 走默认底（`surface-container`）+ `outline` 字，在深色主体上
   对比过低、几乎读不出。
3. **视觉关联性弱**：chip 只用「颜色 + 数字」，**未继承状态点的核心视觉特征（6px 圆点、光晕呼吸）**，
   与逐会话状态点不像一家人——同一行在 ≤4 / >4 两种形态间切换时，语义连续性断裂。

## 方案方向（草案，实施时定）

- **继承指示器语法**：chip 以 **6px 状态圆点领头**（同 `session-*` 点径/色），数字用中性前景
  （`on-surface`/`on-surface-variant`），状态色只落在圆点上——**从根上解掉「同色字压同色底」**。
- **呼吸延续**：运行中 chip 的圆点沿用光晕呼吸（与逐点态一致），其余静态。
- **容器对比**：给 chip 一个在深浅两主题都够对比的中性容器底（按非文字 3:1 下限校），
  或改用「无底描边」形态——待视觉实测。
- **未读**：一并纳入本重设计（蓝点领头的未读 chip）。

## 涉及落点（行号会漂移）

- `src/renderer/src/styles/app.css`：`.session-count` 及 `.session-count.{running,waiting,error,failed}` 全族。
- `src/renderer/src/components/sidebar.tsx`：`SessionIndicator`（>4 分支与计数逻辑）。
- `DESIGN.md`：左栏指示器章（chip 规格）。
- 参考：`docs/design/design-layout.md` §3（会话状态指示器）、`docs/design/v2/design-unread-marker.md` §5.1。

## 验收（草案）

- 深浅两主题下 chip 数字对容器底 ≥4.5:1（文字）/ 状态点对容器底 ≥3:1（非文字）；
- ≤4 与 >4 两种形态并排目检语义连续（圆点/呼吸一致）；
- `grep` app.css 无 chip 处同色字压同色底残留。