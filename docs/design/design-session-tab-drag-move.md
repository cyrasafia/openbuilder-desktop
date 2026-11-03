# 会话 Tab 拖放移动到工作区 — 设计文档

> 2026-11-03 增补：会话 Tab 拖拽在 Tab 条内重排序（design-tab-drag-rename §1）
> 之外，增加拖放到左栏 worktree 行 = 移动会话（右键「移动到」的补充入口，
> 目标集与 design-session-tab-context-menu §2.5 一致）。纯 renderer 改动，
> 复用既有 `moveSession` REST 通道与 `session.moved` 收敛路径，无新 API。
>
> 参考先例（按 AGENTS.md 约定检索 `../openbuilder/docs/design-*.md`）：移动端
> 无 Tab 条与左栏（单会话路由），无拖放移动先例。

## 1. 问题

- 会话移动只有右键菜单一个入口：目标在左栏可见（worktree 行），操作却要经
  右键弹菜单中转——「拖过去」是桌面端更直接的惯例（同项目行拖拽重排序、
  文件拖入 composer 引用条的语言）。
- Tab 条内拖拽已存在（重排序），用户对「拖 = 移动」有自然预期。

## 2. 设计

### 2.1 交互形态

- **拖动 chat Tab 悬停左栏合法目标行**（同项目的 worktree 行 / 项目行=主工作区，
  排除会话当前目录）→ 行高亮（`.tree-row.drop-target`）＝移动目标指示；
  Tab 条内拖拽重排序行为不变（拖在 Tab 条上时仍是重排序预览）。
- **所见即所得 + 任意位置放手**（同 Tab 重排序 dragend 提交语义）：目标行
  高亮期间（= 当前预览是"移动"），**放手在任意位置都执行移动**——不只限
  高亮行内；dragend 在源元素恒触发（Tab 条外/快速越界松手照常提交），提交
  内容取「最后显示的目标」。两类预览**互斥切换**（review 修订：双向）：
  - 悬停合法目标行 → 设移动目标（粘滞：此后悬停非法区域——他项目行、
    窗口空白、右栏——目标保持显示，放手即移动）；同时清 dragSlot——
    Tab 条回原序、拖拽项占位回源位（插入位预览挂起，预览单一指向"移动"）；
  - 悬停回 **Tab 条** → 清目标、dragover 重设插入位预览（显式"放回排序"
    手势）；
  - 悬停会话**当前目录行** → 清目标（显式"放回原处"手势，同 Tab 条语义）。
  dragend 提交另有源一致性校验：登记的 sessionID 必须与 dragend 的 Tab
  key 同源（`chat:${sessionID}`），异常残留的登记/目标不被无关 dragend
  消费（纵深加固，正常路径不可能触发——溢出保位保证 dragend 恒达）。
- 原生拖拽期间无键盘事件（同项目行/Tab 重排序取舍）：无 Esc 取消路径，
  任何方式结束拖拽均按当前预览提交（移动或重排序）。
- 仅 chat Tab 有移动语义（同右键菜单门禁）；file/diff/terminal/browser Tab
  拖到左栏无高亮、无操作（重排序不受影响）。

### 2.2 拖拽带外登记与目标状态（store）

dragover 阶段浏览器禁读 `dataTransfer.getData`（design-file-reference §3.3
同坑），左栏行合法性判定取 dragstart 登记的带外副本；目标高亮需跨组件
（左栏行渲染）+ 跨区域（dragend 提交在 Workspace）可见——落在 AppStore
（sidebar 本就全量驱动）：

- `draggingChatTab: { sessionID, projectId, directory } | null`——chat Tab
  dragstart 写入（projectId/directory 取 Tab 实体；僵尸 Tab 字段空 → 任何
  行不匹配 = 不可拖放移动，右键菜单经 findSession 兜底不受影响），
  dragend/异常终了清空；
- `sessionDropTarget: string | null`——悬停合法行设置（同值不 emit，dragover
  高频无害）；`takeSessionDropTarget()` 供 dragend **取走并清空**（返回
  null = 无移动语义，回退重排序提交）；`cancelChatTabDrag()` 异常终了兜底
  （源 .tab 节点被 SSE 关闭卸载致 dragend 失派发时，既有 dragKey 失效守卫
  随手清；Workspace 卸载时 unmount 清理）。`beginChatTabDrag` 恒重置目标
  （上次拖拽残留不自泄）。

### 2.3 目标行合法性（左栏行级 dragover）

项目行（= 主工作区）与 worktree 行挂行级 dragover；合法性四条，任一不满足
即不高亮（也不 preventDefault，光标呈不可放）。「同项目/当前目录」按
`findSession` **实时归属**判定（review 二轮修订：dragstart 快照在拖拽手势内
他端 `session.moved` 竞态下过期——实时值消除高亮误判窗口，Map 查询成本可
忽略；无本地记录的僵尸 Tab 回退快照，空字段本就匹配不到任何行）：

1. `draggingChatTab` 非空（chat Tab 拖拽中——MIME 以外再用登记判定，项目行
   自身拖拽重排序/文件引用拖拽互不干扰）；
2. 行属会话**同项目**（`project.id === 实时 projectID`）；
3. 行目录 ≠ 会话**实时**当前目录（当前目录行 = 清目标的"放回原处"手势，
   见 §2.1）；
