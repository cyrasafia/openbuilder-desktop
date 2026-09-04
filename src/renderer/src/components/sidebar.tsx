import { useEffect, useRef, useState, type CSSProperties } from "react"
import { FolderGit2, FolderPlus, LoaderCircle, Plus, Settings, Trash2, TriangleAlert, X } from "lucide-react"
import { useI18n, useStore } from "../app"
import { ConfirmDialog } from "./confirm-dialog"
import { relativeTime } from "../i18n"
import { GLOBAL_PROJECT_ID, globalEntryKey } from "@shared/project-entries"
import type { Project, Session } from "@shared/api-types"
import { MIN_SERVER_VERSION } from "@shared/semver"
import { managedNoticeText } from "./managed-notice"
import { PanelResizeHandle } from "./panel-resize"

/** server icon.color 命名色 → --avatar-* token（与 openbuilder ProjectAvatar.namedColor 同源，mint 与 green 同色） */
const NAMED_AVATAR_COLORS: Record<string, string> = {
  mint: "var(--avatar-green)",
  green: "var(--avatar-green)",
  pink: "var(--avatar-pink)",
  blue: "var(--avatar-blue)",
  orange: "var(--avatar-orange)",
  purple: "var(--avatar-purple)",
  yellow: "var(--avatar-yellow)",
  red: "var(--avatar-red)",
  cyan: "var(--avatar-cyan)",
}

/** 哈希回退调色板（openbuilder _palette 同源同序，9 色不含 red），保证同名项目跨端同色 */
const AVATAR_PALETTE = [
  "var(--avatar-green)",
  "var(--avatar-blue)",
  "var(--avatar-orange)",
  "var(--avatar-purple)",
  "var(--avatar-pink)",
  "var(--avatar-mint)",
  "var(--avatar-yellow)",
  "var(--avatar-cyan)",
  "var(--avatar-violet)",
]

function avatarColor(name: string, named?: string): string {
  const hit = named ? NAMED_AVATAR_COLORS[named] : undefined
  if (hit) return hit
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!
}

/** 图片源白名单（openbuilder 同款）：仅 data:/http(s):，其余 scheme 忽略走首字母 */
function avatarImageSrc(icon?: Project["icon"]): string | undefined {
  const src = icon?.override || icon?.url
  if (!src) return undefined
  return src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://") ? src : undefined
}

/**
 * 项目头像（参考 openbuilder ProjectAvatar，按桌面密度缩至 26px）：
 * 图片（`icon.override` > `icon.url`，data:/https:）覆盖于瓷片上，加载失败回退；
 * 无图 = 项目名首字母；色 = `icon.color` 命名色，缺失按名哈希（与移动端同色）。
 * 色框/淡染底仅字母瓷片有（同移动端 foregroundDecoration 仅 img==null），图片态裸图。
 */
function ProjectAvatar({ name, icon }: { name: string; icon?: Project["icon"] }) {
  const imgSrc = avatarImageSrc(icon)
  return (
    <span
      className={"project-avatar" + (imgSrc ? " has-img" : "")}
      style={{ "--avatar-color": avatarColor(name, icon?.color) } as CSSProperties}
      aria-hidden
    >
      {imgSrc && (
        <img
          className="project-avatar-img"
          src={imgSrc}
          alt=""
          onError={(e) => {
            // 失败回退字母瓷片：藏图并撤 has-img，恢复色框/淡染底
            const img = e.currentTarget
            img.style.display = "none"
            img.parentElement?.classList.remove("has-img")
          }}
        />
      )}
      {(Array.from(name.trim())[0] ?? "?").toUpperCase()}
    </span>
  )
}

export function Sidebar() {
  const store = useStore()
  const { t } = useI18n()

  return (
    // 折叠 = display:none（design-layout-collapse §2.3）：组件仍挂载，文件树状态不因收起丢失
    <aside className={"sidebar" + (store.layoutLeftCollapsed ? " collapsed" : "")}>
      {store.activeProfile ? (
        <ProjectTree />
      ) : (
        <div className="sidebar-empty">
          <p>{t.connectFirst}</p>
          <button className="btn-primary" onClick={() => store.openSettings()}>
            {t.openSettings}
          </button>
        </div>
      )}

      {/* 服务器状态 + 设置行：置底常驻，不随项目区状态变化 */}
      <div className="sidebar-footer">
        <ServerStatus />
        <button className="icon-btn" title={t.settings} onClick={() => store.openSettings()}>
          <Settings size={12} aria-hidden />
        </button>
      </div>
      {/* 内缘调宽手柄（折叠时随面板 display:none 一并消失） */}
      {!store.layoutLeftCollapsed && <PanelResizeHandle side="left" />}
    </aside>
  )
}

