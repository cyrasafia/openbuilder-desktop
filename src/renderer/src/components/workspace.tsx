import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type WheelEvent,
} from "react"
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleX,
  FileDiff,
  Globe,
  ListChecks,
  ListTree,
  LoaderCircle,
  Plus,
  RotateCcw,
  ShieldAlert,
  SquareTerminal,
  X,
} from "lucide-react"
import { useI18n, useStore } from "../app"
import { format, relativeTime } from "../i18n"
import type { Catalog } from "../i18n"
import { filterRevertedEntries, type ChatEntry } from "@shared/message-merge"
import { extractErrorMessage, extractRetryMessage } from "@shared/message-error"
import type {
  CommandInfo,
  Part,
  Session,
  SessionStatusValue,
  SubtaskPart,
  Todo,
  ToolPart,
} from "@shared/api-types"
import type { PendingPermission, PendingQuestion } from "@shared/pending-requests"
import { externalDirectoryPath, permissionCommand } from "@shared/pending-requests"
import { todoActive, todoDone, todoKey, todosActive } from "@shared/session-todos"
import { Markdown } from "./markdown"
import { splitFrontMatter } from "./markdown-frontmatter"
import { ModelSwitcherBar } from "./model-switcher"
import { CodeView } from "./code-view"
import { collectHeadings, MdToc, type TocHeading } from "./md-toc"
import { DiffView } from "./diff-view"
import { PdfFrameView } from "./pdf-frame-view"
import { parseDiffTabKey } from "../store/app-store"
import { closeTabInteractive } from "./tab-actions"
import { TerminalView } from "./terminal-view"
import { BrowserTabView } from "./browser-tab-view"
import { FileRefChips, useFileRefInput, type RefChipItem } from "./file-ref"
import { isFileRefPart } from "@shared/api-types"

export function Workspace() {
  const store = useStore()
  const { t } = useI18n()
  // Tab 条只显示当前作用域的 Tab（全 kind 按 directory 匹配，2026-08-25 §18：
  // chat = 会话目录、diff = 作用域目录、file = 打开时作用域目录）
  const scopeDir = store.scopeQuery.directory
  const tabs = store.tabs.filter((tab) => tab.directory === scopeDir)
  const active = store.activeTab

  // 浏览器视图显隐协调（design-browser-tab §1.2）：激活 Tab + 无浮层才显示；
  // Tab 切换/作用域切换/设置弹窗与右键菜单（overlayCount）变化时重算
  useEffect(() => {
    store.syncBrowserViewVisibility()
  }, [store.activeTabKey, store.overlayCount, scopeDir, store])
  // 拖拽重排序（design-tab-drag-rename §1，2026-08-29 修订为实时预览式，参考
  // design-project-drag-reorder）：dragKey = 拖拽中 Tab；dragSlot = 目标插入位
  // （以"移除拖拽项后的作用域数组"为坐标系，0..base.length）。拖动中 Tab 条
  // 即时重排：拖拽项在目标位渲染占位样式，源位间隙闭合。提交挂 dragend（源
  // 元素上恒触发——drop 只在松手于合法落区内才发，Tab 条外/快速拖动越界松手
  // 时浏览器直接取消只发 dragend），按松手时预览 DOM 序整体重排（所见即所得，
  // 不经 slot 换算——换算与最后一次 dragover 的 setState 有竞态窗口）。
  // 注：原生拖拽期间页面收不到键盘事件，无 Esc 取消路径（同左栏项目行取舍）
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragSlot, setDragSlot] = useState<number | null>(null)
  const tabbarRef = useRef<HTMLDivElement | null>(null)
  // 行内重命名（design-tab-drag-rename §2）：仅 chat Tab，双击进入
  const [renaming, setRenaming] = useState<{ key: string; value: string } | null>(null)

  const endDrag = () => {
    setDragKey(null)
    setDragSlot(null)
  }
  /** dragend 提交：按松手时预览 DOM 序整体重排（所见即所得）——读 tabbar 容器
   *  内 .tab 的 data-tab-key 顺序调 applyTabOrder，不经 slot 换算。 */
  const handleDragEnd = () => {
    if (tabbarRef.current) {
      const keys = [...tabbarRef.current.querySelectorAll<HTMLElement>(".tab")]
        .map((el) => el.dataset.tabKey)
        .filter((k): k is string => k != null)
      if (keys.length > 0) store.applyTabOrder(keys)
    }
    endDrag()
  }
  // 拖拽中 Tab 被移除的兜底（review 发现）：他端删会话经 SSE closeTab 卸载源
  // .tab 节点后 dragend 不再派发，残留 dragKey 会让容器 dragover 对后续无关
  // 拖拽误 preventDefault（显示 move 落点光标）——dragKey 失效即清拖拽态；
  // 预览侧另有 dragIdx 守卫（拖拽中回原序），两道防线互不依赖
  useEffect(() => {
    if (dragKey && !tabs.some((tb) => tb.key === dragKey)) {
      setDragKey(null)
      setDragSlot(null)
    }
  }, [dragKey, tabs])

  const commitRename = (tab: { kind: string; key: string; title: string }) => {
    if (!renaming || renaming.key !== tab.key) return
    const value = renaming.value.trim()
    setRenaming(null)
    if (tab.kind === "chat" && value && value !== tab.title) {
      void store.renameSession(tab.key.slice(5), value)
    }
  }

  // 浏览器视图显隐协调（design-browser-tab §1.2）：激活 Tab + 无浮层才显示；
  // Tab 切换/作用域切换/设置弹窗与右键菜单（overlayCount）变化时重算
  useEffect(() => {
    store.syncBrowserViewVisibility()
  }, [store.activeTabKey, store.overlayCount, scopeDir, store])

  // 预览序：base = 移除拖拽项的作用域数组；slot 缺省 = 原位（dragIdx 在 base
  // 中即原位）。dragIdx 守卫：拖拽中 Tab 被关（快照/会话删除）不崩溃回原序
  const dragIdx = dragKey ? tabs.findIndex((tb) => tb.key === dragKey) : -1
  const base = dragIdx >= 0 ? tabs.filter((_, i) => i !== dragIdx) : tabs
  const slot = dragKey && dragSlot != null ? Math.max(0, Math.min(dragSlot, base.length)) : dragIdx
  const previewTabs =
    dragKey && dragIdx >= 0 && slot !== dragIdx
      ? [...base.slice(0, slot), tabs[dragIdx]!, ...base.slice(slot)]
      : tabs

  return (
    <main className="workspace">
      <div
        ref={tabbarRef}
        className="tabbar"
        onDragOver={(ev) => {
          if (!dragKey) return
          // 容器整体为合法落区（含 Tab 间空隙、条尾空白/"+"按钮、占位 Tab）：
          // dragover preventDefault 让预览插入位在整条区域连续生效。插入位按
          // 光标 X 几何计算（边缘带判定，项目行判定水平化）：光标落入某 Tab
          // 左/右 25% 区域 = 换位（插其前/后），中间 50% 滞回带保持当前插入位
          // ——预览换位后 Tab 移位，滞回带吸收移位量防抖。光标不在任何 Tab 内
          // （Tab 间空隙）= 最近边界；末位 Tab 右半以远全部区域（含条尾）= 末位；
          // 占位 Tab 跳过 = 悬停占位维持当前插入位。同值保留旧引用 bail out
          ev.preventDefault()
          ev.dataTransfer.dropEffect = "move"
          const EDGE_BAND = 0.25
          const els = ev.currentTarget.querySelectorAll<HTMLElement>(".tab")
          // next = null 且命中过 Tab（hit）= 中带/悬停占位：维持当前插入位不动；
          // 未命中任何 Tab = 条尾区域：末位（两态共用 null 会把中带误判成末位）
          let next: number | null = null
          let hit = false
          for (let i = 0; i < els.length; i++) {
            const rect = els[i]!.getBoundingClientRect()
            if (els[i]!.dataset.tabKey === dragKey) {
              // 悬停占位 Tab = 维持当前插入位
              if (ev.clientX >= rect.left && ev.clientX <= rect.right) hit = true
              continue
            }
            if (ev.clientX < rect.left) {
              // Tab 间空隙/首 Tab 左侧：最近边界 = 插到该 Tab 前
              next = i < slot ? i : i - 1
              hit = true
              break
            }
            if (ev.clientX <= rect.right) {
              hit = true
              const baseIdx = i < slot ? i : i - 1
              if (ev.clientX < rect.left + rect.width * EDGE_BAND) next = baseIdx
              else if (ev.clientX > rect.right - rect.width * EDGE_BAND) next = baseIdx + 1
              break
            }
          }
          if (!hit) next = base.length
          if (next != null) setDragSlot((prev) => (prev === next ? prev : next))
        }}
        onDrop={(ev) => {
          // 提交统一在 dragend（恒触发，任何释放位置都按预览序提交）；
          // 此处仅 preventDefault 屏蔽浏览器对拖拽数据的默认处理
          ev.preventDefault()
        }}
      >
        {previewTabs.map((tab) => {
          // 会话状态点常显（含 idle，design-error-message §3.3 修订）：
          // running/error 呼吸光晕、waiting/failed/idle 静态，统一 12px 盒几何
          // （session-* 变体类）与其他指示纵向对齐；非 chat Tab 无会话语义不显示
          const dot =
            tab.kind === "chat" ? store.dotStateFor(tab.key.slice(5)) : null
          // 全状态（含 idle）映射 session-* 变体——统一 12px 盒几何，状态切换
          // 零布局位移（裸 "idle" 只吃基础 6px 类，会与 12px 盒间跳变抖动）
          const dotClass =
            dot === "running"
              ? "session-running"
              : dot === "error"
                ? "session-error"
                : dot === "waiting"
                  ? "session-waiting"
                  : dot === "failed"
                    ? "session-failed"
                    : "session-idle"
          const isRenamingThis = renaming?.key === tab.key
          return (
          <div
            key={tab.key}
            data-tab-key={tab.key}
            className={
              "tab" +
              (tab.key === store.activeTabKey ? " active" : "") +
              (tab.key === dragKey ? " dragging" : "")
            }
            draggable={!isRenamingThis}
            onClick={() => store.setActiveTab(tab.key)}
            onDoubleClick={() => {
              // 重命名仅 chat Tab（= 会话重命名）。切到另一 Tab 编辑时先提交旧的，
              // 未提交内容不静默丢弃；同一 Tab 再双击不重置已输入值
              if (tab.kind === "chat") {
                if (renaming && renaming.key !== tab.key) {
                  const prev = store.tabs.find((x) => x.key === renaming.key)
                  if (prev) commitRename(prev)
                }
                if (renaming?.key !== tab.key) {
                  setRenaming({ key: tab.key, value: tab.title })
                }
              }
            }}
            onDragStart={(e) => {
              setDragKey(tab.key)
              setDragSlot(null)
              // 自定义 MIME：避免内部 key 以 text/plain 拖入可编辑区被默认插入
              e.dataTransfer.setData("application/x-openbuilder-tab", tab.key)
              e.dataTransfer.effectAllowed = "move"
            }}
            onDragEnd={handleDragEnd}
          >
            {dot && <span className={"status-dot " + dotClass} />}
            {isRenamingThis ? (
              // 行内重命名输入框：Enter/失焦提交、Esc 取消；隔离点击与拖拽。
              // 键盘事件不 blanket stopPropagation——全局快捷键（Ctrl+W/Tab 等）
              // 在重命名中仍可用（同 ChatView 输入区约定）
              <input
                className="tab-label-input"
                value={renaming!.value}
                autoFocus
                aria-label={t.renameTab}
                title={t.renameTab}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setRenaming({ key: tab.key, value: e.target.value })}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  // IME 组合中（fcitx5 上屏/取消候选）不触发提交/取消
                  if (e.nativeEvent.isComposing) return
                  if (e.key === "Enter") {
                    e.preventDefault()
                    commitRename(tab)
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    setRenaming(null)
                  }
                }}
                onBlur={() => commitRename(tab)}
              />
            ) : (
              <span className="tab-label">
                {tab.kind === "diff" ? t.diffTitle : tab.title || t.untitled}
              </span>
            )}
            <button
              className="icon-btn tab-close"
              title={t.closeTab}
              onClick={(e) => {
                e.stopPropagation()
                // 用户主动关闭统一路径（design-keyboard-shortcuts §4）：
                // chat 流式确认 + 入关闭栈；与 Ctrl+W 同语义
                closeTabInteractive(store, tab, t)
              }}
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          )
        })}
        <button
          className="icon-btn tabbar-new"
          title={t.newTab}
          onClick={() => store.showGuidePage()}
        >
          <Plus size={14} aria-hidden />
        </button>
      </div>

      <div className="workspace-body">
        {/* 无激活 Tab = 新 Tab 引导页（新建项目/工作区、Tab 栏 +、作用域无 Tab）。
            key 按作用域目录隔离：草稿按作用域存取（design-compose-draft §2），
            切作用域重挂载，避免旧作用域草稿/pendingSession 残留串用 */}
        {!active && <GuidePage key={scopeDir} />}
        {/* key 隔离：防止 chat→chat 切换时复用 fiber 导致草稿/pinned ref 跨会话残留 */}
        {active?.kind === "chat" && <ChatView key={active.key} sessionID={active.key.slice(5)} />}
        {active?.kind === "file" && (
          /* key 隔离：file Tab 切换时防 mode（预览/源码）等局部 state 跨文件残留（同 ChatView） */
          <FileView key={active.key} absolutePath={active.key.slice(5)} revealLine={active.revealLine} />
        )}
        {active?.kind === "diff" &&
          (() => {
            const diff = parseDiffTabKey(active.key)
            return diff ? <DiffView key={active.key} tabKey={active.key} directory={diff.directory} /> : null
          })()}
        {active?.kind === "terminal" && (
          /* key 隔离：pty Tab 切换时重挂载（WS 卸载重连 + cursor replay） */
          <TerminalView key={active.key} ptyID={active.key.slice("terminal:".length)} />
        )}
        {active?.kind === "browser" &&
          (() => {
            const viewId = store.browserViewIdFor(active.key)
            return viewId != null ? (
              <BrowserTabView key={active.key} tabKey={active.key} viewId={viewId} />
            ) : null
          })()}
      </div>

      {store.settingsOpen && <SettingsDialog />}
    </main>
  )
}

