# 左栏项目行拖拽排序 — 设计文档（实时预览 + 所见即所得落位）

> 2026-08-29。左栏顶级 entry（普通项目行 / global 目录行）拖拽重排序；行序 = 打开顺序。
> 纯 renderer 改动，server 无参与（顺序是纯客户端状态，`ProjectState.opened` 按 profile 持久化）。
>
> 先例检索（AGENTS.md 约定）：`../openbuilder` 移动端无项目侧栏，无同类设计。
> 同仓库先例 [design-tab-drag-rename.md](./design-tab-drag-rename.md)（Tab 条拖拽，命中半区 + 指示线）——
> 本方案第一版曾直接复用该模式，实测暴露三处不适配（见 §6 踩坑），最终演进为本文方案。
> 行为速览见 [design-layout.md](./design-layout.md) §3"行序与拖拽排序"。

## 1. 行序语义（打开顺序，非创建顺序）

- `openedEntries` 行序 = `ProjectState.opened` 数组序（按 profile 经 `project.state` 持久化、重启保留）。2026-08-29 修订：原按 server projects 快照序迭代 = 创建序，弃用
- 新打开项目 / global 目录**追加末位**（`openProject`/`openGlobalDirectory` push 语义）；关闭移除键、**重开落末位**
- `openedEntries` 由 opened 键序直接投影：无法解析的键（项目快照未落地）跳过不占位；键与行一一对应（open 去重、close 移除），不会产生重复行

## 2. 交互：实时预览式（非指示线式）

拖动中列表**即时重排**：拖拽项在目标插入位渲染为**占位样式**（`.dragging`：虚线框 + 降不透明度），源位间隙随之闭合，其余项目组实时让位；松手才提交。占位行压过行三态背景（未选中/hover/active——本块 CSS 位于三态规则之后同特异性胜出）并隐藏行内操作钮，防预览态出现可点反馈。

- 预览坐标系：`slot` = 插入位，以**移除拖拽项后的数组**（base）为基准（0..base.length）；渲染序 `preview = base[0..slot) + dragged + base[slot..]`。悬停行换算回 base 下标（`i < slot ? i : i - 1`）再算命中——直接用可见下标会在预览移位后产生"行移位→悬停行漂移→预览回跳"的抖动振荡
- worktree 行不入拖拽：拖项目行 = 整组（项目 + 其全部 worktree）移动；global 目录行与普通项目行**平权参与**（键统一为 entry key）

## 3. 换位判定：边缘带几何（容器级统一计算）

dragover 挂在 `.tree` 容器上（行级无 dragover），按光标 Y 遍历预览序项目行：

- 光标落入某行**上 25% 区域** = 插其前；**下 25% 区域** = 插其后（换算回 base 下标）
- **中间 50% = 滞回带**：维持当前插入位——预览换位后行会移位，滞回带吸收移位量防抖
- 光标不在任何行内（行间空隙 / 首行上方）= 最近边界（插到下一行前）；**末行中线以下全部区域（含列表空白）= 末位**——移到最后无需精确命中末行下半缘
- 悬停占位行自身 = 维持当前插入位
- 判定用 `hit` 标记区分"行内滞回（next=null → 不动）"与"未命中任何行（next=末位）"——两态共用 next=null 会把中带误判成移到末位（迭代中实际出过此 bug）
- dragover 高频触发：同值保留旧引用 React bail out（同 Tab 条约定）

## 4. 落位：dragend 提交 + DOM 序整体重排（所见即所得）

**提交挂 `dragend` 而非 `drop`**（2026-08-29 关键修订）：`drop` 只在松手点位于 dragover 被 preventDefault 的合法落区内才触发——**松手在左栏外、快速拖动越界时浏览器直接取消拖拽、只发 `dragend`**，挂 drop 的提交在这些场景全部丢失（实测复现："预览已到位、松手不动"）。`dragend` 在源元素上恒触发，任何释放位置都提交。

提交内容 = **松手时预览 DOM 序**：读 tree 容器内 `.project-group` 的 `data-entry-key` 顺序，调 `store.applyEntryOrder(keys)` **整体重排** opened 数组——所见即所得。

