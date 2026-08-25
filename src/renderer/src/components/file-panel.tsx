import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react"
import { createPortal } from "react-dom"
import { useI18n, useStore } from "../app"
import type { FileNode } from "@shared/api-types"

interface MenuState {
  absolute: string
  isDirectory: boolean
  x: number
  y: number
}

type OpenMenu = (
  e: ReactMouseEvent,
  target: { absolute: string; isDirectory: boolean },
) => void

export function FilePanel() {
  const store = useStore()
  const { t } = useI18n()
  const project = store.currentProject
  const hasLoaded = store.fileTreeNodes.has(".")
  const rootNodes = store.fileTreeNodes.get(".") ?? []
  const [menu, setMenu] = useState<MenuState | null>(null)

  // Hooks 必须无条件执行（项目有↔无切换时不允许 Hook 数量变化）
  useEffect(() => {
    if (project && !hasLoaded) void store.loadFileNodes(".")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLoaded, project?.id, store.currentWorkspace?.directory])

  if (!project) {
    return (
      <aside className="file-panel">
        <div className="sidebar-empty">{t.noProject}</div>
      </aside>
    )
  }

  const openMenu: OpenMenu = (e, target) => {
    if (!target.absolute) return
    e.preventDefault()
    e.stopPropagation()
    setMenu({ ...target, x: e.clientX, y: e.clientY })
  }

  return (
    <aside
      className="file-panel"
      // 空白处/标题栏：对象 = 当前作用域根目录（主工作区 = 项目根；
      // worktree/global = 其目录，与所见树根一致）
      onContextMenu={(e) =>
        openMenu(e, { absolute: store.scopeQuery.directory, isDirectory: true })
      }
    >
      <div className="sidebar-heading">
        <span>{t.filesTitle}</span>
        <span className="tree-meta" title={project.worktree}>
          {project.name || project.worktree.split("/").pop()}
        </span>
      </div>
      <div className="tree scroll">
        {!hasLoaded && <div className="tree-empty">{t.loading}</div>}
        <NodeList nodes={rootNodes} depth={0} onContextMenu={openMenu} />
      </div>
      {menu && <FileContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}

function NodeList({
  nodes,
  depth,
  onContextMenu,
}: {
  nodes: FileNode[]
  depth: number
  onContextMenu: OpenMenu
}) {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return (
    <>
      {sorted
        .filter((n) => !n.name.startsWith(".") && !n.ignored)
        .map((n) => (
          <FileRow key={n.path} node={n} depth={depth} onContextMenu={onContextMenu} />
        ))}
    </>
  )
}

function FileRow({
  node,
  depth,
  onContextMenu,
}: {
  node: FileNode
  depth: number
  onContextMenu: OpenMenu
}) {
  const store = useStore()
  const expanded = store.fileTreeExpanded.get(node.path) ?? false
  const children = store.fileTreeNodes.get(node.path) ?? []
  const isActive = store.activeTab?.key === `file:${node.absolute}`

  if (node.type === "directory") {
    return (
      <>
        <div
          className="tree-row file-row"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => store.toggleFileNode(node.path)}
          onContextMenu={(e) =>
            onContextMenu(e, { absolute: node.absolute, isDirectory: true })
          }
        >
          <span className="chevron">{expanded ? "▾" : "▸"}</span>
          <span className="tree-label">{node.name}</span>
        </div>
        {expanded && children.length > 0 && (
          <NodeList nodes={children} depth={depth + 1} onContextMenu={onContextMenu} />
        )}
        {expanded && children.length === 0 && (
          <div className="tree-row file-row disabled" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
            <span className="tree-label">…</span>
          </div>
        )}
      </>
    )
  }

  return (
    <div
      className={"tree-row file-row" + (isActive ? " active" : "")}
      style={{ paddingLeft: 8 + depth * 14 + 16 }}
      onClick={() => store.openFileTab(node.absolute)}
      onContextMenu={(e) =>
        onContextMenu(e, { absolute: node.absolute, isDirectory: false })
      }
    >
      <span className="tree-label">{node.name}</span>
    </div>
  )
}

/** 右键菜单（design-file-panel-context-menu）：打开 / 打开方式 / 复制路径 */
function FileContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // linux/browser 无系统级「打开方式」（§2.4）；目录无打开方式语义
  const showOpenWith =
    !menu.isDirectory &&
    (window.desktop.platform === "win32" || window.desktop.platform === "darwin")

  // 首帧隐藏渲染供测量，再钳制到视口内定位（同 Popover 无闪烁模式）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - el.offsetWidth - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - el.offsetHeight - 4)),
    })
    // 初始焦点 = 首项：autoFocus 在隐藏帧落空（同 model-switcher popover 模式），rAF 时定位已完成
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>("button")?.focus())
  }, [menu])

  // 外部 mousedown / Esc / 滚动 / 失焦关闭（capture 阶段；回调走 ref 免重订阅）
  useEffect(() => {
    const outside = (target: EventTarget | null) => !ref.current?.contains(target as Node)
    const onDown = (e: MouseEvent) => {
      if (outside(e.target)) onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    const onWheel = (e: WheelEvent) => {
      if (outside(e.target)) onCloseRef.current()
    }
    const onBlur = () => onCloseRef.current()
    window.addEventListener("mousedown", onDown, true)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("wheel", onWheel, true)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("mousedown", onDown, true)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("wheel", onWheel, true)
      window.removeEventListener("blur", onBlur)
    }
  }, [])

  const run = (action: () => void) => {
    onClose()
    action()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    e.preventDefault()
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLButtonElement)
    // 焦点不在菜单内（如 Tab 移出）：Down 落首项、Up 落末项（-1 与 0 同归首/末项语义）
    const next =
      e.key === "ArrowDown" ? (idx + 1) % items.length : idx <= 0 ? items.length - 1 : idx - 1
    items[next].focus()
  }

  return createPortal(
    <div
      ref={ref}
      className="popover context-menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <button
        className="context-menu-item"
        onClick={() => run(() => void window.desktop.shellOpenPath(menu.absolute))}
      >
        {t.fileOpen}
      </button>
      {showOpenWith && (
        <button
          className="context-menu-item"
          onClick={() => run(() => void window.desktop.shellOpenWith(menu.absolute))}
        >
          {t.fileOpenWith}
        </button>
      )}
      <button
        className="context-menu-item"
        onClick={() => run(() => void navigator.clipboard?.writeText(menu.absolute).catch(() => {}))}
      >
        {t.fileCopyPath}
      </button>
    </div>,
    document.body,
  )
}