/** 存档期大小：初始加载与「加载更多」步长 */
const ARCHIVE_PAGE_SIZE = 5

/**
 * 新 Tab 引导页：无激活 Tab 时的默认视图（design-layout §4）。
 * 输入消息发送 = 新建会话 + 发送首条消息（Tab 自动打开激活，引导页退出）；
 * 输入区固定纵向居中（不受存档列表影响），下方依次为操作区与已归档会话
 * （初始 5 条 + 加载更多），点击恢复（取消归档并开 Tab）。
 */
function GuidePage() {
  const store = useStore()
  const { t, locale } = useI18n()
  // 草稿按作用域目录暂存（design-compose-draft）：挂载初始化从 store 读回；
  // 每次变化同步 store（写入不 emit，高频键入不触发整树重渲染）。发送成功在
  // handler 内显式清 store（同 commit 卸载丢待定 effect，见 send 注释）；
  // 发送失败草稿保留（本地 + store 一致）
  const directory = store.scopeQuery.directory
  const [draft, setDraft] = useState(() => store.guideDraftFor(directory))
  const [sending, setSending] = useState(false)
  useEffect(() => {
    store.setGuideDraft(directory, draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, directory])
  // 已创建待发送的会话：发送失败保留草稿，重试复用（不重复建会话、不产生空 Tab）
  const pendingSession = useRef<Session | null>(null)
  // 存档会话分页：初始 5 条、每次「加载更多」+5，全部加载后隐藏按钮。
  // 挂载即重置（组件按作用域 key 隔离，切作用域回到初始页大小）
  const [archivedLimit, setArchivedLimit] = useState(ARCHIVE_PAGE_SIZE)
  const archivedAll = store.archivedSessions
  const archived = archivedAll.slice(0, archivedLimit)
  const hasMoreArchived = archivedAll.length > archivedLimit
  // global 拆分：作用域名 = 目录末段（根目录显示 "global"）——store 统一派生
  const scopeName = store.scopeDisplayName
  // 文件引用输入接线（design-file-reference §3）：引用按作用域目录键存（与草稿同构）
  const guideTaRef = useRef<HTMLTextAreaElement>(null)
  const refInput = useFileRefInput({
    refKey: directory,
    directory,
    onRemoveAtToken: (start, end) => {
      setDraft((d) => d.slice(0, start) + d.slice(end))
      requestAnimationFrame(() => guideTaRef.current?.setSelectionRange(start, start))
    },
  })
  const guideRefs = store.fileRefsFor(directory)

  const send = async () => {
    const text = draft.trim()
    // 空守卫：文本与引用全空才拒绝（纯引用发送合法，design-file-reference §4）
    const refs = store.fileRefsFor(directory)
    if ((!text && refs.length === 0) || sending) return
    setSending(true)
    if (!pendingSession.current) {
      // openTab:false——首条消息发送成功才开 Tab 激活（引导页退出）
      const session = await store.createSession({ openTab: false })
      if (!session) {
        setSending(false)
        return
      }
      pendingSession.current = session
    }
    // 引用随首条消息发送；发送成功 store 侧清（引导页卸载丢待定 effect，同草稿）
    const res = await store.sendPrompt(pendingSession.current.id, text, refs)
    setSending(false)
    if (res.ok) {
      // store 侧显式清：发送成功开 Tab → 引导页同 commit 卸载，React 丢弃卸载
      // 组件的待定 effect，同步 effect 的 setGuideDraft("") 不会执行（不清则
      // 旧草稿残留，关 Tab 回引导页会复活已发送文本）；引用同因（sendPrompt
      // 只清 session 键，directory 键在此显式清）
      setDraft("")
      store.setGuideDraft(directory, "")
      store.clearFileRefs(directory)
      store.openChatTab(pendingSession.current)
      pendingSession.current = null
    }
    // 失败：草稿保留在输入框，connectionError 经左栏状态行可见，重试复用同一会话
  }

  return (
    <div className="guide-view">
      {/* 居中层 = 会话区 + 操作区（顶部 32vh 定值空白使其大致居中） */}
      <div className="guide-main">
        <div className="guide-session">
          <div className="hero">{scopeName}</div>
          <div className="guide-hint">{t.guideHint}</div>
          <div className="guide-composer" {...refInput.dragProps}>
            {refInput.chips}
            <textarea
              ref={guideTaRef}
              value={draft}
              placeholder={t.guidePlaceholder}
              rows={1}
              autoFocus
              onFocus={(e) => {
                // 默认聚焦（autoFocus）时光标置于末尾，而非开头（有草稿时）
                const el = e.currentTarget
                requestAnimationFrame(() => {
                  const len = el.value.length
                  el.setSelectionRange(len, len)
                })
              }}
              onChange={(e) => {
                setDraft(e.target.value)
                refInput.onTextChange(e.target.value, e.target.selectionStart)
              }}
              onKeyUp={(e) => {
                if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
                if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
                  refInput.onTextChange(e.currentTarget.value, e.currentTarget.selectionStart)
                }
              }}
              onKeyDown={(e) => {
                // IME 组合中（如 fcitx5 上屏）不触发发送
                if (e.nativeEvent.isComposing) return
                // @ 浮层键盘交互优先（消费则终止）
                if (refInput.onKeyDown(e)) return
                if (e.key === "Enter") {
                  // 修饰键组合（Ctrl/Shift/Alt/Meta）= 换行；裸 Enter = 发送（与聊天输入区一致）
                  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {refInput.picker}
            <div className="composer-actions">
              {/* pendingSession 时切会话绑定；会话记录从 store 重读（乐观补丁是新对象，
                  ref 持有的是创建时快照——AM-FIX-2：UI 不依赖父组件传参快照）。
                  目录用该会话自身的：引导页已按作用域 key 隔离（design-compose-draft §2），
                  挂载期内作用域不变、二者恒等，保留会话目录作防御（原 AM-IMPL3-3
                  跨作用域存活场景随 key 隔离消失） */}
              <ModelSwitcherBar
                directory={pendingSession.current?.directory ?? store.scopeQuery.directory}
                mode={pendingSession.current ? "session" : "defaults"}
                session={
                  pendingSession.current
                    ? (store.findSession(pendingSession.current.id) ?? pendingSession.current)
                    : undefined
                }
                disabled={sending}
              />
              <button
                className="btn-primary"
                disabled={(!draft.trim() && guideRefs.length === 0) || sending}
                onClick={() => void send()}
              >
                {t.send}
              </button>
            </div>
          </div>
        </div>
        {/* 操作区（design-diff-view §4.4 / design-layout §4）：diff 单入口（页内
            segment 切换三种来源）；.btn-tile 磁贴等宽 96px、5:4，icon 在上、
            名称在磁贴内 icon 下方（DESIGN.md §按钮） */}
        <div className="guide-actions">
          <button type="button" className="btn-tile" onClick={() => store.openDiffTab()}>
            <FileDiff size={20} aria-hidden />
            <span className="btn-tile-label">{t.diffTitle}</span>
          </button>
          <button
            type="button"
            className="btn-tile"
            onClick={() => void store.openTerminalTab()}
            disabled={!store.activeProfile}
          >
            <SquareTerminal size={20} aria-hidden />
            <span className="btn-tile-label">{t.openTerminal}</span>
          </button>
          <button
            type="button"
            className="btn-tile"
            disabled={!store.activeProfile || window.desktop.platform === "browser"}
            title={window.desktop.platform === "browser" ? t.comingSoon : undefined}
            onClick={() => void store.openBrowserTab("about:blank")}
          >
            <Globe size={20} aria-hidden />
            <span className="btn-tile-label">{t.openBrowser}</span>
          </button>
        </div>
      </div>
      {/* 存档区：随页面向下扩展，不挤占上方 */}
      {archived.length > 0 && (
        <div className="guide-archived">
          <div className="guide-archived-header">
            <span>{t.archivedSessions}</span>
          </div>
          {archived.map((s) => (
            <div key={s.id} className="guide-card" onClick={() => store.openChatTab(s)}>
              <div className="guide-card-title">{s.title || s.slug || t.untitled}</div>
                <div className="guide-card-meta">
                  <span>{relativeTime(locale, s.time.archived ?? s.time.updated)}</span>
                </div>
            </div>
          ))}
          {hasMoreArchived && (
            <button
              type="button"
              className="guide-load-more"
              onClick={() => setArchivedLimit((n) => n + ARCHIVE_PAGE_SIZE)}
            >
              {t.loadMore}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ChatView({ sessionID }: { sessionID: string }) {
  const store = useStore()
  const { t } = useI18n()
  // 草稿按会话暂存（design-compose-draft）：挂载初始化从 store 读回，恢复切走前
  // 未发送内容；每次变化同步 store（写入不 emit，高频键入不触发整树重渲染）
  const [draft, setDraft] = useState(() => store.chatDraftFor(sessionID))
  useEffect(() => {
    store.setChatDraft(sessionID, draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, sessionID])
  const entries = store.chatEntries(sessionID)
  const status = store.statusOf(sessionID)
  const busy = status.type !== "idle"
  // 回滚暂存态（design-message-revert）：回滚点起消息从消息流隐藏（对齐官方
  // timeline visibleUserMessages 过滤），撤销回滚恢复显示；发送即提交删除。
  // 乐观消息恒显（未达 server，不构成回滚对象）
  const revertMessageID = store.findSession(sessionID)?.revert?.messageID ?? null
  const visibleEntries = filterRevertedEntries(entries, revertMessageID)
  const revertedCount = entries.length - visibleEntries.length
  const scrollRef = useRef<HTMLDivElement>(null)
  // 滚动位置记忆（design-tab-state-memory §2.3）：有条目 = 切走时处于上滚阅读态，
  // 初始不贴底、待恢复；无条目 = 贴底默认。捕获经 onScroll 更新
  // scrollCapture，卸载 cleanup 落 store（贴底则删条目）
  const savedScroll = store.chatScrollFor(sessionID)
  const pinnedToBottom = useRef(savedScroll == null)
  const prevScrollTop = useRef(0)
  const scrollCapture = useRef(savedScroll)
  const scrollRestore = useRef(savedScroll)
  const lastEntryCount = useRef(0)
  // 上滚分页视口锚定（design-message-history-pagination §4.3）：触发时记录
  // scrollHeight/scrollTop + 头部基准（最旧消息 id）；layout effect 只在**头部
  // 真实增长**（更早页落地）时消费补差——loading 指示行出现、底部流式增长等
  // 中间渲染不消费，避免 anchor 被提前花掉或按头部公式反向误补（review P1）
  const anchorRef = useRef<{ height: number; top: number; headId: string | null } | null>(null)

  /** entries 头部基准：最旧 message id（乐观恒排尾部，不构成头部） */
  const headIdOf = (list: ChatEntry[]): string | null =>
    list[0]?.kind === "message" ? list[0].data.info.id : null

  // 激活即重拉（design-layout §5：切回 Tab 时重拉；快照与 SSE 状态合并不丢数据）。
  // 任务列表同挂点回填（design-task-list：补 SSE 断线窗口的全量快照）
  useEffect(() => {
    const session = store.findSession(sessionID)
    if (session) {
      void store.loadSessionMessages(sessionID, session.directory)
      void store.loadSessionTodos(sessionID, session.directory)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionID])

  // 回滚草稿回填（design-message-revert §3.3）：回滚点 user 消息文本置入输入框，可编辑重发
  useEffect(() => {
    const seed = store.takeRevertDraft(sessionID)
    if (seed != null) setDraft(seed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.revertDraftVersion, sessionID])

  // 文件引用输入接线（design-file-reference §3）：chip 条 + @ 浮层 + drop 接收；
  // 引用按 sessionID 键存（与草稿同构）。选中引用后移除 @词 区间并把光标
  // 回退到该位置（受控赋值会把光标甩到末尾）
  const composerTaRef = useRef<HTMLTextAreaElement>(null)
  const refInput = useFileRefInput({
    refKey: sessionID,
    directory: store.findSession(sessionID)?.directory ?? null,
    onRemoveAtToken: (start, end) => {
      setDraft((d) => d.slice(0, start) + d.slice(end))
      requestAnimationFrame(() => composerTaRef.current?.setSelectionRange(start, start))
    },
  })

  // 滚动位置落 store（design-tab-state-memory §2.3）：卸载即切走——贴底删条目
  //（切回贴底是正确默认），否则存最后捕获值。cleanup 必随卸载执行，捕获在
  // ref（不依赖 cleanup 闭包新鲜度）。闸门：Tab 仍在 = 切走保存；Tab 已关
  //（关闭/删除/收敛——条目已随 closeTab 清除）则不写，防复活已清条目
  useEffect(() => {
    return () => {
      if (!store.tabs.some((t) => t.key === `chat:${sessionID}`)) return
      if (pinnedToBottom.current) store.setChatScroll(sessionID, null)
      else if (scrollCapture.current) store.setChatScroll(sessionID, scrollCapture.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionID])

  // 跨客户端回滚覆盖窗口（design-message-revert §3.4）：他端暂存的回滚点可能早于
  // 本端已加载窗口（全部已加载消息被隐藏、计数偏小）——持续拉更早页直到窗口覆盖
  // 回滚点或历史穷尽（loadEarlierMessages 自带 loading/exhausted/error 守卫）
  useEffect(() => {
    if (!revertMessageID) return
    const covered = entries.some(
      (e) => e.kind === "message" && e.data.info.id < revertMessageID,
    )
    if (!covered) void store.loadEarlierMessages(sessionID)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revertMessageID, entries, sessionID])

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }

  /**
   * 上滚分页触发（store 侧守卫为权威：in-flight/exhausted/error 语义全在
   * loadEarlierMessages，UI 不重复判定——无状态 = 种子路径，挂载加载失败的
   * 唯一重试入口，review P2）
   */
  const maybeLoadEarlier = () => {
    const el = scrollRef.current
    if (el)
      anchorRef.current = {
        height: el.scrollHeight,
        top: el.scrollTop,
        headId: headIdOf(visibleEntries),
      }
    void store.loadEarlierMessages(sessionID)
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    // 仅"吸附"（带滞回，§7.14）：scrollTop 增加（向下接近底部）且距底 <8px 才
    // 恢复跟随。不在此清除 pinned——scroll 事件无法区分用户滚动与程序滚动/smooth
    // 动画：动画进行中每帧距底 >阈值，若据此清 pinned，流式更新会被误判"用户上滚"
    // 而停止跟随，且 smooth 目标是过期 scrollHeight、动画终点仍距底 >阈值，
    // 没有任何事件把 pinned 置回 → 跟随死锁（§7.9）。
    // 滞回两要素：①方向——上滚手势期间每个 scroll 事件方向都是"向上"（scrollTop
    // 减少），永不吸附，手势被完整保留；仅收紧阈值不够，触控板 scroll 高频小增量，
    // 手势首批事件距底仍 <8px 会立刻吃回。②8px 回底阈值——解除后悬停在距底
    // 8~40px 不再视作"在底部"，向下回滚越过 8px 即吸附（滚轮一档过量被钳制在底，
    // 末事件 gap=0 必吸附）。
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    if (el.scrollTop > prevScrollTop.current && gap < 8) pinnedToBottom.current = true
    prevScrollTop.current = el.scrollTop
    // 触顶翻页：pinned 期间不触发（发送后 smooth 回底动画起点可能距顶很近，
    // 会误触一次分页 + 锚定补差与回底动画互相拉扯）
    if (!pinnedToBottom.current && el.scrollTop <= 64) maybeLoadEarlier()
    // 滚动位置捕获：廉数值读取；卸载时按贴底与否决定删条目/落 store（§2.3）
    scrollCapture.current = { top: el.scrollTop, headId: headIdOf(visibleEntries) }
  }

  // 解除跟随只认用户主动上滚（wheel deltaY<0 + 键盘上滚键）。滚动条已隐藏（app.css），
  // wheel/触控板与键盘是用户上滚入口；Chromium 已归一化自然滚动方向，deltaY<0 恒为"向上看历史"。
  // 两类误触排除：ctrlKey=缩放手势（Ctrl+wheel 放大/触控板 pinch-out）；
  // 内容未溢出时上滚是视觉 no-op——若此时清 pinned，流式增长越过容器后无
  // scroll 事件可再吸附（scrollTop 未变），跟随将停摆到用户手动滚底
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return
    const el = scrollRef.current
    if (e.deltaY < 0 && el && el.scrollHeight - el.clientHeight > 0) pinnedToBottom.current = false
  }

  // 键盘上滚解除（§7.14 修订）：§7.9 "列表不可聚焦，无键盘滚动" 的前提不成立——
  // tabIndex=-1 只是不入 Tab 序列，点击仍会聚焦容器（Chromium 行为），聚焦后
  // ArrowUp 等滚动容器且只产生 scroll 事件（无 wheel），pinned 不清则任何
  // entries 变化都被 useLayoutEffect 拉回底部。上滚键：ArrowUp/PageUp/Home/
  // Shift+Space；ctrl/meta/alt 组合是快捷键非滚动，不解除；溢出守卫同 wheel。
  const onKeyScroll = (e: KeyboardEvent) => {
    // 只认容器自身聚焦的按键：焦点在可滚后代（代码块 pre 自带 overflow:auto、
    // chip 按钮等）时，按键滚动的是内层元素、外层不产生 scroll 事件——若仍清
    // pinned，跟随会静默停摆到下次向下输入（§7.9 溢出守卫防的同型问题）
    if (e.target !== e.currentTarget) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const up =
      e.key === "ArrowUp" ||
      e.key === "PageUp" ||
      e.key === "Home" ||
      (e.key === " " && e.shiftKey)
    if (!up) return
    const el = scrollRef.current
    if (el && el.scrollHeight - el.clientHeight > 0) pinnedToBottom.current = false
  }

  // useLayoutEffect：DOM 变更后、绘制前同步置底，首帧即到底、无滚动动画
  // 依赖 visibleEntries（非 entries）：回滚暂存隐藏尾部消息也要触发贴底重定位
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // 滚动位置恢复（design-tab-state-memory §2.3）：entries 落地且头部未变 →
    // 定位切走时的 scrollTop（底部增长不影响绝对偏移）；头部变化（远端窗口漂移）
    // → 放弃恢复回落贴底，不错位。恢复后 pinned=false，prepend 走既有锚定补差
    const pending = scrollRestore.current
    if (pending) {
      if (visibleEntries.length > 0) {
        scrollRestore.current = null
        if (headIdOf(visibleEntries) === pending.headId) {
          el.scrollTop = Math.min(pending.top, el.scrollHeight - el.clientHeight)
        } else {
          pinnedToBottom.current = true
        }
      }
    }
    const anchor = anchorRef.current
    if (anchor && !pinnedToBottom.current) {
      const head = headIdOf(visibleEntries)
      if (head !== anchor.headId) {
        anchorRef.current = null
        if (visibleEntries.length > lastEntryCount.current) {
          // 头部真实增长（分页/种子窗口落地——两个来源，见设计 §4.3）：
          // prepend 增量按 scrollHeight 差补回，视口内容不动；随后**重新武装**
          // anchor——种子路径同调用内窗口+before 两次落地，第二次 prepend 也要补偿
          el.scrollTop = el.scrollHeight - anchor.height + anchor.top
          anchorRef.current = { height: el.scrollHeight, top: el.scrollTop, headId: head }
        }
        // 头部 shrink（远端 message.removed 删了最旧消息）：陈旧 anchor 作废丢弃
      }
    } else if (pinnedToBottom.current) {
      // 已回底：任何 armed anchor 过时作废（后续 prepend 由贴底逻辑接管）
      anchorRef.current = null
      // 0→N（含首次加载与切回 Tab 重拉快照）用 auto 瞬时定位——溢出态初始 scrollTop=0
      // 在顶部，auto 在绘制前同步跳底，用户看不到顶部帧；smooth 则是可见的整屏滚动
      // 动画（§7.8 症状回归）。lastEntryCount>0 排除 0→N，之后新条目（N→N+1）才
      // smooth 跟随，同条目流式更新（N→N）即时贴底。回滚隐藏尾部 = 条数减少，
      // 走 auto 即时贴底（无动画）
      const grew = lastEntryCount.current > 0 && visibleEntries.length > lastEntryCount.current
      scrollToBottom(grew ? "smooth" : "auto")
    }
    lastEntryCount.current = visibleEntries.length
    // 链式加载：内容不足以溢出视口（用户无从滚动）且还能加载更早历史 → 再拉一页
    // （失败停链——error 守卫在 canLoadEarlier 内，design §4.3）
    if (el.scrollHeight <= el.clientHeight && store.canLoadEarlier(sessionID)) {
      maybeLoadEarlier()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEntries])

  const send = async () => {
    const text = draft.trim()
    // 引用（design-file-reference §4）：空守卫 = 文本与引用全空才拒绝（纯引用合法）
    const refs = store.fileRefsFor(sessionID)
    if (!text && refs.length === 0) return
    // busy 不拦（design-supplement-send）：进行中发送 = 补充消息，server 在
    // 当前 run 内吸收（不打断、不排队），乐观气泡按时间序排活跃流式下方
    // store 侧显式清（不依赖同步 effect，与引导页发送成功路径同构；失败回填
    // 经 setDraft(text) 再落 store；引用失败保留在 store 供重发）
    setDraft("")
    store.setChatDraft(sessionID, "")
    setCmdDismissed(false)
    pinnedToBottom.current = true
    scrollToBottom("smooth")
    const res = text.startsWith("/")
      ? await sendSlash(text, refs)
      : await store.sendPrompt(sessionID, text, refs)
    // 失败回填草稿：文本不丢（乐观消息已在 store 侧撤回）
    if (!res.ok) setDraft(text)
  }

  /**
   * 斜杠命令分流：发送前强制重拉注册表（最新命令集），命中才走
   * POST /session/:id/command（服务端展开）；未注册的 /xxx 按字面文本
   * 走 prompt（服务端不会展开模板）。
   * 命令名与参数以任意空白分隔（空格/换行/Tab——Shift+Enter 多行参数可达）。
   */
  const sendSlash = async (
    text: string,
    refs: ReturnType<typeof store.fileRefsFor>,
  ): Promise<{ ok: boolean; error?: string }> => {
    const slashDir = store.findSession(sessionID)?.directory ?? null
    await store.refreshCommands(slashDir)
    const rest = text.slice(1)
    const sep = rest.search(/\s/)
    const token = (sep === -1 ? rest : rest.slice(0, sep)).toLowerCase()
    const matched = (slashDir ? store.commandsFor(slashDir) : []).find(
      (c) => c.name.toLowerCase() === token,
    )
    // 未注册命令按字面文本走 prompt（引用 parts 同样携带）；命中走 command（parts 契约同）
    if (!matched) return store.sendPrompt(sessionID, text, refs)
    const args = sep === -1 ? "" : rest.slice(sep + 1).trim()
    return store.sendCommand(sessionID, matched.name, args, refs)
  }

  // ---- 斜杠命令菜单（参考 openbuilder conversation_screen _CommandHints）----
  // 命令模式：以 / 开头且其后无任何空白（命令名不含空白）；Esc 关闭（改草稿后重开）
  const [cmdDismissed, setCmdDismissed] = useState(false)
  const [selIndex, setSelIndex] = useState(0)
  const cmdMode = draft.startsWith("/") && !/\s/.test(draft.slice(1)) && !cmdDismissed
  const directory = store.findSession(sessionID)?.directory ?? ""
  const commands = store.commandsFor(directory)
  const matches = cmdMode
    ? commands.filter((c) => ("/" + c.name).toLowerCase().startsWith(draft.toLowerCase()))
    : []
  const sel = Math.min(selIndex, Math.max(0, matches.length - 1))
  const cmdRefreshTriggeredRef = useRef(false)

  // 进入命令模式按需拉取：未拉过或上次降级才拉（不在每次键入时打服务器）
  useEffect(() => {
    if (!cmdMode) {
      cmdRefreshTriggeredRef.current = false
      return
    }
    if (!cmdRefreshTriggeredRef.current || store.commandsDegraded) {
      cmdRefreshTriggeredRef.current = true
      void store.refreshCommands(directory)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmdMode, directory])

  const pickCommand = (c: CommandInfo) => {
    setDraft(`/${c.name} `)
    setSelIndex(0)
    setCmdDismissed(false)
  }

  return (
    <div className="chat-view">
      {/* 全宽滚动层：空白处滚轮可滚（限宽在内层，见 app.css .message-list 注释）。
          tabIndex=-1：Chromium 把滚动容器纳入焦点序列（Shift+Tab 会给整层画环，
          实证见 2026-08-24 会话），移出后键盘焦点直达输入框/Tab 条 */}
      <div
        className="message-list scroll"
        ref={scrollRef}
        tabIndex={-1}
        onScroll={onScroll}
        onWheel={onWheel}
        onKeyDown={onKeyScroll}
      >
        <div className="message-list-inner">
          <HistoryRow sessionID={sessionID} onRetry={maybeLoadEarlier} />
          {visibleEntries.map((entry) => (
            <MessageBlock
              key={entry.kind === "optimistic" ? entry.data.localId : entry.data.info.id}
              entry={entry}
            />
          ))}
          {/* 常驻固定高槽位（INV-1）：显隐只动槽内内容，消息流总高度不变（design-typing-indicator §3） */}
          <TypingSlot status={status} />
        </div>
      </div>
      <ChatFooter sessionID={sessionID} />
      <div className="composer" {...refInput.dragProps}>
        {/* 回滚暂存条（design-message-revert §3.4）：composer 内常驻一行，撤销入口 */}
        {revertMessageID && <RevertBar sessionID={sessionID} count={revertedCount} busy={busy} />}
        {/* 覆盖层：锚在 composer 上沿悬浮于消息流（不占布局、不顶起消息） */}
        {cmdMode && (
          <CommandHints
            matches={matches}
            loading={store.commandsRefreshing && commands.length === 0}
            selIndex={sel}
            onPick={pickCommand}
          />
        )}
        {/* @ 引用浮层（design-file-reference §3.1）：同 CommandHints 锚定 */}
        {refInput.picker}
        {/* 引用 chip 条（design-file-reference §5） */}
        {refInput.chips}
        <textarea
          ref={composerTaRef}
          value={draft}
          placeholder={t.inputPlaceholder}
          rows={1}
          autoFocus
          onFocus={(e) => {
            // 默认聚焦（autoFocus）时光标置于末尾，而非开头（有草稿时）
            const el = e.currentTarget
            requestAnimationFrame(() => {
              const len = el.value.length
              el.setSelectionRange(len, len)
            })
          }}
          onChange={(e) => {
            setDraft(e.target.value)
            setCmdDismissed(false)
            setSelIndex(0)
            // @ 引用检测（光标处 @词 → 触发搜索浮层）
            refInput.onTextChange(e.target.value, e.target.selectionStart)
          }}
          onKeyUp={(e) => {
            // Esc 关闭后光标移回 @词 内重开浮层（无修饰键的移动类按键；
            // Esc 自身不重开——onKeyDown 已消费）
            if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
              refInput.onTextChange(e.currentTarget.value, e.currentTarget.selectionStart)
            }
          }}
          onKeyDown={(e) => {
            // IME 组合中（如 fcitx5 上屏）不触发发送与菜单选中
            if (e.nativeEvent.isComposing) return
            // @ 浮层键盘交互优先（↑/↓/Enter/Tab/Esc；消费则终止）
            if (refInput.onKeyDown(e)) return
            // 命令菜单打开且有匹配：↑/↓ 移动、Enter/Tab 选中补全、Esc 关闭。
            // 修饰键组合（Ctrl/Meta/Alt）是全局快捷键域（Ctrl+Tab 切 Tab、
            // Ctrl+Alt+↑/↓ 遍历作用域），不在此拦截（design-keyboard-shortcuts）
            if (cmdMode && matches.length > 0) {
              const noMod = !e.ctrlKey && !e.metaKey && !e.altKey
              if (noMod && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault()
                const len = matches.length
                setSelIndex(e.key === "ArrowDown" ? (sel + 1) % len : (sel - 1 + len) % len)
                return
              }
              if (
                (noMod && e.key === "Tab") ||
                (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey)
              ) {
                e.preventDefault()
                pickCommand(matches[sel])
                return
              }
              if (e.key === "Escape") {
                e.preventDefault()
                setCmdDismissed(true)
                return
              }
            }
            if (e.key === "Enter") {
              // 修饰键组合（Ctrl/Shift/Alt/Meta）= 换行；裸 Enter = 发送
              if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="composer-actions">
          {/* busy 不禁切换：服务端 next 语义（下一条消息生效）是预期行为（设计"不做的事"） */}
          <ModelSwitcherBar
            directory={store.findSession(sessionID)?.directory ?? ""}
            mode="session"
            session={store.findSession(sessionID)}
          />
          {/* busy 时停止常驻可达（移动端 showStop 输入即隐藏——桌面空间足够，
              保留停止入口：补充输入中途仍可直接终止 run，无需清空草稿）；
              发送按钮在 busy 时仅于有草稿或引用时出现（纯引用可发送） */}
          {busy && (
            <button className="btn-danger" onClick={() => void store.abortSession(sessionID)}>
              {t.abort}
            </button>
          )}
          {(!busy || draft.trim() || store.fileRefsFor(sessionID).length > 0) && (
            <button
              className="btn-primary"
              disabled={!draft.trim() && store.fileRefsFor(sessionID).length === 0}
              onClick={() => void send()}
            >
              {t.send}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 回滚暂存条（design-message-revert §3.4）：session.revert 存在时出现于
 * composer 顶部；「撤销回滚」= unrevert（恢复文件、清暂存）。发送下一条
 * 消息即提交回滚（server 删消息、清暂存），条随之消失。
 */
function RevertBar({ sessionID, count, busy }: { sessionID: string; count: number; busy: boolean }) {
  const store = useStore()
  const { t } = useI18n()
  const [undoing, setUndoing] = useState(false)

  const undo = async () => {
    if (undoing) return
    setUndoing(true)
    await store.unrevertSession(sessionID)
    setUndoing(false)
  }

  return (
    <div className="revert-bar" role="status">
      <RotateCcw className="revert-bar-icon" size={14} aria-hidden />
      <span className="revert-bar-text">{format(t.revertBarHint, { count })}</span>
      <button className="btn-tonal revert-bar-undo" disabled={busy || undoing} onClick={() => void undo()}>
        {t.unrevert}
      </button>
    </div>
  )
}

/** 斜杠命令菜单：输入 / 触发，前缀过滤，↑/↓ + Enter/Tab 补全（桌面交互） */
function CommandHints({
  matches,
  loading,
  selIndex,
  onPick,
}: {
  matches: CommandInfo[]
  loading: boolean
  selIndex: number
  onPick: (c: CommandInfo) => void
}) {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 键盘移动时保持选中项可见
    listRef.current
      ?.querySelector<HTMLElement>(".command-row.selected")
      ?.scrollIntoView({ block: "nearest" })
  }, [selIndex, matches.length])

  if (matches.length === 0) {
    // 仅加载中提示（无匹配时静默，同 openbuilder _CommandHints）
    if (!loading) return null
    return (
      <div className="command-hints-slot">
        <div className="command-hints">
          <div className="command-empty">{t.commandListLoading}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="command-hints-slot">
      {/* tabIndex=-1：滚动容器不入焦点序列（同 .message-list），命令行按钮保持可达 */}
      <div className="command-hints scroll" ref={listRef} tabIndex={-1}>
        {matches.map((c, i) => (
          <button
            key={c.name}
            className={"command-row" + (i === selIndex ? " selected" : "")}
            // mousedown：先于 textarea blur，补全后焦点留在输入框
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(c)
            }}
          >
            <span className="command-name mono">/{c.name}</span>
            {c.description && <span className="command-desc">{c.description}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 会话底部待处理面板：一次渲染一张卡（授权优先于问题，同移动端 _FooterPanel——
 * 权限通常阻塞执行），队列 >1 时计数提示。卡片按 id 键控（review-73dcfa6：
 * 队列推进时复用组件 State 导致选中/提交态残留的教训）。
 * 任务卡（design-task-list）是第三类：有待处理人机交互时不渲染（授权/问题卡
 * 需用户动作，不得被遮挡或推高），全部完成也不渲染（todosActive 闸门）。
 */
function ChatFooter({ sessionID }: { sessionID: string }) {
  const store = useStore()
  const permission = store.pendingPermissions.get(sessionID)
  const questions = store.questionsForSession(sessionID)
  const question = permission ? null : (questions[0] ?? null)
  const queueTotal = (permission ? 1 : 0) + questions.length
  const todos = queueTotal === 0 ? store.todosForSession(sessionID) : []
  const showTodos = queueTotal === 0 && todosActive(todos)
  if (queueTotal === 0 && !showTodos) return null
  return (
    <div className="chat-footer">
      {permission && (
        <PermissionCard key={permission.id} permission={permission} queueTotal={queueTotal} />
      )}
      {question && <QuestionCard key={question.id} question={question} queueTotal={queueTotal} />}
      {showTodos && <TodoCard todos={todos} />}
    </div>
  )
}

/**
 * 任务卡（design-task-list）：默认收起——头部一行（图标 + 标题 + done/total
 * 计数 + 展开箭头），点击切换；展开显示进度条 + 逐条状态行。无提交态，列表
 * 整体重渲染即正确（键控无必要，见设计「与移动端的差异」）。
 */
function TodoCard({ todos }: { todos: Todo[] }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const done = todos.filter(todoDone).length
  const pct = todos.length === 0 ? 0 : Math.round((done / todos.length) * 100)
  return (
    <div className="pending-card todo">
      <button
        className="pending-card-header"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <ListChecks className="pending-card-icon" size={16} aria-hidden />
        <span className="pending-card-title">{t.todoTitle}</span>
        <span className="pending-card-sub">{format(t.todoCount, { done, total: todos.length })}</span>
        {expanded ? (
          <ChevronDown className="pending-card-chevron" size={16} aria-hidden />
        ) : (
          <ChevronRight className="pending-card-chevron" size={16} aria-hidden />
        )}
      </button>
      {expanded && (
        <div className="pending-card-body">
          <div
            className="todo-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div className="todo-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <ul className="todo-list">
            {todos.map((todo, i) => (
              <li key={todoKey(todo, i)} className={"todo-row" + (todoDone(todo) ? " done" : "")}>
                <span className="todo-row-icon" aria-hidden>
                  {todo.status === "cancelled" ? (
                    <CircleX size={14} />
                  ) : todo.status === "completed" ? (
                    <CircleCheck size={14} />
                  ) : todoActive(todo) ? (
                    <CircleDot className="todo-active" size={14} />
                  ) : (
                    <Circle size={14} />
                  )}
                </span>
                <span className="todo-row-text">{todo.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** 权限类型 → 可读标题（移动端 l10n_ext.dart permissionTitle 同源映射） */
function permissionTitle(t: Catalog, p: PendingPermission): string {
  switch (p.type) {
    case "external_directory":
      return t.permissionExternalDir
    case "bash":
      return t.permissionExecute
    default:
      return p.type || t.permissionRequest
  }
}

function PermissionCard({
  permission,
  queueTotal,
}: {
  permission: PendingPermission
  queueTotal: number
}) {
  const store = useStore()
  const { t } = useI18n()
  const [replying, setReplying] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const title = permissionTitle(t, permission)
  const detail =
    permissionCommand(permission) ??
    (permission.patterns.length > 0 ? permission.patterns.join("\n") : null) ??
    externalDirectoryPath(permission)

  const respond = async (response: "once" | "always" | "reject") => {
    setReplying(true)
    setError(null)
    const res = await store.respondPermission(permission.sessionID, response)
    if (!res.ok) {
      setError(res.error ?? t.replyFailed)
      setReplying(false)
    }
    // 成功：卡片随 store 移除而卸载，不回设状态
  }

  return (
    <div className="pending-card permission">
      <button className="pending-card-header" onClick={() => setCollapsed(!collapsed)}>
        <ShieldAlert className="pending-card-icon" size={16} aria-hidden />
        <span className="pending-card-title">{t.permissionRequest}</span>
        <span className="pending-card-sub">{title}</span>
        {queueTotal > 1 && (
          <span className="pending-queue">{format(t.pendingQueue, { total: queueTotal })}</span>
        )}
        {collapsed ? (
          <ChevronRight className="pending-card-chevron" size={16} aria-hidden />
        ) : (
          <ChevronDown className="pending-card-chevron" size={16} aria-hidden />
        )}
      </button>
      {!collapsed && (
        <div className="pending-card-body">
          {detail && <pre className="pending-card-detail mono">{detail}</pre>}
          <div className="pending-card-actions">
            <button className="btn-danger" disabled={replying} onClick={() => void respond("reject")}>
              {t.reject}
            </button>
            <button className="btn-tonal" disabled={replying} onClick={() => void respond("always")}>
              {t.permissionAlwaysAllow}
            </button>
            <button className="btn-primary" disabled={replying} onClick={() => void respond("once")}>
              {t.permissionAllowOnce}
            </button>
          </div>
          {error && <div className="pending-card-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

/**
 * 输入中提示常驻槽位（design-typing-indicator §3）：
 * - 高度恒定 28px + overflow hidden——busy ⇄ idle 切换零布局变化（INV-1）；
 * - idle 时兼作消息流底部呼吸留白；空会话时同样无害；
 * - 显隐只走 opacity/visibility（150ms），布局属性不参与动画；
 * - retry 在同槽位呈现（旋转图标 + 单行截断文案，高度 ≤ H）。
 */
function TypingSlot({ status }: { status: SessionStatusValue }) {
  const { t } = useI18n()
  const busy = status.type === "busy"
  const retry = status.type === "retry"
  // retry message 清洗（design-error-message §3.1）：provider 原文可内嵌 JSON body，
  // 展示层提取人读字段（store 数据保持忠实）
  const retryText = retry
    ? status.message
      ? format(t.retryingMessage, { message: extractRetryMessage(status.message) })
      : t.retrying
    : ""
  return (
    <div
      className="typing-slot"
      role="status"
      aria-label={busy ? t.generating : retry ? retryText : undefined}
    >
      <span className={"typing-dots" + (busy ? " on" : "")} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className={"typing-retry" + (retry ? " on" : "")}>
        <LoaderCircle className="typing-spinner" size={16} aria-hidden="true" />
        <span className="typing-retry-text">{retryText}</span>
      </span>
    </div>
  )
}

function QuestionCard({
  question,
  queueTotal,
}: {
  question: PendingQuestion
  queueTotal: number
}) {
  const store = useStore()
  const { t } = useI18n()
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [step, setStep] = useState(0)
  const [replying, setReplying] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totalSub = question.questions.length
  // 步进钳制：同 id 载荷重新归一化后子问题变短的防御（当前 server 不会变更已
  // 排队问题，纯 hardening），防止 questions[step] 越界
  const stepIdx = Math.min(step, Math.max(0, totalSub - 1))
  const q = question.questions[stepIdx]
  const sel = selected[stepIdx] ?? []
  const stepAnswered = sel.length > 0
  const isLast = stepIdx >= totalSub - 1

  const toggle = (label: string) => {
    if (replying) return
    const i = stepIdx
    setSelected((prev) => {
      const cur = prev[i] ?? []
      const next = cur.includes(label)
        ? cur.filter((x) => x !== label)
        : q.multiple
          ? [...cur, label]
          : [label]
      return { ...prev, [i]: next }
    })
  }

  const finish = async (action: "reply" | "reject") => {
    setReplying(true)
    setError(null)
    const answers = question.questions.map((_, i) => selected[i] ?? [])
    const res =
      action === "reject"
        ? await store.rejectQuestion(question.id)
        : await store.replyQuestion(question.id, answers)
    if (!res.ok) {
      setError(res.error ?? t.replyFailed)
      setReplying(false)
    }
  }

  return (
    <div className="pending-card question">
      <button className="pending-card-header" onClick={() => setCollapsed(!collapsed)}>
        <CircleHelp className="pending-card-icon" size={16} aria-hidden />
        <span className="pending-card-title">{q.header}</span>
        {totalSub > 1 && (
          <span className="pending-queue">
            {stepIdx + 1}/{totalSub}
          </span>
        )}
        {queueTotal > 1 && (
          <span className="pending-queue">{format(t.pendingQueue, { total: queueTotal })}</span>
        )}
        {collapsed ? (
          <ChevronRight className="pending-card-chevron" size={16} aria-hidden />
        ) : (
          <ChevronDown className="pending-card-chevron" size={16} aria-hidden />
        )}
      </button>
      {!collapsed && (
        <div className="pending-card-body">
          <div className="pending-question-text">{q.question}</div>
          <div className="pending-options">
            {q.options.map((opt) => {
              const active = sel.includes(opt.label)
              return (
                <button
                  key={opt.label}
                  className={"pending-option" + (active ? " active" : "")}
                  disabled={replying}
                  onClick={() => toggle(opt.label)}
                >
                  <span
                    className={
                      "pending-option-mark " + (q.multiple ? "checkbox" : "radio") + (active ? " on" : "")
                    }
                    aria-hidden
                  />
                  <span className="pending-option-label">
                    {opt.label}
                    {opt.description && <span className="pending-option-desc">{opt.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="pending-card-actions">
            <button className="btn-danger" disabled={replying} onClick={() => void finish("reject")}>
              {t.reject}
            </button>
            {isLast ? (
              <button
                className="btn-primary"
                disabled={replying || !stepAnswered}
                onClick={() => void finish("reply")}
              >
                {t.questionSubmit}
              </button>
            ) : (
              <button
                className="btn-primary"
                disabled={replying || !stepAnswered}
                onClick={() => setStep(stepIdx + 1)}
              >
                {t.questionNext}
              </button>
            )}
          </div>
          {error && <div className="pending-card-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

/**
 * 上滚翻页顶部指示行（design-message-history-pagination §4.3）：
 * loading → spinner + 文案；error → 可点击重试（继续上滑同样触发）；穷尽不渲染。
 */
function HistoryRow({ sessionID, onRetry }: { sessionID: string; onRetry: () => void }) {
  const store = useStore()
  const { t } = useI18n()
  const hs = store.sessionPages.get(sessionID)
  if (hs?.loading) {
    return (
      <div className="history-row" role="status">
        <LoaderCircle className="history-spinner" size={14} aria-hidden />
        <span>{t.loadingEarlier}</span>
      </div>
    )
  }
  if (hs && !hs.loading && hs.error) {
    return (
      <button type="button" className="history-row error" onClick={onRetry}>
        {t.loadEarlierFailed}
      </button>
    )
  }
  return null
}
/**
 * 高用户消息折叠（design-user-message-collapse；参考 openbuilder 同名设计）：
 * 自然高度超过约 20 行正文 → 默认收起，点击气泡任意处展开/收起。
 * 内容层（.bubble-content）永不加高度约束、恒自然高度，外层气泡 max-height 裁切——
 * 测高口径与收起态无关，无判定振荡（移动端用双 map 分账解决，此处双层 DOM 结构性消解）。
 */
const COLLAPSE_LINES = 20
const COLLAPSE_MIN_GAIN = 24

export function UserBubble({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const contentRef = useRef<HTMLDivElement>(null)
  const [collapsible, setCollapsible] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const measure = () => {
      // 行高以正文 markdown 计算样式为准（14px × 1.6），jsdom/缺样式回落同值
      const md = el.querySelector(".markdown-body")
      const cs = getComputedStyle(md ?? el)
      const fs = parseFloat(cs.fontSize)
      const lh = parseFloat(cs.lineHeight)
      const lineHeight = Number.isFinite(lh) ? lh : Number.isFinite(fs) ? fs * 1.6 : 22.4
      setCollapsible(el.offsetHeight > COLLAPSE_LINES * lineHeight + COLLAPSE_MIN_GAIN)
    }
    measure()
    // 窗口宽度变化 → 文本重排 → 高度变化，重判定（跨门槛双向都走）
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const collapsed = collapsible && !expanded
  return (
    <div
      className={"bubble" + (collapsible ? " user-collapse" : "") + (collapsed ? " collapsed" : "")}
      title={collapsible ? (collapsed ? t.bubbleExpand : t.bubbleCollapse) : undefined}
      onClick={(e) => {
        if (!collapsible) return
        // 链接（系统浏览器打开）/按钮（代码块复制）点击与文本选择不触发切换
        // （选区限定气泡内——别处的残留选区不拦截本气泡点击）
        const target = e.target as HTMLElement
        if (target.closest("a,button")) return
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed && contentRef.current?.contains(sel.anchorNode)) return
        setExpanded(!expanded)
      }}
    >
      <div className="bubble-content" ref={contentRef}>
        {children}
      </div>
      {collapsible &&
        (collapsed ? (
          <div className="bubble-collapse-hint" aria-hidden>
            <ChevronDown size={16} />
          </div>
        ) : (
          <div className="bubble-expand-hint" aria-hidden>
            <ChevronUp size={14} />
          </div>
        ))}
    </div>
  )
}

function MessageBlock({ entry }: { entry: ChatEntry }) {
  const { t } = useI18n()
  const store = useStore()
  const [reverting, setReverting] = useState(false)

  if (entry.kind === "optimistic") {
    return (
      <div className="msg user">
        <div className="bubble">
          {/* 引用 chip（design-file-reference §5）：乐观消息携带 refs，SSE 真实
              user 消息到达后经 file part 渲染同款（乐观→真实替换不闪烁） */}
          {entry.data.text && <Markdown softLineBreak>{entry.data.text}</Markdown>}
          {entry.data.refs && entry.data.refs.length > 0 && (
            <FileRefChips
              items={entry.data.refs.map((r) => ({
                key: r.absolute,
                path: r.path,
                absolute: r.absolute,
                isDir: r.isDir,
                title: r.absolute,
              }))}
              onOpen={(item) => store.openFileTab(item.absolute!)}
            />
          )}
          <div className="bubble-pending">{t.sending}</div>
        </div>
      </div>
    )
  }

  const { info, parts } = entry.data
  const texts = parts.filter((p) => p.type === "text") as Array<{
    id: string
    text: string
  }>
  // 斜杠命令回显：subtask part（展开 prompt 在 prompt 字段，text 恒空）
  const subtasks = parts.filter((p) => p.type === "subtask") as SubtaskPart[]
  // 思考默认隐藏（设置开关控制，同移动端 showThinking；数据保留，仅不渲染）
  const reasonings = store.showThinking ? parts.filter((p) => p.type === "reasoning") : []
  const tools = parts.filter((p) => p.type === "tool") as ToolPart[]
  const errored = info.role === "assistant" && info.error
  // 引用回灌 file part（design-file-reference §5）：user 消息内 source.type=file
  const fileRefParts = info.role === "user" ? parts.filter(isFileRefPart) : []
  // chip 跳转绝对路径 = 会话目录 + source.path（禁用 part.url——二进制回灌变 data:，4R-B）
  const sessionDir = store.findSession(info.sessionID)?.directory
  // 子会话（subagent）内禁用回滚（design-subagent-status §D2）
  const isChildSession = !!store.findSession(info.sessionID)?.parentID
  const refChipItems: RefChipItem[] = fileRefParts.map((p) => {
    const rel = p.source?.path ?? p.filename ?? ""
    const abs = sessionDir && rel && !rel.startsWith("/")
      ? `${sessionDir.replace(/\/+$/, "")}/${rel.replace(/^\.?\//, "")}`
      : null
    return {
      key: p.id,
      path: rel,
      absolute: abs ?? undefined,
      isDir: rel.endsWith("/"),
      title: abs ?? rel,
    }
  })

  if (info.role === "user") {
    // 回滚到此消息（design-message-revert §3.4）：busy 时确认后先停止再回滚
    const revertHere = async () => {
      if (reverting) return
      if (store.isSessionActive(info.sessionID) && !confirm(t.confirmRevertBusy)) return
      setReverting(true)
      await store.revertToMessage(info.sessionID, info.id)
      setReverting(false)
    }
    return (
      <div className="msg user">
        {/* 动作行先于气泡（flex 顺序）：紧贴气泡左侧、纵向居中；常驻占位 hover 显形。
            斜杠命令回显（subtask/展开 text）有入口（2026-09-01 修订，design-message-revert
            §3.4）；纯附件（无 text 无 subtask）不显示——回滚 API 按 messageID 工作，与 part 无关 */}
        {(texts.length > 0 || subtasks.length > 0) && !isChildSession && (
          <div className="msg-actions">
            <button
              className="icon-btn msg-action"
              title={t.revertToHere}
              aria-label={t.revertToHere}
              disabled={reverting}
              onClick={() => void revertHere()}
            >
              {reverting ? <LoaderCircle size={14} aria-hidden /> : <RotateCcw size={14} aria-hidden />}
            </button>
          </div>
        )}
        <UserBubble>
          {texts.map((p) => (
            <Markdown key={p.id} softLineBreak>
              {p.text}
            </Markdown>
          ))}
          {refChipItems.length > 0 && (
            <FileRefChips
              items={refChipItems}
              onOpen={(item) => store.openFileTab(item.absolute!)}
            />
          )}
          {subtasks.map((p) => {
            // 标签行 + 正文合并为单一 Markdown（openbuilder 二次评审结论：
            // 单独画标签观感像 chip，与正文样式不一致）
            const body = p.prompt || p.text || p.description || ""
            return (
              <div key={p.id} className="bubble-subtask">
                <Markdown softLineBreak>
                  {body ? `**subtask: ${p.command}**\n\n${body}` : `**subtask: ${p.command}**`}
                </Markdown>
              </div>
            )
          })}
        </UserBubble>
      </div>
    )
  }

  return (
    <div className="msg assistant">
      {reasonings.map((p) => (
        <ReasoningChip key={p.id} part={p} />
      ))}
      {tools.map((p) => (
        p.tool === "task" ? (
          <SubagentPanel key={p.id} part={p} parentSessionID={info.sessionID} />
        ) : (
          <ToolChip key={p.id} part={p} />
        )
      ))}
      {texts.map((p) => (
        <div key={p.id} className="assistant-text">
          <Markdown>{p.text}</Markdown>
        </div>
      ))}
      {errored && (
        <div className="error-card">
          {/* NamedError 形态解析 + 内嵌 JSON 清洗（design-error-message §3.1）：
              样式（红卡）已承载出错语义，正文只显示错误信息本身 */}
          {extractErrorMessage(info.error)}
        </div>
      )}
    </div>
  )
}

function ReasoningChip({ part }: { part: Part }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const text = (part as { text?: string }).text ?? ""
  return (
    <div className={"chip" + (open ? " open" : "")}>
      <button className="chip-header" tabIndex={-1} onClick={() => setOpen(!open)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className="chip-label">{t.thinking}</span>
      </button>
      {open && (
        <div className="chip-body reasoning">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  )
}

function ToolChip({ part }: { part: ToolPart }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const state = part.state
  const status = state.status
  const summary =
    status === "completed"
      ? state.title || ""
      : status === "error"
        ? state.error.slice(0, 120)
        : ""

  return (
    <div className={"chip" + (open ? " open" : "")}>
      <button className="chip-header" tabIndex={-1} onClick={() => setOpen(!open)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className="chip-label">{part.tool}</span>
        {summary && <span className="chip-summary">{summary}</span>}
      </button>
      {open && (
        <div className="chip-body">
          <div className="code-block-label">{t.inputLabel}</div>
          <pre className="code-block" tabIndex={-1}>{JSON.stringify(state.input, null, 2)}</pre>
          <div className="code-block-label">{t.outputLabel}</div>
          <pre className="code-block" tabIndex={-1}>
            {status === "completed" ? state.output : status === "error" ? state.error : "…"}
          </pre>
        </div>
      )}
    </div>
  )
}

/**
 * subagent 工作状态面板（design-subagent-status）：
 * task 工具的专用渲染——替代 ToolChip，在主消息流中内嵌子会话消息流。
 * 收起态 = agent 名 + 状态图标 + 描述摘要；展开态 = 独立滚动（滚动条隐藏）的
 * 子会话消息列表，宽度与消息区一致。子会话内回滚已屏蔽（MessageBlock isChildSession）。
 */
function SubagentPanel({ part, parentSessionID }: { part: ToolPart; parentSessionID: string }) {
  const { t } = useI18n()
  const store = useStore()
  const [open, setOpen] = useState(false)
  const state = part.state
  const status = state.status

  // 子会话 ID 来源（design-subagent-status §D3）：
  // 1. tool.state.metadata.sessionId（running/completed 后 server 写入）
  // 2. 降级：findChildSession 按 parentID + description 匹配
  const metadata = "metadata" in state ? (state as { metadata?: Record<string, unknown> }).metadata : undefined
  const metadataSessionId = typeof metadata?.sessionId === "string" ? metadata.sessionId : undefined
  const description = typeof (state as { input?: { description?: string } }).input?.description === "string"
    ? (state as { input?: { description?: string } }).input!.description!
    : ""
  const subagentType = typeof (state as { input?: { subagent_type?: string } }).input?.subagent_type === "string"
    ? (state as { input?: { subagent_type?: string } }).input!.subagent_type!
    : ""

  // 启发式降级：metadata 无 sessionId 时从 sessionsByProject 查找
  const childSession = metadataSessionId
    ? store.findSession(metadataSessionId)
    : store.findChildSession(parentSessionID, description || undefined)
  const childSessionId = metadataSessionId ?? childSession?.id

  // 状态图标 + 摘要
  const running = status === "pending" || status === "running"
  const agentLabel = subagentType
    ? subagentType.charAt(0).toUpperCase() + subagentType.slice(1)
    : t.assistant
  const summary =
    status === "completed"
      ? (("title" in state ? state.title : "") || description || "")
      : status === "error"
        ? ("error" in state ? state.error.slice(0, 120) : "")
        : description || ""

  // 首次展开加载子会话消息：SSE 增量已累积时跳过 REST（避免冗余拉取 +
  // loadSessionMessages 的 idle 副作用对运行中子会话的误判，review #1）。
  // 记录已加载 id 而非布尔（review R2-#1）：childSessionId 漂移（启发式命中
  // 在先 → metadata.sessionId 到达切换）时对新 id 重新触发 REST；收起即重置——
  // 面板无错误态渲染，再展开是 REST 失败后的唯一重试入口
  const loadedIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      loadedIdRef.current = null
      return
    }
    if (!childSessionId || loadedIdRef.current === childSessionId) return
    loadedIdRef.current = childSessionId
    if (store.chatEntries(childSessionId).length > 0) return
    const dir = childSession?.directory
      ?? store.findSession(parentSessionID)?.directory
      ?? ""
    if (dir) void store.loadSessionMessages(childSessionId, dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, childSessionId])

  // 子会话消息列表
  const childEntries = childSessionId ? store.chatEntries(childSessionId) : []

  // 独立滚动跟随（design-subagent-status §D5，ChatView 贴底语义同构）：
  // 展开挂载即贴底；贴底时新消息/流式更新跟随。上滚解除：wheel deltaY<0 +
  // 键盘上滚键（ArrowUp/PageUp/Home/Shift+Space——body tabIndex=-1 可被点击
  // 聚焦，键盘滚动只产生 scroll 事件，不清 pinned 则流式更新拉回底部，§7.14）。
  // 回底吸附带滞回（向下滚且距底 <8px 才恢复——防 smooth 动画帧间 gap 抖动
  // 误吸附）。收起重置 pinned，再展开恢复默认贴底
  const bodyRef = useRef<HTMLDivElement>(null)
  const bodyPinned = useRef(true)
  const bodyPrevTop = useRef(0)

  useEffect(() => {
    if (!open) {
      bodyPinned.current = true
      bodyPrevTop.current = 0
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const el = bodyRef.current
    if (!el) return
    if (bodyPinned.current) {
      // auto 瞬时贴底（同 ChatView 流式更新路径）；面板上限 400px，动画增益有限
      el.scrollTop = el.scrollHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, childEntries])

  const onBodyScroll = () => {
    const el = bodyRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    if (el.scrollTop > bodyPrevTop.current && gap < 8) bodyPinned.current = true
    bodyPrevTop.current = el.scrollTop
  }

  const onBodyWheel = (e: WheelEvent) => {
    // 不冒泡：面板内滚轮不得触发主消息流的上滚解跟（ChatView onWheel）
    e.stopPropagation()
    if (e.ctrlKey) return
    const el = bodyRef.current
    if (e.deltaY < 0 && el && el.scrollHeight - el.clientHeight > 0) bodyPinned.current = false
  }

  // 键盘上滚解除（同 ChatView onKeyScroll）：只认 body 自身聚焦的按键——
  // 焦点在可滚后代（pre.code-block 自带 overflow:auto）时按键滚的是内层、
  // body 不产生 scroll 事件，误清 pinned 会让跟随静默停摆
  const onBodyKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const up =
      e.key === "ArrowUp" ||
      e.key === "PageUp" ||
      e.key === "Home" ||
      (e.key === " " && e.shiftKey)
    if (!up) return
    const el = bodyRef.current
    if (el && el.scrollHeight - el.clientHeight > 0) bodyPinned.current = false
  }

  return (
    <div className={"subagent-panel" + (open ? " open" : "")}>
      <button
        className="subagent-header"
        tabIndex={-1}
        onClick={() => setOpen(!open)}
        title={open ? t.subagentCollapse : t.subagentExpand}
      >
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span
          className="subagent-status-icon"
          aria-label={running ? t.subagentRunning : status === "error" ? t.subagentError : t.subagentCompleted}
        >
          {running ? (
            <LoaderCircle size={14} className="spin" aria-hidden />
          ) : status === "error" ? (
            <CircleX size={14} aria-hidden />
          ) : (
            <CircleCheck size={14} aria-hidden />
          )}
        </span>
        <span className="subagent-agent-label">{agentLabel}</span>
        {summary && <span className="chip-summary">{summary}</span>}
      </button>
      {open && (
        <div
          className="subagent-body"
          ref={bodyRef}
          tabIndex={-1}
          onScroll={onBodyScroll}
          onWheel={onBodyWheel}
          onKeyDown={onBodyKeyDown}
        >
          {!childSessionId ? (
            <div className="subagent-empty">{t.subagentNoSession}</div>
          ) : childEntries.length === 0 ? (
            <div className="subagent-empty">{t.subagentLoading}</div>
          ) : (
            childEntries.map((entry) => (
              <MessageBlock key={entry.kind === "optimistic" ? entry.data.localId : entry.data.info.id} entry={entry} />
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * markdown 文件判定（design-markdown-preview §2.1）：basename 取最后一个**非前导**
 * 点的后缀，大小写不敏感。`.md`/`.markdown` 命中；`.mdx` 不识别；无扩展名与
 * 点文件（前导点，如名字恰为 `.md` 的文件）不命中。
 */
function isMarkdownPath(path: string): boolean {
  const base = path.split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return false
  const ext = base.slice(dot + 1).toLowerCase()
  return ext === "md" || ext === "markdown"
}


/* TOC 悬浮窗布局常量——与 app.css .md-toc 定位公式同源，改 CSS 须同步此处 */
const TOC_W = 240 // --toc-w
const TOC_GAP = 16 // --toc-gap
const TOC_MIN_LEFT = 12 // CSS left: max(12px, …) 左缘兜底
const FILE_MD_MIN = 600 // --file-md-min（内容区下限为硬约束）
const FILE_MD_MAX = 800 // --file-md-max

/** 按 CSS 定位公式推演悬浮窗是否遮挡内容区（右缘越过内容区左缘）。
 * 内容区居中，宽 = clamp(600, 可见宽, 800)，左缘 = (可见宽 − 内容宽)/2
 * （内容宽超可见宽时左缘为负，内容横向溢出，判定仍成立）；
 * 窗左缘 = max(12, 内容左缘 − 窗宽 − 间距)。
 * 遮挡时 TOC 默认收起（工具条按钮可显式展开）（design-markdown-preview §2.4）。 */
function tocOccludesContent(paneW: number): boolean {
  if (paneW <= 0) return false // 未测得宽度：默认显示（测量落地后按实际判定）
  const contentW = Math.max(FILE_MD_MIN, Math.min(paneW, FILE_MD_MAX))
  const contentLeft = (paneW - contentW) / 2
  const tocLeft = Math.max(TOC_MIN_LEFT, contentLeft - TOC_W - TOC_GAP)
  return tocLeft + TOC_W > contentLeft
}

/**
 * 图片文件判定（design-image-preview §2.2）：与 isMarkdownPath 同解析规则。
 * 移动端格式集 jpeg/png/gif/webp/svg；avif/bmp/ico 为 Chromium 原生解码的桌面增补。
 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

/** PDF 判定（design-pdf-preview §1）：仅 .pdf 扩展名（大小写不敏感） */
function isPdfPath(path: string): boolean {
  const base = path.split("/").pop() ?? ""
  return base.toLowerCase().endsWith(".pdf")
}

function isImagePath(path: string): boolean {
  const base = path.split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return false
  const ext = base.slice(dot + 1).toLowerCase()
  return ext === "svg" || ext in IMAGE_MIME_BY_EXT
}

/**
 * 图片 data URL 构建（design-image-preview §2.3）：渲染依据是服务端返回的
 * type/mimeType（扩展名只决定分支入口）——位图须 binary + image/*（mimeType
 * 缺省按扩展名兜底）；svg 为 text 源码（服务端对 svg 不返 mimeType）。
 * 不满足返回 null → 回落文本/二进制占位分支。
 */
function imageSrcFor(
  path: string,
  cached: { content: string; binary?: boolean; mimeType?: string },
): string | null {
  const base = path.split("/").pop() ?? ""
  const ext = base.slice(base.lastIndexOf(".") + 1).toLowerCase()
  if (ext === "svg") {
    // <img> 中的 SVG 不执行脚本（规范行为），无需 html 预览那套沙箱
    if (cached.binary) return null
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cached.content)}`
  }
  if (!cached.binary) return null
  const mime =
    cached.mimeType && cached.mimeType.startsWith("image/")
      ? cached.mimeType
      : IMAGE_MIME_BY_EXT[ext]
  if (!mime) return null
  return `data:${mime};base64,${cached.content}`
}

/**
 * 滚轮缩放步进与边界（design-image-preview §2.4）。scale 相对原始尺寸（1 = 1:1），
 * 指数步进使滚轮手感对称（放大 1.22× 后再缩小 1/1.22× 回到原位）。
 */
export const IMAGE_MIN_SCALE = 0.05
export const IMAGE_MAX_SCALE = 16

/** deltaMode===1（Firefox 行模式）折算为像素量级 */
export function normalizeWheelDeltaY(deltaY: number, deltaMode: number): number {
  return deltaMode === 1 ? deltaY * 16 : deltaY
}

export function wheelScaleFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.002)
}

export function clampImageScale(scale: number): number {
  return Math.min(IMAGE_MAX_SCALE, Math.max(IMAGE_MIN_SCALE, scale))
}

/**
 * 图片预览体（design-image-preview §2.3/§2.4）：适应窗口（默认）↔ 滚轮连续缩放
 *（光标锚定）↔ 按住拖动平移 ↔ 点击快捷切换 适应/1:1。解码失败（img error 事件）
 * 落错误文案，内容重拉（src 变化）重置全部状态。不用 key 重置：src 是兆字节级
 * data URL，不宜作 React key。
 */
function ImagePreview({ src, title, zoomLabel, failedText }: {
  src: string
  title: string
  zoomLabel: string
  failedText: string
}) {
  // scale: null = 适应窗口（CSS max 约束）；数值 = 相对原始尺寸的缩放系数
  const [scale, setScale] = useState<number | null>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const scaleRef = useRef<number | null>(null)
  scaleRef.current = scale
  // 光标锚点：新尺寸落地后（[scale] layout effect）按实测位置换算滚动；
  // 点击切换则落地后滚动居中（新内容尺寸布局后才可算）
  const pendingAnchor = useRef<{
    fx: number
    fy: number
    clientX: number
    clientY: number
  } | null>(null)
  const pendingCenter = useRef(false)
  // 拖动判定：位移超阈值才算拖动，其后的 click 抑制（不误触缩放切换）
  const didDrag = useRef(false)
  const dragStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  useEffect(() => {
    setFailed(false)
    setScale(null)
    setNat(null)
    setDragging(false)
    didDrag.current = false
    dragStart.current = null
    pendingAnchor.current = null
    pendingCenter.current = false
  }, [src])

  // 滚轮监听须原生注册且 passive: false——React 根监听器对 wheel 是 passive，
  // preventDefault 无效，容器会跟着滚。
  // 挂在回调 ref 而非 useEffect：注册/清理与节点生命周期绑定（节点挂载即注册、
  // 卸载即清理），不依赖 effect 的调度时序与依赖数组。初次打开要经过
  // 加载态→预览体 的分支切换（容器节点由不同渲染路径先后产出），此前
  // useEffect([failed]) 一次性读取 ref 挂载，与节点实际生命周期脱钩——
  // 一旦监听不在当前可见节点上，滚轮就落回默认滚动而非缩放。
  const handleWheel = useCallback((ev: Event) => {
    // 本文件从 react 导入了 WheelEvent 类型（合成事件），原生类型须走 globalThis
    const e = ev as globalThis.WheelEvent
    const c = containerRef.current
    const img = imgRef.current
    if (!c || !img) return
    e.preventDefault()
    const natW = img.naturalWidth
    if (!natW) return
    const dy = normalizeWheelDeltaY(e.deltaY, e.deltaMode)
    const imgRect = img.getBoundingClientRect()
    // 适应窗口态起点 = 当前渲染宽 / 原始宽（直接量渲染结果，不重算容器几何）
    const cur = scaleRef.current ?? (imgRect.width / natW || 1)
    const next = clampImageScale(cur * wheelScaleFactor(dy))
    if (next === cur) return
    // 写穿 ref：wheel 是连续事件（React 19 非离散事件不逐事件刷新渲染），
    // 同一批渲染内到达的多个事件都从 scaleRef 取当前值，不回写则 N 刻塌缩为 1 步
    scaleRef.current = next
    // 锚点 = 光标在图内的分数位置 + 光标视口坐标，新布局落地后按实测换算
    // （不能按 ratio 匀缩内容坐标：按钮 16px 恒定 padding 不参与缩放，
    // 匀缩假设每刻漂移 16(ratio-1) 且复利累积；居中偏移同样被测量吸收）
    pendingAnchor.current = {
      fx: imgRect.width ? (e.clientX - imgRect.left) / imgRect.width : 0,
      fy: imgRect.height ? (e.clientY - imgRect.top) / imgRect.height : 0,
      clientX: e.clientX,
      clientY: e.clientY,
    }
    // 滚轮意图覆盖残留的点击居中意图（竞态下后者可能未被消费而滞留）
    pendingCenter.current = false
    setScale(next)
  }, [])
  const attachContainer = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node
      if (!node) return
      node.addEventListener("wheel", handleWheel, { passive: false })
      return () => node.removeEventListener("wheel", handleWheel)
    },
    [handleWheel],
  )

  // nat 竞态兜底：img 的 load 事件可能绕过 React onLoad（启动后首个图片 Tab
  // 实测复现：complete=true、naturalWidth 已就位而 nat 永远不落 → 缩放渲染门槛
  // 永不满足，滚轮 preventDefault 生效却无视觉变化；重开 Tab 时序变化才自愈）。
  // 不依赖 onLoad：任何一次渲染发现 img 已 complete 即补登记
  useLayoutEffect(() => {
    if (nat) return
    const img = imgRef.current
    // 与 onLoad 路径同口径：宽高都须就位（防退化 0 尺寸落地）
    if (img && img.complete && img.naturalWidth && img.naturalHeight) {
      setNat({ w: img.naturalWidth, h: img.naturalHeight })
    }
  })

  // 新尺寸落地后应用滚动：滚轮锚定优先，其次点击切换居中。
  // useLayoutEffect（绘制前）：避免每个滚轮刻先以旧滚动位置绘制一帧再跳变。
  // deps 带 nat 且以 nat 为消费门槛：竞态下首个滚轮刻 scale 先落、nat 未落，
  // 该帧还是适应窗口布局（无滚动余地）——此时不消费锚点，等 nat 落地重跑再对
  // 真实放大布局换算，否则首刻锚定失效（光标下的点跑到左上角）
  useLayoutEffect(() => {
    const c = containerRef.current
    const img = imgRef.current
    if (!c) return
    const p = pendingAnchor.current
    if (p && img) {
      if (!nat) return
      pendingAnchor.current = null
      // 新布局实测：光标下的图像点保持不动（padding/居中偏移被测量吸收）
      const imgRect = img.getBoundingClientRect()
      const cRect = c.getBoundingClientRect()
      c.scrollLeft =
        imgRect.left - cRect.left + c.scrollLeft + p.fx * imgRect.width - (p.clientX - cRect.left)
      c.scrollTop =
        imgRect.top - cRect.top + c.scrollTop + p.fy * imgRect.height - (p.clientY - cRect.top)
      return
    }
    if (pendingCenter.current) {
      if (!nat) return
      pendingCenter.current = false
      c.scrollLeft = Math.max(0, (c.scrollWidth - c.clientWidth) / 2)
      c.scrollTop = Math.max(0, (c.scrollHeight - c.clientHeight) / 2)
    }
  }, [scale, nat])

  if (failed)
    return (
      <div className="file-view image-view">
        <div className="file-state file-error">{failedText}</div>
      </div>
    )

  const zoomed = scale !== null
  // 显式尺寸（及解除 fit max 约束的 zoomed class）以 nat 落地为前提：Chromium
  // 头部嗅探使 naturalWidth 先于 load 事件可用，滚轮可能先设 scale——此时若已挂
  // zoomed class（max:none）而无显式尺寸，会以 1:1 原始尺寸闪一窗口期
  const sized = zoomed && nat !== null
  // 显式 width/height（不用 transform——其不参与布局，滚动容器拿不到放大后的
  // 滚动范围）；覆写 max 约束，否则适应窗口态的 100% 上限会压住放大尺寸
  const imgStyle = sized
    ? {
        width: `${nat!.w * scale}px`,
        height: `${nat!.h * scale}px`,
        maxWidth: "none",
        maxHeight: "none",
      }
    : undefined

  return (
    <div
      className="file-view image-view"
      ref={attachContainer}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const c = containerRef.current
        if (!c) return
        didDrag.current = false
        dragStart.current = { x: e.clientX, y: e.clientY, left: c.scrollLeft, top: c.scrollTop }
        try {
          c.setPointerCapture(e.pointerId)
        } catch {
          /* jsdom 等环境未实现指针捕获：move 仍走容器监听，功能不退化 */
        }
      }}
      onPointerMove={(e) => {
        const s = dragStart.current
        const c = containerRef.current
        if (!s || !c) return
        const dx = e.clientX - s.x
        const dy = e.clientY - s.y
        if (!didDrag.current && Math.hypot(dx, dy) > 3) {
          didDrag.current = true
          setDragging(true)
        }
        if (didDrag.current) {
          c.scrollLeft = s.left - dx
          c.scrollTop = s.top - dy
        }
      }}
      onPointerUp={(e) => {
        dragStart.current = null
        setDragging(false)
        const c = containerRef.current
        if (c?.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId)
      }}
      onPointerCancel={() => {
        dragStart.current = null
        setDragging(false)
      }}
      // 切换监听必须在容器上：setPointerCapture 把 pointerup 派生的 click 重定向
      // 到捕获元素（容器），button 自身的 onClick 在真实 Chromium 永不触发
      // （jsdom 不实现指针捕获、合成 click 直达目标，测试绕过了该行为）。
      // button 的键盘 click 冒泡到容器，两条路径在此统一
      onClick={() => {
        if (didDrag.current) {
          didDrag.current = false
          return
        }
        // 点击意图覆盖残留的滚轮锚点（竞态下后者可能未被消费而滞留）
        pendingAnchor.current = null
        pendingCenter.current = true
        setScale(zoomed ? null : 1)
      }}
    >
      <button
        type="button"
        className={"image-zoom" + (sized ? " zoomed" : "") + (dragging ? " dragging" : "")}
        aria-pressed={zoomed}
        aria-label={zoomLabel}
      >
        <img
          ref={imgRef}
          src={src}
          alt={title}
          draggable={false}
          style={imgStyle}
          onLoad={(e) => {
            const el = e.currentTarget
            if (el.naturalWidth && el.naturalHeight) {
              setNat({ w: el.naturalWidth, h: el.naturalHeight })
            }
          }}
          onError={() => setFailed(true)}
        />
      </button>
    </div>
  )
}

/**
 * 文件 Tab 视图。图片（design-image-preview）：img data URL 渲染 + 点击缩放，
 * 无工具条。预览文件（design-markdown-preview）：`.md`/`.markdown` 渲染
 * markdown（内容区动态宽度 [600, 800] 居中，TOC 悬浮窗挂内容区左侧）；
 * 模式/滚动/TOC 状态挂载时从 store 按路径恢复（切走保存、切回恢复，
 * design-tab-state-memory §2.2/§2.4），仅换文件（key 隔离重挂载无条目）回默认。
 * 其余文件（含 `.html`/`.htm`——预览已迁浏览器 Tab，design-browser-tab §1.4，
 * 此处恒源码态）走代码视图（行号+语法高亮，design-code-view）；
 * 非图二进制占位提示（不把 base64 当文本）。
 */
export function FileView({ absolutePath, revealLine }: { absolutePath: string; revealLine?: number }) {
  const store = useStore()
  const { t, locale } = useI18n()
  const cached = store.fileContents.get(absolutePath)
  const isMarkdown = isMarkdownPath(absolutePath)
  const isImage = isImagePath(absolutePath)
  const isPdf = isPdfPath(absolutePath)
  const previewable = isMarkdown
  // 文件视图状态记忆（design-tab-state-memory §2.2）：挂载从 store 恢复模式 +
  // 滚动偏移（一次性待恢复）；捕获 = 容器/CM 滚动上报 + 模式切换归零
  const savedView = store.fileViewStateFor(absolutePath)
  // 从 diff 跳转携带 revealLine 时强制源码模式（行锚定仅对 CodeView 有意义）
  const [mode, setMode] = useState<"preview" | "source">(
    revealLine != null ? "source" : savedView?.mode ?? "preview",
  )
  const fileScrollRef = useRef<HTMLDivElement>(null)
  const pendingScroll = useRef(savedView && savedView.top > 0 ? savedView.top : null)
  // TOC 大纲（design-markdown-preview §2.4）：预览体 DOM 扫描 h1–h6
  const mdRef = useRef<HTMLDivElement | null>(null)
  const [tocHeadings, setTocHeadings] = useState<TocHeading[]>([])
  // TOC 显隐 = 宽度默认态（宽显窄隐）+ 用户显式选择覆盖（工具条按钮）
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  // null = 未手动操作，随宽度默认；布尔 = 用户显式选择（不再随宽度回摆）。
  // 显式选择按文件记忆（design-tab-state-memory §2.4），挂载恢复
  const savedToc = store.tocStateFor(absolutePath)
  const [tocUserMode, setTocUserMode] = useState<boolean | null>(savedToc?.visible ?? null)
  // 章节折叠态由 FileView 持有：悬浮窗收起时 MdToc 卸载，折叠态跨显隐保留，
  // 仅内容更换（标题集合变化）时重置（§2.4）；另按文件记忆，切走再回恢复
  const [tocFolded, setTocFolded] = useState<ReadonlySet<HTMLElement>>(new Set())
  // 标题集首次落地恢复折叠记忆（文本标识匹配仍存活章节），其后标题集更换重置。
  // ref 记已初始化的标题数组：StrictMode 双跑/重复触发不得把恢复结果再重置
  const tocFoldInitFor = useRef<TocHeading[] | null>(null)
  useEffect(() => {
    if (tocFoldInitFor.current === tocHeadings) return
    if (tocHeadings.length === 0) {
      setTocFolded(new Set())
      return // 不消耗恢复机会：等真实标题落地（扫描可能晚于首帧）
    }
    const first = tocFoldInitFor.current === null
    tocFoldInitFor.current = tocHeadings
    if (first && savedToc && savedToc.folded.length > 0) {
      const texts = new Set(savedToc.folded)
      setTocFolded(new Set(tocHeadings.filter((h) => texts.has(h.text)).map((h) => h.el)))
    } else {
      setTocFolded(new Set())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocHeadings])
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    setPaneWidth(el.clientWidth) // 同步首测（RO 回调是异步的，否则窄屏先闪显一帧）
    const ro = new ResizeObserver(() => setPaneWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // 图片 data URL 是兆字节级拼接，同此决策：agent 流式期间 emit 频繁，
  // 不可每次渲染重建（store 订阅在 App 层，FileView 非 memo）
  const imageSrc = useMemo(
    () => (isImage && cached && !cached.error ? imageSrcFor(absolutePath, cached) : null),
    [isImage, absolutePath, cached?.content, cached?.binary, cached?.mimeType],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  )
  // front matter 拆分（design-markdown-preview §2.5）：O(行数) 扫描 + 卡片条目
  // 提取，同 htmlDoc/imageSrc 决策——SSE emit 重渲染不重复付出。null = 未检出
  const mdFrontMatter = useMemo(
    () => (isMarkdown && cached && !cached.error ? splitFrontMatter(cached.content) : null),
    [isMarkdown, cached?.content, cached?.error],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  )

  // 激活即重拉（缓存仅作首帧显示）
  useEffect(() => {
    void store.loadFileContent(absolutePath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absolutePath])

  // 标题扫描：预览体落地后收集；若渲染尚未完成（streamdown 内部延迟），
  // 观察 DOM 变更补扫一次。源码/加载/错误态无预览体 → 清空（TOC 不渲染）
  useEffect(() => {
    const el = mdRef.current
    if (!el) {
      setTocHeadings([])
      return
    }
    const first = collectHeadings(el)
    if (first.length > 0) {
      setTocHeadings(first)
      return
    }
    let scheduled = false
    const mo = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        const found = collectHeadings(el)
        if (found.length > 0) {
          setTocHeadings(found)
          mo.disconnect()
        }
      })
    })
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cached?.content, cached?.error])

  // 图片分支（design-image-preview §2.2）：扩展名决定入口，渲染按服务端
  // type/mimeType 兜底——不满足（如 .png 实为文本）继续走下方文本/二进制分支
  if (isImage) {
    if (!cached)
      return (
        <div className="file-view image-view">
          <div className="file-state">{t.loading}</div>
        </div>
      )
    if (cached.error) return <div className="file-view error">{cached.error}</div>
    // ImagePreview 自持滚动容器（滚轮锚定/拖动平移都要操作其 scroll 位置）
    if (imageSrc)
      return (
        <ImagePreview
          src={imageSrc}
          title={absolutePath.split("/").pop() ?? absolutePath}
          zoomLabel={t.imageZoomToggle}
          failedText={t.imageDecodeFailed}
        />
      )
  }

  // PDF 分支（design-pdf-preview §1 终态）：先经 /file/content 判可用性
  // （错误/非二进制走占位），渲染 = 专用 WebContentsView（PDFium 顶层接管）
  if (isPdf) {
    if (!cached) return <div className="file-view pdf-view">{t.loading}</div>
    if (cached.error) return <div className="file-view error">{cached.error}</div>
    if (!cached.binary)
      return (
        <div className="file-view pdf-view">
          <div className="file-state file-binary">{t.binaryUnsupported}</div>
        </div>
      )
    return <PdfFrameView tabKey={`file:${absolutePath}`} absolutePath={absolutePath} />
  }


  // 滚动偏移一次性恢复（§2.2）：预览 = 内容落地后设滚动层；源码 = 经
  // CodeView initialScrollTop prop 在同 commit 消费（rAF 布局落定后应用）。
  // 内容未落地（loading/error）→ 等待，不清待恢复标记
  useLayoutEffect(() => {
    if (pendingScroll.current == null) return
    if (!cached || cached.error) return
    if (mode === "preview") {
      const el = fileScrollRef.current
      if (el) el.scrollTop = pendingScroll.current
    }
    pendingScroll.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cached?.content, cached?.error])

  if (!previewable) {
    if (!cached) return <div className="file-view">{t.loading}</div>
    if (cached.error) return <div className="file-view error">{cached.error}</div>
    // 非图二进制：占位提示，不把 base64 当文本灌进代码视图（design-image-preview §2.5）
    if (cached.binary)
      return (
        <div className="file-view">
          <div className="file-state file-binary">{t.binaryUnsupported}</div>
        </div>
      )
    return (
      <div className="file-view code-view">
        {/* key 并入 locale：搜索面板短语随语言设置即时重建（CM phrases 是创建期 facet） */}
        <CodeView
          key={locale}
          path={absolutePath}
          content={cached.content}
          locale={locale}
          initialScrollTop={pendingScroll.current ?? undefined}
          revealLine={revealLine}
          onScrollTop={(top) => store.setFileViewState(absolutePath, { mode: "source", top })}
        />
      </div>
    )
  }

  // md/html 被嗅探为二进制（内容含 NUL 等）：预览/源码两态都是同一占位，
  // 工具条无意义，直接占位返回
  if (cached && !cached.error && cached.binary)
    return (
      <div className="file-view">
        <div className="file-state file-binary">{t.binaryUnsupported}</div>
      </div>
    )

  // TOC 可用 = markdown 且已扫出标题（加载/错误/源码态标题被清空，天然为 false）；
  // 悬浮窗可能遮挡内容区 → 默认收起（工具条按钮可显式展开，悬浮覆盖内容区）
  const hasToc = isMarkdown && tocHeadings.length > 0
  const tocOccluded = tocOccludesContent(paneWidth)
  const tocVisible = hasToc && (tocUserMode ?? !tocOccluded)

  // 预览文件：工具条常驻（loading/error 也渲染）——避免内容落地/重试成功时
  // 工具条弹入造成 ~32px 布局跳动
  const view = (
    // onScroll 捕获仅预览态有效：源码态 CM 内滚（经 CodeView onScrollTop 上报），
    // html 沙箱 iframe 容器 overflow:hidden 不滚——捕获写入不 emit（§2.2）
    <div
      className="file-view code-view"
      ref={fileScrollRef}
      onScroll={(e) => store.setFileViewState(absolutePath, { mode, top: e.currentTarget.scrollTop })}
    >
      {!cached && <div className="file-state">{t.loading}</div>}
      {cached?.error && <div className="file-state file-error">{cached.error}</div>}
      {cached && !cached.error && mode === "preview" && isMarkdown && (
        // 内容区动态宽度 [600, 800] 相对全窗居中（§2.4）；滚动层全宽 →
        // 滚动条贴窗口右缘；TOC 悬浮窗在滚动层之外（.file-view-wrap 绝对定位）
        <div className="file-md" ref={mdRef}>
          {/* front matter 元数据卡（§2.5）：仅顶层标量条目成卡；纯嵌套容器时
              无卡但正文仍已剥离；卡在 markdown-body 之外（不受 vendor 排版） */}
          {mdFrontMatter?.frontMatter && (
            <dl className="md-frontmatter">
              {mdFrontMatter.frontMatter.map((e, idx) => (
                <Fragment key={`${e.key}:${idx}`}>
                  <dt className="md-fm-key">{e.key}</dt>
                  <dd className="md-fm-val">{e.value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          <Markdown>{mdFrontMatter ? mdFrontMatter.body : cached.content}</Markdown>
        </div>
      )}
      {cached && !cached.error && mode === "source" && (
        <CodeView
          key={locale}
          path={absolutePath}
          content={cached.content}
          locale={locale}
          initialScrollTop={pendingScroll.current ?? undefined}
          revealLine={revealLine}
          onScrollTop={(top) => store.setFileViewState(absolutePath, { mode: "source", top })}
        />
      )}
    </div>
  )

  return (
    <div className="file-view-wrap" ref={wrapRef}>
      <div className="file-toolbar">
        {hasToc && (
          <button
            type="button"
            className="icon-btn file-toolbar-toc"
            title={tocVisible ? t.tocCollapse : t.tocExpand}
            aria-label={tocVisible ? t.tocCollapse : t.tocExpand}
            aria-pressed={tocVisible}
            onClick={() => {
              const next = !tocVisible
              setTocUserMode(next)
              // 显式选择落 store（切走再回恢复，§2.4）
              store.setTocVisible(absolutePath, next)
            }}
          >
            <ListTree size={16} aria-hidden />
          </button>
        )}
        <div className="ms-segmented" role="group" aria-label={t.viewModeLabel}>
          <button
            type="button"
            aria-pressed={mode === "preview"}
            className={"ms-seg" + (mode === "preview" ? " active" : "")}
            onClick={() => {
              setMode("preview")
              // 模式切换归零偏移：非激活模式偏移不保留（两模式坐标系不可换算，§2.2）。
              // 待恢复偏移同弃——内容未落地时切换，残留值会在落地后错灌入新模式
              pendingScroll.current = null
              store.setFileViewState(absolutePath, { mode: "preview", top: 0 })
            }}
          >
            {t.previewMode}
          </button>
          <button
            type="button"
            aria-pressed={mode === "source"}
            className={"ms-seg" + (mode === "source" ? " active" : "")}
            onClick={() => {
              setMode("source")
              // 同预览钮：待恢复偏移同弃（防内容未落地时切换、落地后错灌旧偏移）
              pendingScroll.current = null
              store.setFileViewState(absolutePath, { mode: "source", top: 0 })
            }}
          >
            {t.sourceMode}
          </button>
        </div>
      </div>
      {view}
      {/* TOC 悬浮窗：滚动层之外绝对定位（常驻可见），遮挡内容区时默认收起（§2.4） */}
      {tocVisible && (
        <MdToc
          headings={tocHeadings}
          folded={tocFolded}
          onFold={(el) => {
            const next = new Set(tocFolded)
            if (next.has(el)) next.delete(el)
            else next.add(el)
            setTocFolded(next)
            // 折叠态落 store（文本标识，切走再回恢复，§2.4）
            store.setTocFolded(
              absolutePath,
              tocHeadings.filter((h) => next.has(h.el)).map((h) => h.text),
            )
          }}
        />
      )}
    </div>
  )
}

import { SettingsDialog } from "./settings-dialog"
