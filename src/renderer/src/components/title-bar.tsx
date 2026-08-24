import { useEffect, useState } from "react"
import { Copy, Minus, Square, X } from "lucide-react"
import { useI18n } from "../app"

/**
 * Linux 自定义头部（design-layout §1）：frameless 窗口的拖拽区 + 窗口控制。
 * 颜色全走主题 token（跟随 data-theme 深/浅切换）；仅 platform=linux 渲染（app.tsx 门控）。
 * 双击拖拽区最大化/还原由 Electron 原生处理，不另挂 dblclick（避免二次切换）。
 */
export function TitleBar() {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // invoke 回复与 send 事件无顺序保证：一旦收到推送，挂载快照即过期，不再采纳
    let pushed = false
    void window.desktop.winIsMaximized().then((snapshot) => {
      if (!pushed) setMaximized(snapshot)
    })
    return window.desktop.onWindowMaximized((maximized) => {
      pushed = true
      setMaximized(maximized)
    })
  }, [])

  return (
    <header className="title-bar">
      <span className="title-bar-title">{t.appTitle}</span>
      <div className="title-bar-controls">
        <button
          className="title-bar-btn"
          title={t.winMinimize}
          aria-label={t.winMinimize}
          onClick={() => window.desktop.winMinimize()}
        >
          <Minus size={14} />
        </button>
        <button
          className="title-bar-btn"
          title={maximized ? t.winRestore : t.winMaximize}
          aria-label={maximized ? t.winRestore : t.winMaximize}
          onClick={() => window.desktop.winToggleMaximize()}
        >
          {maximized ? <Copy size={13} /> : <Square size={11} />}
        </button>
        <button
          className="title-bar-btn close"
          title={t.winClose}
          aria-label={t.winClose}
          onClick={() => window.desktop.winClose()}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  )
}
