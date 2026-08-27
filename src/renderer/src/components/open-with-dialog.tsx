import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useI18n } from "../app"

/**
 * Linux「打开方式」选择器弹窗（design-linux-open-with §1.3）：枚举结果列表，
 * 键盘 ↑↓ + Enter、Esc 关闭、点击行启动并关闭。复用 dialog 模式；
 * 图标 = 名称首字母瓷片（同 ProjectAvatar 模式，v0.3 无 icon theme 解析）。
 */
export function OpenWithDialog({
  path,
  onLaunch,
  onClose,
}: {
  path: string
  onLaunch: (appId: string) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [apps, setApps] = useState<{ id: string; name: string }[] | null>(null)
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void window.desktop
      .shellListOpenWithApps(path)
      .then((list) => {
        if (alive) {
          setApps(list)
          setSel(0)
        }
      })
      .catch(() => {
        // 枚举失败容错：空列表按空态呈现（不让 loading 悬挂）
        if (alive) setApps([])
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const pick = (id: string) => {
    onLaunch(id)
    onClose()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!apps || apps.length === 0) {
      if (e.key === "Escape") onClose()
      return
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const len = apps.length
      setSel((s) => (e.key === "ArrowDown" ? (s + 1) % len : (s - 1 + len) % len))
    } else if (e.key === "Enter") {
      e.preventDefault()
      pick(apps[sel]!.id)
    } else if (e.key === "Escape") {
      onClose()
    }
  }

  // 打开即聚焦列表容器（tabIndex=-1）：键盘 ↑↓/Enter/Esc 从第一刻起可达
  // （否则焦点在 body，keydown 不冒泡到 dialog）
  useEffect(() => {
    listRef.current?.focus()
  }, [])

  // 选中行可见（键盘导航）；scrollIntoView 在 jsdom 缺失——可选调用
  useEffect(() => {
    listRef.current?.querySelectorAll<HTMLButtonElement>(".open-with-row")[sel]?.scrollIntoView?.({
      block: "nearest",
    })
  }, [sel, apps])

  const initials = useMemo(
    () => (apps ?? []).map((a) => (Array.from(a.name.trim())[0] ?? "?").toUpperCase()),
    [apps],
  )

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog open-with-dialog" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="dialog-title">{t.fileOpenWith}</div>
        <div className="dialog-body scroll" ref={listRef} tabIndex={-1}>
          {apps == null && <div className="tree-empty">{t.openWithLoading}</div>}
          {apps != null && apps.length === 0 && <div className="tree-empty">{t.openWithEmpty}</div>}
          {apps?.map((a, i) => (
            <button
              key={a.id}
              className={"open-with-row" + (i === sel ? " selected" : "")}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(a.id)}
            >
              <span className="open-with-avatar" aria-hidden>
                {initials[i]}
              </span>
              <span className="open-with-name">{a.name}</span>
              <span className="mono open-with-id">{a.id}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
