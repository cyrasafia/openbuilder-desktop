import { useEffect, useLayoutEffect, useRef, useState, type WheelEvent } from "react"
import { LoaderCircle } from "lucide-react"
import { useI18n, useStore } from "../app"
import { format, relativeTime } from "../i18n"
import type { ChatEntry } from "@shared/message-merge"
import type {
  CommandInfo,
  Part,
  Session,
  SessionStatusValue,
  SubtaskPart,
  ToolPart,
} from "@shared/api-types"
import { Markdown } from "./markdown"

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
            {tab.kind === "chat" && store.isSessionActive(tab.key.slice(5)) && (
              <span className="status-dot running" />
            )}
            <span className="tab-label">{tab.title || t.untitled}</span>
            <button
              className="icon-btn tab-close"
              title={t.closeTab}
              onClick={(e) => {
                e.stopPropagation()
                if (tab.kind === "chat") {
                  const streaming = store.isSessionActive(tab.key.slice(5))
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
        <button
          className="icon-btn tabbar-new"
          title={t.newTab}
          onClick={() => store.showGuidePage()}
        >
          +
        </button>
      </div>

      <div className="workspace-body">
        {/* 无激活 Tab = 新 Tab 引导页（新建项目/工作区、Tab 栏 +、作用域无 Tab） */}
        {!active && <GuidePage />}
        {/* key 隔离：防止 chat→chat 切换时复用 fiber 导致草稿/pinned ref 跨会话残留 */}
        {active?.kind === "chat" && <ChatView key={active.key} sessionID={active.key.slice(5)} />}
        {active?.kind === "file" && <FileView absolutePath={active.key.slice(5)} />}
      </div>

      {store.settingsOpen && <SettingsDialog />}
    </main>
  )
}

/**
 * 新 Tab 引导页：无激活 Tab 时的默认视图（design-layout §4）。
 * 输入消息发送 = 新建会话 + 发送首条消息（Tab 自动打开激活，引导页退出）；
 * 下方列出当前作用域已归档会话，点击恢复（取消归档并开 Tab）；
 * 终端/网页 Tab 入口为禁用预留（v0.2/v0.3）。
 */
function GuidePage() {
  const store = useStore()
  const { t, locale } = useI18n()
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  // 已创建待发送的会话：发送失败保留草稿，重试复用（不重复建会话、不产生空 Tab）
  const pendingSession = useRef<Session | null>(null)
  const archived = store.archivedSessions
  const scopeName =
    store.currentWorkspace?.name ?? store.currentProject?.name ?? store.currentProject?.worktree.split("/").pop() ?? ""

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
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
    const res = await store.sendPrompt(pendingSession.current.id, text)
    setSending(false)
    if (res.ok) {
      setDraft("")
      store.openChatTab(pendingSession.current)
      pendingSession.current = null
    }
    // 失败：草稿保留在输入框，connectionError 经状态栏可见，重试复用同一会话
  }

  return (
    <div className="guide-view">
      <div className="guide-main">
        <div className="hero">{scopeName}</div>
        <div className="guide-hint">{t.guideHint}</div>
        <div className="guide-composer">
          <textarea
            value={draft}
            placeholder={t.guidePlaceholder}
            rows={1}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // IME 组合中（如 fcitx5 上屏）不触发发送
              if (e.nativeEvent.isComposing) return
              if (e.key === "Enter") {
                // 修饰键组合（Ctrl/Shift/Alt/Meta）= 换行；裸 Enter = 发送（与聊天输入区一致）
                if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="composer-actions">
            <button className="btn-primary" disabled={!draft.trim() || sending} onClick={() => void send()}>
              {t.send}
            </button>
          </div>
        </div>
        <div className="guide-actions">
          <button className="guide-action" disabled title={t.comingSoon}>
            {t.openTerminal}
          </button>
          <button className="guide-action" disabled title={t.comingSoon}>
            {t.openBrowser}
          </button>
        </div>
      </div>
      {archived.length > 0 && (
        <div className="guide-archived">
          <div className="guide-archived-header">
            <span>{t.archivedSessions}</span>
            <span className="guide-archived-hint">{t.restoreHint}</span>
          </div>
          {archived.map((s) => (
            <div key={s.id} className="guide-card" onClick={() => store.openChatTab(s)}>
              <div className="guide-card-title">{s.title || s.slug || t.untitled}</div>
              <div className="guide-card-meta">
                <span className="mono">{s.slug}</span>
                <span>{relativeTime(locale, s.time.updated)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ChatView({ sessionID }: { sessionID: string }) {
  const store = useStore()
  const { t } = useI18n()
  const [draft, setDraft] = useState("")
  const entries = store.chatEntries(sessionID)
  const status = store.statusOf(sessionID)
  const busy = status.type !== "idle"
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const lastEntryCount = useRef(0)

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
    // 仅"吸附"：距底 <40px 恢复跟随。不在此清除 pinned——scroll 事件无法区分
    // 用户滚动与程序滚动/smooth 动画：动画进行中每帧距底 >40px，若据此清 pinned，
    // 流式更新会被误判"用户上滚"而停止跟随，且 smooth 目标是过期 scrollHeight、
    // 动画终点仍距底 >40px，没有任何事件把 pinned 置回 → 跟随死锁
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) pinnedToBottom.current = true
  }

  // 解除跟随只认用户主动上滚（wheel deltaY<0）。滚动条已隐藏（app.css），
  // wheel/触控板是唯一用户上滚入口；Chromium 已归一化自然滚动方向，deltaY<0 恒为"向上看历史"。
  // 两类误触排除：ctrlKey=缩放手势（Ctrl+wheel 放大/触控板 pinch-out）；
  // 内容未溢出时上滚是视觉 no-op——若此时清 pinned，流式增长越过容器后无
  // scroll 事件可再吸附（scrollTop 未变），跟随将停摆到用户手动滚底
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return
    const el = scrollRef.current
    if (e.deltaY < 0 && el && el.scrollHeight - el.clientHeight > 0) pinnedToBottom.current = false
  }

  // useLayoutEffect：DOM 变更后、绘制前同步置底，首帧即到底、无滚动动画
  // 0→N（含首次加载与切回 Tab 重拉快照）用 auto 瞬时定位；
  // 之后新条目（N→N+1）才 smooth 跟随，同条目流式更新即时贴底。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (!pinnedToBottom.current) {
      lastEntryCount.current = entries.length
      return
    }
    const grew = entries.length > lastEntryCount.current
    scrollToBottom(grew ? "smooth" : "auto")
    lastEntryCount.current = entries.length
  }, [entries])

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft("")
    setCmdDismissed(false)
    pinnedToBottom.current = true
    scrollToBottom("smooth")
    const res = text.startsWith("/")
      ? await sendSlash(text)
      : await store.sendPrompt(sessionID, text)
    // 失败回填草稿：文本不丢（乐观消息已在 store 侧撤回）
    if (!res.ok) setDraft(text)
  }

  /**
   * 斜杠命令分流：发送前强制重拉注册表（最新命令集），命中才走
   * POST /session/:id/command（服务端展开）；未注册的 /xxx 按字面文本
   * 走 prompt（服务端不会展开模板）。
   * 命令名与参数以任意空白分隔（空格/换行/Tab——Shift+Enter 多行参数可达）。
   */
  const sendSlash = async (text: string): Promise<{ ok: boolean; error?: string }> => {
    const directory = store.findSession(sessionID)?.directory ?? null
    await store.refreshCommands(directory)
    const rest = text.slice(1)
    const sep = rest.search(/\s/)
    const token = (sep === -1 ? rest : rest.slice(0, sep)).toLowerCase()
    const matched = (directory ? store.commandsFor(directory) : []).find(
      (c) => c.name.toLowerCase() === token,
    )
    if (!matched) return store.sendPrompt(sessionID, text)
    const args = sep === -1 ? "" : rest.slice(sep + 1).trim()
    return store.sendCommand(sessionID, matched.name, args)
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
      <div className="message-list scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel}>
        {entries.map((entry) => (
          <MessageBlock key={entry.kind === "optimistic" ? entry.data.localId : entry.data.info.id} entry={entry} />
        ))}
        {/* 常驻固定高槽位（INV-1）：显隐只动槽内内容，消息流总高度不变（design-typing-indicator §3） */}
        <TypingSlot status={status} />
      </div>
      {cmdMode && (
        <CommandHints
          matches={matches}
          loading={store.commandsRefreshing && commands.length === 0}
          selIndex={sel}
          onPick={pickCommand}
        />
      )}
      <div className="composer">
        <textarea
          value={draft}
          placeholder={t.inputPlaceholder}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value)
            setCmdDismissed(false)
            setSelIndex(0)
          }}
          onKeyDown={(e) => {
            // IME 组合中（如 fcitx5 上屏）不触发发送与菜单选中
            if (e.nativeEvent.isComposing) return
            // 命令菜单打开且有匹配：↑/↓ 移动、Enter/Tab 选中补全、Esc 关闭
            if (cmdMode && matches.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault()
                const len = matches.length
                setSelIndex(e.key === "ArrowDown" ? (sel + 1) % len : (sel - 1 + len) % len)
                return
              }
              if (
                e.key === "Tab" ||
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
      <div className="command-hints">
        <div className="command-empty">{t.commandListLoading}</div>
      </div>
    )
  }

  return (
    <div className="command-hints scroll" ref={listRef}>
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
      <div className="command-keys mono">{t.commandHintKeys}</div>
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
  const retryText = retry
    ? status.message
      ? format(t.retryingMessage, { message: status.message })
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
  // 斜杠命令回显：subtask part（展开 prompt 在 prompt 字段，text 恒空）
  const subtasks = parts.filter((p) => p.type === "subtask") as SubtaskPart[]
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
          {subtasks.map((p) => {
            // 标签行 + 正文合并为单一 Markdown（openbuilder 二次评审结论：
            // 单独画标签观感像 chip，与正文样式不一致）
            const body = p.prompt || p.text || p.description || ""
            return (
              <div key={p.id} className="bubble-subtask">
                <Markdown>{body ? `**subtask: ${p.command}**\n\n${body}` : `**subtask: ${p.command}**`}</Markdown>
              </div>
            )
          })}
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
          <Markdown>{p.text}</Markdown>
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
