import { useCallback, useEffect, useRef } from "react"

/**
 * IME 切换反弹窗口（ms）：Wayland text-input 上下文重建（fcitx5 中英切换等）
 * 会让聚焦中的输入框瞬时 blur→focus 连发（2026-09-30 实测定因：会话/guide
 * 输入框光标跳末尾、地址栏清空回显页面 URL、Tab 重命名误提交，皆非真实聚焦
 * 变化撞上了假设"focus/blur=用户行为"的处理器）。失焦类动作（回显/提交）
 * 延迟到窗口外执行；窗口内回焦即判定为反弹——取消挂起动作，保留编辑态
 * （已上屏内容、光标/选区）
 */
export const IME_REFOCUS_WINDOW_MS = 200

/**
 * IME 反弹窗口内判定"真实失焦"的 hook（见 IME_REFOCUS_WINDOW_MS）。三方法：
 * - `defer(action)`：blur 时调用——真实失焦时（窗口外）执行 action（回显/提交）
 * - `refocus()`：focus 时调用——返回 true = IME 反弹回焦（挂起动作已取消），
 *   调用方应跳过 focus 态重置（全选/光标置末尾）
 * - `cancel()`：主动使挂起动作失效（如 Enter 导航后的乐观展示不被覆写）
 */
export function useImeBlurDebounce() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])
  const defer = useCallback(
    (action: () => void) => {
      cancel()
      timer.current = setTimeout(() => {
        timer.current = null
        action()
      }, IME_REFOCUS_WINDOW_MS)
    },
    [cancel],
  )
  const refocus = useCallback(() => {
    if (timer.current == null) return false
    cancel()
    return true
  }, [cancel])
  useEffect(() => cancel, [cancel])
  return { defer, refocus, cancel }
}
