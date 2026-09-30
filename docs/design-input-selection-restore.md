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

移动端 openbuilder 同类问题（输入框 focus/blur 处理器假设真实用户
行为）可同构参考。
