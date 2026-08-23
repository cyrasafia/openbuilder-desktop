import { useState } from "react"
import { useI18n, useStore } from "../app"
import { relativeTime } from "../i18n"

export function Sidebar() {
  const store = useStore()
  const { t, locale } = useI18n()
  const [pickerOpen, setPickerOpen] = useState(false)

  const projects = store.openedProjects
  const current = store.currentProject

  /** 选项目 = 选主工作区（并切换项目上下文） */
  const selectProjectMain = (projectId: string) => {
    if (projectId === current?.id && !store.currentWorkspace) return
    void store.setCurrentProject(projectId).then(() => store.setCurrentWorkspace(null))
  }

  /** 选工作区（项目内 worktree） */
  const selectWorkspace = (projectId: string, directory: string) => {
    if (projectId === current?.id && store.currentWorkspace?.directory === directory) return
    if (projectId !== current?.id) {
      void store.setCurrentProject(projectId).then(() => store.setCurrentWorkspace(directory))
    } else {
      void store.setCurrentWorkspace(directory)
    }
  }

  if (!store.activeProfile) {
    return (
      <aside className="sidebar">
        <div className="sidebar-empty">
          <p>{t.connectFirst}</p>
          <button className="btn-primary" onClick={() => store.openSettings()}>
            {t.openSettings}
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
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
                  <span className="tree-label" title={w.directory}>
                    {w.name}
                  </span>
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

      <div className="sidebar-footer">
        <button className="icon-btn" title={t.settings} onClick={() => store.openSettings()}>
          ⚙
        </button>
      </div>

      {pickerOpen && <ProjectPicker onClose={() => setPickerOpen(false)} />}
    </aside>
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

