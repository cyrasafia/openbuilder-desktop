import { useState } from "react"
import { FolderGit2 } from "lucide-react"
import { useI18n, useStore } from "../app"
import { relativeTime } from "../i18n"
import type { Session } from "@shared/api-types"

export function Sidebar() {
  const store = useStore()
  const { t } = useI18n()

  return (
    <aside className="sidebar">
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
          ⚙
        </button>
      </div>
    </aside>
  )
}

/**
 * 服务器连接状态（左栏底部，与设置同行）：SSE/对账状态点 + 文案，点击打开设置；
 * connectionError 以 ⚠ 内联 + 悬浮提示可见。服务器版本不再展示。
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
      {store.connectionError && <span className="status-error">⚠</span>}
    </button>
  )
}

/** 项目/工作区两级树（有活跃 profile 时的左栏主体） */
function ProjectTree() {
  const store = useStore()
  const { t } = useI18n()
  const [pickerOpen, setPickerOpen] = useState(false)

  const projects = store.openedProjects
  const current = store.currentProject

  /** 选项目 = 选主工作区（openProject 内含切回主工作区，先切换后加载） */
  const selectProjectMain = (projectId: string) => {
    if (projectId === current?.id && !store.currentWorkspace) return
    void store.setCurrentProject(projectId)
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
          onClick={() => setPickerOpen(true)}
        >
          +
        </button>
      </div>

      <div className="tree scroll">
        {projects.map((p) => {
          const isCurrent = p.id === current?.id
          const workspaces = store.workspacesOfProject(p.id)
          return (
            <div key={p.id} className="project-group">
              {/* 项目行 = 主工作区入口 */}
              <div
                className={"tree-row project-row" + (isCurrent && !store.currentWorkspace ? " active" : "")}
                onClick={() => selectProjectMain(p.id)}
              >
                <span className="tree-label" title={p.worktree}>
                  {p.name || p.worktree.split("/").pop() || p.id}
                </span>
                <SessionIndicator sessions={store.sessionsInDirectory(p.id, p.worktree)} />
                {isCurrent && (
                  <button
                    className="icon-btn row-action"
                    title={t.newWorkspace}
                    onClick={(e) => {
                      e.stopPropagation()
                      // 不弹窗：name 省略，由 server 生成随机 slug
                      void store.createWorkspace()
                    }}
                  >
                    +
                  </button>
                )}
                {isCurrent && projects.length > 1 && (
                  <button
                    className="icon-btn row-action"
                    title={t.closeProject}
                    onClick={(e) => {
                      e.stopPropagation()
                      void store.closeProject(p.id)
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              {/* 工作区跟随项目，全部展示（仅当前项目可新增/删除） */}
              {workspaces.map((w) => (
                <div
                  key={w.directory}
                  className={
                    "tree-row ws-row" +
                    (isCurrent && store.currentWorkspace?.directory === w.directory ? " active" : "")
                  }
                  onClick={() => selectWorkspace(p.id, w.directory)}
                >
                  <FolderGit2 className="ws-icon" size={16} aria-hidden />
                  <span className="tree-label" title={w.directory}>
                    {w.name}
                  </span>
                  <SessionIndicator sessions={store.sessionsInDirectory(p.id, w.directory)} />
                  {isCurrent && (
                    <button
                      className="icon-btn row-action"
                      title={t.deleteWorkspace}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(t.confirmDeleteWorkspace)) void store.removeWorkspace(w.directory)
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {pickerOpen && <ProjectPicker onClose={() => setPickerOpen(false)} />}
    </>
  )
}

/**
 * 会话状态指示器（项目/工作区行右侧）：该作用域未归档、非 subagent 会话的状态。
 * 状态投影同移动端 design-agent-status-indicator：waiting（待输入，琥珀静态）优先于
 * running（busy/retry = 运行色光晕呼吸，消费 dotStateFor——sessionStatus 单一事实源）。
 * ≤4 个逐会话状态点；>4 个按状态聚合为数字 chip（待输入数琥珀、运行数绿 chip、
 * 空闲数灰 chip，各自为 0 时省略）。靠右浮层覆盖操作按钮，行 hover 时隐藏。
 */
function SessionIndicator({ sessions }: { sessions: Session[] }) {
  const store = useStore()
  const { t } = useI18n()
  if (sessions.length === 0) return null
  let busyCount = 0
  let waitingCount = 0
  const dots = sessions.map((s) => store.dotStateFor(s.id))
  for (const d of dots) {
    if (d === "waiting") waitingCount++
    else if (d === "running") busyCount++
  }
  const idleCount = sessions.length - busyCount - waitingCount
  const title = t.sessionIndicatorTitle
    .replace("{count}", String(sessions.length))
    .replace("{busy}", String(busyCount))
    .replace("{waiting}", String(waitingCount))
  return (
    <span className="session-indicator" title={title}>
      {sessions.length > 4 ? (
        <>
          {waitingCount > 0 && <span className="session-count waiting">{waitingCount}</span>}
          {busyCount > 0 && <span className="session-count running">{busyCount}</span>}
          {idleCount > 0 && <span className="session-count">{idleCount}</span>}
        </>
      ) : (
        sessions.map((s, i) => (
          <span
            key={s.id}
            className={"status-dot " + (dots[i] === "running" ? "session-running" : dots[i])}
          />
        ))
      )}
    </span>
  )
}

function ProjectPicker({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const { t, locale } = useI18n()
  const opened = new Set(store.openedProjects.map((p) => p.id))
  const candidates = store.projects
    .filter((p) => !opened.has(p.id))
    .sort((a, b) => b.time.updated - a.time.updated)
  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{t.openProject}</div>
        <div className="dialog-body scroll">
          {candidates.length === 0 && <div className="tree-empty">{t.empty}</div>}
          {candidates.map((p) => (
            <div
              key={p.id}
              className="tree-row project-row"
              onClick={() => {
                void store.openProject(p.id)
                onClose()
              }}
            >
              <span className="tree-label">{p.name || p.worktree.split("/").pop()}</span>
              <span className="tree-meta">{relativeTime(locale, p.time.updated)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
