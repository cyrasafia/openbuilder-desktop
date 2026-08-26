import { useEffect, useState } from "react"
import { Copy, Minus, PanelLeft, PanelRight, Square, X } from "lucide-react"
import { useI18n, useStore } from "../app"

/**
 * 标题栏：拖拽区 + 居中标题 + 面板收起/展开开关（全平台）+ 窗口控制（仅
 * linux frameless；其他平台系统装饰已有）。颜色全走主题 token。
 * 双击拖拽区最大化/还原由 Electron 原生处理，不另挂 dblclick（避免二次切换）。
 */
export function TitleBar() {
  const { t } = useI18n()
  const store = useStore()
  const [maximized, setMaximized] = useState(false)
  const isLinux = window.desktop.platform === "linux"

  useEffect(() => {
    // 最大化状态仅窗口控制消费（linux frameless）；其他平台无该按钮，不查询
    if (window.desktop.platform !== "linux") return
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
        {/* 面板开关（design-layout-collapse）：应用级控件，位于窗口控制左侧 */}
        <button
          className="title-bar-btn panel-toggle"
          title={store.layoutLeftCollapsed ? t.expandLeftPanel : t.collapseLeftPanel}
          aria-label={store.layoutLeftCollapsed ? t.expandLeftPanel : t.collapseLeftPanel}
          onClick={() => store.toggleLeftPanel()}
        >
          <PanelLeft size={14} />
        </button>
        <button
          className="title-bar-btn panel-toggle"
          title={store.layoutRightCollapsed ? t.expandRightPanel : t.collapseRightPanel}
          aria-label={store.layoutRightCollapsed ? t.expandRightPanel : t.collapseRightPanel}
          onClick={() => store.toggleRightPanel()}
        >
          <PanelRight size={14} />
        </button>
        {isLinux && (
          <>
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
          </>
        )}
      </div>
    </header>
  )
}
