import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react"
import { createPortal } from "react-dom"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import { useI18n, useStore } from "../app"
import type { FileNode } from "@shared/api-types"
import { PanelResizeHandle } from "./panel-resize"
import { OpenWithDialog } from "./open-with-dialog"
import { FILEREF_MIME, setDraggingFileRef } from "./file-ref"
import { fileUrlOf } from "@shared/file-url"
import type { FileRef } from "@shared/api-types"

interface MenuState {
  absolute: string
  /** 相对 worktree 路径（目录尾随 /；根目录回退 "./"，引用 source.path 用） */
  path: string
  name: string
  isDirectory: boolean
  /** .html/.htm 文件（「在浏览器 Tab 中预览 / 预览」双入口显隐且置首，design-html-preview §3.4） */
  isHtml: boolean
  x: number
  y: number
}

type OpenMenu = (
  e: ReactMouseEvent,
  target: { absolute: string; path: string; name: string; isDirectory: boolean; isHtml: boolean },
) => void

export function FilePanel() {
  const store = useStore()
  const { t } = useI18n()
  const project = store.currentProject
  const hasLoaded = store.fileTreeNodes.has(".")
  const rootNodes = store.fileTreeNodes.get(".") ?? []
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [openWith, setOpenWith] = useState<string | null>(null)
  const collapsed = store.layoutRightCollapsed
  // 刷新滚动还原（q1，2026-11-26 review）：先清空再渲染会塌缩内容高度，
  // 浏览器把 scrollTop 钳到 0——触发沿存、回填后 layout 提交前还原
  const treeRef = useRef<HTMLDivElement>(null)
  const treeScrollTop = useRef(0)
  const treeRestorePending = useRef(false)

  // Hooks 必须无条件执行（项目有↔无切换时不允许 Hook 数量变化）
  useEffect(() => {
    // 刷新在途（先清空再渲染的空白窗口）不抢跑根首载：重列集合自带 "."，抢跑
    // 会让根行在窗口内提前回填、清空帧被吞（多一轮重复请求）；首载失败的补拉
    // 走刷新钮（重列集合根恒在），不靠本效应重触发。
    // 依赖含 refreshingFileTree（review m1）：同作用域 resetFileTree（如卸载
    // 非当前 worktree）会收标记作废本轮，但 hasLoaded 已是 false 且不再变化——
    // 不入依赖效应不重跑，根永远无人拉，树卡「加载中…」
    if (project && !hasLoaded && !store.refreshingFileTree) void store.loadFileNodes(".")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLoaded, project?.id, store.currentWorkspace?.directory, store.refreshingFileTree])

  // 滚动还原走 layout effect：回填帧提交前归位，不闪跳顶（q1 dev 实测确认；
  // jsdom 无布局测不了，见 design-file-panel-context-menu §2.3 已接受边缘）
  useLayoutEffect(() => {
    const el = treeRef.current
    if (!el) return
    if (store.refreshingFileTree && !treeRestorePending.current && hasLoaded) {
      // 触发沿首个内容帧：存滚动位（每轮一次；清空后的内容帧 hasLoaded=false 不覆盖）
      treeScrollTop.current = el.scrollTop
      treeRestorePending.current = true
    } else if (treeRestorePending.current && hasLoaded) {
      // 回填帧（其后任一内容帧）：归位
      el.scrollTop = treeScrollTop.current
      treeRestorePending.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.refreshingFileTree, hasLoaded])

  if (!project) {
    // 空态（design-layout §4 无项目空状态，2026-09-06 修订）：右栏保留「文件」
    // 标题行、树区无内容——与左栏空态保留标题行对称（原"完全空白"弃用）；
    // 打开项目的引导在中栏。无作用域根目录，不挂右键菜单
    return (
      <aside className={"file-panel" + (collapsed ? " collapsed" : "")}>
        <div className="sidebar-heading">
          <span>{t.filesTitle}</span>
        </div>
        {!collapsed && <PanelResizeHandle side="right" />}
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
      className={"file-panel" + (collapsed ? " collapsed" : "")}
      // 空白处/标题栏：对象 = 当前作用域根目录（主工作区 = 项目根；
      // worktree/global = 其目录，与所见树根一致）
      onContextMenu={(e) =>
        openMenu(e, {
          absolute: store.scopeQuery.directory,
          path: "./",
          name: store.scopeQuery.directory.split("/").pop() || "/",
          isDirectory: true,
          isHtml: false,
        })
      }
    >
      <div className="sidebar-heading">
        <span>{t.filesTitle}</span>
        {/* 刷新整树（design-file-panel-context-menu §2.3 2026-11-25 增补）：
            同排图标钮沿左栏 Plus 钮模式（.icon-btn 12px）。空态无树不放；根目录
            未加载时（含首载失败、树区常驻「加载中…」）照常渲染——刷新兼首载重试。
            在途转圈（2026-11-26）：refreshingFileTree 驱动 .spinning，重列全部
            落地停——标题栏钮与右键菜单两入口同走 store 方法，转圈表现一致 */}
        <button
          className={"icon-btn tree-refresh" + (store.refreshingFileTree ? " spinning" : "")}
          title={t.fileRefresh}
          onClick={() => store.refreshFileTree()}
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>
      <div ref={treeRef} className="tree scroll">
        {!hasLoaded && <div className="tree-empty">{t.loading}</div>}
        <NodeList nodes={rootNodes} depth={0} onContextMenu={openMenu} />
      </div>
      {menu && (
        <FileContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpenWith={(path) => setOpenWith(path)}
        />
      )}
      {openWith && (
        <OpenWithDialog
          path={openWith}
          onLaunch={(appId) => {
            void window.desktop.shellOpenWithApp(openWith, appId)
          }}
          onClose={() => setOpenWith(null)}
        />
      )}
      {/* 内缘调宽手柄（折叠时随面板 display:none 一并消失） */}
      {!collapsed && <PanelResizeHandle side="right" />}
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
        // dot 文件与 ignored（server 按 .gitignore/.ignore 规则标记）均展示；
        // ignored 以弱化样式区分（design-layout §5，2026-08-27）
        .map((n) => (
          <FileRow key={n.path} node={n} depth={depth} onContextMenu={onContextMenu} />
        ))}
    </>
  )
}

/** FileNode → 菜单/拖拽共用目标（引用值对象与菜单态字段一致） */
function ctxTargetOf(node: FileNode) {
  return {
    absolute: node.absolute,
    path: node.path,
    name: node.name,
    isDirectory: node.type === "directory",
    isHtml: node.type === "file" && /\.html?$/i.test(node.name),
  }
}

function fileRefOfNode(node: FileNode): FileRef {
  return {
    path: node.path,
    absolute: node.absolute,
    filename: node.name,
    isDir: node.type === "directory",
  }
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
  const expanded = store.fileTreeExpanded.has(node.path)
  const children = store.fileTreeNodes.get(node.path) ?? []
  const isActive = store.activeTab?.key === `file:${node.absolute}`

  if (node.type === "directory") {
    return (
      <>
        <div
          className={"tree-row file-row" + (node.ignored ? " ignored" : "")}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => store.toggleFileNode(node.path)}
          onContextMenu={(e) =>
            onContextMenu(e, ctxTargetOf(node))
          }
          draggable
          onDragStart={(e) => {
            // 拖拽引用（design-file-reference §3.3）：自定义 MIME 携带 FileRef；
            // 带外登记负载供 composer 悬停实时预览（dragover 阶段 getData 禁读）
            setDraggingFileRef(fileRefOfNode(node))
            e.dataTransfer.setData(FILEREF_MIME, JSON.stringify(fileRefOfNode(node)))
            e.dataTransfer.effectAllowed = "copy"
          }}
          onDragEnd={() => setDraggingFileRef(null)}
        >
          {expanded ? (
            <ChevronDown className="chevron" size={12} aria-hidden />
          ) : (
            <ChevronRight className="chevron" size={12} aria-hidden />
          )}
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
      className={
        "tree-row file-row" + (isActive ? " active" : "") + (node.ignored ? " ignored" : "")
      }
      style={{ paddingLeft: 8 + depth * 14 + 16 }}
      onClick={() => {
        // .html/.htm 按连接分派（design-html-preview §3.4）：本地 server file://
        // 可直读 → 浏览器 Tab（shim 失败回退文件 Tab）；远程 file:// 必败 →
        // 文件 Tab 预览态
        if (/\.html?$/i.test(node.name)) {
          if (store.isLocalServer) {
            void store.openBrowserTab(fileUrlOf(node.absolute)).then((ok) => {
              if (!ok) store.openFileTab(node.absolute)
            })
          } else {
            store.openFileTab(node.absolute)
          }
          return
        }
        store.openFileTab(node.absolute)
      }}
      onContextMenu={(e) => onContextMenu(e, ctxTargetOf(node))}
      draggable
      onDragStart={(e) => {
        // 拖拽引用（design-file-reference §3.3）：自定义 MIME 携带 FileRef；
        // 带外登记负载供 composer 悬停实时预览（dragover 阶段 getData 禁读）
        setDraggingFileRef(fileRefOfNode(node))
        e.dataTransfer.setData(FILEREF_MIME, JSON.stringify(fileRefOfNode(node)))
        e.dataTransfer.effectAllowed = "copy"
      }}
      onDragEnd={() => setDraggingFileRef(null)}
    >
      <span className="tree-label">{node.name}</span>
    </div>
  )
}

/** 右键菜单（design-file-panel-context-menu）：html 双入口（置首）/ 打开 / 打开方式 / 引用到会话 / 复制路径 / 刷新（分隔线下，树全局动作） */
function FileContextMenu({
  menu,
  onClose,
  onOpenWith,
}: {
  menu: MenuState
  onClose: () => void
  onOpenWith: (path: string) => void
}) {
  const { t } = useI18n()
  const store = useStore()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // 目录（含空白处根目录）同样提供（2026-08-31 修订，design-file-panel-context-menu §2.3）：
  // xdg-mime 对目录返回 inode/directory，枚举天然命中文件管理器等应用；win32/darwin
  // 系统对话框同样接受目录路径。win32/darwin 走系统对话框；linux 走自建选择器弹窗
  // （design-linux-open-with，修订 §2.4 原"Linux 不显示"决策）
  const showOpenWith =
    window.desktop.platform === "win32" ||
    window.desktop.platform === "darwin" ||
    window.desktop.platform === "linux"

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

  // 浮层计数（design-browser-tab §1.2 z-order）：菜单存在期间隐藏浏览器视图
  useEffect(() => {
    store.pushOverlay()
    return () => store.popOverlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      {menu.isHtml && (
        <>
          <button
            className="context-menu-item"
            onClick={() =>
              run(() => {
                void store.openBrowserTab(fileUrlOf(menu.absolute)).then((ok) => {
                  if (!ok) store.openFileTab(menu.absolute)
                })
              })
            }
          >
            {t.filePreviewInBrowser}
            {store.isLocalServer && <span className="menu-default-tag">{t.defaultAction}</span>}
          </button>
          <button
            className="context-menu-item"
            onClick={() =>
              run(() => {
                // 显式预览意图：覆写模式记忆确定性以预览打开（模式记忆的显式例外）
                store.setFileViewState(menu.absolute, { mode: "preview", top: 0 })
                store.openFileTab(menu.absolute, undefined, { remountView: true })
              })
            }
          >
            {t.filePreview}
            {!store.isLocalServer && <span className="menu-default-tag">{t.defaultAction}</span>}
          </button>
        </>
      )}

      <button
        className="context-menu-item"
        onClick={() => run(() => void window.desktop.shellOpenPath(menu.absolute))}
      >
        {t.fileOpen}
      </button>
      {showOpenWith && (
        <button
          className="context-menu-item"
          onClick={() =>
            run(() => {
              if (window.desktop.platform === "linux") onOpenWith(menu.absolute)
              else void window.desktop.shellOpenWith(menu.absolute)
            })
          }
        >
          {t.fileOpenWith}
        </button>
      )}
      <button
        className="context-menu-item"
        onClick={() =>
          run(() => {
            // 引用到会话（design-file-reference §3.2）：目标路由 = 激活 chat Tab
            // 的 composer 优先，否则引导页 composer（作用域目录键）
            const active = store.activeTab
            const key = active?.kind === "chat" ? active.key.slice(5) : store.scopeQuery.directory
            store.addFileRef(key, {
              path: menu.path,
              absolute: menu.absolute,
              filename: menu.name,
              isDir: menu.isDirectory,
            })
          })
        }
      >
        {t.fileRefToSession}
      </button>
      <button
        className="context-menu-item"
        onClick={() => run(() => void navigator.clipboard?.writeText(menu.absolute).catch(() => {}))}
      >
        {t.fileCopyPath}
      </button>
      {/* 刷新（§2.3 2026-11-25 增补）：树全局动作，与上方文件级动作以分隔线隔开；
          无论菜单对象是文件还是目录，均刷新整树（= 当前作用域全部已加载目录重列） */}
      <div className="context-menu-separator" />
      <button className="context-menu-item" onClick={() => run(() => store.refreshFileTree())}>
        {t.fileRefresh}
      </button>
    </div>,
    document.body,
  )
}