/**
 * 服务器连接状态（左栏底部，与设置同行）：SSE/对账状态点 + 文案，点击打开设置；
 * connectionError 以 TriangleAlert 内联 + 悬浮提示可见。服务器版本不再展示。
 */
function ServerStatus() {
  const store = useStore()
  const { t } = useI18n()

  const state = store.reconciling
    ? "reconciling"
    : store.connectionState === "streaming"
      ? "streaming"
      : store.connectionState === "degraded"
        ? "degraded"
        : store.connectionState === "connecting"
          ? "degraded"
          : "offline"

  const label =
    state === "reconciling"
      ? t.statusReconciling
      : state === "streaming"
        ? t.statusStreaming
        : state === "degraded"
          ? t.statusDegraded
          : t.statusOffline

  const dotClass =
    state === "streaming" || state === "reconciling"
      ? "running"
      : state === "degraded"
        ? "pending"
        : "error"

  const title = [
    store.activeProfile?.name,
    store.baseUrl,
    store.connectionError,
    // 版本下限提示与 managed 崩溃重启提示（design-managed-config §2/§3.2）
    store.serverVersionWarning
      ? t.serverVersionWarn
          .replace("{version}", store.serverVersionWarning.version)
          .replace(/\{min\}/g, MIN_SERVER_VERSION)
      : null,
    store.managedNotice ? managedNoticeText(store.managedNotice, t) : null,
  ]
    .filter(Boolean)
    .join("\n")

  return (
    <button className="status-cluster" title={title} onClick={() => store.openSettings()}>
      <span className={"status-dot " + dotClass + (state === "reconciling" ? " blink" : "")} />
      <span>{label}</span>
      {store.connectionError && <TriangleAlert className="status-error" size={12} aria-hidden />}
    </button>
  )
}

/**
 * 项目/工作区两级树（有活跃 profile 时的左栏主体）。
 * global 项目按 directory 拆为 N 个顶级 entry 行（design-layout §3）：行视觉与
 * 普通项目行一致（头像 + 名称/路径两行），无子行（global 非 git 无 worktree）。
 * 项目行可拖拽排序（行序 = 打开序，松手按预览 DOM 序调 store.applyEntryOrder
 * 整体重排；实时预览式——拖动中列表即时重排、拖拽项在目标位渲染占位样式；
 * worktree 行不入拖拽、随项目组移动；global 目录行与普通项目行平权参与）。
 */
