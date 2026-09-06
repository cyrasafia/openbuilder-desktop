import { useSyncExternalStore } from "react"

/**
 * Ctrl（mac ⌘ 经 metaKey 等价）按住状态跟踪（design-keyboard-shortcuts §1.1
 * 磁贴角标支持）。跟踪器必须是模块级单例而非组件内监听：Ctrl+T 开新 Tab 时
 * 引导页在 keydown 之后才挂载，而按住的修饰键不再派发 keydown（无自动重复），
 * 组件内自挂监听拿不到"已按住"的初始态——角标不显示（2026-09-06 修复）。
 * 监听常驻（随模块加载注册一次，无挂载生命周期可泄漏）；keydown 用 capture——
 * 先于任何内层消费方（xterm cancel / 快捷键 preventDefault），保持"物理按住"
 * 语义不受事件是否被消费影响；keyup Control/Meta 或窗口失焦清（失焦后 keyup
 * 不再派发，不清会残留）。
 */
let ctrlHeld = false
const subscribers = new Set<() => void>()

function update(value: boolean) {
  if (ctrlHeld === value) return
  ctrlHeld = value
  for (const fn of subscribers) fn()
}

window.addEventListener(
  "keydown",
  (e) => {
    if (e.ctrlKey || e.metaKey) update(true)
  },
  true,
)
window.addEventListener(
  "keyup",
  (e) => {
    if (e.key === "Control" || e.key === "Meta") update(false)
  },
  true,
)
window.addEventListener("blur", () => update(false))

/** 当前 Ctrl 按住态（挂载即继承已按住状态；外部存惯用 API——订阅与快照读
 *  同源，无 render/effect 间的失读窗口） */
export function useCtrlHeld(): boolean {
  return useSyncExternalStore(subscribe, () => ctrlHeld)
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}
