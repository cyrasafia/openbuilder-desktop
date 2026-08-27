import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, FolderOpen, RotateCw, X } from "lucide-react"
import { useI18n, useStore } from "../app"
import { fileUrlOf } from "@shared/file-url"

/**
 * 浏览器 Tab 内容（design-browser-tab §1.3）：工具条 + 内容宿主。
 * 视图本体在 main 进程（WebContentsView）——宿主 div 只负责占位与 bounds 同步
 * （ResizeObserver → IPC），内容渲染不在 DOM 里。显隐协调在 Workspace 层
 * （overlay/激活）；本组件挂载即推送 bounds 并显示，卸载不 dispose（切走保留）。
 */
export function BrowserTabView({ tabKey, viewId }: { tabKey: string; viewId: number }) {
  const store = useStore()
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const state = store.browserStates.get(viewId)
  // 地址栏本地态：聚焦编辑时不被 store url 回写打断；失焦/导航后同步
  const [address, setAddress] = useState(state?.url ?? tabKey.slice("browser:".length))
  const addressFocused = useRef(false)

  // bounds 同步：挂载 + 尺寸变化（rAF 合帧，拖拽调宽高频）
  useEffect(() => {
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

  // store url → 地址栏同步（未聚焦时）
  useEffect(() => {
    if (!addressFocused.current && state?.url) setAddress(state.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.url])

  const navigate = (raw: string) => {
    const value = raw.trim()
    if (!value) return
    // 字面 file 路径补 scheme（逐段编码）；其余原样（http/https/file/about）
    const url = value.startsWith("file://") || /^[a-z]+:\/\//i.test(value) || value.startsWith("about:")
      ? value
      : fileUrlOf(value)
    window.desktop.browserNavigate(viewId, url)
  }

  return (
    <div className="browser-tab">
      <div className="browser-toolbar">
        <button
          className="icon-btn"
          title={t.browserBack}
          aria-label={t.browserBack}
          disabled={!state?.canGoBack}
          onClick={() => window.desktop.browserGoBack(viewId)}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="icon-btn"
          title={t.browserForward}
          aria-label={t.browserForward}
          disabled={!state?.canGoForward}
          onClick={() => window.desktop.browserGoForward(viewId)}
        >
          <ArrowRight size={14} />
        </button>
        {state?.loading ? (
          <button
            className="icon-btn"
            title={t.browserStop}
            aria-label={t.browserStop}
            onClick={() => window.desktop.browserStop(viewId)}
          >
            <X size={14} />
          </button>
        ) : (
          <button
            className="icon-btn"
            title={t.browserReload}
            aria-label={t.browserReload}
            onClick={() => window.desktop.browserReload(viewId)}
          >
            <RotateCw size={14} />
          </button>
        )}
        <input
          className="browser-address mono"
          value={address}
          spellCheck={false}
          placeholder={t.browserAddressPlaceholder}
          aria-label={t.browserAddressPlaceholder}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => {
            addressFocused.current = true
            e.currentTarget.select()
          }}
          onBlur={() => {
            addressFocused.current = false
            if (state?.url) setAddress(state.url)
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === "Enter") {
              e.preventDefault()
              e.currentTarget.blur()
              navigate(address)
            } else if (e.key === "Escape") {
              e.preventDefault()
              if (state?.url) setAddress(state.url)
              e.currentTarget.blur()
            }
          }}
        />
        <button
          className="icon-btn"
          title={t.browserOpenFile}
          aria-label={t.browserOpenFile}
          onClick={() => {
            void window.desktop.openHtmlFilePicker().then((path) => {
              if (path) window.desktop.browserNavigate(viewId, fileUrlOf(path))
            })
          }}
        >
          <FolderOpen size={14} />
        </button>
      </div>
      {/* 内容宿主：占位 + bounds 源（渲染在 main 侧原生视图） */}
      <div ref={hostRef} className="browser-host" />
    </div>
  )
}
