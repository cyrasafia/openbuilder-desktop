import { useState } from "react"
import { useI18n, useStore } from "../app"
import { relativeTime } from "../i18n"
import type { Session } from "@shared/api-types"

export function Sidebar() {
  const store = useStore()
  const { t, locale } = useI18n()
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [wsDialogOpen, setWsDialogOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const projects = store.openedProjects
  const current = store.currentProject
  const workspaces = current ? store.workspacesOfCurrentProject : []
  const sessions = store.visibleSessions
  const archived = store.archivedSessions

  if (!store.activeProfile) {
    return (
      <aside className="sidebar">
        <div className="sidebar-empty">
          <p>{t.connectFirst}</p>
          <button className="btn-primary" onClick={() => (store.openSettings())}>
            {t.openSettings}
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-section projects">
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
        <div className="tree">
          {projects.map((p) => (
            <div
              key={p.id}
              className={
                "tree-row project-row" + (p.id === current?.id ? " active" : "")
              }
              onClick={() => void store.setCurrentProject(p.id)}
            >
              <span className="tree-label" title={p.worktree}>
                {p.name || p.worktree.split("/").pop() || p.id}
              </span>
              <span className="tree-meta">{relativeTime(locale, p.time.updated)}</span>
              {p.id === current?.id && projects.length > 1 && (
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
          ))}
        </div>
      </div>

      {current && (
        <div className="sidebar-section workspaces">
          <div className="sidebar-heading">
            <span>{t.workspacesTitle}</span>
            <button
              className="icon-btn"
              title={t.newWorkspace}
              onClick={() => setWsDialogOpen(true)}
            >
              +
            </button>
          </div>
          <div className="tree">
            <div
              className={
                "tree-row ws-row" + (!store.currentWorkspace ? " active" : "")
              }
              onClick={() => void store.setCurrentWorkspace(null)}
            >
              <span className="tree-label">{t.mainWorkspace}</span>
            </div>
            {workspaces.map((w) => (
              <div
                key={w.directory}
                className={"tree-row ws-row" + (store.currentWorkspace?.directory === w.directory ? " active" : "")}
                onClick={() => void store.setCurrentWorkspace(w.directory)}
              >
                <span className="tree-label">{w.name}</span>
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
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sidebar-section sessions">
        <div className="sidebar-heading">
          <span>{t.sessionsTitle}</span>
          <button className="icon-btn" title={t.newSession} onClick={() => void store.createSession()}>
            +
          </button>
        </div>
        <div className="tree scroll">
          {sessions.length === 0 && <div className="tree-empty">{t.noSession}</div>}
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              busy={store.busySessions.has(s.id)}
              activeTabKey={store.activeTabKey}
              onOpen={() => store.openChatTab(s)}
              menuOpen={menuFor === s.id}
              onMenuToggle={() => setMenuFor(menuFor === s.id ? null : s.id)}
              onClose={() => setMenuFor(null)}
            />
          ))}
          {archived.length > 0 && (
            <>
              <button
                className="archived-toggle"
                onClick={() => setArchivedOpen(!archivedOpen)}
              >
                {t.archivedSessions} ({archived.length}) {archivedOpen ? "▾" : "▸"}
              </button>
              {archivedOpen &&
                archived.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    busy={false}
                    activeTabKey={store.activeTabKey}
                    archived
                    onOpen={() => void store.unarchiveSession(s.id).then(() => store.openChatTab(s))}
                    menuOpen={menuFor === s.id}
                    onMenuToggle={() => setMenuFor(menuFor === s.id ? null : s.id)}
                    onClose={() => setMenuFor(null)}
                  />
                ))}
            </>
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <button className="icon-btn" title={t.settings} onClick={() => (store.openSettings())}>
          ⚙
        </button>
      </div>

      {pickerOpen && current && <ProjectPicker onClose={() => setPickerOpen(false)} />}
      {wsDialogOpen && current && (
        <WorkspaceDialog projectId={current.id} onClose={() => setWsDialogOpen(false)} />
      )}
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

function WorkspaceDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const store = useStore()
  const { t } = useI18n()
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  void projectId

  const submit = async () => {
    setBusy(true)
    // 名字留空 = server 生成随机 slug
    const res = await store.createWorkspace(name.trim() || undefined)
    setBusy(false)
    if (res.ok) onClose()
    else setError(res.error ?? "failed")
  }

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog dialog-sm" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">{t.newWorkspace}</div>
        <div className="dialog-body">
          <label className="form-label">
            {t.workspaceName}
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>{t.cancel}</button>
          <button className="btn-primary" disabled={busy} onClick={() => void submit()}>
            {t.create}
          </button>
        </div>
      </div>
    </div>
  )
}

function SessionRow({
  session,
  busy,
  activeTabKey,
  archived,
  onOpen,
  menuOpen,
  onMenuToggle,
  onClose,
}: {
  session: Session
  busy: boolean
  activeTabKey: string | null
  archived?: boolean
  onOpen: () => void
  menuOpen: boolean
  onMenuToggle: () => void
  onClose: () => void
}) {
  const store = useStore()
  const { t } = useI18n()
  const active = activeTabKey === `chat:${session.id}`

  return (
    <div
      className={"tree-row session-row" + (active ? " active" : "") + (archived ? " archived" : "")}
      onClick={onOpen}
    >
      {busy && <span className="status-dot running" />}
      <span className="tree-label">{session.title || session.slug || t.untitled}</span>
      <button
        className="icon-btn row-action"
        onClick={(e) => {
          e.stopPropagation()
          onMenuToggle()
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <>
          <div className="menu-mask" onClick={onClose} />
          <div className="menu">
            {archived ? (
              <button
                onClick={() => {
                  onOpen()
                  onClose()
                }}
              >
                {t.unarchive}
              </button>
            ) : (
              <button
                onClick={() => {
                  void store.archiveSession(session.id)
                  onClose()
                }}
              >
                {t.archive}
              </button>
            )}
            <button
              onClick={() => {
                const title = prompt(t.rename, session.title ?? "")
                if (title != null && title.trim()) void store.renameSession(session.id, title.trim())
                onClose()
              }}
            >
              {t.rename}
            </button>
            <button
              className="danger"
              onClick={() => {
                if (confirm(t.confirmDeleteSession)) void store.deleteSession(session.id)
                onClose()
              }}
            >
              {t.delete}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
