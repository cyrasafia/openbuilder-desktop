import { useCallback, useRef } from "react"

/** 保存的编辑会话快照：value + 选区。value 参与恢复校验——value 已变
 * （导航回写/Escape 还原/换目标重命名）说明会话已结束，不恢复走默认 */
interface SavedSelection {
  value: string
  start: number
  end: number
}

/**
 * 输入框编辑会话保存/恢复（2026-09-30 修订，替代 IME 反弹窗口判定）：
 * 失焦（无论 IME 切换的瞬时 blur→focus 反弹，还是真实离开再回来）一律
 * 无损保存 value+选区，重新聚焦时恢复——不判定 blur 性质，自然覆盖反弹
 * 回归晚于任意固定窗口的场景（Ctrl+Space 按住 Ctrl 期间焦点回归被推迟）。
 * 三方法：
 * - `save(el)`：blur 时调用——保存当前 value 与选区
 * - `restore(el)`：focus 时调用——value 未变（同一编辑会话）恢复选区并返回
 *   true；value 已变或无保存（新会话）返回 false，调用方走默认（全选/
 *   光标置末尾）
 * - `clear()`：显式结束会话（Enter 导航/Escape 还原/重命名提交）——清除
 *   保存，下次聚焦走默认
 */
export function useSelectionRestore() {
  const saved = useRef<SavedSelection | null>(null)
  const save = useCallback((el: HTMLInputElement | HTMLTextAreaElement) => {
    saved.current = {
      value: el.value,
      start: el.selectionStart ?? 0,
      end: el.selectionEnd ?? 0,
    }
  }, [])
  const restore = useCallback((el: HTMLInputElement | HTMLTextAreaElement) => {
    const s = saved.current
    if (!s || s.value !== el.value) {
      saved.current = null
      return false
    }
    // value 等值 ⇒ 长度等值，索引必在界内
    el.setSelectionRange(s.start, s.end)
    return true
  }, [])
  const clear = useCallback(() => {
    saved.current = null
  }, [])
  return { save, restore, clear }
}
