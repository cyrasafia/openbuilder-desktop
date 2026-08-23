import { useEffect, useRef, useState } from "react"
import { useI18n, useStore } from "../app"
import { relativeTime } from "../i18n"
import type { ChatEntry } from "@shared/message-merge"
import type { Part, ToolPart } from "@shared/api-types"

export function Workspace() {
  const store = useStore()
  const { t } = useI18n()
  // Tab 条只显示当前作用域的 Tab（chat: directory 匹配；file: 跟随显示）
  const scopeDir = store.scopeQuery.directory
  const tabs = store.tabs.filter(
    (tab) => tab.kind === "file" || (tab.kind === "chat" && tab.directory === scopeDir),
  )
  const active = store.activeTab

  return (
    <main className="workspace">
      <div className="tabbar">
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={"tab" + (tab.key === store.activeTabKey ? " active" : "")}
            onClick={() => store.setActiveTab(tab.key)}
          >
            {tab.kind === "chat" && store.busySessions.has(tab.key.slice(5)) && (
              <span className="status-dot running" />
            )}
            <span className="tab-label">{tab.title || t.untitled}</span>
            <button
              className="icon-btn tab-close"
              title={t.closeTab}
              onClick={(e) => {
                e.stopPropagation()
                if (tab.kind === "chat") {
                  const streaming = store.busySessions.has(tab.key.slice(5))
                  if (streaming && !confirm(t.confirmCloseStreamingTab)) return
                  void store.closeChatTab(tab.key.slice(5), { streaming })
                } else {
                  store.closeTab(tab.key)
                }
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="icon-btn tabbar-new" title={t.newChatTab} onClick={() => void store.createSession()}>
          +
        </button>
      </div>

      <div className="workspace-body">
        {/* 无激活 Tab = 当前作用域的会话列表（未归档、非 subagent） */}
        {!active && <SessionList />}
        {/* key 隔离：防止 chat→chat 切换时复用 fiber 导致草稿/pinned ref 跨会话残留 */}
        {active?.kind === "chat" && <ChatView key={active.key} sessionID={active.key.slice(5)} />}
        {active?.kind === "file" && <FileView absolutePath={active.key.slice(5)} />}
      </div>

      {store.settingsOpen && <SettingsDialog />}
    </main>
  )
}

/** 作用域会话列表：选择项目/工作区后的默认视图 */
function SessionList() {
  const store = useStore()
  const { t, locale } = useI18n()
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const sessions = store.visibleSessions
  const archived = store.archivedSessions
  const [archivedOpen, setArchivedOpen] = useState(false)
  const scopeName =
    store.currentWorkspace?.name ?? store.currentProject?.name ?? store.currentProject?.worktree.split("/").pop() ?? ""

  return (
    <div className="session-list-view">
      <div className="session-list-header">
        <div>
          <div className="session-list-scope mono">{scopeName}</div>
          <div className="session-list-count">
            {t.sessionsTitle}: {sessions.length}
          </div>
        </div>
        <button className="btn-primary" onClick={() => void store.createSession()}>
          {t.newSession}
        </button>
      </div>
      <div className="session-list scroll">
        {sessions.length === 0 && <div className="session-empty">{t.noSession}</div>}
        {sessions.map((s) => (
          <SessionCard
            key={s.id}
            sessionID={s.id}
            busy={store.busySessions.has(s.id)}
            locale={locale}
            menuOpen={menuFor === s.id}
            onMenuToggle={() => setMenuFor(menuFor === s.id ? null : s.id)}
            onCloseMenu={() => setMenuFor(null)}
          />
        ))}
        {archived.length > 0 && (
          <>
            <button className="archived-toggle" onClick={() => setArchivedOpen(!archivedOpen)}>
              {t.archivedSessions} ({archived.length}) {archivedOpen ? "▾" : "▸"}
            </button>
            {archivedOpen &&
              archived.map((s) => (
                <SessionCard
                  key={s.id}
                  sessionID={s.id}
                  busy={false}
                  locale={locale}
                  archived
                  menuOpen={menuFor === s.id}
                  onMenuToggle={() => setMenuFor(menuFor === s.id ? null : s.id)}
                  onCloseMenu={() => setMenuFor(null)}
                />
              ))}
          </>
        )}
      </div>
    </div>
  )
}

function SessionCard({
  sessionID,
  busy,
  locale,
  archived,
  menuOpen,
  onMenuToggle,
  onCloseMenu,
}: {
  sessionID: string
  busy: boolean
  locale: "zh" | "en"
  archived?: boolean
  menuOpen: boolean
  onMenuToggle: () => void
  onCloseMenu: () => void
}) {
  const store = useStore()
  const { t } = useI18n()
  const session = store.findSession(sessionID)
  if (!session) return null

  return (
    <div
      className={"session-card" + (archived ? " archived" : "")}
      onClick={() => store.openChatTab(session)}
    >
      <div className="session-card-main">
        <div className="session-card-title">
          {busy && <span className="status-dot running" />}
          <span>{session.title || session.slug || t.untitled}</span>
        </div>
        <div className="session-card-meta">
          <span className="mono">{session.slug}</span>
          <span>{relativeTime(locale, session.time.updated)}</span>
        </div>
      </div>
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
          <div className="menu-mask" onClick={onCloseMenu} />
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            {archived ? (
              <button
                onClick={() => {
                  void store.unarchiveSession(session.id).then(() => store.openChatTab(session))
                  onCloseMenu()
                }}
              >
                {t.unarchive}
              </button>
            ) : (
              <button
                onClick={() => {
                  void store.archiveSession(session.id)
                  onCloseMenu()
                }}
              >
                {t.archive}
              </button>
            )}
            <button
              onClick={() => {
                const title = prompt(t.rename, session.title ?? "")
                if (title != null && title.trim()) void store.renameSession(session.id, title.trim())
                onCloseMenu()
              }}
            >
              {t.rename}
            </button>
            <button
              className="danger"
              onClick={() => {
                if (confirm(t.confirmDeleteSession)) void store.deleteSession(session.id)
                onCloseMenu()
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

function ChatView({ sessionID }: { sessionID: string }) {
  const store = useStore()
  const { t } = useI18n()
  const [draft, setDraft] = useState("")
  const entries = store.chatEntries(sessionID)
  const busy = store.busySessions.has(sessionID)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const lastEntryCount = useRef(0)
  // 初始置底未完成前不渲染消息：避免先画顶部再跳底的闪动
  // （组件 key 隔离，每次打开会话都重新走一遍该流程）
  const [initialScrollDone, setInitialScrollDone] = useState(false)

  // 激活即重拉（design-layout §5：切回 Tab 时重拉；快照与 SSE 状态合并不丢数据）
  useEffect(() => {
    const session = store.findSession(sessionID)
    if (session) void store.loadSessionMessages(sessionID, session.directory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionID])

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    // 距底 <40px 视为"钉在底部"；用户上滚即解除跟随
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (pinnedToBottom.current) {
      if (!initialScrollDone) {
        // 首批消息到达：直接置底（auto，无动画），完成后才放行渲染
        scrollToBottom("auto")
        setInitialScrollDone(true)
      } else {
        // 初始加载已完成：新条目 smooth；同条目流式更新即时贴底
        scrollToBottom(entries.length > lastEntryCount.current ? "smooth" : "auto")
      }
    }
    lastEntryCount.current = entries.length
  }, [entries, initialScrollDone])

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft("")
    pinnedToBottom.current = true
    scrollToBottom("smooth")
    await store.sendPrompt(sessionID, text)
  }

  return (
    <div className="chat-view">
      <div className="message-list scroll" ref={scrollRef} onScroll={onScroll}>
        {/* 初始置底完成前不渲染，杜绝"顶部一帧→跳底"闪动 */}
        {initialScrollDone &&
          entries.map((entry) => (
            <MessageBlock key={entry.kind === "optimistic" ? entry.data.localId : entry.data.info.id} entry={entry} />
          ))}
      </div>
      <div className="composer">
        <textarea
          value={draft}
          placeholder={t.inputPlaceholder}
          rows={Math.min(8, Math.max(1, draft.split("\n").length))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // 修饰键组合（Ctrl/Shift/Alt/Meta）= 换行；裸 Enter = 发送
              if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="composer-actions">
          {busy ? (
            <button className="btn-danger" onClick={() => void store.abortSession(sessionID)}>
              {t.abort}
            </button>
          ) : (
            <button className="btn-primary" disabled={!draft.trim()} onClick={() => void send()}>
              {t.send}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageBlock({ entry }: { entry: ChatEntry }) {
  const { t } = useI18n()

  if (entry.kind === "optimistic") {
    return (
      <div className="msg user">
        <div className="bubble">
          <p>{entry.data.text}</p>
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
  const reasonings = parts.filter((p) => p.type === "reasoning")
  const tools = parts.filter((p) => p.type === "tool") as ToolPart[]
  const errored = info.role === "assistant" && info.error

  if (info.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">
          {texts.map((p) => (
            <p key={p.id}>{p.text}</p>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="msg assistant">
      {reasonings.map((p) => (
        <ReasoningChip key={p.id} part={p} />
      ))}
      {tools.map((p) => (
        <ToolChip key={p.id} part={p} />
      ))}
      {texts.map((p) => (
        <div key={p.id} className="assistant-text">
          {p.text}
        </div>
      ))}
      {errored && (
        <div className="error-card">
          {t.errorTitle}: {String((info.error as { message?: string })?.message ?? info.error)}
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
      <button className="chip-header" onClick={() => setOpen(!open)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className="chip-label">{t.thinking}</span>
      </button>
      {open && <div className="chip-body reasoning">{text}</div>}
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
      <button className="chip-header" onClick={() => setOpen(!open)}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className={"status-dot tool-" + status} data-status={status} />
        <span className="chip-label">{part.tool}</span>
        {summary && <span className="chip-summary">{summary}</span>}
      </button>
      {open && (
        <div className="chip-body">
          <div className="code-block-label">{t.inputLabel}</div>
          <pre className="code-block">{JSON.stringify(state.input, null, 2)}</pre>
          <div className="code-block-label">{t.outputLabel}</div>
          <pre className="code-block">
            {status === "completed" ? state.output : status === "error" ? state.error : "…"}
          </pre>
        </div>
      )}
    </div>
  )
}

function FileView({ absolutePath }: { absolutePath: string }) {
  const store = useStore()
  const { t } = useI18n()
  const cached = store.fileContents.get(absolutePath)

  // 激活即重拉（缓存仅作首帧显示）
  useEffect(() => {
    void store.loadFileContent(absolutePath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [absolutePath])

  if (!cached) return <div className="file-view">{t.loading}</div>
  if (cached.error) return <div className="file-view error">{cached.error}</div>
  return (
    <div className="file-view">
      <pre className="file-content mono">{cached.content}</pre>
    </div>
  )
}

import { SettingsDialog } from "./settings-dialog"
