import { useEffect } from "react"
import { useI18n, useStore } from "../app"
import { closeTabInteractive } from "./tab-actions"

/**
 * 全局快捷键（design-keyboard-shortcuts §1）：window keydown（bubble）分发；
 * 浏览器视图聚焦时原生 webContents 抢走键盘，经 main 的 before-input-event
 * 转发（onBrowserShortcut，design-browser-tab 评审 M5）走同一分发。
 * IME 组合中（fcitx5 上屏）不触发；已 preventDefault 的事件不重复处理。
 * Ctrl+T/W、Ctrl(+Shift)+Tab、Ctrl+PgUp/PgDn、Ctrl+Shift+T、Ctrl+Alt+↑/↓。
 */

/** 键盘事件统一分发（window keydown 与 browser:shortcut 转发共用）；
 *  返回是否消费（未消费不 preventDefault——无激活 Tab 的 Ctrl+W 等 no-op 放行） */
function dispatch(
  store: ReturnType<typeof useStore>,
  t: ReturnType<typeof useI18n>["t"],
  key: string,
  ctrl: boolean,
  shift: boolean,
  alt: boolean,
): boolean {
  // Ctrl+Alt+↑/↓：左栏作用域遍历
  if (ctrl && alt && (key === "ArrowDown" || key === "ArrowUp")) {
    store.cycleScopeEntry(key === "ArrowDown" ? 1 : -1)
    return true
  }
  if (!alt && key === "Tab") {
    store.cycleTab(shift ? -1 : 1)
    return true
  }
  if (!alt && (key === "PageDown" || key === "PageUp")) {
    // Shift 反转方向（与 Ctrl+Shift+Tab 一致）
    const base = key === "PageDown" ? 1 : -1
    store.cycleTab(shift ? (-base as 1 | -1) : (base as 1 | -1))
    return true
  }
  if (alt || shift) {
    // Ctrl+Shift+T：恢复刚关闭的 Tab
    if (shift && !alt && key.toLowerCase() === "t") {
      store.restoreClosedTab()
      return true
    }
    return false
  }
  if (key.toLowerCase() === "t") {
    store.showGuidePage()
    return true
  }
  if (key.toLowerCase() === "w") {
    const active = store.activeTab
    if (!active) return false
    closeTabInteractive(store, active, t)
    return true
  }
  return false
}

export function useShortcuts() {
  const store = useStore()
  const { t } = useI18n()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      // Cmd 视同 Ctrl（macOS 开发态惯例；Linux 主环境无影响）
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl) return
      // 消费才吞（未映射组合/no-op 放行——Ctrl+S 浏览器保存、无激活 Tab 的 Ctrl+W）
      if (dispatch(store, t, e.key, ctrl, e.shiftKey, e.altKey)) e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [store, t])

  // 浏览器视图内快捷键转发（main → renderer；无 preventDefault 语义——页面
  // 原按键已发生，转发仅驱动应用侧动作）
  useEffect(() => {
    return window.desktop.onBrowserShortcut?.((input) => {
      if (!input || typeof input.key !== "string") return
      dispatch(store, t, input.key, input.control || input.meta, input.shift, input.alt)
    })
  }, [store, t])
}