4. 移动 POST 不在途（`isSessionMoving`，同右键菜单禁用口径）。

合法即 `preventDefault()`（行成合法落区：move 光标 + drop 事件可达）+
`setSessionDropTarget(行目录)`。运行中会话**不禁入**（区别于右键菜单的
禁用项）：拖放走二次确认（§2.4）。行级 `onDrop` 仅 preventDefault（提交
统一在 dragend，同 Tab 条惯例）。`deleting` 行 `pointer-events:none`
自然不受理。提交时 `moveSession` 自身的目标合法性/目录等值守卫兜底（拖拽
期间 worktree 被删等竞态 → 静默 no-op）。

### 2.4 进行中会话：二次确认，先停止后移动

拖放提交（dragend）时会话进行中（`isSessionActive`，busy/retry 同口径）→
挂 ConfirmDialog（复用 pendingTabClose 弹窗模式，ConfirmDialog 的
Promise onConfirm loading 态承载停止耗时）：

- **确认** → `store.moveSessionConfirmed(sessionID, directory)`：
  1. 重估（弹窗期间状态可能已变）：已空闲则跳过停止直接移动；
  2. 先停止：`client.interrupt`——v2 awaitSettlement，回执即 run 已结算；
     失败（断连等）放弃移动并经 `connectionError` 呈现（保守口径同
     moveSession 的运行中拒绝，不盲 POST）；
  3. 后移动：回执后 SSE `execution.interrupted` 的 idle 投影可能晚到，
     主动置 idle 放行 `moveSession` 的 active 守卫（事件随后同值幂等）；
  4. `moveSession` 既有守卫全量生效（在途防重/目标合法/目录等值）。
- **取消** → 不停止也不移动（弹窗关闭即终了）。
- 弹窗存续期间 Tab 被关（SSE 删会话等）→ 渲染守卫卸载弹窗（同
  pendingTabClose 模式）；确认路径的会话缺失由 moveSession 兜底 no-op。

### 2.5 完成语义（复用，不新增）

204 准入 / `session.moved` 旁路收敛 / 目标快照兜底 / relocateSession 单一
写路径 / Tab·消息·草稿保留 / 激活跟随目标作用域——全部沿用
design-session-tab-context-menu §2.5，本功能零增量。

## 3. 不做的事

| 项 | 原因 |
|---|---|
| 跨项目拖放移动 | 同右键菜单口径（server move 也限同 project） |
| 拖放移动时新建 worktree / 任意路径输入 | 同右键菜单口径 |
| 非 chat Tab 拖到左栏的语义 | 无会话语义（file/diff 属作用域、terminal 属 pty、browser 属 URL，无"移动到目录"概念） |
| 移动目标的行间空隙 preventDefault（扩大 move 光标区） | 提交挂 dragend 恒达，光标形状非承诺信号（同 Tab 重排序条外松手语义） |
| Esc 取消拖拽 | 原生拖拽无键盘事件（同既有两次拖拽取舍） |
| 移动成功/失败 toast | 失败经 connectionError 状态行（同右键移动）；成功由 Tab 归属变化自呈现 |

## 4. 涉及文件

| 文件 | 变更 |
|---|---|
| `src/renderer/src/store/app-store.ts` | `draggingChatTab`/`sessionDropTarget` 字段 + `beginChatTabDrag`/`setSessionDropTarget`/`takeSessionDropTarget`/`cancelChatTabDrag`；`moveSessionConfirmed`（先停后移） |
| `src/renderer/src/components/workspace.tsx` | chat Tab dragstart 登记；tabbar dragover 清目标（预览切回排序）+ 目标设置期间挂起插入位预览（互斥双向，effect 清 dragSlot）；dragend 移动提交分支（含源一致性校验）；dragKey 失效守卫/unmount 清 store 拖拽态；进行中确认弹窗 |
| `src/renderer/src/components/sidebar.tsx` | 项目行/worktree 行 dragover 合法性判定 + drop-target 高亮；行级 drop preventDefault |
| `src/renderer/src/i18n/index.ts` | `confirmMoveActiveSession(Title)`、`movingSession`（loading 文案） |
| `src/renderer/src/styles/app.css` | `.tree-row.drop-target` 高亮（背景单信号，强于 scope-cursor 的 primary 淡染） |
| 测试 | store：拖拽登记/目标取走/清空、moveSessionConfirmed（停→idle 置位→移、interrupt 失败不移、已空闲直移）；UI：dragend 移动提交、进行中确认、tabbar dragover 清目标 |

## 5. 验收

- 拖 chat Tab 悬停同项目 worktree 行/项目行（主工作区）：行高亮；放手在
  **任意位置**（含行外、Tab 条外、窗口空白）会话移动到高亮目标；当前目录
  行与他项目行不高亮
- 目标高亮后拖回 Tab 条：恢复插入位预览，放手按重排序提交（不移动）
- 拖动中 Tab 条重排序行为与既有完全一致（非 chat Tab 拖到左栏无反应）
- 进行中会话拖放 → 确认弹窗；确认 = 先停止（interrupt）后移动；取消 =
  不停止不移动；弹窗期间会话转空闲后确认 = 直接移动
- 移动完成后 Tab/消息/草稿保留、激活会话跟随目标作用域（既有 §2.5 语义）
- `npm run test` / `typecheck` / `build` 全绿
