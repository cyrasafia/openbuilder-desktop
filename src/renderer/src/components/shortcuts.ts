import { useEffect } from "react"
import { useI18n, useStore } from "../app"
import { closeTabInteractive } from "./tab-actions"

/**
 * 全局快捷键（design-keyboard-shortcuts §1）：window keydown（bubble）分发。
 * IME 组合中（fcitx5 上屏）不触发；已 preventDefault 的事件不重复处理。
 * Ctrl+T/W、Ctrl(+Shift)+Tab、Ctrl+PgUp/PgDn、Ctrl+Shift+T、Ctrl+Alt+↑/↓。
 */
export function useShortcuts() {
  const store = useStore()
  const { t } = useI18n()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      // Cmd 视同 Ctrl（macOS 开发态惯例；Linux 主环境无影响）
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      const key = e.key.toLowerCase()

      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault()
        store.cycleScopeEntry(e.key === "ArrowDown" ? 1 : -1)
        return
      }
      if (!e.altKey && e.key === "Tab") {
        e.preventDefault()
        store.cycleTab(e.shiftKey ? -1 : 1)
        return
      }
      if (!e.altKey && (e.key === "PageDown" || e.key === "PageUp")) {
        e.preventDefault()
        // Shift 反转方向（与 Ctrl+Shift+Tab 一致）
        const base = e.key === "PageDown" ? 1 : -1
        store.cycleTab(e.shiftKey ? (-base as 1 | -1) : (base as 1 | -1))
        return
      }
      if (e.altKey || e.shiftKey) {
        // Ctrl+Shift+T：恢复刚关闭的 Tab
        if (e.shiftKey && !e.altKey && key === "t") {
          e.preventDefault()
          store.restoreClosedTab()
        }
        return
      }
      if (key === "t") {
        e.preventDefault()
        store.showGuidePage()
        return
      }
      if (key === "w") {
        const active = store.activeTab
        if (!active) return
        e.preventDefault()
        closeTabInteractive(store, active, t)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [store, t])
}
