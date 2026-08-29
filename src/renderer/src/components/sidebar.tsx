import { useEffect, useRef, useState, type CSSProperties } from "react"
import { FolderGit2, FolderPlus, LoaderCircle, Plus, Settings, Trash2, TriangleAlert, X } from "lucide-react"
import { useI18n, useStore } from "../app"
import { ConfirmDialog } from "./confirm-dialog"
import { relativeTime } from "../i18n"
import { GLOBAL_PROJECT_ID, globalEntryKey } from "@shared/project-entries"
import type { Project, Session } from "@shared/api-types"
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

  const title = [store.activeProfile?.name, store.baseUrl, store.connectionError]
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
 */
function ProjectTree() {
  const store = useStore()
  const { t } = useI18n()
  const [pendingDelete, setPendingDelete] = useState<{
    directory: string
    projectId: string
  } | null>(null)

  const entries = store.openedEntries
  const current = store.currentProject

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

      <div className="tree scroll">
        {entries.map((e) => {
          // global 按目录拆行：作用域 = 该目录本身；普通项目行 = 主工作区入口
          const isActive = store.isEntryActive(e.key)
          const isCurrentProject = e.project.id === current?.id
          const workspaces = e.isGlobal ? [] : store.workspacesOfProject(e.project.id)
          return (
            <div key={e.key} className="project-group">
              <div
                className={"tree-row project-row" + (isActive ? " active" : "")}
                onClick={() => selectEntry(e.key)}
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
      </div>
    </div>
  )
}