function ProjectTree() {
  const store = useStore()
  const { t } = useI18n()
  const [pendingDelete, setPendingDelete] = useState<{
    directory: string
    projectId: string
  } | null>(null)
  // 项目行拖拽排序（design-layout §3）：实时预览式——dragKey = 拖拽中的 entry 键，
  // dragSlot = 目标插入位（以"移除拖拽项后的数组"为坐标系，0..base.length）。
  // 拖动中列表即时重排：拖拽项在目标位渲染占位样式，源位间隙闭合。提交挂
  // dragend（源元素上恒触发——drop 只在松手于合法落区内才发，左栏外/快速
  // 拖动越界松手时浏览器直接取消只发 dragend），按松手时预览 DOM 序整体重排。
  // 注：原生拖拽期间页面收不到键盘事件（Chromium 嵌套拖拽循环吞掉输入），
  // Esc 原生取消与栏外松手在 dragend 层不可区分，故取消语义同样提交预览序。
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragSlot, setDragSlot] = useState<number | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const endDrag = () => {
    setDragKey(null)
    setDragSlot(null)
  }
  /** dragend 提交：按松手时预览 DOM 序整体重排（所见即所得）——读 tree 容器
   *  内 .project-group 的 data-entry-key 顺序调 applyEntryOrder，不经 slot 换算。 */
  const handleDragEnd = () => {
    if (treeRef.current) {
      const keys = [...treeRef.current.querySelectorAll<HTMLElement>(".project-group")]
        .map((el) => el.dataset.entryKey)
        .filter((k): k is string => k != null)
      if (keys.length > 0) store.applyEntryOrder(keys)
    }
    endDrag()
  }

  const entries = store.openedEntries
  const current = store.currentProject

  // 预览序：base = 移除拖拽项；slot 缺省 = 原位（dragIdx 在 base 中即原位）
  const dragIdx = dragKey ? entries.findIndex((e) => e.key === dragKey) : -1
  const base = dragIdx >= 0 ? entries.filter((_, i) => i !== dragIdx) : entries
  const slot = dragKey && dragSlot != null ? Math.max(0, Math.min(dragSlot, base.length)) : dragIdx
  const previewEntries =
    dragKey && dragIdx >= 0 && slot >= 0 && slot !== dragIdx
      ? [...base.slice(0, slot), entries[dragIdx]!, ...base.slice(slot)]
      : entries

  /** 选 entry 行（普通项目 = 主工作区入口，worktree 态点击 = 回主工作区——
   *  openProject 内含切回；global = 该目录作用域，openGlobalDirectory 先切换后加载） */
  const selectEntry = (key: string) => {
    if (store.isEntryActive(key)) return
    void store.openEntry(key)
  }

  /** 选工作区（项目内 worktree）；跨项目点击 = 开项目并直达该工作区（单次切换） */
  const selectWorkspace = (projectId: string, directory: string) => {
    if (projectId === current?.id) {
      if (store.currentWorkspace?.directory !== directory) void store.setCurrentWorkspace(directory)
      return
    }
    void store.setCurrentProject(projectId, directory)
  }

  return (
    <>
      <div className="sidebar-heading">
        <span>{t.projectsTitle}</span>
        <button
          className="icon-btn"
          title={t.openProject}
          onClick={() => store.openProjectPicker()}
        >
          <Plus size={12} aria-hidden />
        </button>
      </div>

      <div
        ref={treeRef}
        className="tree scroll"
        onDragOver={(ev) => {
          if (!dragKey) return
          // 容器整体为合法落区（含 worktree 行/行间空隙/列表空白/占位行）：
          // dragover preventDefault 让预览插入位在整个列表区域连续生效。
          // 插入位按光标 Y 几何计算（边缘带判定）：光标落入某行的上/下 25%
          // 区域 = 换位（插其前/后），中间 50% 滞回带保持当前插入位——
          // 相比中线判定（50% 行程才翻转）换位行程减半，滞回带防抖。
          // 光标不在任何行内（行间空隙）= 最近边界；末行以下全部区域 = 末位；
          // 占位行跳过 = 悬停占位维持当前插入位。同值保留旧引用，React bail out
          ev.preventDefault()
          ev.dataTransfer.dropEffect = "move"
          const EDGE_BAND = 0.25
          const rows = ev.currentTarget.querySelectorAll<HTMLElement>(".tree-row.project-row")
          // next = null 且命中过行（hit）= 中带/悬停占位：维持当前插入位不动；
          // 未命中任何行 = 光标在末行以下全部区域：末位
          let next: number | null = null
          let hit = false
          for (let i = 0; i < rows.length; i++) {
            const rect = rows[i]!.getBoundingClientRect()
            if (previewEntries[i]?.key === dragKey) {
              // 悬停占位行 = 维持当前插入位
              if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) hit = true
              continue
            }
            if (ev.clientY < rect.top) {
              // 行间空隙/首行上方：最近边界 = 插到该行前
              next = i < slot ? i : i - 1
              hit = true
              break
            }
            if (ev.clientY <= rect.bottom) {
              hit = true
              const baseIdx = i < slot ? i : i - 1
              if (ev.clientY < rect.top + rect.height * EDGE_BAND) next = baseIdx
              else if (ev.clientY > rect.bottom - rect.height * EDGE_BAND) next = baseIdx + 1
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
        {previewEntries.map((e) => {
          // global 按目录拆行：作用域 = 该目录本身；普通项目行 = 主工作区入口
          const isActive = store.isEntryActive(e.key)
          const isCurrentProject = e.project.id === current?.id
          const workspaces = e.isGlobal ? [] : store.workspacesOfProject(e.project.id)
          return (
            <div key={e.key} className="project-group" data-entry-key={e.key}>
              <div
                className={
                  "tree-row project-row" +
                  (isActive ? " active" : "") +
                  (e.key === dragKey ? " dragging" : "")
                }
                draggable
                onClick={() => selectEntry(e.key)}
                onDragStart={(ev) => {
                  setDragKey(e.key)
                  setDragSlot(null)
                  // 自定义 MIME：内部键不以 text/plain 外泄（同 Tab 条拖拽约定）
                  ev.dataTransfer.setData("application/x-openbuilder-entry", e.key)
                  ev.dataTransfer.effectAllowed = "move"
                }}
                onDragEnd={handleDragEnd}
              >
                <ProjectAvatar name={e.name} icon={e.project.icon} />
                <span className="project-main" title={e.directory}>
                  <span className="project-name">{e.name}</span>
                  <span className="project-path">{e.directory}</span>
                </span>
                {/* 指示器行内流式（名称/路径行尾），文本提前省略不与其重叠 */}
                <SessionIndicator sessions={store.sessionsInDirectory(e.project.id, e.directory)} />
                {/* 操作按钮 = 单个绝对定位带背景 overlay（hover 全行显示），不占行内流式空间，
                    名称/路径不再被隐藏按钮截断。工作区新增仅普通项目（global 非 git，无
                    worktree），非当前项目点击不切当前项目、仅在其下创建 worktree
                    （createWorkspace 接 projectId）；关闭按钮任意已打开项目/global 目录均可
                    （closeEntry 按 key 工作，纯客户端状态，无副作用），单项目时无意义隐藏。
                    2026-08-25 修订：原 global 仅激活态、普通项目仅当前项目可关，hover 不一致 */}
                {(!e.isGlobal || entries.length > 1) && (
                  <div className="row-actions">
                    {!e.isGlobal && (
                      <button
                        className="icon-btn row-action"
                        title={t.newWorkspace}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          // 不弹窗：name 省略，由 server 生成随机 slug
                          void store.createWorkspace(e.project.id)
                        }}
                      >
                        <FolderPlus size={16} aria-hidden />
                      </button>
                    )}
                    {entries.length > 1 && (
                      <button
                        className="icon-btn row-action"
                        title={t.closeProject}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          void store.closeEntry(e.key)
                        }}
                      >
                        <X size={16} aria-hidden />
                      </button>
                    )}
                  </div>
                )}
              </div>
              {/* 工作区跟随项目，全部展示（仅当前项目可新增/删除；global 无子行） */}
              {workspaces.map((w) => {
                // 删除中（非阻塞删除，design-layout §工作区行）：整行禁用样式、
                // 不可点击，右缘 loading 常显（替代 hover 才显的删除钮/指示点）
                const deleting = store.isWorkspaceDeleting(e.project.id, w.directory)
                return (
                  <div
                    key={w.directory}
                    className={
                      "tree-row ws-row" +
                      (deleting ? " deleting" : "") +
                      (isCurrentProject && store.currentWorkspace?.directory === w.directory ? " active" : "")
                    }
                    onClick={() => {
                      if (deleting) return
                      selectWorkspace(e.project.id, w.directory)
                    }}
                  >
                    <FolderGit2 className="ws-icon" size={16} aria-hidden />
                    <span className="tree-label" title={w.directory}>
                      {w.name}
                    </span>
                    {deleting ? (
                      <LoaderCircle className="typing-spinner ws-deleting" size={14} aria-label={t.deletingWorkspace} />
                    ) : (
                      <>
                        {/* 指示器行内流式（label 行尾），文本提前省略不与其重叠 */}
                        <SessionIndicator sessions={store.sessionsInDirectory(e.project.id, w.directory)} />
                        {/* 删除按钮 = 绝对定位带背景 overlay（hover 全行显示），不占行内流式
                            空间；非当前项目点击不切当前项目、仅删除该 worktree 并清理其
                            项目会话/Tab/记忆（removeWorkspace 接 projectId） */}
                        <div className="row-actions">
                          <button
                            className="icon-btn row-action"
                            title={t.deleteWorkspace}
                            onClick={(ev) => {
                              ev.stopPropagation()
                              setPendingDelete({ directory: w.directory, projectId: e.project.id })
                            }}
                          >
                            <Trash2 size={16} aria-hidden />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {store.pickerOpen && <ProjectPicker onClose={() => store.closeProjectPicker()} />}

      {pendingDelete && (
        <ConfirmDialog
          title={t.confirmDeleteWorkspace}
          message={t.confirmDeleteWorkspaceMsg}
          confirmLabel={t.confirm}
          cancelLabel={t.cancel}
          danger
          onConfirm={() => {
            // 非阻塞删除（design-layout §工作区行）：弹窗即关，删除态由
            // store.deletingWorkspaces 驱动左栏行禁用/loading，完成或失败
            // 复位由 removeWorkspace finally 兜底
            void store.removeWorkspace(pendingDelete.directory, pendingDelete.projectId)
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </>
  )
}

/**
 * 会话状态指示器（项目/工作区行右侧）：该作用域未归档、非 subagent 会话的状态。
 * 状态投影同移动端 design-agent-status-indicator + design-error-message §3：
 * waiting（待输入，琥珀静态）优先于 error（retry 退避重试，红光晕呼吸）优先于
 * running（busy 运行绿光晕呼吸）——消费 dotStateFor，sessionStatus 单一事实源；
 * 会话点统一 session-* 变体类（12px 盒几何与其他指示对齐）。
 * ≤4 个逐会话状态点；>4 个按状态聚合为数字 chip（待输入琥珀、重试红、运行绿、
 * 空闲灰 chip，各自为 0 时省略）。行内流式元素（名称/路径行尾，flex-shrink:0），
 * 文本在其前省略不重叠；行 hover 时隐藏（visibility 保占位）让位给操作 overlay。
 */
function SessionIndicator({ sessions }: { sessions: Session[] }) {
  const store = useStore()
  const { t } = useI18n()
  if (sessions.length === 0) return null
  let busyCount = 0
  let waitingCount = 0
  let errorCount = 0
  let failedCount = 0
  const dots = sessions.map((s) => store.dotStateFor(s.id))
  for (const d of dots) {
    if (d === "waiting") waitingCount++
    else if (d === "error") errorCount++
    else if (d === "failed") failedCount++
    else if (d === "running") busyCount++
  }
  const idleCount = sessions.length - busyCount - waitingCount - errorCount - failedCount
  const title = t.sessionIndicatorTitle
    .replace("{count}", String(sessions.length))
    .replace("{busy}", String(busyCount))
    .replace("{error}", String(errorCount))
    .replace("{failed}", String(failedCount))
    .replace("{waiting}", String(waitingCount))
  return (
    <span className="session-indicator" title={title}>
      {sessions.length > 4 ? (
        <>
          {waitingCount > 0 && <span className="session-count waiting">{waitingCount}</span>}
          {errorCount > 0 && <span className="session-count error">{errorCount}</span>}
          {busyCount > 0 && <span className="session-count running">{busyCount}</span>}
          {failedCount > 0 && <span className="session-count failed">{failedCount}</span>}
          {idleCount > 0 && <span className="session-count">{idleCount}</span>}
        </>
      ) : (
        sessions.map((s, i) => (
          <span
            key={s.id}
            className={
              "status-dot " +
              (dots[i] === "running"
                ? "session-running"
                : dots[i] === "error"
                  ? "session-error"
                  : dots[i] === "waiting"
                    ? "session-waiting"
                    : dots[i] === "failed"
                      ? "session-failed"
                      : "session-idle")
            }
          />
        ))
      )}
    </span>
  )
}

interface PickerCandidate {
  key: string
  name: string
  path: string
  updated: number
  icon?: Project["icon"]
}

function ProjectPicker({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const { t, locale } = useI18n()
  const [query, setQuery] = useState("")
  const [sel, setSel] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 新建项目流（design-new-project）：系统目录选择器 busy/错误态——错误内联不关弹窗可重试
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // 在途创建的中止器（评审 R3）：弹窗被 Escape/遮罩关闭（卸载）即 abort，
  // 在途 resolve 完成后不再打开/切换作用域
  const createAbortRef = useRef<AbortController | null>(null)
  useEffect(() => () => createAbortRef.current?.abort(), [])

  // 打开即刷新 global 发现快照：新 global 目录的首个会话事件被事件闸门丢弃
  // （entry 未打开），只能靠 scope=project 全量快照发现（openbuilder 同源结论）
  useEffect(() => {
    void store.refreshGlobalSessions()
    searchRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const opened = new Set(store.openedEntries.map((e) => e.key))
  const candidates: PickerCandidate[] = [
    ...store.projects
      .filter((p) => p.id !== GLOBAL_PROJECT_ID && !opened.has(p.id))
      .map((p) => ({
        key: p.id,
        name: p.name || p.worktree.split("/").pop() || p.id,
        path: p.worktree,
        updated: p.time.updated,
        icon: p.icon,
      })),
    ...store
      .globalDirectoryRows()
      .filter((r) => !opened.has(globalEntryKey(r.directory)))
      .map((r) => ({ key: globalEntryKey(r.directory), name: r.name, path: r.directory, updated: r.updated })),
  ].sort((a, b) => b.updated - a.updated)

  const kw = query.trim().toLowerCase()
  const visible = kw
    ? candidates.filter((c) => c.name.toLowerCase().includes(kw) || c.path.toLowerCase().includes(kw))
    : candidates
  const selClamped = Math.min(sel, Math.max(0, visible.length - 1))

  // 选中行可见（键盘 ↑↓）；scrollIntoView 在 jsdom 缺失——可选调用（open-with-dialog 同例）
  useEffect(() => {
    listRef.current?.querySelectorAll<HTMLElement>(".project-row")[selClamped]?.scrollIntoView?.({
      block: "nearest",
    })
  }, [selClamped, visible.length])

  /** 新建项目（design-new-project §4.3）：系统文件管理器选文件夹 → 注册/解析 → 直接打开。
   *  取消（null）= 无操作留在选择器；失败错误内联，弹窗不关可重试；成功关弹窗。
   *  弹窗在途被关闭 → abort，各 await 之间检查后静默返回（评审 R3） */
  const createProject = async () => {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    const ac = new AbortController()
    createAbortRef.current = ac
    try {
      const dir = await window.desktop.openPathPicker()
      if (!dir || ac.signal.aborted) return
      await store.createProjectFromDirectory(dir, ac.signal)
      if (!ac.signal.aborted) onClose()
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
      if (createAbortRef.current === ac) createAbortRef.current = null
    }
  }

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div
        className="dialog dialog-project"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // dialog 层 Escape（输入框 keydown 冒泡至此也覆盖）；
          // IME 组合中的 Escape 是取消候选词，不能顺手关弹窗
          if (e.nativeEvent.isComposing) return
          if (e.key === "Escape") onClose()
        }}
      >
        <div className="dialog-title dialog-title-row">
          <span>{t.openProject}</span>
          <button className="icon-btn" title={t.close} onClick={onClose}>
            <X size={14} aria-hidden />
          </button>
        </div>
        <input
          ref={searchRef}
          className="dialog-search"
          placeholder={t.projectSearchPlaceholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            // IME 组合中的 Enter（fcitx5 确认候选词）不上屏误开项目，
            // 守卫惯例对齐 workspace.tsx / shortcuts.ts；Escape 由 dialog 层处理
            if (e.nativeEvent.isComposing) return
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              const len = visible.length
              if (len === 0) return
              setSel(e.key === "ArrowDown" ? (selClamped + 1) % len : (selClamped - 1 + len) % len)
            } else if (e.key === "Enter") {
              e.preventDefault()
              const pick = visible[selClamped]
              if (pick) {
                void store.openEntry(pick.key)
                onClose()
              }
            }
          }}
        />
        <div className="dialog-body scroll" ref={listRef}>
          {visible.length === 0 && (
            <div className="tree-empty">{candidates.length === 0 ? t.empty : t.noProjectMatch}</div>
          )}
          {visible.map((c, i) => (
            <div
              key={c.key}
              className={"tree-row project-row" + (i === selClamped ? " selected" : "")}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                void store.openEntry(c.key)
                onClose()
              }}
            >
              <ProjectAvatar name={c.name} icon={c.icon} />
              <span className="project-main" title={c.path}>
                <span className="project-name">{c.name}</span>
                <span className="project-path">{c.path}</span>
              </span>
              <span className="tree-meta">{relativeTime(locale, c.updated)}</span>
            </div>
          ))}
        </div>

        {/* 新建项目动作行（design-new-project §4.3）：错误左对齐内联，右侧动作钮。
            不进搜索框键盘流（↑↓/Enter 只作用于候选列表），Tab 可达 */}
        <div className="dialog-footer">
          {createError && (
            <span className="dialog-footer-error" title={createError}>
              {createError}
            </span>
          )}
          <button className="btn-tonal btn-new-project" disabled={creating} onClick={() => void createProject()}>
            {creating ? (
              <LoaderCircle className="typing-spinner" size={14} aria-hidden />
            ) : (
              <FolderPlus size={14} aria-hidden />
            )}
            <span>{creating ? t.newProjectCreating : t.newProject}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
