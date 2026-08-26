import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type WheelEvent,
} from "react"
import { ChevronDown, ChevronRight, ChevronUp, CircleHelp, ListTree, LoaderCircle, RotateCcw, ShieldAlert } from "lucide-react"
import { useI18n, useStore } from "../app"
import { format, relativeTime } from "../i18n"
import type { Catalog } from "../i18n"
import { filterRevertedEntries, type ChatEntry } from "@shared/message-merge"
import type {
  CommandInfo,
  Part,
  Session,
  SessionStatusValue,
  SubtaskPart,
  ToolPart,
} from "@shared/api-types"
import type { PendingPermission, PendingQuestion } from "@shared/pending-requests"
import { externalDirectoryPath, permissionCommand } from "@shared/pending-requests"
import { Markdown } from "./markdown"
import { ModelSwitcherBar } from "./model-switcher"
import { CodeView } from "./code-view"
import { buildHtmlPreviewDocument } from "./html-preview"
import { collectHeadings, MdToc, type TocHeading } from "./md-toc"
import { DiffView } from "./diff-view"
import { parseDiffTabKey } from "../store/app-store"

export function Workspace() {
  const store = useStore()
  const { t } = useI18n()
  // Tab 条只显示当前作用域的 Tab（全 kind 按 directory 匹配，2026-08-25 §18：
  // chat = 会话目录、diff = 作用域目录、file = 打开时作用域目录）
  const scopeDir = store.scopeQuery.directory
  const tabs = store.tabs.filter((tab) => tab.directory === scopeDir)
  const active = store.activeTab

  return (
    <main className="workspace">
      <div className="tabbar">
        {tabs.map((tab) => {
          return (
          <div
            key={tab.key}
            className={"tab" + (tab.key === store.activeTabKey ? " active" : "")}
            onClick={() => store.setActiveTab(tab.key)}
          >
            {tab.kind === "chat" && store.dotStateFor(tab.key.slice(5)) !== "idle" && (
              <span
                className={
                  "status-dot " +
                  (store.dotStateFor(tab.key.slice(5)) === "running"
                    ? "session-running"
                    : store.dotStateFor(tab.key.slice(5)))
                }
              />

            )}
            <span className="tab-label">
              {tab.kind === "diff" ? t.diffTitle : tab.title || t.untitled}
            </span>
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
          )
        })}
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
        {active?.kind === "file" && (
          /* key 隔离：file Tab 切换时防 mode（预览/源码）等局部 state 跨文件残留（同 ChatView） */
          <FileView key={active.key} absolutePath={active.key.slice(5)} />
        )}
        {active?.kind === "diff" &&
          (() => {
            const diff = parseDiffTabKey(active.key)
            return diff ? <DiffView key={active.key} tabKey={active.key} directory={diff.directory} /> : null
          })()}
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
  // global 拆分：作用域名 = 目录末段（根目录显示 "global"）——store 统一派生
  const scopeName = store.scopeDisplayName

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
    // 失败：草稿保留在输入框，connectionError 经左栏状态行可见，重试复用同一会话
  }

  return (
    <div className="guide-view">
      <div className="guide-main">
        <div className="hero">{scopeName}</div>
        <div className="guide-hint">{t.guideHint}</div>
        {/* Tab 入口（design-diff-view §4.4 / design-layout §4）：diff 单入口（页内
            segment 切换三种来源）；终端/网页为禁用态预留（v0.2/v0.3） */}
        <div className="guide-actions">
          <button type="button" className="guide-action" onClick={() => store.openDiffTab()}>
            {t.diffTitle}
          </button>
          <button type="button" className="guide-action" disabled title={t.comingSoon}>
            {t.openTerminal}
          </button>
          <button type="button" className="guide-action" disabled title={t.comingSoon}>
            {t.openBrowser}
          </button>
        </div>
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
            {/* pendingSession 时切会话绑定；会话记录从 store 重读（乐观补丁是新对象，
                ref 持有的是创建时快照——AM-FIX-2：UI 不依赖父组件传参快照）。
                目录用该会话自身的（AM-IMPL3-3：引导页 fiber 跨作用域切换仍存活，
                用 scope 目录会加载与会话 provider 集不符的列表） */}
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
            <button className="btn-primary" disabled={!draft.trim() || sending} onClick={() => void send()}>
              {t.send}
            </button>
          </div>
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
  // 回滚暂存态（design-message-revert）：回滚点起消息从消息流隐藏（对齐官方
  // timeline visibleUserMessages 过滤），撤销回滚恢复显示；发送即提交删除。
  // 乐观消息恒显（未达 server，不构成回滚对象）
  const revertMessageID = store.findSession(sessionID)?.revert?.messageID ?? null
  const visibleEntries = filterRevertedEntries(entries, revertMessageID)
  const revertedCount = entries.length - visibleEntries.length
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)
  const lastEntryCount = useRef(0)
  // 上滚分页视口锚定（design-message-history-pagination §4.3）：触发时记录
  // scrollHeight/scrollTop + 头部基准（最旧消息 id）；layout effect 只在**头部
  // 真实增长**（更早页落地）时消费补差——loading 指示行出现、底部流式增长等
  // 中间渲染不消费，避免 anchor 被提前花掉或按头部公式反向误补（review P1）
  const anchorRef = useRef<{ height: number; top: number; headId: string | null } | null>(null)

  /** entries 头部基准：最旧 message id（乐观恒排尾部，不构成头部） */
  const headIdOf = (list: ChatEntry[]): string | null =>
    list[0]?.kind === "message" ? list[0].data.info.id : null

  // 激活即重拉（design-layout §5：切回 Tab 时重拉；快照与 SSE 状态合并不丢数据）
  useEffect(() => {
    const session = store.findSession(sessionID)
    if (session) void store.loadSessionMessages(sessionID, session.directory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionID])

  // 回滚草稿回填（design-message-revert §3.3）：回滚点 user 消息文本置入输入框，可编辑重发
  useEffect(() => {
    const seed = store.takeRevertDraft(sessionID)
    if (seed != null) setDraft(seed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.revertDraftVersion, sessionID])

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
    // 仅"吸附"：距底 <40px 恢复跟随。不在此清除 pinned——scroll 事件无法区分
    // 用户滚动与程序滚动/smooth 动画：动画进行中每帧距底 >40px，若据此清 pinned，
    // 流式更新会被误判"用户上滚"而停止跟随，且 smooth 目标是过期 scrollHeight、
    // 动画终点仍距底 >40px，没有任何事件把 pinned 置回 → 跟随死锁
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) pinnedToBottom.current = true
    // 触顶翻页：pinned 期间不触发（发送后 smooth 回底动画起点可能距顶很近，
    // 会误触一次分页 + 锚定补差与回底动画互相拉扯）
    if (!pinnedToBottom.current && el.scrollTop <= 64) maybeLoadEarlier()
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
  // 依赖 visibleEntries（非 entries）：回滚暂存隐藏尾部消息也要触发贴底重定位
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
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
    // busy 不拦（design-supplement-send）：进行中发送 = 补充消息，server 在
    // 当前 run 内吸收（不打断、不排队），乐观气泡按时间序排活跃流式下方
    if (!text) return
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
      {/* 全宽滚动层：空白处滚轮可滚（限宽在内层，见 app.css .message-list 注释）。
          tabIndex=-1：Chromium 把滚动容器纳入焦点序列（Shift+Tab 会给整层画环，
          实证见 2026-08-24 会话），移出后键盘焦点直达输入框/Tab 条 */}
      <div className="message-list scroll" ref={scrollRef} tabIndex={-1} onScroll={onScroll} onWheel={onWheel}>
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
      <div className="composer">
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
          {/* busy 不禁切换：服务端 next 语义（下一条消息生效）是预期行为（设计"不做的事"） */}
          <ModelSwitcherBar
            directory={store.findSession(sessionID)?.directory ?? ""}
            mode="session"
            session={store.findSession(sessionID)}
          />
          {/* busy 时停止常驻可达（移动端 showStop 输入即隐藏——桌面空间足够，
              保留停止入口：补充输入中途仍可直接终止 run，无需清空草稿）；
              发送按钮在 busy 时仅于有草稿时出现（空输入无发送语义） */}
          {busy && (
            <button className="btn-danger" onClick={() => void store.abortSession(sessionID)}>
              {t.abort}
            </button>
          )}
          {(!busy || draft.trim()) && (
            <button className="btn-primary" disabled={!draft.trim()} onClick={() => void send()}>
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
 */
function ChatFooter({ sessionID }: { sessionID: string }) {
  const store = useStore()
  const permission = store.pendingPermissions.get(sessionID)
  const questions = store.questionsForSession(sessionID)
  const question = permission ? null : (questions[0] ?? null)
  const queueTotal = (permission ? 1 : 0) + questions.length
  if (queueTotal === 0) return null
  return (
    <div className="chat-footer">
      {permission && (
        <PermissionCard key={permission.id} permission={permission} queueTotal={queueTotal} />
      )}
      {question && <QuestionCard key={question.id} question={question} queueTotal={queueTotal} />}
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
          <Markdown>{entry.data.text}</Markdown>
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
            无 text part（纯附件/命令回显）不显示——草稿回填无文本可取（设计 §3.4） */}
        {texts.length > 0 && (
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
            <Markdown key={p.id}>{p.text}</Markdown>
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

/**
 * html 文件判定（design-html-preview §3.2）：与 isMarkdownPath 同解析规则。
 */
function isHtmlPath(path: string): boolean {
  const base = path.split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return false
  const ext = base.slice(dot + 1).toLowerCase()
  return ext === "html" || ext === "htm"
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
 * 文件 Tab 视图。预览文件（design-markdown-preview / design-html-preview）：
 * `.md`/`.markdown` 渲染 markdown（内容区动态宽度 [600, 800] 居中，TOC 悬浮窗
 * 挂内容区左侧）；`.html`/`.htm` 渲染 sandboxed iframe——默认预览态 + 工具条
 * 二态切换；模式为组件局部 state，Tab 重开/切文件重置（key 隔离）。
 * 其余文件代码视图（行号+语法高亮，design-code-view）。
 */
export function FileView({ absolutePath }: { absolutePath: string }) {
  const store = useStore()
  const { t, locale } = useI18n()
  const cached = store.fileContents.get(absolutePath)
  const isMarkdown = isMarkdownPath(absolutePath)
  const isHtml = isHtmlPath(absolutePath)
  const previewable = isMarkdown || isHtml
  const [mode, setMode] = useState<"preview" | "source">("preview")
  // TOC 大纲（design-markdown-preview §2.4）：预览体 DOM 扫描 h1–h6
  const mdRef = useRef<HTMLDivElement | null>(null)
  const [tocHeadings, setTocHeadings] = useState<TocHeading[]>([])
  // TOC 显隐 = 宽度默认态（宽显窄隐）+ 用户显式选择覆盖（工具条按钮）
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  // null = 未手动操作，随宽度默认；布尔 = 用户显式选择（不再随宽度回摆）
  const [tocUserMode, setTocUserMode] = useState<boolean | null>(null)
  // 章节折叠态由 FileView 持有：悬浮窗收起时 MdToc 卸载，折叠态跨显隐保留，
  // 仅内容更换（标题集合变化）时重置（§2.4）
  const [tocFolded, setTocFolded] = useState<ReadonlySet<HTMLElement>>(new Set())
  useEffect(() => {
    setTocFolded(new Set())
  }, [tocHeadings])
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    setPaneWidth(el.clientWidth) // 同步首测（RO 回调是异步的，否则窄屏先闪显一帧）
    const ro = new ResizeObserver(() => setPaneWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // CSP 注入是 O(n) 扫描 + 拼接：只在内容变化时重算（SSE emit 重渲染不重复付出）
  const htmlDoc = useMemo(
    () => (isHtml && cached ? buildHtmlPreviewDocument(cached.content) : ""),
    [isHtml, cached?.content],
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

  if (!previewable) {
    if (!cached) return <div className="file-view">{t.loading}</div>
    if (cached.error) return <div className="file-view error">{cached.error}</div>
    return (
      <div className="file-view code-view">
        {/* key 并入 locale：搜索面板短语随语言设置即时重建（CM phrases 是创建期 facet） */}
        <CodeView key={locale} path={absolutePath} content={cached.content} locale={locale} />
      </div>
    )
  }

  // TOC 可用 = markdown 且已扫出标题（加载/错误/源码态标题被清空，天然为 false）；
  // 悬浮窗可能遮挡内容区 → 默认收起（工具条按钮可显式展开，悬浮覆盖内容区）
  const hasToc = isMarkdown && tocHeadings.length > 0
  const tocOccluded = tocOccludesContent(paneWidth)
  const tocVisible = hasToc && (tocUserMode ?? !tocOccluded)

  // 预览文件：工具条常驻（loading/error 也渲染）——避免内容落地/重试成功时
  // 工具条弹入造成 ~32px 布局跳动
  const view = (
    <div className={"file-view" + (isHtml ? " html-view" : " code-view")}>
      {!cached && <div className="file-state">{t.loading}</div>}
      {cached?.error && <div className="file-state file-error">{cached.error}</div>}
      {cached && !cached.error && mode === "preview" && isMarkdown && (
        // 内容区动态宽度 [600, 800] 相对全窗居中（§2.4）；滚动层全宽 →
        // 滚动条贴窗口右缘；TOC 悬浮窗在滚动层之外（.file-view-wrap 绝对定位）
        <div className="file-md" ref={mdRef}>
          <Markdown>{cached.content}</Markdown>
        </div>
      )}
      {cached && !cached.error && mode === "preview" && isHtml && (
        <iframe
          className="html-preview"
          title={absolutePath}
          // 全沙箱：禁脚本 / opaque origin（触不到父页面与 preload 桥）/ 禁顶层
          // 导航与弹窗；CSP 注入屏蔽外链资源（design-html-preview §2）
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={htmlDoc}
        />
      )}
      {cached && !cached.error && mode === "source" && (
        <CodeView key={locale} path={absolutePath} content={cached.content} locale={locale} />
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
            onClick={() => setTocUserMode(!tocVisible)}
          >
            <ListTree size={16} aria-hidden />
          </button>
        )}
        <div className="ms-segmented" role="group" aria-label={t.viewModeLabel}>
          <button
            type="button"
            aria-pressed={mode === "preview"}
            className={"ms-seg" + (mode === "preview" ? " active" : "")}
            onClick={() => setMode("preview")}
          >
            {t.previewMode}
          </button>
          <button
            type="button"
            aria-pressed={mode === "source"}
            className={"ms-seg" + (mode === "source" ? " active" : "")}
            onClick={() => setMode("source")}
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
          onFold={(el) =>
            setTocFolded((prev) => {
              const next = new Set(prev)
              if (next.has(el)) next.delete(el)
              else next.add(el)
              return next
            })
          }
        />
      )}
    </div>
  )
}

import { SettingsDialog } from "./settings-dialog"
