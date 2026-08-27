import { useEffect, useRef, useState } from "react"
import { useI18n, useStore } from "../app"
import { fileUrlOf } from "@shared/file-url"

/**
 * PDF 预览宿主（design-pdf-preview §1 终态）：文件 Tab 内嵌**专用
 * WebContentsView**（复用 browser-view IPC 基建）——顶层 file:// 导航由
 * Chromium 内置 PDFium 查看器接管（实测 2026-08-27：iframe/embed/object 与
 * pdfjs 自渲染在 Electron renderer 均不可用——前者不接管 blob/data，后者
 * fake-worker 下 render 挂起）。
 * 视图生命周期挂 Tab：本组件挂载时懒建（注册进 browserViewIds，key = file
 * Tab key），bounds 随宿主同步，卸载仅隐藏（内容保留），关 Tab 由 closeTab
 * 统一 dispose；显隐随激活/overlay 协调（syncBrowserViewVisibility）。
 */
export function PdfFrameView({ tabKey, absolutePath }: { tabKey: string; absolutePath: string }) {
  const store = useStore()
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const [viewId, setViewId] = useState<number | null>(() => store.browserViewIdFor(tabKey))

  // 懒建视图 + 导航（一次）
  useEffect(() => {
    if (viewId != null) return
    let disposed = false
    void window.desktop.browserViewCreate().then((id) => {
      if (id == null || id < 0) return
      if (disposed) {
        // IPC 落地时组件已卸载（StrictMode 双跑/切走）：main 侧 view 已建，
        // 不 dispose 即为孤儿（评审 M2）——立即回收，不进注册表
        window.desktop.browserViewDispose(id)
        return
      }
      store.registerFileTabView(tabKey, id)
      setViewId(id)
      window.desktop.browserNavigate(id, fileUrlOf(absolutePath))
    })
    return () => {
      disposed = true
      // 卸载即隐藏（评审 N1）：文件监听把快照翻转为 error/占位时本组件卸载，
      // 若不隐藏，原生视图盖住占位文本（sync effect 依赖不变不会重跑）。
      // 重挂载复用路径经 registerFileTabView 注册即 sync 恢复显示
      const id = store.browserViewIdFor(tabKey)
      if (id != null) window.desktop.browserViewHide(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 复用重挂载（切回 Tab）：注册即协调恢复显示（首次路径 register 内已 sync）
  useEffect(() => {
    if (viewId != null) store.registerFileTabView(tabKey, viewId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId])

  // bounds 同步（挂载 + resize，rAF 合帧）
  useEffect(() => {
    if (viewId == null) return
    const host = hostRef.current
    if (!host) return
    let raf = 0
    const push = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect()
        window.desktop.browserViewBounds(viewId, {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        })
      })
    }
    push()
    const observer = new ResizeObserver(push)
    observer.observe(host)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [viewId])

  return (
    <div className="file-view pdf-view">
      {viewId == null && <div className="file-state">{t.loading}</div>}
      <div ref={hostRef} className="pdf-host" />
    </div>
  )
}
