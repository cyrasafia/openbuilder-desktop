# 输入框失焦保存/恢复（selection-restore）

2026-09-30。会话/guide 输入框、浏览器地址栏、Tab 重命名三处共用。

## 问题与定因

GNOME/Wayland（fcitx5）下切换输入法（Ctrl+Space 等）会重建 text-input
上下文，聚焦中的输入框瞬时 blur→focus 连发——非真实聚焦变化，撞上
假设 focus/blur=用户行为的处理器：

- 会话/guide 输入框 onFocus 光标置末尾 → 光标跳末尾
- 地址栏 onBlur 回显页面 URL → 已输入内容被清空
- Tab 重命名 onBlur 提交 → 误退出编辑态

## 方案演进（前两版被否决的依据）

1. **固定时间窗（200ms）**：按住 Ctrl 切换时反弹的 focus 回归可被推迟到
   任意晚于窗口，计时先到即误执行——时间窗从根上判不住（用户实测否决）
2. **事件驱动 + 修饰键门控**（focus 回归任意时刻取消挂起动作；修饰键
   松开/窗口失焦才判真实失焦执行）：能覆盖场景，但 Super+Space 被 WM
   拦截收不到 keydown/keyup 门控失效有盲区，且整套延迟执行框架复杂
3. **保存/恢复（采纳）**：不判定 blur 性质——失焦一律保存 value+选区，
   回焦 value 未变即恢复续编辑。反弹（任意回归时长）与真实离开再回来
   同路径无损覆盖；无「必须延迟执行」的挂起动作，前两版全部判定逻辑
   消失，实现净减（45 行 hook 替代窗口+门控+兜底）

## 语义（用户确认接受）

| 输入框 | blur | focus | 会话结束（清保存） |
|---|---|---|---|
| 会话/guide | 保存 | 恢复；无保存置末尾（原 autoFocus 语义） | — |
| 地址栏 | 保存，**不回显** | 恢复；无保存全选 | Enter 导航 / Escape 还原 |
| 重命名 | 保存，**不提交** | 恢复；无保存全选 | Enter / Escape / 换目标 |

相对 2026-09-30 前的行为变化：

- 地址栏失焦后显示草稿而非当前页 URL；回显收敛于 Escape（唯一显式
  路径）与导航后 store 同步（state.url 变化 + 未聚焦回写）
- 重命名失焦保持编辑态（原失焦即提交），提交收敛于 Enter/Escape/换
  目标三条显式路径
- 会话/guide 点离再点回恢复原光标（原每次聚焦置末尾）

## 实现与会话校验

`src/renderer/src/components/selection-restore.ts`（useSelectionRestore：
save/restore/clear）。会话有效性 = value 快照等值——导航回写、Escape
还原、换目标重命名等任何改值路径自动令恢复失效走默认（全选/末尾），
无需额外清理同步。

### 显式结束会话的时序（2026-09-30 review 修订）

Escape 后的 `blur()` 会同步触发 onBlur 的 `save`（Chromium 事件同步派
发），覆盖 handler 内先行执行的 `clear`——快照 value 恰与还原后 URL
等值时（未改值即 Escape），下次聚焦误恢复旧光标而非全选。地址栏以
`addressEscape` 标记让该次终止性失焦跳过 save（jsdom 不派发 blur 事件，
clear/blur 顺序在两环境下相反，故不依赖顺序而以标记表达语义）。重命名
的 Escape 不经 blur 路径（handler 内直接清 + 退出编辑态由 setRenaming
卸载输入框），无此问题；Enter 路径 save 先于 navigate 内 clear，顺序
恰好正确。配套用例「未改值即 Escape 再聚焦应全选」在未修复代码上可复
现故障（stash 反证验证）。

外部关闭 renaming 目标 Tab 时清悬挂状态（对齐 dragKey 失效守卫惯例）：
`renaming && !store.tabs.some(key 匹配)` 即 `renameSel.clear()` +
`setRenaming(null)`。判定集合须用**未过滤的 store.tabs**：用作用域过滤
数组会把「切作用域看一眼」误判为 Tab 已关，草稿静默丢弃（切回原作用域
本可恢复编辑；2026-09-30 前后三代行为对照——blur 即提交时代该流提交、
50c0187 该流保留、错误判定的守卫版本该流丢弃，只有最后者丢数据）。
右键菜单「重命名」入口镜像双击路径：换目标先 commitRename 提交旧目标
（失焦不提交后 setRenaming 的唯一无保护入口；提交顺带 clear 快照，防
标题等值时光标串台）。

移动端 openbuilder 同类问题（输入框 focus/blur 处理器假设真实用户
行为）可同构参考。
