import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useI18n } from "../app"

/**
 * Linux「打开方式」选择器弹窗（design-linux-open-with §1.3）：全量应用列表
 * （2026-08-31 修订）+ 搜索框；匹配组在前、其他组在后（排序由 main 侧完成，
 * 渲染层按 matches 分段），键盘 ↑↓ + Enter、Esc 关闭、点击行启动并关闭。
 * 图标 = data URL 或首字母瓷片兜底（同 ProjectAvatar 模式）。
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
  const [apps, setApps] = useState<{ id: string; name: string; icon: string | null; matches: boolean }[] | null>(null)
  const [query, setQuery] = useState("")
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

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

  // 搜索过滤（名称大小写不敏感子串）；过滤后仍保持 main 侧的分组次序
  const filtered = useMemo(() => {
    if (!apps) return null
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter((a) => a.name.toLowerCase().includes(q))
  }, [apps, query])

  // 分段（filtered 已是「匹配组先、字母序」）：matches 边界切两段
  const matched = useMemo(() => filtered?.filter((a) => a.matches) ?? [], [filtered])
  const other = useMemo(() => filtered?.filter((a) => !a.matches) ?? [], [filtered])
  const flat = useMemo(() => [...matched, ...other], [matched, other])

  // 查询变化后选中项越界 → 归零（保留在有效范围内）
  useEffect(() => {
    setSel((s) => (s < flat.length ? s : 0))
  }, [flat.length])

  const pick = (id: string) => {
    onLaunch(id)
    onClose()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // IME 组合中（fcitx5 等，key="Process"/keyCode 229）：Enter/Escape 是确认/取消
    // 组合而非对话框操作，忽略（2026-08-31 code review 加固）
    if (e.nativeEvent.isComposing) return
    const inSearch = document.activeElement === searchRef.current
    if (e.key === "Escape") {
      // 搜索框有内容先清空（同常见 command palette 语义），再 Esc 关闭
      if (inSearch && query) {
        e.preventDefault()
        setQuery("")
        setSel(0)
        return
      }
      onClose()
      return
    }
    if (!flat || flat.length === 0) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const len = flat.length
      setSel((s) => (e.key === "ArrowDown" ? (s + 1) % len : (s - 1 + len) % len))
    } else if (e.key === "Enter") {
      e.preventDefault()
      pick(flat[sel]!.id)
    }
  }

  // 打开即聚焦搜索框：输入即过滤；↑↓/Enter 从第一刻可达（keydown 冒泡到 dialog）
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // 选中行可见（键盘导航）；scrollIntoView 在 jsdom 缺失——可选调用
  useEffect(() => {
    const el = listRef.current?.querySelectorAll<HTMLButtonElement>(".open-with-row")[sel]
    // 选中态按 flat 内序号对应 DOM 全列表行序（matched 在前 other 在后，与 flat 一致）
    el?.scrollIntoView?.({ block: "nearest" })
  }, [sel, flat])

  const initials = useMemo(
    () => (flat ?? []).map((a) => (Array.from(a.name.trim())[0] ?? "?").toUpperCase()),
    [flat],
  )

  const row = (a: (typeof flat)[number], i: number) => (
    <button
      key={a.id}
      className={"open-with-row" + (i === sel ? " selected" : "")}
      onMouseEnter={() => setSel(i)}
      onClick={() => pick(a.id)}
    >
      <span className="open-with-avatar" aria-hidden>
        {a.icon ? (
          <img className="open-with-icon" src={a.icon} alt="" draggable={false} />
        ) : (
          initials[i]
        )}
      </span>
      <span className="open-with-name">{a.name}</span>
    </button>
  )

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog open-with-dialog" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="dialog-title">{t.fileOpenWith}</div>
        <input
          ref={searchRef}
          className="ms-search open-with-search"
          type="text"
          placeholder={t.openWithSearch}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          spellCheck={false}
        />
        <div className="dialog-body scroll" ref={listRef} tabIndex={-1}>
          {apps == null && <div className="tree-empty">{t.openWithLoading}</div>}
          {apps != null && apps.length === 0 && <div className="tree-empty">{t.openWithEmpty}</div>}
          {apps != null && apps.length > 0 && flat.length === 0 && (
            <div className="tree-empty">{t.openWithNoResult}</div>
          )}
          {matched.length > 0 && <div className="open-with-group">{t.openWithMatched}</div>}
          {matched.map((a, i) => row(a, i))}
          {other.length > 0 && <div className="open-with-group">{t.openWithOther}</div>}
          {other.map((a, i) => row(a, matched.length + i))}
        </div>
      </div>
    </div>
  )
}
