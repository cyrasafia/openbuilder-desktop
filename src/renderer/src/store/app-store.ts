/**
 * 应用状态层：连接 → 项目/工作区 → 会话 → 消息 → Tab。
 * 事件闸门、乐观消息、SSE 生命周期都在这里收敛。
 */
import { RestClient } from "@shared/rest-client"
import { SseSubscriber, type SseStatus } from "@shared/sse-subscriber"
import { Reconciler } from "@shared/reconciler"
import { mergeSessionsSnapshot } from "@shared/session-merge"
import { inferIdleFromMessages, mergeStatusSnapshot } from "@shared/session-status"
import { runLimited } from "@shared/run-limited"
import {
  buildFirstOpenMemory,
  deriveMemory,
  isSnapshotMissing,
  resolveRestoreActive,
  shrinkMemoryTabs,
  type ScopeTabMemory,
} from "@shared/scope-tab-memory"
import {
  mergeSnapshotIntoMessages,
  sortEntries,
  sortMessages,
  type ChatEntry,
  type OptimisticMessage,
} from "@shared/message-merge"
import type { ConnectionProfile } from "@shared/ipc"
import "@shared/ipc-global"
import {
  applyCommandFetch,
  initialCommandCache,
  type CommandCacheState,
} from "@shared/command-cache"
import type {
  CommandInfo,
  FileNode,
  HealthInfo,
  Message,
  MessageWithParts,
  OpencodeEvent,
  Part,
  Project,
  Session,
  SessionStatusValue,
  Workspace,
} from "@shared/api-types"

export type TabKind = "chat" | "file"

export interface TabEntity {
  kind: TabKind
  /** chat: sessionID; file: absolute path */
  key: string
  projectId: string
  title: string
  /** chat: 会话目录（事件路由需要） */
  directory?: string
}

export type ConnectionState = "disconnected" | "connecting" | "streaming" | "degraded"

export interface ProjectState {
  opened: string[]
  currentProjectId: string | null
  currentWorkspaceId: string | null
}

export interface SessionRuntime {
  /** 流式中（assistant 未完成） */
  busy: boolean
}

type Listener = () => void

export class AppStore {
  // ---- 持久化状态 ----
  profiles: ConnectionProfile[] = []
  activeProfileId: string | null = null
  projectStates: Record<string, ProjectState> = {}
  /** worktree 级 Tab 记忆（design-tab-memory）：profileKey → directory → 记忆 */
  tabMemory: Record<string, Record<string, ScopeTabMemory>> = {}
  themeMode: "auto" | "dark" | "light" = "auto"
  localeMode: "auto" | "zh" | "en" = "auto"

  // ---- 连接运行时 ----
  connectionState: ConnectionState = "disconnected"
  sseStatus: SseStatus = "stopped"
  reconciling = false
  health: HealthInfo | null = null
  connectionError: string | null = null
  managedBaseUrl: string | null = null

  // ---- 域数据 ----
  projects: Project[] = []
  sessionsByProject = new Map<string, Map<string, Session>>()
  messagesBySession = new Map<string, Map<string, MessageWithParts>>()
  optimisticBySession = new Map<string, OptimisticMessage[]>()
  /**
   * 会话状态（busy/idle/retry）——纯客户端内存映射，单一事实源：
   * Tab 状态点、左栏指示器、消息流 TypingSlot 都消费它（design-typing-indicator §4）。
   * idle 不落 map（缺省即 idle）；来源见 setSessionStatus/applyStatusSnapshot。
   */
  sessionStatus = new Map<string, SessionStatusValue>()
  /** sessionID → 状态来源目录（REST 按目录覆盖合并的权威边界） */
  private statusSources = new Map<string, string>()
  // 斜杠命令注册表缓存（全局单份 per-server，目录隔离见 command-cache.ts）
  commandCache: CommandCacheState = initialCommandCache()

  // ---- UI 状态 ----
  tabs: TabEntity[] = []
  activeTabKey: string | null = null
  settingsOpen = false
  fileTreeExpanded = new Map<string, boolean>()
  fileTreeNodes = new Map<string, FileNode[]>()
  fileContents = new Map<string, { content: string; error?: string }>()

  // ---- 内部 ----
  private client: RestClient | null = null
  private reconciler: Reconciler | null = null
  private listeners = new Set<Listener>()
  private snapshotHandlers: Array<() => void> = []

  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit = () => {
    for (const fn of this.listeners) fn()
  }

  // ============ 初始化 ============

  private initPromise: Promise<void> | null = null

