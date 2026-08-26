import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react"
import { useStore } from "../app"

/**
 * 面板拖拽调宽手柄（design-layout-collapse §2.4）：挂在面板内缘（side=left 在
 * 左栏右缘、right 在右栏左缘）。Pointer capture 逐帧写 store（emit 驱动栅格），
 * pointerup 落盘。宽度按「按下时面板宽 + 位移」计算——不用面板实时 rect（逐帧
 * emit 改变面板宽，读实时值会形成反馈回路）。
 *
 * 拖拽期间给 <html> 挂 resizing 类：子帧（html 预览 iframe 等）pointer-events
 * 屏蔽，防手柄拖过 iframe 时 pointer 被吞。up/cancel/卸载均移除（拖拽中组件
 * 被卸载的极边角不残留）。
 */
export function PanelResizeHandle({ side }: { side: "left" | "right" }) {
  const store = useStore()
  const start = useRef<{ width: number; x: number } | null>(null)

  // 卸载兜底：拖拽中面板折叠（标题栏开关）等原因卸载手柄时清 dragging 态
  useEffect(() => {
    return () => {
      if (start.current) {
        start.current = null
        document.documentElement.classList.remove("resizing")
      }
    }
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const panel = e.currentTarget.parentElement
    if (!panel) return
    start.current = { width: panel.getBoundingClientRect().width, x: e.clientX }
    try {
      // jsdom 无 setPointerCapture；无捕获时快速拖出会丢帧，真机由捕获兜底
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 已释放/无效 pointerId 等抛 NotFoundError——捕获失败不阻断拖拽
    }
    document.documentElement.classList.add("resizing")
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current
    if (!s) return
    const dx = e.clientX - s.x
    store.setPanelWidth(side, s.width + (side === "left" ? dx : -dx))
  }

  const endDrag = () => {
    if (!start.current) return
    start.current = null
    document.documentElement.classList.remove("resizing")
    store.persistLayout()
  }

  return (
    <div
      className={side === "left" ? "sidebar-resize" : "filepanel-resize"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      aria-hidden
    />
  )
}
