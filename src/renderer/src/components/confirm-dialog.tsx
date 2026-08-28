import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { LoaderCircle } from "lucide-react"
import { useI18n, useStore } from "../app"

/**
 * 应用内确认弹窗（替代原生 confirm()）。props 驱动，调用方控制挂载/卸载。
 * 确认后调用 onConfirm（异步），期间展示加载动画；完成或出错后回调 onClose。
 * 复用 .dialog-sm / .dialog-actions 样式，与 SettingsDialog / OpenWithDialog 同体系。
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  loadingLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  loadingLabel?: string
  danger?: boolean
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useI18n()
  const store = useStore()
  const [loading, setLoading] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    store.pushOverlay()
    return () => store.popOverlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 打开即聚焦取消钮，使 Esc keydown 到达 dialog（同 OpenWithDialog 的 focus-on-mount）
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await onConfirm()
    } finally {
      setLoading(false)
      onClose()
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape" && !loading) onClose()
  }

  return (
    <div className="dialog-mask" onClick={loading ? undefined : onClose}>
      <div
        className="dialog dialog-sm"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">
          {loading ? (
            <div className="confirm-loading">
              <LoaderCircle className="typing-spinner" size={18} aria-hidden />
              <span className="confirm-loading-text">{loadingLabel ?? t.deletingWorkspace}</span>
            </div>
          ) : (
            <p className="confirm-message">{message}</p>
          )}
        </div>
        <div className="dialog-actions">
          <button ref={cancelRef} disabled={loading} onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            className={"btn-primary" + (danger ? " danger" : "")}
            disabled={loading}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}