- **不经 slot→目标键换算**：第一版按闭包里的 slot 推导目标键/前后插，与最后一次 dragover 的 setState 提交存在竞态窗口（预览已渲染新位、drop 闭包还持旧 slot），同样产生预览/落点不一致。DOM 是用户看到的唯一事实，直接读它提交
- `applyEntryOrder` 防御：keys 去重（重复键会写坏 opened）；未覆盖的键（拖拽中快照变化）按原相对顺序追加，不复活已关 entry；顺序无变化 no-op 不落盘
- `onDrop` 仅保留 preventDefault（屏蔽浏览器对拖拽数据的默认处理）；容器 dragover 的 preventDefault 不再承担"保证 drop 触发"职责，只服务于预览几何连续生效

## 5. store API

`applyEntryOrder(keys: string[])`（app-store.ts，替代初版 `moveEntry(dragKey, targetKey, before|after)`——后者落位换算语义已被整体覆盖式提交取代，删除）：

- 重排 `ps.opened` → emit → `persistProjectState()`（`project.state`，fire-and-forget 同全库惯例）；无变化早退不 emit 不落盘

## 6. 踩坑记录（三轮实测迭代，含最终取舍）

1. **死区 drop 不触发**：行级 dragover/drop 模式（Tab 条同款）下，worktree 行、行间空隙、列表空白都不是合法落区——光标停在这些位置松手，浏览器取消拖拽只发 dragend，预览停留在上次插入位但不提交。修法：落点判定与 preventDefault 收归容器级
2. **快速拖动丢落位**：同根因的越界形态——快速拖动常越出列表边缘松手。修法：提交挂 dragend（恒触发）
3. **slot 换算竞态**：提交从闭包 slot 推导目标，与最后一次 dragover 的 setState 有竞态窗口。修法：提交改为读 DOM 序整体重排，与用户所见严格一致
4. **中带误判末位**：几何循环里"行内中带（不动）"与"遍历完未命中（末位）"共用 null 哨兵，中带被兜底成移到末位。修法：hit 标记分离两态
5. **Esc 取消不可行**：曾用 window keydown capture 置位跳过提交——Chromium/Electron 原生拖拽运行在嵌套循环中，**页面收不到键盘事件**，监听是死代码；且 Esc 原生取消与栏外松手在 dragend 层不可区分（dropEffect 均 "none"，不可靠也不可依赖）。最终取舍：**任何方式结束拖拽均提交预览序**（与"栏外松手要落位"的需求一致优先）；Esc 的效果 = 立即提交当前预览序。弃用文档化于 design-layout.md §3
6. **拖拽中 entry 消失**：快照刷新移除被拖 entry 时 `entries[dragIdx]!` 为 undefined 进渲染崩溃。修法：preview 推导加 `dragIdx >= 0` 守卫（review 发现）

## 7. 不做的事

- worktree 行拖拽排序（用户明确：worktree 跟着项目走）
- 拖拽动画/过渡（React 重排为即时位移，未引入 FLIP）
- 键盘排序、触屏长按排序
- Tab 条拖拽迁移到本方案（Tab 条横向单行、无死区问题，指示线模式够用且已验证）

## 8. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/renderer/src/store/app-store.ts` | `openedEntries` 按 opened 序投影；`applyEntryOrder(keys)` |
| `src/renderer/src/components/sidebar.tsx` | 容器级 dragover 几何判定 + dragend DOM 序提交 + 预览渲染 |
| `src/renderer/src/styles/app.css` | `.tree-row.project-row.dragging` 占位样式（压三态背景、藏行内操作钮） |
| 测试 | store：打开序/新开末位/关闭重开末位、applyEntryOrder（重排落盘/无位移早退/去重/ghost/global 平权） |

## 9. 验收口径

- 打开顺序 = 左栏行序：先开 B 后开 A → B 在前；关 A 重开 → A 落末位；重启顺序保持
- 拖动中：列表即时重排、占位样式随光标连续移动；行间空隙、worktree 行、列表空白处悬停均有合理预览（不回跳、不丢失）
- 松手：任何释放位置（含左栏外、快速越界）均按松手时预览序落位；顺序无变化不产生写盘
- worktree 组随项目整体移动；global 目录行与项目行互相穿插排序