  /** 幂等 init（StrictMode 双调用/重复挂载防护） */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit()
    }
    return this.initPromise
  }

  private async doInit() {
    const profileData = (await window.desktop.storeGet("connection.profiles")) ?? {
      profiles: [],
      activeId: null,
    }
    this.profiles = profileData.profiles
    this.activeProfileId = profileData.activeId
    const ps = await window.desktop.storeGet("project.state")
    if (ps) this.projectStates = ps
    this.tabMemory = (await window.desktop.storeGet("tabs.memory")) ?? {}
    this.themeMode = (await window.desktop.storeGet("theme.mode")) ?? "auto"
    this.localeMode = (await window.desktop.storeGet("locale.mode")) ?? "auto"

    if (this.activeProfileId) {
      await this.connect()
    }
    this.emit()
  }

  // ============ 连接 ============

  get activeProfile(): ConnectionProfile | null {
    return this.profiles.find((p) => p.id === this.activeProfileId) ?? null
  }

  getActiveClient(): RestClient | null {
    return this.client
  }

  get baseUrl(): string | null {
    return this.managedBaseUrl ?? this.activeProfile?.baseUrl ?? null
  }

  async connect() {
    const profile = this.activeProfile
    if (!profile) return
    // 连接前先拆干净旧连接（SSE 组、域数据、Tab）——防跨 profile 状态串台
    this.teardownConnection()
    this.connectionState = "connecting"
    this.connectionError = null
    this.emit()

    let baseUrl = profile.baseUrl
    let username = profile.username
    let password = profile.password
    if (profile.mode === "managed") {
      const res = await window.desktop.managedStart()
      if (!res.ok || !res.baseUrl) {
        this.connectionState = "disconnected"
        this.connectionError = res.error ?? "managed 启动失败"
        this.emit()
        return
      }
      baseUrl = res.baseUrl
      // managed 模式：主进程生成的凭据（spawn 时注入 OPENCODE_SERVER_PASSWORD）
      username = res.username ?? "opencode"
      password = res.password
      this.managedBaseUrl = baseUrl
    }

    const client = new RestClient({ baseUrl, username, password })
    let projects: Project[]
    try {
      this.health = await client.health()
      projects = await client.listProjects()
    } catch (e) {
      this.connectionState = "disconnected"
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.emit()
      return
    }

    // 全部快照成功后才暴露 client（失败路径不悬挂）
    this.client = client
    this.projects = projects
    // 生效凭据（managed 模式为主进程生成值）——后续 SSE 重建统一使用
    this.sseCreds = { username, password }

    // 首次连接默认打开 current + 最近活跃 1 个（design-layout）
    await this.ensureDefaultProjects()

    // 打开项目的快照 + 订阅
    await this.refreshAllOpenedProjects()
    // 启动恢复（design-tab-memory §8）：逐作用域按记忆重建 Tab（不动激活），
    // 当前作用域含激活规则；无记忆则首次打开。须在快照落地之后（WT-2 教训）
    {
      const slice = this.tabMemory[this.profileKey()] ?? {}
      for (const p of this.openedProjects) {
        for (const dir of new Set([p.worktree, ...(p.sandboxes ?? [])])) {
          if (slice[dir]) this.restoreScopeTabs(dir, false)
        }
      }
      this.restoreScopeTabs(this.scopeDirectory(), true)
    }
    this.startSse()
    this.connectionState = "streaming"
    this.emit()
  }

  async disconnect() {
    if (this.activeProfile?.mode === "managed") {
      await window.desktop.managedStop()
    }
    this.teardownConnection()
    this.connectionState = "disconnected"
    this.emit()
  }

  /** 拆除连接相关的一切运行时状态（SSE 组、域数据、Tab、managed 地址） */
  private teardownConnection() {
    for (const sub of this.sseGroup) sub.stop()
    this.sseGroup = []
    this.client = null
    this.managedBaseUrl = null
    this.health = null
    this.projects = []
    this.sessionsByProject.clear()
    this.messagesBySession.clear()
    this.pendingPartsMap.clear()
    this.optimisticBySession.clear()
    this.sessionStatus.clear()
    this.statusSources.clear()
    this.tabs = []
    this.activeTabKey = null
    this.commandCache = initialCommandCache()
    // 在途 fetch 无法中断；迟到的结果由 refreshCommands 的 client 身份守卫丢弃
    this.commandsInFlight.clear()
    if (this.catalogRefreshTimer != null) {
      clearTimeout(this.catalogRefreshTimer)
      this.catalogRefreshTimer = null
    }
    this.snapshottedDirs.clear()
    this.resetFileTree()
  }

  private async ensureDefaultProjects() {
    const ps = this.projectStateFor()
    if (ps.opened.length > 0) return
    // design-layout：首次连接默认打开 current + 最近活跃 1 个
    let currentId: string | null = null
    try {
      const current = await this.client!.currentProject()
      currentId = current.id
    } catch {
      currentId = this.projects[0]?.id ?? null
    }
    if (!currentId) return
    const recent = [...this.projects]
      .filter((p) => p.id !== currentId && p.id !== "global")
      .sort((a, b) => b.time.updated - a.time.updated)[0]
    ps.opened = recent ? [currentId, recent.id] : [currentId]
    ps.currentProjectId = currentId
    ps.currentWorkspaceId = null
    this.projectStates[this.profileKey()] = ps
    await this.persistProjectState()
  }

  private async refreshAllOpenedProjects() {
    await runLimited(this.openedProjects, 2, (p) => this.refreshSessionsForProject(p))
  }

  /**
   * 将单目录会话快照合入项目 map（按 projectID 过滤后交 session-merge 分域合并）。
   * 闸门：在途快照落地时项目可能已关闭、目录可能已被删除（removeWorkspace）——
   * 过期快照直接丢弃，防止复活已卸载的 worktree 会话。
   */
  private applySessionsSnapshot(projectId: string, directory: string, sessions: Session[]) {
    const project = this.openedProjects.find((p) => p.id === projectId)
    if (!project) return
    if (directory !== project.worktree && !(project.sandboxes ?? []).includes(directory)) return
    const filtered = sessions.filter((s) => s.projectID === projectId)
    const local = this.sessionsByProject.get(projectId) ?? new Map<string, Session>()
    // 空快照 = 该目录会话已全部删除，逐条清除本地同目录会话——merge 层 <2 条
    // 无开区间，"整目录被清空"场景永远删不掉。安全性依据（server 源码核实）：
    // 到达此处的快照必为成功响应（失败路径 null 直接跳过）；V2Session.list 不过滤
    // archived（归档会话也在列表里，空 ≠ 全被归档）、首页空即全表空（分页按
    // created desc 截断，不会把非空目录返回成空）
    if (filtered.length === 0) {
      for (const [id, s] of local) {
        if (s.directory === directory) local.delete(id)
      }
    }
    this.sessionsByProject.set(projectId, mergeSessionsSnapshot(local, directory, filtered))
    this.snapshottedDirs.add(directory)
  }

  private startSse() {
    const profile = this.activeProfile
    if (!profile || !this.client) return
    // 先停旧组（关闭的项目/旧 profile 的订阅不得继续收事件——锁定语义）
    for (const sub of this.sseGroup) sub.stop()
    this.sseGroup = []
    const username = this.sseCreds?.username ?? profile.username
    const password = this.sseCreds?.password ?? profile.password
    for (const dir of this.subscriptionDirectories()) {
      const sub = new SseSubscriber({
        baseUrl: this.activeBaseUrl!,
        directory: dir,
        username,
        password,
        onEvent: (ev) => this.handleEvent(dir, ev),
        onReconnected: () => {
          this.reconciler?.request()
          // 命令缓存自愈：重连后重拉，让网络抖动恢复期的瞬时空被自动覆盖
          // （openbuilder design-slash-command-refresh：事件驱动重拉 + 缓存保留两层互补）
          const cmdDir = this.activeChatDirectory() ?? this.commandCache.cacheDir
          if (cmdDir) void this.refreshCommands(cmdDir)
        },
        onStatus: () => this.updateSseAggregate(),
        log: (...args) => console.debug("[sse]", ...args),
      })
      sub.start()
      this.sseGroup.push(sub)
    }
    this.updateSseAggregate()
  }

  /**
   * SSE 订阅目录集合 = 打开项目的 worktree 根 ∪ 当前工作区目录，上限 MAX_SSE。
   * 两个约束（第二轮 review 后实测发现）：
   * 1. server 每条 /event 连接只圈定一个 directory（worktree 会话事件只在
   *    /event?directory=<worktree> 流上）——当前 scope 的目录必须订阅；
   * 2. 浏览器对同 host 的 HTTP/1.1 并发连接上限 6——SSE 占满后 REST 全部
   *    排队超时，因此预算 5 条，永久留 ≥1 条给 REST。
   * 非当前 worktree 的目录不订阅：其会话不在可见 scope 内，切换工作区时
   * 重订 + REST 快照兜底。
   */
  private subscriptionDirectories(): string[] {
    const dirs = new Set<string>()
    // 当前 scope 最优先（超预算截断时绝不能丢——它是聊天流式的命脉）
    const scope = this.scopeQuery.directory
    if (scope) dirs.add(scope)
    for (const p of this.openedProjects) dirs.add(p.worktree)
    return [...dirs].slice(0, 5)
  }

  /** 对账范围与订阅集合一致 */
  private sseCreds: { username?: string; password?: string } | null = null

  private sseGroup: SseSubscriber[] = []

  private get activeBaseUrl(): string | null {
    return this.baseUrl
  }

  private updateSseAggregate() {
    // 任一目录订阅非 connected 即 degraded（spec：degraded 态要明确提示）；
    // 空组（如全部项目关闭）不触发 degraded——无订阅 ≠ 连接异常
    const statuses = this.sseGroup.map((s) => s.getStatus())
    if (statuses.length === 0) {
      this.sseStatus = "stopped"
      if (this.connectionState === "degraded") this.connectionState = "streaming"
      this.emit()
      return
    }
    let sseStatus: SseStatus
    if (statuses.every((s) => s === "connected")) sseStatus = "connected"
    else if (statuses.includes("reconnecting")) sseStatus = "reconnecting"
    else sseStatus = "connecting"
    this.sseStatus = sseStatus
    if (this.connectionState !== "connecting" && this.connectionState !== "disconnected") {
      this.connectionState = sseStatus === "connected" ? "streaming" : "degraded"
    }
    this.emit()
  }

  // ============ 事件处理（闸门 + 应用） ============

  private handleEvent(directory: string, ev: OpencodeEvent) {
    // 闸门：关闭项目不更新（事件按订阅目录到达，订阅集合即打开集合）
    switch (ev.type) {
      case "session.created":
      case "session.updated": {
        const info = ev.properties.info as Session
        if (!info || info.directory !== directory) return
        let map = this.sessionsByProject.get(info.projectID)
        if (!map) {
          map = new Map()
          this.sessionsByProject.set(info.projectID, map)
        }
        map.set(info.id, info)
        break
      }
      case "session.deleted": {
        const info = ev.properties.info as Session
        if (!info) return
        this.sessionsByProject.get(info.projectID)?.delete(info.id)
        // 会话不存在了：对应 Tab 直接关 + 状态卸载
        this.closeTab(`chat:${info.id}`, { archive: false })
        this.cleanupSessionState(info.id)
        this.setSessionStatus(info.id, { type: "idle" })
        break
      }
      case "session.status": {
        // 权威状态设置（含 retry 态）；事件到达的目录流即其作用域。
        // 闸门（§4 事件闸门）：closeProject purge 与 startSse 重订之间有 async 窗口，
        // 已关项目的迟到事件在此丢弃，防复活刚 purge 的条目
        if (!this.isOpenedDirectory(directory)) return
        const { sessionID, status } = ev.properties as {
          sessionID: string
          status: SessionStatusValue
        }
        if (!sessionID || !status?.type) return
        this.setSessionStatus(sessionID, status, directory)
        break
      }
      case "session.idle": {
        // 仅状态实际变化时置 idle（防 spurious idle 抖动——移动端 wasBusy/wasRetry 守卫）；
        // 无条目 = 已是缺省 idle，直接忽略。闸门同 session.status
        if (!this.isOpenedDirectory(directory)) return
        const { sessionID } = ev.properties as { sessionID: string }
        if (!sessionID || !this.sessionStatus.has(sessionID)) return
        this.setSessionStatus(sessionID, { type: "idle" }, directory)
        break
      }
      case "message.updated": {
        const { sessionID, info } = ev.properties as { sessionID: string; info: Message }
        this.ensureConversation(sessionID)
        const m = this.messagesBySession.get(sessionID)
        if (m) {
          const prev = m.get(info.id)
          if (prev) {
            m.set(info.id, { info, parts: prev.parts })
          } else {
            // part 事件先于 message.info 到达：回放缓存（设计 §3"消息到达后回放"）
            const pending = this.pendingParts(sessionID).get(info.id) ?? []
            this.pendingParts(sessionID).delete(info.id)
            m.set(info.id, { info, parts: pending })
          }
        }
        if (info.role === "user") {
          this.clearOptimistic(sessionID)
        }
        // busy/retry 不再从 message.completed 推断（中间步骤 tool-calls 完成会造成
        // dots 闪烁）：状态由 session.status/session.idle 事件权威驱动（design-typing-indicator §4）
        break
      }
      case "message.removed": {
        const { sessionID, messageID } = ev.properties as { sessionID: string; messageID: string }
        this.messagesBySession.get(sessionID)?.delete(messageID)
        break
      }
      case "message.part.updated": {
        const { sessionID, part } = ev.properties as { sessionID: string; part: Part }
        this.ensureConversation(sessionID)
        const conv = this.messagesBySession.get(sessionID)
        const msg = conv?.get(part.messageID)
        if (msg) {
          const idx = msg.parts.findIndex((p) => p.id === part.id)
          if (idx >= 0) {
            msg.parts[idx] = part
          } else {
            msg.parts.push(part)
          }
          // 触发 immutable 更新
          conv!.set(part.messageID, { ...msg })
        } else if (conv) {
          // 消息 info 未到，先缓存 part
          this.pendingParts(sessionID).set(part.messageID, [
            ...(this.pendingParts(sessionID).get(part.messageID) ?? []),
            part,
          ])
        }
        break
      }
      case "message.part.removed": {
        const { sessionID, messageID, partID } = ev.properties as {
          sessionID: string
          messageID: string
          partID: string
        }
        const msg = this.messagesBySession.get(sessionID)?.get(messageID)
        if (msg) {
          msg.parts = msg.parts.filter((p) => p.id !== partID)
        }
        const pending = this.pendingParts(sessionID).get(messageID)
        if (pending) {
          this.pendingParts(sessionID).set(
            messageID,
            pending.filter((p) => p.id !== partID),
          )
        }
        break
      }
      case "catalog.updated":
      case "mcp.tools.changed": {
        // 服务端命令/skill 目录或 MCP 工具变化 → 重拉注册表（不必等下次输入 `/`）。
        // 事件在每条订阅流上都广播，多目录订阅会连发——去抖合并为一次刷新。
        this.scheduleCatalogRefresh()
        break
      }
      default:
        // 未知事件透传忽略（AGENTS.md 风险对策）
        break
    }
    this.emit()
  }

  private catalogRefreshTimer: ReturnType<typeof setTimeout> | null = null

  private scheduleCatalogRefresh() {
    if (this.catalogRefreshTimer != null) return
    this.catalogRefreshTimer = setTimeout(() => {
      this.catalogRefreshTimer = null
      const dir = this.activeChatDirectory()
      // 无激活 chat Tab 时跳过（无"当前所见"目录），下次输入 `/` 会触发
      if (dir) void this.refreshCommands(dir)
    }, 1500)
  }

  /** 激活 chat Tab 的 directory（命令刷新的"当前所见"目录） */
  private activeChatDirectory(): string | null {
    const tab = this.activeTab
    return tab?.kind === "chat" ? (tab.directory ?? null) : null
  }

  private pendingPartsMap = new Map<string, Map<string, Part[]>>()

  private pendingParts(sessionID: string) {
    let m = this.pendingPartsMap.get(sessionID)
    if (!m) {
      m = new Map()
      this.pendingPartsMap.set(sessionID, m)
    }
    return m
  }

  /**
   * 惰性累积容器（design-message-accumulation）：事件到达即建容器，不发 REST。
   * 门槛（第二轮 review P3-7）：有 Tab 或已有容器的会话无条件累积；
   * 其余（其他客户端驱动的会话）最多累积 MAX_LAZY 容器，超出丢弃
   * （打开时走 REST 快照，不损失数据）。
   */
  private ensureConversation(sessionID: string) {
    if (this.messagesBySession.has(sessionID)) return
    const hasTab = this.tabs.some((t) => t.kind === "chat" && t.key === `chat:${sessionID}`)
    if (!hasTab && this.messagesBySession.size >= 20) return
    this.messagesBySession.set(sessionID, new Map())
  }

  private clearOptimistic(sessionID: string) {
    if (this.optimisticBySession.has(sessionID)) {
      this.optimisticBySession.delete(sessionID)
    }
  }

  // ============ 会话状态（design-typing-indicator §4） ============

  statusOf(sessionID: string): SessionStatusValue {
    return this.sessionStatus.get(sessionID) ?? { type: "idle" }
  }

  /** busy/retry 均视为进行中（Tab 状态点、composer 停止按钮、关 Tab 确认） */
  isSessionActive(sessionID: string): boolean {
    return this.sessionStatus.has(sessionID)
  }

  private setSessionStatus(sessionID: string, status: SessionStatusValue, directory?: string) {
    if (status.type === "idle") {
      this.sessionStatus.delete(sessionID)
      this.statusSources.delete(sessionID)
    } else {
      this.sessionStatus.set(sessionID, status)
      if (directory) this.statusSources.set(sessionID, directory)
    }
  }

  /**
   * REST 状态快照按目录覆盖合并（冷启动/重连对账/项目打开）。
   * 失败目录（null）保留旧值——严禁 clear()+addAll()（SS-1 回归）。
   */
  private applyStatusSnapshot(directory: string, fresh: Record<string, SessionStatusValue> | null) {
    if (!fresh) return
    const merged = mergeStatusSnapshot(this.sessionStatus, this.statusSources, directory, fresh)
    this.sessionStatus = merged.status
    this.statusSources = merged.sources
  }

  /** 卸载目录级状态（关项目/删工作区：该目录来源的状态随会话状态一并卸载） */
  private purgeStatusForDirectories(dirs: string[]) {
    const set = new Set(dirs)
    for (const [sid, dir] of this.statusSources) {
      if (set.has(dir)) {
        this.statusSources.delete(sid)
        this.sessionStatus.delete(sid)
      }
    }
  }

  /** 目录是否仍属于某个打开项目（root 或其 worktree）——在途状态快照的闸门 */
  private isOpenedDirectory(dir: string): boolean {
    return this.openedProjects.some(
      (p) => p.worktree === dir || (p.sandboxes ?? []).includes(dir),
    )
  }

  // ============ 项目/工作区 ============

  get openedProjects(): Project[] {
    const ps = this.projectStates[this.profileKey()]
    if (!ps) return []
    const ids = new Set(ps.opened)
    return this.projects.filter((p) => ids.has(p.id))
  }

  get currentProject(): Project | null {
    const ps = this.projectStates[this.profileKey()]
    if (!ps?.currentProjectId) return null
    return this.projects.find((p) => p.id === ps.currentProjectId) ?? null
  }

  get currentWorkspace(): { name: string; directory: string } | null {
    const ps = this.projectStates[this.profileKey()]
    if (!ps?.currentWorkspaceId || !ps.currentProjectId) return null
    const p = this.projects.find((x) => x.id === ps.currentProjectId)
    const dir = ps.currentWorkspaceId
    if (!p?.sandboxes?.includes(dir)) return null
    return { name: dir.split("/").pop() ?? dir, directory: dir }
  }

  /**
   * 当前作用域：directory = 当前工作区路径（主工作区 = 项目根，worktree = 其路径）。
   * worktree 过滤是纯客户端行为（参考移动端 server_store.dart：s.directory == worktreeDir）；
   * 实测 `?workspace=` 参数（wrk id 体系）对 worktree API 创建的目录无效且 500，不用。
   */
  get scopeQuery(): { directory: string; workspace?: string } {
    return { directory: this.currentWorkspace?.directory ?? this.currentProject?.worktree ?? "" }
  }

  projectStateFor(profileId = this.activeProfileId ?? "default"): ProjectState {
    return (
      this.projectStates[profileId] ?? {
        opened: [],
        currentProjectId: null,
        currentWorkspaceId: null,
      }
    )
  }

  private profileKey() {
    return this.activeProfileId ?? "default"
  }

  private async persistProjectState() {
    this.projectStates[this.profileKey()] = this.projectStateFor()
    await window.desktop.storeSet("project.state", this.projectStates)
  }

  /**
   * 开项目（先切换后加载）：workspaceDirectory = 直达的 worktree（跨项目点工作区行，
   * 须在该项目 sandboxes 内——幻影 currentWorkspaceId 防御，同 createWorkspace）。
   * 同步段：作用域状态立即生效并渲染——左栏高亮/中栏标题即时跟手；文件树同步清空
   * （FilePanel 侦听 workspace 变化即刻重载右栏）、SSE 重订到新 scope、有记忆的作用域
   * 即时恢复 Tab（immediate 模式：无记忆只清算激活，首次全量打开等快照落地）。
   * 异步段：持久化 + 快照刷新，落地后完整恢复（闸门：在途时用户可能已切走）。
   */
  async openProject(projectId: string, workspaceDirectory?: string) {
    const ps = this.projectStateFor()
    if (!ps.opened.includes(projectId)) ps.opened.push(projectId)
    ps.currentProjectId = projectId
    ps.currentWorkspaceId =
      workspaceDirectory != null &&
      this.projects.find((p) => p.id === projectId)?.sandboxes?.includes(workspaceDirectory)
        ? workspaceDirectory
        : null
    // 立即登记：同步段（SSE 订阅目录/作用域派生）即读得到新状态
    this.projectStates[this.profileKey()] = ps
    const expectedDir = this.scopeDirectory()
    this.resetFileTree()
    this.startSse()
    this.restoreScopeTabs(expectedDir, true, true)
    this.emit()
    await this.persistProjectState()
    await this.refreshAllOpenedProjects()
    if (this.currentProject?.id !== projectId || this.scopeDirectory() !== expectedDir) return
    this.restoreScopeTabs(expectedDir, true)
  }

  async closeProject(projectId: string) {
    const ps = this.projectStateFor()
    ps.opened = ps.opened.filter((id) => id !== projectId)
    if (ps.currentProjectId === projectId) {
      // 回退到剩余打开项目中最近活跃的一个
      const remaining = this.projects
        .filter((p) => ps.opened.includes(p.id))
        .sort((a, b) => b.time.updated - a.time.updated)
      ps.currentProjectId = remaining[0]?.id ?? null
      ps.currentWorkspaceId = null
    }
    // 卸载该项目的会话状态（关闭 = 不展示 + 不更新）；状态随目录一并卸载（project-scoped）
    this.sessionsByProject.delete(projectId)
    const project = this.projects.find((p) => p.id === projectId)
    if (project) {
      const dirs = [project.worktree, ...(project.sandboxes ?? [])]
      this.purgeStatusForDirectories(dirs)
      // 快照落地标记随目录一并卸载：重开项目时不因残留标记把"快照未落地"
      // 误判为"真实空目录"而写零 Tab 哨兵
      for (const d of dirs) this.snapshottedDirs.delete(d)
    }
    // 该项目的 chat Tab 随之关闭（仅关 Tab，不归档——归档只发生在显式关闭 Tab）
    for (const tab of [...this.tabs]) {
      if (tab.kind !== "chat") continue
      if (tab.projectId === projectId) {
        this.closeTab(tab.key)
        this.cleanupSessionState(tab.key.slice(5))
      } else if (project && tab.directory === project.worktree) {
        this.closeTab(tab.key)
        this.cleanupSessionState(tab.key.slice(5))
      }
    }
    // 清除该项目全部 Tab 记忆（须在关 Tab 之后——closeTab 的记忆同步会重建条目，
    // 此处最终清除；按 projectId 匹配而非 sandboxes 枚举，外部删除的 worktree
    // 目录不在 sandboxes 里，按目录枚举会留孤儿条目永久残留 store.json）
    this.forgetProjectMemory(projectId)
    await this.persistProjectState()
    await this.switchProjectContext()
    this.emit()
  }

  async setCurrentProject(projectId: string, workspaceDirectory?: string) {
    await this.openProject(projectId, workspaceDirectory)
  }

  /** 切工作区（先切换后加载，同 openProject）：参数是 worktree directory（null = 主工作区）。
   *  同值早退（不刷新不恢复）——需要重同步作用域时须先切走再切回 */
  async setCurrentWorkspace(directory: string | null) {
    const project = this.currentProject
    if (!project) return
    // 幻影 directory 防御（同 openProject）：不在 sandboxes 内的目录视为主工作区，
    // 防把幻影 currentWorkspaceId 持久化（currentWorkspace getter 会拒认、下次启动才自愈）
    const valid =
      directory != null && (project.sandboxes ?? []).includes(directory) ? directory : null
    const ps = this.projectStateFor()
    if (ps.currentWorkspaceId === valid) return
    ps.currentWorkspaceId = valid
    const expectedDir = this.scopeDirectory()
    this.resetFileTree()
    this.startSse()
    this.restoreScopeTabs(expectedDir, true, true)
    this.emit()
    // 再加载：持久化 + 本项目快照刷新（WT-1：worktree 会话只有逐目录快照可达）
    await this.persistProjectState()
    await this.refreshSessionsForProject(project)
    if (this.currentProject?.id !== project.id || this.scopeDirectory() !== expectedDir) return
    this.restoreScopeTabs(expectedDir, true)
  }

  /** 关闭当前项目后（openProject/closeProject 链）：快照 + SSE 重订阅 + 文件树重置 + 恢复该作用域的 Tab 记忆 */
  private async switchProjectContext() {
    if (!this.client) return
    await this.refreshAllOpenedProjects()
    this.startSse()
    this.resetFileTree()
    this.restoreScopeTabs(this.scopeDirectory(), true)
  }

  // ============ Tab 记忆（design-tab-memory） ============

  private memorySlice(): Record<string, ScopeTabMemory> {
    return this.tabMemory[this.profileKey()] ?? {}
  }

  /** 写入单作用域记忆并整体落盘（体量 KB 级，不做 debounce；写失败仅内存/持久暂不一致，重启回退旧记忆） */
  private setMemory(directory: string, mem: ScopeTabMemory) {
    const key = this.profileKey()
    if (!this.tabMemory[key]) this.tabMemory[key] = {}
    this.tabMemory[key][directory] = mem
    void window.desktop.storeSet("tabs.memory", this.tabMemory).catch(() => {})
  }

  private findProjectOwningDirectory(directory: string): Project | null {
    return (
      this.projects.find(
        (p) => p.worktree === directory || (p.sandboxes ?? []).includes(directory),
      ) ?? null
    )
  }

  /** live tabs → 记忆派生落盘（§5 挂点：openChatTab/closeTab/setActiveTab） */
  private syncScopeMemory(directory: string) {
    const project = this.findProjectOwningDirectory(directory)
    if (!project) return
    const prev = this.memorySlice()[directory]
    this.setMemory(
      directory,
      deriveMemory(project.id, directory, this.tabs, this.activeTabKey, prev?.active ?? null),
    )
  }

  /** 删除某项目的全部记忆条目（closeProject：按 projectId 匹配，含外部删除的 worktree 目录） */
  private forgetProjectMemory(projectId: string) {
    const key = this.profileKey()
    const slice = this.tabMemory[key]
    if (!slice) return
    let changed = false
    for (const dir of Object.keys(slice)) {
      if (slice[dir].projectId === projectId) {
        delete slice[dir]
        changed = true
      }
    }
    if (changed) void window.desktop.storeSet("tabs.memory", this.tabMemory).catch(() => {})
  }

  /** 无激活副作用的开 Tab（恢复路径专用，§5：不走 openChatTab 的记忆同步钩子） */
  private openChatTabSilent(session: Session) {
    const key = `chat:${session.id}`
    if (this.tabs.some((t) => t.key === key)) return
    this.tabs.push({
      kind: "chat",
      key,
      projectId: session.projectID,
      title: session.title || session.slug || "",
      directory: session.directory,
    })
  }

  /**
   * 切入作用域的 Tab 恢复（§6，替换原"补开最近活跃前 8"）：
   * - 无记忆 / 记忆 projectId 不符（worktree 同路径重建）→ 首次打开：
   *   全量开未归档会话（created 升序），active = 最近活跃；真实空目录也写入空记忆（§3.3）
   * - 有记忆 → 按记忆顺序补齐 live Tab（复用已开、不补开记忆外会话）+ 校验收缩
   * - 防御闸门：快照未落地（可见与全量皆空）时不动作，下次切入/重启再恢复
   * - 恢复后无 Tab 时中栏显示会话列表视图（master 40459e9 后为无 Tab 引导页语义）
   * applyActivation=false 供启动逐作用域重建（§8 不改变激活）。
   * immediate=true 供"先切换后加载"的切换即时段（openProject/setCurrentWorkspace）：
   * 内存快照可能滞后，首次打开分支不在此时做（新会话会因记忆已写入而不补开，
   * 全量打开留给快照落地后的完整恢复），只做有记忆的即时恢复 + 激活清算；
   * 也不在此时关闭死会话 Tab（数据滞后时保守不动，完整恢复统一收敛）。
   */
  private restoreScopeTabs(directory: string, applyActivation = true, immediate = false) {
    if (!directory) return
    const project = this.findProjectOwningDirectory(directory)
    if (!project) return
    const visible = this.sessionsInDirectory(project.id, directory)
    const all = [...(this.sessionsByProject.get(project.id)?.values() ?? [])].filter(
      (s) => s.directory === directory,
    )
    const mem = this.memorySlice()[directory]

    let next: ScopeTabMemory
    if (!mem || mem.projectId !== project.id) {
      if (immediate) {
        this.clearCrossScopeActivation(directory)
        return
      }
      // 快照未落地（从未成功）且会话为空：无法与真实空目录区分，不写零 Tab
      // 哨兵（§3.3 空记忆 = 用户已收敛到零 Tab 的承诺，误写会让该作用域永不
      // 全量打开）——下次切入重试，幂等
      if (visible.length === 0 && !this.snapshottedDirs.has(directory)) return
      next = buildFirstOpenMemory(project.id, visible)
      const byId = new Map(visible.map((s) => [s.id, s]))
      for (const id of next.tabs) {
        const s = byId.get(id)
        if (s) this.openChatTabSilent(s)
      }
    } else {
      // 防御闸门（§6）：记忆非空但本地该目录会话全空 = 快照未落地，不动作。
      // 例外：snapshottedDirs 含该目录 = 空态来自成功快照（整目录被他端清空时
      // applySessionsSnapshot 会清除本地会话，空可信）——照常收缩收敛
      if (isSnapshotMissing(mem, visible, all) && !this.snapshottedDirs.has(directory)) {
        this.clearCrossScopeActivation(directory)
        return
      }
      next = shrinkMemoryTabs(mem, visible)
      const byId = new Map(visible.map((s) => [s.id, s]))
      for (const id of next.tabs) {
        const s = byId.get(id)
        if (s) this.openChatTabSilent(s)
      }
    }

    // 死会话 Tab 收敛（§6 完整恢复段）：会话已不可见（他端归档/删除/subagent 化，
    // 未订阅目录收不到事件）的 live chat Tab 关闭。只关"会话不可见"的 Tab——
    // 会话仍可见但记忆外的 Tab 按"不强制收敛"保留；immediate 段数据滞后不做；
    // snapshottedDirs 闸门保证只凭可信快照关闭（失败轮保守保留旧数据，不会误关）
    if (!immediate && this.snapshottedDirs.has(directory)) {
      const visibleIds = new Set(visible.map((s) => s.id))
      for (const tab of [...this.tabs]) {
        if (tab.kind === "chat" && tab.directory === directory && !visibleIds.has(tab.key.slice(5))) {
          this.closeTab(tab.key)
        }
      }
    }

    if (applyActivation) {
      const resolved = resolveRestoreActive(next, this.activeTab?.kind ?? null)
      if (resolved !== undefined) {
        this.activeTabKey = resolved != null ? `chat:${resolved}` : null
        next = { ...next, active: resolved }
      }
    }
    this.setMemory(directory, next)
    this.emit()
  }

  /** 激活不得指向其他作用域的 chat Tab——Tab 条按作用域过滤不显示它，
   *  中栏却会渲染其会话；file Tab 全局可见，保留 */
  private clearCrossScopeActivation(directory: string) {
    const active = this.activeTab
    if (active?.kind === "chat" && active.directory !== directory) {
      this.activeTabKey = null
      this.emit()
    }
  }

  /** 卸载单个会话的运行时状态（关 Tab/删会话/切项目时调用，防无界增长）。
   *  注意：sessionStatus 不在此卸载——状态生命周期是 project-scoped（左栏指示器仍
   *  消费它），只在关项目/删工作区/会话删除/拆连接时清理；idle 条目本身不落 map。 */
  private cleanupSessionState(sessionID: string) {
    this.messagesBySession.delete(sessionID)
    this.pendingPartsMap.delete(sessionID)
    this.optimisticBySession.delete(sessionID)
  }

  private resetFileTree() {
    this.fileTreeExpanded.clear()
    this.fileTreeNodes.clear()
    this.fileContents.clear()
  }

  /**
   * 拉取项目会话快照：项目根 + 各 worktree 目录**逐目录**拉取（实测
   * /session?directory=X 精确匹配，项目根快照不含 worktree 会话，切进工作区/
   * 左栏指示器都依赖 worktree 目录有自己的快照）；合并按 directory 分域。
   * 同一批目录附带拉会话状态快照（GET /session/status，冷启动/项目打开路径；
   * 重连对账由 Reconciler 负责）。
   * 成功落地的目录记入 snapshottedDirs（applySessionsSnapshot 统一维护，含对账
   * 路径）——restoreScopeTabs 以此区分"真实空目录"（可写空记忆哨兵）与
   * "快照未落地"（不得写零 Tab 哨兵，design-tab-memory §6）。失败的目录不合并
   * 空快照（session-merge 保守保留旧数据）；关项目/删工作区时随目录卸载标记。
   */
  private snapshottedDirs = new Set<string>()

  async refreshSessionsForProject(project: Project) {
    const client = this.client
    if (!client) return
    const dirs = [...new Set([project.worktree, ...(project.sandboxes ?? [])])]
    await runLimited(dirs, 3, async (dir) => {
      const sessions = await client.listSessions(dir).catch(() => null)
      if (sessions === null) return
      this.applySessionsSnapshot(project.id, dir, sessions)
      const statuses = await client.listSessionStatus(dir).catch(() => null)
      // 闸门：在途快照落地时项目可能已关闭/目录可能已删——过期状态直接丢弃
      const still = this.openedProjects.find((p) => p.id === project.id)
      if (still && (still.worktree === dir || (still.sandboxes ?? []).includes(dir))) {
        this.applyStatusSnapshot(dir, statuses)
      }
    })
  }

  /** name 省略：由 server 生成随机 slug（两端一致的默认行为） */
  async createWorkspace(): Promise<{ ok: boolean; error?: string }> {
    if (!this.client || !this.currentProject) return { ok: false, error: "no project" }
    try {
      const result = await this.client.createWorktree(this.currentProject.worktree)
      // worktree API 返回轻量对象，重拉列表拿完整 Workspace 记录
      await this.refreshWorkspacesForProject(this.currentProject)
      // 默认切换到新 worktree；setCurrentWorkspace 内含会话快照/SSE 重订/文件树重置/开作用域 Tab。
      // 须校验重拉后 sandboxes 已含新目录（重拉失败/列表滞后时 currentWorkspace getter 会拒认，
      // 先行切换会把幻影 currentWorkspaceId 持久化、下次启动才延迟生效）——此时退回仅订阅
      if (this.currentProject?.sandboxes?.includes(result.directory)) {
        await this.setCurrentWorkspace(result.directory)
      } else {
        this.startSse()
        this.emit()
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async removeWorkspace(directory: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.client || !this.currentProject) return { ok: false, error: "no project" }
    try {
      await this.client.removeWorktree(this.currentProject.worktree, directory)
      // worktree 列表数据源是 Project.sandboxes，重拉项目列表同步
      await this.refreshWorkspacesForProject(this.currentProject)
      // 卸载已删目录的会话与状态（目录已出 sandboxes，此后无快照/订阅通道覆盖它）
      const map = this.sessionsByProject.get(this.currentProject.id)
      if (map) {
        for (const [id, s] of map) {
          if (s.directory === directory) map.delete(id)
        }
      }
      this.purgeStatusForDirectories([directory])
      this.snapshottedDirs.delete(directory)
      // 显式关闭该目录 live chat Tab：订阅即将拆除，session.deleted 事件
      // 兜底存在窗口期（design-tab-memory §5）
      for (const tab of [...this.tabs]) {
        if (tab.kind === "chat" && tab.directory === directory) {
          this.closeTab(tab.key)
          this.cleanupSessionState(tab.key.slice(5))
        }
      }
      // 删除该目录记忆（目录已死；须在关 Tab 之后——closeTab 同步会重建条目）
      const key = this.profileKey()
      if (this.tabMemory[key]) {
        delete this.tabMemory[key][directory]
        void window.desktop.storeSet("tabs.memory", this.tabMemory).catch(() => {})
      }
      const ps = this.projectStateFor()
      if (ps.currentWorkspaceId === directory) {
        ps.currentWorkspaceId = null
        await this.persistProjectState()
      }
      await this.refreshSessionsForProject(this.currentProject)
      this.resetFileTree()
      this.startSse()
      // 删除的是当前 worktree → 作用域已切回项目根：与其他切换路径一致，
      // 恢复根作用域的 Tab 与激活（否则有根 Tab 却落到会话列表视图）
      if (!ps.currentWorkspaceId) {
        this.restoreScopeTabs(this.currentProject.worktree, true)
      }
      this.emit()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async refreshWorkspacesForProject(project: Project) {
    // worktree 列表数据源是 Project.sandboxes（directory 数组，实测 /experimental/workspace 不可靠）
    const fresh = await this.client?.listProjects().catch(() => null)
    if (fresh) this.projects = fresh
    this.emit()
  }

  /** 当前项目的工作区列表（从 sandboxes 派生，name 取 directory 末段） */
  /** 指定项目的工作区列表（从 sandboxes 派生，name 取 directory 末段） */
  workspacesOfProject(projectId: string): Array<{ name: string; directory: string }> {
    const p = this.projects.find((x) => x.id === projectId)
    if (!p) return []
    // 防御：主工作区 = 项目行本身，sandboxes 若含项目根路径则排除（防重复展示）
    return (p.sandboxes ?? [])
      .filter((dir) => dir !== p.worktree)
      .map((dir) => ({
        name: dir.split("/").pop() ?? dir,
        directory: dir,
      }))
  }

  get workspacesOfCurrentProject(): Array<{ name: string; directory: string }> {
    return this.currentProject ? this.workspacesOfProject(this.currentProject.id) : []
  }

  // ============ 会话 ============

  /** 当前作用域的 directory（客户端 worktree 过滤：directory 精确匹配） */
  private scopeDirectory(): string {
    return this.currentWorkspace?.directory ?? this.currentProject?.worktree ?? ""
  }

  /** 指定目录的未归档 + 非 subagent 会话（updated 降序）——左栏指示器数据源 */
  sessionsInDirectory(projectId: string, directory: string): Session[] {
    return [...(this.sessionsByProject.get(projectId)?.values() ?? [])]
      .filter((s) => !s.time.archived && !s.parentID && s.directory === directory)
      .sort((a, b) => b.time.updated - a.time.updated)
  }

  /** 当前作用域的可见会话：未归档 + 非 subagent（parentID 为空） */
  get visibleSessions(): Session[] {
    const project = this.currentProject
    if (!project) return []
    return this.sessionsInDirectory(project.id, this.scopeDirectory())
  }

  get archivedSessions(): Session[] {
    const project = this.currentProject
    if (!project) return []
    const dir = this.scopeDirectory()
    return [...(this.sessionsByProject.get(project.id)?.values() ?? [])]
      .filter((s) => !s.parentID && s.time.archived && s.directory === dir)
      .sort((a, b) => b.time.updated - a.time.updated)
  }

  /**
   * 新建会话。opts.openTab = false 供引导页使用：先建会话发首条消息，
   * 发送成功才开 Tab（失败保留草稿，重试复用同一会话，不产生空 Tab）。
   */
  async createSession(opts: { openTab?: boolean } = {}): Promise<Session | null> {
    if (!this.client || !this.currentProject) return null
    const { directory } = this.scopeQuery
    try {
      const session = await this.client.createSession(directory)
      const map = this.sessionsByProject.get(this.currentProject.id) ?? new Map()
      map.set(session.id, session)
      this.sessionsByProject.set(this.currentProject.id, map)
      if (opts.openTab !== false) this.openChatTab(session)
      this.emit()
      return session
    } catch (e) {
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.emit()
      return null
    }
  }

  async loadSessionMessages(sessionID: string, directory: string) {
    if (!this.client) return
    const msgs = await this.client
      .listMessages(sessionID, directory, 100)
      .catch(() => null)
    if (!msgs) return
    const local = this.messagesBySession.get(sessionID) ?? new Map()
    const merged = mergeSnapshotIntoMessages(local, msgs)
    // 应用 pending parts
    const pending = this.pendingParts(sessionID)
    for (const [mid, parts] of pending) {
      const m = merged.get(mid)
      if (m) {
        for (const p of parts) {
          const idx = m.parts.findIndex((x) => x.id === p.id)
          if (idx >= 0) m.parts[idx] = p
          else m.parts.push(p)
        }
      }
    }
    pending.clear()
    this.messagesBySession.set(sessionID, merged)
    // finish 推断（design-typing-indicator §4 来源 5）：末条 assistant 终态 ⇒ idle；
    // tool-calls/null 不触发（进行中消息在 REST 可见，D-SS-A）——兜底断线丢
    // session.idle 的场景（手动刷新/激活重拉）
    if (inferIdleFromMessages([...merged.values()].sort(sortMessages).map((m) => m.info))) {
      this.setSessionStatus(sessionID, { type: "idle" })
    }
    this.emit()
  }

  async archiveSession(sessionID: string): Promise<boolean> {
    return this.patchSessionArchive(sessionID, Date.now())
  }

  async unarchiveSession(sessionID: string): Promise<boolean> {
    return this.patchSessionArchive(sessionID, 0)
  }

  private async patchSessionArchive(sessionID: string, archived: number): Promise<boolean> {
    if (!this.client) return false
    const session = this.findSession(sessionID)
    if (!session) return false
    try {
      const updated = await this.client.updateSession(sessionID, session.directory, {
        time: { archived },
      })
      if (!updated) return false
      const map = this.sessionsByProject.get(updated.projectID)
      map?.set(updated.id, updated)
      this.emit()
      return true
    } catch (e) {
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.emit()
      return false
    }
  }

  // 重命名/删除会话的 store 方法随 v0.1 会话卡片菜单一并移除（UI 无入口），
  // v0.2 chat 视图头部菜单落地时恢复（REST 层 updateSession/deleteSession 仍在）

  findSession(sessionID: string): Session | null {
    for (const map of this.sessionsByProject.values()) {
      const s = map.get(sessionID)
      if (s) return s
    }
    return null
  }

  async sendPrompt(sessionID: string, text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: "not connected" }
    const session = this.findSession(sessionID)
    if (!session) return { ok: false, error: "session not found" }
    // 乐观消息（design-optimistic-messages：POST 不可信为已送达，真实 user 事件到达即清）
    const optimistic: OptimisticMessage = {
      optimistic: true,
      localId: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: Date.now(),
    }
    this.optimisticBySession.set(sessionID, [
      ...(this.optimisticBySession.get(sessionID) ?? []),
      optimistic,
    ])
    this.emit()
    try {
      await this.client.promptAsync(sessionID, session.directory, [{ type: "text", text }])
      // 乐观 busy（design-typing-indicator §4 来源 3）：不等 session.status 事件，
      // 消除首字节延迟——dots 于预留槽内立即出现
      this.setSessionStatus(sessionID, { type: "busy" }, session.directory)
      this.emit()
      return { ok: true }
    } catch (e) {
      // 撤回乐观 + 提示（写操作不自动重试）；connectionError 经状态栏可见
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.optimisticBySession.set(
        sessionID,
        (this.optimisticBySession.get(sessionID) ?? []).filter((o) => o.localId !== optimistic.localId),
      )
      this.emit()
      return { ok: false, error: this.connectionError }
    }
  }

  async abortSession(sessionID: string) {
    if (!this.client) return
    const session = this.findSession(sessionID)
    if (!session) return
    await this.client.abortSession(sessionID, session.directory).catch(() => {})
  }

  // ============ 斜杠命令 ============

  private commandsInFlight = new Map<string, Promise<void>>()

  get commandsRefreshing(): boolean {
    return this.commandsInFlight.size > 0
  }

  /** 缓存是否可用（同目录且非空）——命令菜单数据源 */
  commandsFor(directory: string): CommandInfo[] {
    return this.commandCache.cacheDir === directory ? this.commandCache.commands : []
  }

  get commandsDegraded(): boolean {
    return this.commandCache.degraded
  }

  /**
   * 拉取命令注册表（空响应防护见 command-cache.ts）。
   * - 同目录 in-flight 共享同一 Promise：发送前的强制重拉会**等待**在途
   *   请求完成再匹配，而非立即读旧缓存（保证"最新注册表"语义）；
   * - 在途结果跨越 teardown（断开/切 profile）时按 client 身份守卫丢弃，
   *   防旧 server 的命令写入新连接的缓存。
   */
  async refreshCommands(directory: string | null): Promise<void> {
    const client = this.client
    if (!client || !directory) return
    const existing = this.commandsInFlight.get(directory)
    if (existing) return existing
    let p!: Promise<void>
    p = (async () => {
      let result
      try {
        result = { ok: true as const, commands: await client.listCommands(directory) }
      } catch {
        result = { ok: false as const }
      }
      if (this.client !== client) return
      this.commandCache = applyCommandFetch(this.commandCache, directory, result)
      this.emit()
    })().finally(() => {
      // 身份比对：迟到的旧请求不得误删重连后同目录的新 in-flight 条目
      if (this.commandsInFlight.get(directory) === p) this.commandsInFlight.delete(directory)
    })
    this.commandsInFlight.set(directory, p)
    return p
  }

  /** 发送斜杠命令：乐观回显原始 `/cmd args`，真实 user 消息（subtask/展开文本）到达即清 */
  async sendCommand(
    sessionID: string,
    command: string,
    arguments_: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: "not connected" }
    const session = this.findSession(sessionID)
    if (!session) return { ok: false, error: "session not found" }
    const text = arguments_ ? `/${command} ${arguments_}` : `/${command}`
    const optimistic: OptimisticMessage = {
      optimistic: true,
      localId: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: Date.now(),
    }
    this.optimisticBySession.set(sessionID, [
      ...(this.optimisticBySession.get(sessionID) ?? []),
      optimistic,
    ])
    this.emit()
    try {
      await this.client.sendCommand(sessionID, session.directory, command, arguments_)
      return { ok: true }
    } catch (e) {
      this.optimisticBySession.set(
        sessionID,
        (this.optimisticBySession.get(sessionID) ?? []).filter((o) => o.localId !== optimistic.localId),
      )
      this.emit()
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // ============ Tab ============

  /** 打开 chat Tab = 取消归档（与"关闭 Tab = 归档"对称） */
  openChatTab(session: Session) {
    if (session.time.archived) {
      void this.unarchiveSession(session.id).then(() => {
        // 归档事件/响应到达后 Tab 标题等状态自然刷新
      })
    }
    const key = `chat:${session.id}`
    const existing = this.tabs.find((t) => t.key === key)
    if (!existing) {
      this.tabs.push({
        kind: "chat",
        key,
        projectId: session.projectID,
        title: session.title || session.slug || "",
        directory: session.directory,
      })
    } else {
      existing.title = session.title || session.slug || ""
    }
    this.activeTabKey = key
    // Tab 记忆同步（§5 挂点）：新 Tab 追加尾部 + active 更新
    if (session.directory) this.syncScopeMemory(session.directory)
    this.emit()
  }

  openFileTab(absolutePath: string) {
    const key = `file:${absolutePath}`
    if (!this.tabs.find((t) => t.key === key)) {
      const name = absolutePath.split("/").pop() ?? absolutePath
      this.tabs.push({ kind: "file", key, projectId: this.currentProject?.id ?? "", title: name })
      void this.loadFileContent(absolutePath)
    }
    this.activeTabKey = key
    this.emit()
  }

  async loadFileContent(absolutePath: string) {
    const { directory, workspace } = this.scopeQuery
    try {
      const content = await this.client!.readFileContent(directory, absolutePath, workspace)
      this.fileContents.set(absolutePath, { content })
    } catch (e) {
      this.fileContents.set(absolutePath, {
        content: "",
        error: e instanceof Error ? e.message : String(e),
      })
    }
    this.emit()
  }

  /** 关闭 chat Tab = 归档（design-layout 锁定语义），并卸载会话运行时状态 */
  async closeChatTab(sessionID: string, opts: { streaming: boolean }): Promise<boolean> {
    if (opts.streaming) {
      await this.abortSession(sessionID)
    }
    // 会话已不存在（如被其他客户端删除）：视为成功关闭
    if (!this.findSession(sessionID)) {
      this.closeTab(`chat:${sessionID}`, { archive: false })
      this.cleanupSessionState(sessionID)
      return true
    }
    const ok = await this.archiveSession(sessionID)
    if (ok) {
      this.closeTab(`chat:${sessionID}`, { archive: false })
      this.cleanupSessionState(sessionID)
    }
    return ok
  }

  closeTab(key: string, _opts: { archive?: boolean } = {}) {
    const idx = this.tabs.findIndex((t) => t.key === key)
    if (idx < 0) return
    const closed = this.tabs[idx]
    this.tabs.splice(idx, 1)
    if (this.activeTabKey === key) {
      // 回退激活：优先同作用域的相邻 Tab（Tab 条按作用域过滤显示，不能激活到隐藏 Tab）
      const scopeDir = closed.kind === "file" ? null : closed.directory
      const candidates =
        scopeDir != null
          ? this.tabs.filter((t) => t.kind === "file" || t.directory === scopeDir)
          : this.tabs
      const pos = candidates.findIndex((t) => t.key === key)
      this.activeTabKey =
        candidates[Math.min(Math.max(pos, 0), candidates.length - 1)]?.key ??
        candidates[0]?.key ??
        null
    }
    // Tab 记忆同步（§5 挂点）：chat Tab 关闭 → 从所属目录记忆移除（active 按回退结果派生）
    if (closed.kind === "chat" && closed.directory) this.syncScopeMemory(closed.directory)
    this.emit()
  }

  setActiveTab(key: string) {
    this.activeTabKey = key
    // Tab 记忆同步（§5 挂点）：激活 chat Tab → 更新所属目录 active；file Tab 不改写
    const tab = this.tabs.find((t) => t.key === key)
    if (tab?.kind === "chat" && tab.directory) this.syncScopeMemory(tab.directory)
    this.emit()
  }

  /** Tab 栏 "+"：清空激活进入新 Tab 引导页（无激活 Tab 的默认视图，design-layout §4） */
  showGuidePage() {
    this.activeTabKey = null
    this.emit()
  }

  get activeTab(): TabEntity | null {
    return this.tabs.find((t) => t.key === this.activeTabKey) ?? null
  }

  // ============ 文件树 ============

  async loadFileNodes(dirPath: string) {
    const { directory, workspace } = this.scopeQuery
    if (!this.client || !directory) return
    const nodes = await this.client
      .listFiles(directory, dirPath, workspace)
      .catch(() => null)
    // 闸门：在途请求落地时作用域可能已切走——旧目录节点不得污染新作用域文件树
    if (nodes && this.scopeQuery.directory === directory) {
      this.fileTreeNodes.set(dirPath, nodes)
      this.emit()
    }
  }

  toggleFileNode(path: string) {
    const next = !this.fileTreeExpanded.get(path)
    this.fileTreeExpanded.set(path, next)
    if (next) void this.loadFileNodes(path)
    this.emit()
  }

  // ============ 设置 ============

  openSettings() {
    this.settingsOpen = true
    this.emit()
  }

  closeSettings() {
    this.settingsOpen = false
    this.emit()
  }

  async saveProfiles(profiles: ConnectionProfile[], activeId: string | null) {
    this.profiles = profiles
    this.activeProfileId = activeId
    await window.desktop.storeSet("connection.profiles", { profiles, activeId })
    this.emit()
  }

  async setThemeMode(mode: "auto" | "dark" | "light") {
    this.themeMode = mode
    await window.desktop.storeSet("theme.mode", mode)
    this.emit()
  }

  async setLocaleMode(mode: "auto" | "zh" | "en") {
    this.localeMode = mode
    await window.desktop.storeSet("locale.mode", mode)
    this.emit()
  }

  // ============ 对账挂载 ============

  mountReconciler() {
    this.reconciler = new Reconciler({
      client: () => this.client,
      getOpenedDirectories: () => this.subscriptionDirectories(),
      // 状态快照目录集 = 打开项目全集（非当前 worktree 无 SSE 通道，stale busy 靠这里纠正）
      getStatusDirectories: () => {
        const dirs = new Set<string>()
        for (const p of this.openedProjects) {
          dirs.add(p.worktree)
          for (const d of p.sandboxes ?? []) dirs.add(d)
        }
        return [...dirs]
      },
      getActiveSessions: () =>
        this.tabs
          .filter((t) => t.kind === "chat")
          .map((t) => ({ sessionID: t.key.slice(5), directory: t.directory! })),
      onSessionsSnapshot: (dir, sessions) => {
        // 按项目合并（不清空重置，按 directory 分域）；同一 dir 可能含多项目会话
        const byProject = new Map<string, Session[]>()
        for (const s of sessions) {
          const list = byProject.get(s.projectID) ?? []
          list.push(s)
          byProject.set(s.projectID, list)
        }
        for (const [pid, list] of byProject) {
          this.applySessionsSnapshot(pid, dir, list)
        }
        // 旧"无 Tab busy 重置"启发式移除：权威修正由下方 onStatusSnapshot 的
        // 按目录覆盖合并承担（失败目录保留旧值，不再有 SS-1 式误清）
      },
      onStatusSnapshot: (dir, statuses) => {
        // 闸门：对账在途时项目可能已关/工作区可能已删——过期状态丢弃，
        // 防复活 closeProject/removeWorkspace 刚 purge 掉的条目（与 sessions 快照同规则）
        if (!this.isOpenedDirectory(dir)) return
        this.applyStatusSnapshot(dir, statuses)
      },
      onMessagesSnapshot: (sessionID, msgs) => {
        const local = this.messagesBySession.get(sessionID) ?? new Map()
        const merged = mergeSnapshotIntoMessages(local, msgs)
        this.messagesBySession.set(sessionID, merged)
        // finish 推断兜底（断线期间完成的会话不再卡 busy）
        if (inferIdleFromMessages([...merged.values()].sort(sortMessages).map((m) => m.info))) {
          this.setSessionStatus(sessionID, { type: "idle" })
        }
      },
      onReconcileStateChange: (active) => {
        this.reconciling = active
        this.emit()
      },
      log: (...args) => console.debug("[reconcile]", ...args),
    })
  }

  /** 窗口 focus：kick 所有退避（design-sse-reconnect-recovery 的 resume 语义） */
  kickReconnect() {
    for (const sub of this.sseGroup) sub.reconnectNow()
  }

  // ============ 派生 ============

  chatEntries(sessionID: string): ChatEntry[] {
    const msgs = [...(this.messagesBySession.get(sessionID)?.values() ?? [])]
    const optimistic = this.optimisticBySession.get(sessionID) ?? []
    const entries: ChatEntry[] = [
      ...msgs.map((data): ChatEntry => ({ kind: "message", data })),
      ...optimistic.map((data): ChatEntry => ({ kind: "optimistic", data })),
    ]
    return sortEntries(entries)
  }
}
