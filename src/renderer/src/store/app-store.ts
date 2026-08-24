/**
 * 应用状态层：连接 → 项目/工作区 → 会话 → 消息 → Tab。
 * 事件闸门、乐观消息、SSE 生命周期都在这里收敛。
 */
import { RestClient, ApiError } from "@shared/rest-client"
import { SseSubscriber, type SseStatus } from "@shared/sse-subscriber"
import { Reconciler } from "@shared/reconciler"
import { mergeSessionsSnapshot } from "@shared/session-merge"
import { inferIdleFromMessages, mergeStatusSnapshot } from "@shared/session-status"
import { runLimited } from "@shared/run-limited"
import {
  buildFirstOpenMemory,
  deriveMemory,
  isSnapshotMissing,
  reconcileMemoryTabs,
  resolveRestoreActive,
  type ScopeTabMemory,
} from "@shared/scope-tab-memory"
import {
  carriedVariant,
  emptyCatalog,
  effectiveDefaultModel,
  findModel,
  getDefaults,
  normalizeModelRef,
  parseAgents,
  parseModels,
  setDefaults,
  type ModelCatalog,
  type ModelDefaults,
} from "@shared/model-catalog"
import {
  mergeSnapshotIntoMessages,
  sortEntries,
  sortMessages,
  type ChatEntry,
  type OptimisticMessage,
} from "@shared/message-merge"
import {
  mergePendingSnapshot,
  normalizePermission,
  normalizeQuestion,
  sessionDotState,
  type PendingPermission,
  type PendingQuestion,
  type SessionDotState,
} from "@shared/pending-requests"
import {
  GLOBAL_PROJECT_ID,
  globalDirectoryName,
  globalDirectoryOfKey,
  globalDirectoryRows,
  globalEntryKey,
  migrateOpenedKeys,
  type GlobalDirectoryRow,
} from "@shared/project-entries"
import type { ConnectionProfile } from "@shared/ipc"
import "@shared/ipc-global"
import {
  applyCommandFetch,
  initialCommandCache,
  type CommandCacheState,
} from "@shared/command-cache"
import type {
  AgentInfo,
  CommandInfo,
  ConfigProviders,
  FileNode,
  Message,
  MessageWithParts,
  ModelInfo,
  ModelRef,
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
  /** 左栏 entry 键：普通项目 = project.id；global 目录 = `global\0<directory>` */
  opened: string[]
  currentProjectId: string | null
  /** 当前作用域目录（普通项目 = worktree 路径；global = 会话目录；null = 项目根） */
  currentWorkspaceId: string | null
}

/** 左栏「项目行」：普通项目 1 行（worktree）；global 项目按 directory 拆成 N 行 */
export interface ProjectEntry {
  key: string
  project: Project
  /** 作用域根目录（global = 会话 directory；普通 = worktree） */
  directory: string
  name: string
  isGlobal: boolean
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
  /** 消息流思考（reasoning）显隐——默认隐藏，切换即时生效（数据仍在 store，只是不渲染） */
  showThinking = false

  // ---- 连接运行时 ----
  connectionState: ConnectionState = "disconnected"
  sseStatus: SseStatus = "stopped"
  reconciling = false
  connectionError: string | null = null
  managedBaseUrl: string | null = null

  // ---- 域数据 ----
  projects: Project[] = []
  sessionsByProject = new Map<string, Map<string, Session>>()
  messagesBySession = new Map<string, Map<string, MessageWithParts>>()
  optimisticBySession = new Map<string, OptimisticMessage[]>()
  /**
   * 会话消息历史分页状态（design-message-history-pagination §4.2）：
   * cursor 锚定当前最旧已加载消息；不变式 `exhausted ⇒ nextCursor == null`，
   * 逆命题不成立——`nextCursor == null` 为「穷尽（exhausted）**或**可重试的
   * 失败态（error，含挂载窗口加载失败种子）」。无条目 = 尚未做过窗口加载
   * （SSE-only/断线重连后），上滚触发时种子。
   */
  sessionPages = new Map<string, { nextCursor: string | null; exhausted: boolean; loading: boolean; error: boolean }>()
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

  // ---- agent/模型目录（design-agent-model-switch）----
  /** 目录级 agent/模型缓存（SWR：命中即渲染 + 后台重拉覆盖），teardown 清空 */
  modelCatalogs = new Map<string, ModelCatalog>()
  private modelCatalogLoading = new Map<string, Promise<void>>()
  /** 完全加载失败且无缓存的目录——工具条显示「加载失败，点击重试」 */
  private modelCatalogFailed = new Set<string>()
  /** 全局默认 agent/模型（per-profile 持久化 model.defaults） */
  defaults: Record<string, ModelDefaults> = {}
  /**
   * 待处理人机交互（store 级、跨 Tab 存活，与移动端 ServerStore 同构）：
   * 权限以 sessionID 为 key（一会话最多一张在队首）、问题以问题 id 为 key（可多张排队）。
   */
  pendingPermissions = new Map<string, PendingPermission>()
  pendingQuestions = new Map<string, PendingQuestion>()

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
    if (ps) {
      // global 拆分迁移：旧版裸 "global" → 根目录 entry（幂等；变更即时落盘）
      let migrated = false
      for (const key of Object.keys(ps)) {
        const next = migrateOpenedKeys(ps[key].opened)
        if (next.join("\u0001") !== ps[key].opened.join("\u0001")) {
          ps[key].opened = next
          migrated = true
        }
      }
      this.projectStates = ps
      if (migrated) void window.desktop.storeSet("project.state", ps).catch(() => {})
    }
    this.tabMemory = (await window.desktop.storeGet("tabs.memory")) ?? {}
    this.themeMode = (await window.desktop.storeGet("theme.mode")) ?? "auto"
    this.localeMode = (await window.desktop.storeGet("locale.mode")) ?? "auto"
    this.defaults = (await window.desktop.storeGet("model.defaults")) ?? {}
    this.showThinking = (await window.desktop.storeGet("chat.showThinking")) ?? false

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
    // 连接前先拆干净旧连接（SSE、域数据、Tab）——防跨 profile 状态串台
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
      // 连通性探针（快照前的快速失败；版本信息仅设置弹窗"测试连接"时按需拉取）
      await client.health()
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

    // global 拆分发现快照：ensureDefaultProjects 的"最近活跃 global 目录"依赖它
    await this.refreshGlobalSessions()

    // 首次连接默认打开 current + 最近活跃 1 个（design-layout）
    await this.ensureDefaultProjects()

    // 打开项目的快照 + 订阅
    await this.refreshAllOpenedProjects()
    // 启动恢复（design-tab-memory §8）：逐作用域按记忆重建 Tab（不动激活），
    // 当前作用域含激活规则；无记忆则首次打开。须在快照落地之后（WT-2 教训）
    {
      const slice = this.tabMemory[this.profileKey()] ?? {}
      for (const p of this.openedProjects) {
        const dirs =
          p.id === GLOBAL_PROJECT_ID
            ? this.openedGlobalDirectories
            : [...new Set([p.worktree, ...(p.sandboxes ?? [])])]
        for (const dir of dirs) {
          if (slice[dir]) this.restoreScopeTabs(dir, false)
        }
      }
      this.restoreScopeTabs(this.scopeDirectory(), true)
    }
    this.startSse()
    // 冷启动 pending 回填（离线期间产生的授权/问题请求）
    void this.backfillPending()
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

  /** 拆除连接相关的一切运行时状态（SSE、域数据、Tab、managed 地址） */
  private teardownConnection() {
    this.sseSubscriber?.stop()
    this.sseSubscriber = null
    this.client = null
    this.managedBaseUrl = null
    this.projects = []
    this.sessionsByProject.clear()
    this.messagesBySession.clear()
    this.sessionPages.clear()
    this.pendingPartsMap.clear()
    this.optimisticBySession.clear()
    this.sessionStatus.clear()
    this.statusSources.clear()
    this.pendingPermissions.clear()
    this.pendingQuestions.clear()
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
    // agent/模型目录：切 profile 全量重建（与命令缓存同模式）
    this.modelCatalogs.clear()
    this.modelCatalogLoading.clear()
    this.modelCatalogFailed.clear()
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
    if (currentId === GLOBAL_PROJECT_ID) {
      // projects 列表无 global（两次请求响应不一致的防御）：不 push 幻影 entry——
      // 否则 opened 非空短路默认打开逻辑，直到用户手动打开才恢复
      if (!this.globalProject) return
      // global 拆分：current 落到最近活跃 global 目录（发现快照已合并），
      // 无会话则根目录（entry 打开但作用域 = 项目根语义）
      const dir = this.globalDirectoryRowsAll()[0]?.directory ?? this.globalProject.worktree
      ps.opened.push(globalEntryKey(dir))
      ps.currentProjectId = GLOBAL_PROJECT_ID
      ps.currentWorkspaceId = dir === this.globalProject.worktree ? null : dir
    } else {
      ps.opened.push(currentId)
      ps.currentProjectId = currentId
      ps.currentWorkspaceId = null
    }
    const recent = [...this.projects]
      .filter((p) => !ps.opened.includes(p.id) && p.id !== GLOBAL_PROJECT_ID)
      .sort((a, b) => b.time.updated - a.time.updated)[0]
    if (recent) ps.opened.push(recent.id)
    this.projectStates[this.profileKey()] = ps
    await this.persistProjectState()
  }

  private async refreshAllOpenedProjects() {
    // 嵌套限流的乘积才是总并发：外层 2 × 内层（refreshSessionsForProject 目录 3）
    // = 6 ≈ 空闲槽（1 条 SSE 常驻后 5 槽 + 排队余量）——外层限值不可单独解读
    await runLimited(this.openedProjects, 2, (p) => this.refreshSessionsForProject(p))
  }

  /**
   * 将单目录会话快照合入项目 map（按 projectID 过滤后交 session-merge 分域合并）。
   * 闸门：在途快照落地时项目可能已关闭、目录可能已被删除（removeWorkspace）——
   * 过期快照直接丢弃，防止复活已卸载的 worktree 会话。
   * global：目录闸门 = 已打开 entry ∪ 已知会话域（发现快照走 refreshGlobalSessions
   * 直合并，不经此处）。
   */
  private applySessionsSnapshot(projectId: string, directory: string, sessions: Session[]) {
    const project = this.openedProjects.find((p) => p.id === projectId)
    if (!project) return
    if (project.id === GLOBAL_PROJECT_ID) {
      if (
        !this.openedGlobalDirectories.includes(directory) &&
        !this.globalKnownDirectories().has(directory)
      )
        return
    } else if (directory !== project.worktree && !(project.sandboxes ?? []).includes(directory)) {
      return
    }
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
    // 先拆旧连接（旧 profile 的订阅不得继续收事件——锁定语义）
    this.sseSubscriber?.stop()
    const username = this.sseCreds?.username ?? profile.username
    const password = this.sseCreds?.password ?? profile.password
    const sub = new SseSubscriber({
      baseUrl: this.activeBaseUrl!,
      username,
      password,
      onEvent: (dir, ev) => this.handleEvent(dir, ev),
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
    this.sseSubscriber = sub
    this.updateSseAggregate()
  }

  /**
   * 打开项目目录全集（worktree ∪ sandboxes；global = 已打开目录 entry）——事件闸门、
   * 对账、状态快照的统一目录源。单全局流（design-sse-global-event）下连接与打开集合
   * 解耦：开关项目/切工作区不再触发任何连接操作，只影响此集合的过滤范围。
   * global 无连接预算约束（单流覆盖全部目录），但未打开 global 目录的事件仍被
   * 闸门丢弃——新目录发现靠 scope=project 快照（refreshGlobalSessions）。
   */
  private openedDirectories(): string[] {
    const dirs = new Set<string>()
    for (const p of this.openedProjects) {
      // global：worktree 恒为 "/" 且 sandboxes 恒空，目录全集 = 已打开 entry 目录
      if (p.id === GLOBAL_PROJECT_ID) {
        for (const d of this.openedGlobalDirectories) dirs.add(d)
        continue
      }
      dirs.add(p.worktree)
      for (const d of p.sandboxes ?? []) dirs.add(d)
    }
    return [...dirs]
  }

  private sseCreds: { username?: string; password?: string } | null = null

  private sseSubscriber: SseSubscriber | null = null

  private get activeBaseUrl(): string | null {
    return this.baseUrl
  }

  private updateSseAggregate() {
    // 单流直映：connected→streaming，reconnecting/connecting→degraded；
    // stopped（未连接/已拆除）不动 connectionState——由 connect/disconnect 主导
    this.sseStatus = this.sseSubscriber?.getStatus() ?? "stopped"
    if (this.sseStatus !== "stopped") {
      if (this.connectionState !== "connecting" && this.connectionState !== "disconnected") {
        this.connectionState = this.sseStatus === "connected" ? "streaming" : "degraded"
      }
    }
    this.emit()
  }

  // ============ 事件处理（闸门 + 应用） ============

  private handleEvent(directory: string, ev: OpencodeEvent) {
    // 前置闸门（design-sse-global-event §4.2）：单流收到 server 全部目录的事件，
    // 仅打开项目的目录全集（worktree ∪ sandboxes）放行——关闭项目 = 事件忽略。
    // 此前 message.*/session.created 等依赖"订阅集合即打开集合"隐式隔离，单流后必须显式过滤
    if (!this.isOpenedDirectory(directory)) return
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
        this.dropPendingForSession(info.id)
        break
      }
      // ---- 待处理人机交互（v1/v2 事件 + permission.updated 兼容兜底，同移动端）----
      case "permission.asked":
      case "permission.v2.asked":
      case "permission.updated": {
        const p = normalizePermission(ev.properties, directory)
        if (p) this.pendingPermissions.set(p.sessionID, p)
        break
      }
      case "permission.replied":
      case "permission.v2.replied": {
        // spec：id 在 requestID 字段（additionalProperties:false，无 permissionID）
        const pid = String((ev.properties as { requestID?: unknown }).requestID ?? "")
        for (const [sid, p] of [...this.pendingPermissions]) {
          if (p.id === pid) this.pendingPermissions.delete(sid)
        }
        break
      }
      case "question.asked":
      case "question.v2.asked": {
        const q = normalizeQuestion(ev.properties, directory)
        if (q) this.pendingQuestions.set(q.id, q)
        break
      }
      case "question.replied":
      case "question.v2.replied":
      case "question.rejected":
      case "question.v2.rejected": {
        this.pendingQuestions.delete(String((ev.properties as { requestID?: unknown }).requestID ?? ""))
        break
      }
      case "session.status": {
        // 权威状态设置（含 retry 态）；作用域目录 = 信封 directory
        // （已过前置闸门：关闭项目的迟到事件不会到达此处）
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
        // 无条目 = 已是缺省 idle，直接忽略（前置闸门已过滤关闭项目）
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
      case "session.next.agent.switched": {
        // 跨客户端 agent 切换（本端切换已有乐观写，此事件幂等；TUI/CLI 切换靠这里补丁）
        const { sessionID, agent } = ev.properties as { sessionID: string; agent: string }
        if (sessionID && agent) this.patchSessionAgent(sessionID, agent)
        break
      }
      case "session.next.model.switched": {
        const { sessionID, model } = ev.properties as { sessionID: string; model: ModelRef }
        if (sessionID && model?.id && model?.providerID) this.patchSessionModel(sessionID, model)
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

  /** 目录是否仍属于某个打开项目（root 或其 worktree/global 目录）——在途状态快照的闸门 */
  private isOpenedDirectory(dir: string): boolean {
    return this.openedProjects.some((p) => {
      if (p.id === GLOBAL_PROJECT_ID) return this.openedGlobalDirectories.includes(dir)
      return p.worktree === dir || (p.sandboxes ?? []).includes(dir)
    })
  }

  // ============ 项目/工作区 ============

  get globalProject(): Project | null {
    return this.projects.find((p) => p.id === GLOBAL_PROJECT_ID) ?? null
  }

  /** 已打开的 global 目录（entry 键解析；顺序 = opened 追加序） */
  get openedGlobalDirectories(): string[] {
    const ps = this.projectStates[this.profileKey()]
    if (!ps) return []
    return ps.opened.map(globalDirectoryOfKey).filter((d): d is string => d != null)
  }

  /** global 项目已知会话目录集（发现快照/事件累积的域） */
  private globalKnownDirectories(): Set<string> {
    const set = new Set<string>()
    for (const s of this.sessionsByProject.get(GLOBAL_PROJECT_ID)?.values() ?? []) {
      if (s.directory) set.add(s.directory)
    }
    return set
  }

  /**
   * global 目录行（含零会话的已打开目录，updated=0 兜底——否则全部归档后
   * 该行消失、无法导航/关闭）。排序 = 会话活跃度降序。
   */
  private globalDirectoryRowsAll(): GlobalDirectoryRow[] {
    const rows = globalDirectoryRows([
      ...(this.sessionsByProject.get(GLOBAL_PROJECT_ID)?.values() ?? []),
    ])
    const byDir = new Map(rows.map((r) => [r.directory, r]))
    for (const dir of this.openedGlobalDirectories) {
      if (!byDir.has(dir)) {
        const row = { directory: dir, name: globalDirectoryName(dir), updated: 0 }
        rows.push(row)
        byDir.set(dir, row)
      }
    }
    return rows.sort((a, b) => b.updated - a.updated)
  }

  /** global 目录候选（选择器数据源：全部已知目录，含已打开——由调用方过滤） */
  globalDirectoryRows(): GlobalDirectoryRow[] {
    return this.globalDirectoryRowsAll()
  }

  /**
   * 左栏「项目行」（entry）：普通项目 1 行；global 按目录拆 N 行（活跃度降序）。
   * 左栏/选择器唯一数据源——不直接消费 openedProjects。
   */
  get openedEntries(): ProjectEntry[] {
    const ps = this.projectStates[this.profileKey()]
    if (!ps) return []
    const openedIds = new Set(ps.opened)
    const openedGlobal = new Set(this.openedGlobalDirectories)
    const out: ProjectEntry[] = []
    for (const p of this.projects) {
      if (p.id === GLOBAL_PROJECT_ID) {
        if (openedGlobal.size === 0) continue
        for (const row of this.globalDirectoryRowsAll()) {
          if (!openedGlobal.has(row.directory)) continue
          out.push({
            key: globalEntryKey(row.directory),
            project: p,
            directory: row.directory,
            name: row.name,
            isGlobal: true,
          })
        }
      } else if (openedIds.has(p.id)) {
        out.push({
          key: p.id,
          project: p,
          directory: p.worktree,
          name: p.name || p.worktree.split("/").pop() || p.id,
          isGlobal: false,
        })
      }
    }
    return out
  }

  /**
   * entry 行是否为当前激活作用域——selectEntry 跳过条件与行高亮共用。
   * 普通项目 = 当前项目**且主工作区态**（worktree 态点击项目行 = 回主工作区，
   * 不得跳过）；global = 目录匹配。
   */
  isEntryActive(key: string): boolean {
    const p = this.currentProject
    if (!p) return false
    if (p.id !== GLOBAL_PROJECT_ID) return key === p.id && this.currentWorkspace == null
    const dir = globalDirectoryOfKey(key)
    return dir != null && (this.currentWorkspace?.directory ?? p.worktree) === dir
  }

  get openedProjects(): Project[] {
    const ps = this.projectStates[this.profileKey()]
    if (!ps) return []
    const ids = new Set(ps.opened)
    // global 不再有整项目键——只要有任一目录 entry 打开即视为打开项目
    const hasGlobal = this.openedGlobalDirectories.length > 0
    return this.projects.filter((p) => ids.has(p.id) || (p.id === GLOBAL_PROJECT_ID && hasGlobal))
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
    if (!p) return null
    if (p.id === GLOBAL_PROJECT_ID) {
      // global：currentWorkspaceId = 当前 global 目录（entry 模型复用该字段）；
      // 仅认可已打开 entry 的目录（防陈旧持久化值复活已关目录）
      if (!this.openedGlobalDirectories.includes(dir)) return null
      return { name: globalDirectoryName(dir), directory: dir }
    }
    if (!p.sandboxes?.includes(dir)) return null
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

  /** 当前作用域显示名（引导页 hero 等）：global = 目录末段（根目录显示 "global"） */
  get scopeDisplayName(): string {
    const p = this.currentProject
    if (!p) return ""
    if (p.id === GLOBAL_PROJECT_ID) {
      const dir = this.currentWorkspace?.directory ?? p.worktree
      return dir ? globalDirectoryName(dir) : GLOBAL_PROJECT_ID
    }
    return this.currentWorkspace?.name ?? p.name ?? p.worktree.split("/").pop() ?? ""
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
    // 立即登记：同步段（事件闸门目录/作用域派生）即读得到新状态
    this.projectStates[this.profileKey()] = ps
    const expectedDir = this.scopeDirectory()
    this.resetFileTree()
    this.restoreScopeTabs(expectedDir, true, true)
    this.emit()
    // SSE 连接不动（单全局流）；快照刷新在后台
    await this.persistProjectState()
    await this.refreshAllOpenedProjects()
    if (this.currentProject?.id !== projectId || this.scopeDirectory() !== expectedDir) return
    this.restoreScopeTabs(expectedDir, true)
  }

  /** 打开左栏 entry（普通项目 id 或 `global\0<directory>`）并切换作用域 */
  async openEntry(key: string) {
    const dir = globalDirectoryOfKey(key)
    if (dir == null) return this.openProject(key)
    return this.openGlobalDirectory(dir)
  }

  /** 关闭左栏 entry（global 目录 = 关闭该目录作用域；普通项目走 closeProject） */
  async closeEntry(key: string) {
    const dir = globalDirectoryOfKey(key)
    if (dir == null) return this.closeProject(key)
    return this.closeGlobalDirectory(dir)
  }

  /**
   * 打开/切入 global 目录 entry：目录 = 根（`/`）时按"项目根"语义（workspace
   * 置 null，作用域经 worktree 兜底到 `/`），与普通项目主工作区行一致。
   */
  private async openGlobalDirectory(directory: string) {
    const key = globalEntryKey(directory)
    const ps = this.projectStateFor()
    if (!ps.opened.includes(key)) ps.opened.push(key)
    ps.currentProjectId = GLOBAL_PROJECT_ID
    const rootDir = this.globalProject?.worktree ?? "/"
    ps.currentWorkspaceId = directory === rootDir ? null : directory
    // 先切换后加载（同 openProject，7c43827）：同步段立即登记 + 渲染，
    // 快照与 Tab 恢复转后台——切换跟手
    this.projectStates[this.profileKey()] = ps
    const expectedDir = this.scopeDirectory()
    this.resetFileTree()
    this.restoreScopeTabs(expectedDir, true, true)
    this.emit()
    await this.persistProjectState()
    await this.refreshAllOpenedProjects()
    if (this.scopeDirectory() !== expectedDir) return
    this.restoreScopeTabs(expectedDir, true)
    void this.backfillPending()
  }

  /** 关闭单个 global 目录 entry（其余 global 目录不受影响） */
  private async closeGlobalDirectory(directory: string) {
    const key = globalEntryKey(directory)
    const rootDir = this.globalProject?.worktree ?? "/"
    const ps = this.projectStateFor()
    ps.opened = ps.opened.filter((k) => k !== key)
    // 当前作用域在该目录 → 回退：其余已打开 global 目录中最活跃的，否则最近活跃普通项目
    const wasCurrent =
      ps.currentProjectId === GLOBAL_PROJECT_ID &&
      (ps.currentWorkspaceId ?? rootDir) === directory
    if (wasCurrent) {
      const rest = this.globalDirectoryRowsAll().filter(
        (r) => r.directory !== directory && this.openedGlobalDirectories.includes(r.directory),
      )
      if (rest[0]) {
        ps.currentWorkspaceId = rest[0].directory === rootDir ? null : rest[0].directory
      } else {
        const remaining = this.projects
          .filter((p) => ps.opened.includes(p.id) && p.id !== GLOBAL_PROJECT_ID)
          .sort((a, b) => b.time.updated - a.time.updated)
        ps.currentProjectId = remaining[0]?.id ?? null
        ps.currentWorkspaceId = null
      }
    }
    // 卸载该目录的会话域（关闭 = 不展示 + 不更新；重开时 REST 快照重建）
    const map = this.sessionsByProject.get(GLOBAL_PROJECT_ID)
    if (map) {
      for (const [id, s] of map) {
        if (s.directory === directory) map.delete(id)
      }
    }
    this.purgeStatusForDirectories([directory])
    // 该目录 global 会话的 chat Tab 随之关闭（仅关 Tab，不归档——归档只发生在
    // 显式关闭 Tab）。双行目录（git 项目 + global 会话共存）下按 projectId
    // 过滤：git 项目的 Tab 归 closeProject 管，不随 global entry 关闭
    for (const tab of [...this.tabs]) {
      if (
        tab.kind === "chat" &&
        tab.directory === directory &&
        tab.projectId === GLOBAL_PROJECT_ID
      ) {
        this.closeTab(tab.key)
        this.cleanupSessionState(tab.key.slice(5))
      }
    }
    // 该目录 Tab 记忆清除（须在关 Tab 之后——closeTab 的记忆同步会重建条目）。
    // 仅删 global 侧记忆：双行目录的记忆经 findProjectOwningDirectory 归属
    // git 项目（projectId ≠ global），关 global entry 不得误删
    const memKey = this.profileKey()
    if (this.tabMemory[memKey]?.[directory]?.projectId === GLOBAL_PROJECT_ID) {
      delete this.tabMemory[memKey][directory]
      void window.desktop.storeSet("tabs.memory", this.tabMemory).catch(() => {})
    }
    await this.persistProjectState()
    await this.switchProjectContext()
    this.emit()
  }

  /**
   * global 全量发现快照（`GET /session?scope=project&directory=<worktree>`）：
   * 一次返回 global 项目全部目录的未归档会话。连接时与项目选择器打开时调用——
   * 新目录的首个会话事件无从订阅（不在订阅集），只能靠此快照发现。
   * 按 directory 分域全量合并（权威快照，不经 applySessionsSnapshot 逐目录
   * 闸门——新目录必须能进 map）。关目录后迟到的发现快照可能复活其会话域：
   * 该目录 entry 已关、UI 不展示，重开时 refreshSessionsForProject 重新拉取覆盖。
   */
  async refreshGlobalSessions() {
    const client = this.client
    const gp = this.globalProject
    if (!client || !gp) return
    const sessions = await client.listProjectSessions(gp.worktree).catch(() => null)
    if (!sessions || this.client !== client) return
    const filtered = sessions.filter((s) => s.projectID === GLOBAL_PROJECT_ID)
    const byDir = new Map<string, Session[]>()
    for (const s of filtered) {
      if (!s.directory) continue
      const list = byDir.get(s.directory) ?? []
      list.push(s)
      byDir.set(s.directory, list)
    }
    for (const [dir, list] of byDir) {
      const local = this.sessionsByProject.get(GLOBAL_PROJECT_ID) ?? new Map<string, Session>()
      this.sessionsByProject.set(GLOBAL_PROJECT_ID, mergeSessionsSnapshot(local, dir, list))
      // 与 refreshSessionsForProject 同规则标记可信快照（Tab 恢复/死 Tab 收敛
      // 的 snapshottedDirs 闸门依赖；否则 global 目录只经发现快照落地时，
      // restoreScopeTabs 会误判"快照未落地"拒绝恢复/收敛）
      this.snapshottedDirs.add(dir)
    }
    this.emit()
  }

  async closeProject(projectId: string) {
    const ps = this.projectStateFor()
    ps.opened = ps.opened.filter((id) => id !== projectId)
    if (ps.currentProjectId === projectId) {
      // 回退候选 = 剩余打开普通项目 + 已打开 global 目录，按最近活跃统一排序
      //（entry 模型下两类平权；与 closeGlobalDirectory 的回退对称——原实现只查
      // project id，global entry 键永不匹配，会绕过仍在左栏的 global 行直接空态）
      const rootDir = this.globalProject?.worktree ?? "/"
      const candidates: Array<
        { kind: "project"; id: string; updated: number } | { kind: "global"; directory: string; updated: number }
      > = [
        ...this.projects
          .filter((p) => ps.opened.includes(p.id) && p.id !== GLOBAL_PROJECT_ID)
          .map((p) => ({ kind: "project" as const, id: p.id, updated: p.time.updated })),
        ...this.globalDirectoryRowsAll()
          .filter((r) => this.openedGlobalDirectories.includes(r.directory))
          .map((r) => ({ kind: "global" as const, directory: r.directory, updated: r.updated })),
      ].sort((a, b) => b.updated - a.updated)
      const top = candidates[0]
      if (top?.kind === "project") {
        ps.currentProjectId = top.id
        ps.currentWorkspaceId = null
      } else if (top) {
        ps.currentProjectId = GLOBAL_PROJECT_ID
        ps.currentWorkspaceId = top.directory === rootDir ? null : top.directory
      } else {
        ps.currentProjectId = null
        ps.currentWorkspaceId = null
      }
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
      // 该项目的 pending（授权/问题）一并卸载：目录失去订阅，replied 事件收不到，
      // 留着只会假亮；重开项目时 backfill 会按 server 权威重建
      this.dropPendingForDirectories(dirs)
    }
    // 该项目的 chat Tab 随之关闭（仅关 Tab，不归档——归档只发生在显式关闭 Tab）
    for (const tab of [...this.tabs]) {
      if (tab.kind !== "chat") continue
      if (tab.projectId === projectId) {
        this.closeTab(tab.key)
        this.cleanupSessionState(tab.key.slice(5))
      } else if (project && tab.directory === project.worktree && tab.projectId !== GLOBAL_PROJECT_ID) {
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
    // 防把幻影 currentWorkspaceId 持久化（currentWorkspace getter 会拒认、下次启动才自愈）。
    // global：currentWorkspaceId = global 目录（entry 模型复用该字段），有效性 =
    // 已打开 entry（v0.1 路径 openGlobalDirectory 直写不经此处，此分支防未来调用）
    const valid =
      project.id === GLOBAL_PROJECT_ID
        ? directory != null && this.openedGlobalDirectories.includes(directory)
          ? directory
          : null
        : directory != null && (project.sandboxes ?? []).includes(directory)
          ? directory
          : null
    const ps = this.projectStateFor()
    if (ps.currentWorkspaceId === valid) return
    ps.currentWorkspaceId = valid
    const expectedDir = this.scopeDirectory()
    this.resetFileTree()
    this.restoreScopeTabs(expectedDir, true, true)
    // 新 scope 目录（worktree）的 pending 需要回填（此前无订阅通道）
    void this.backfillPending()
    this.emit()
    // 再加载：持久化 + 本项目快照刷新（WT-1：worktree 会话只有逐目录快照可达）。
    // SSE 连接不动（单全局流，闸门集合无变化——目录本就属于打开项目）
    await this.persistProjectState()
    await this.refreshSessionsForProject(project)
    if (this.currentProject?.id !== project.id || this.scopeDirectory() !== expectedDir) return
    this.restoreScopeTabs(expectedDir, true)
  }

  /** 切项目/开项目后：快照 + 文件树重置 + 恢复该作用域的 Tab 记忆（SSE 连接不动） */
  private async switchProjectContext() {
    if (!this.client) return
    await this.refreshAllOpenedProjects()
    this.resetFileTree()
    this.restoreScopeTabs(this.scopeDirectory(), true)
    // 新开项目目录的 pending（授权/问题）回填（SSE 只推 asked 一次）
    void this.backfillPending()
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

  /**
   * 目录 → 所属项目（Tab 记忆归属 / restoreScopeTabs 会话集解析）。
   * 普通（git）项目精确匹配优先，global 只兜底无人认领的目录——双行目录
   * （先建会话后 init git，global 会话与 git 项目共存）解析到 git 项目：
   * worktree/sandboxes 定义上拥有该目录，global 的散点会话不构成所有权。
   * global 在 projects 数组首位，若不区分顺序直接 find，双行目录永远命中
   * global——P 的作用域会恢复 global 会话的 Tab、记忆错标 projectId。
   */
  private findProjectOwningDirectory(directory: string): Project | null {
    const normal = this.projects.find(
      (p) =>
        p.id !== GLOBAL_PROJECT_ID &&
        (p.worktree === directory || (p.sandboxes ?? []).includes(directory)),
    )
    if (normal) return normal
    return this.globalKnownDirectories().has(directory) ? this.globalProject : null
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
   * - 有记忆 → 按记忆顺序补齐 live Tab（复用已开）+ 校验收缩 + 补开记忆外
   *   可见会话（§17：他端新建/外部取消归档无其他 UI 入口，不补开即不可见）
   * - 防御闸门：快照未落地（可见与全量皆空）时不动作，下次切入/重启再恢复
   * - 恢复后无 Tab 时中栏显示会话列表视图（master 40459e9 后为无 Tab 引导页语义）
   * applyActivation=false 供启动逐作用域重建（§8 不改变激活）。
   * immediate=true 供"先切换后加载"的切换即时段（openProject/setCurrentWorkspace）：
   * 内存快照可能滞后，首次打开分支不在此时做（空/滞后目录与真实状态不可区分，
   * 全量打开留给快照落地后的完整恢复），只做有记忆的即时恢复 + 激活清算
   * （补开为幂等增量：本地已有者即开，滞后漏开由完整恢复补齐）；
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
      next = reconcileMemoryTabs(mem, visible)
      const byId = new Map(visible.map((s) => [s.id, s]))
      for (const id of next.tabs) {
        const s = byId.get(id)
        if (s) this.openChatTabSilent(s)
      }
    }

    // 死会话 Tab 收敛（§6 完整恢复段）：会话已不可见（他端归档/删除/subagent 化，
    // 未订阅目录收不到事件）的 live chat Tab 关闭。可见会话的 Tab 一律保留——
    // 记忆外的已被上方补开吸收进记忆；immediate 段数据滞后不做；
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
    this.sessionPages.delete(sessionID)
  }

  private resetFileTree() {
    this.fileTreeExpanded.clear()
    this.fileTreeNodes.clear()
    this.fileContents.clear()
  }

  /**
   * 拉取项目会话快照：global = 已打开目录逐个拉取（发现走 refreshGlobalSessions）；
   * 普通项目 = 项目根 + 各 worktree 目录**逐目录**拉取（实测
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
    const dirs =
      project.id === GLOBAL_PROJECT_ID
        ? [...new Set(this.openedGlobalDirectories)]
        : [...new Set([project.worktree, ...(project.sandboxes ?? [])])]
    await runLimited(dirs, 3, async (dir) => {
      const sessions = await client.listSessions(dir).catch(() => null)
      if (sessions === null) return
      this.applySessionsSnapshot(project.id, dir, sessions)
      const statuses = await client.listSessionStatus(dir).catch(() => null)
      // 闸门：在途快照落地时项目可能已关闭/目录可能已删——过期状态直接丢弃
      const still = this.openedProjects.find((p) => p.id === project.id)
      const stillHasDir =
        still &&
        (still.id === GLOBAL_PROJECT_ID
          ? this.openedGlobalDirectories.includes(dir)
          : still.worktree === dir || (still.sandboxes ?? []).includes(dir))
      if (stillHasDir) {
        this.applyStatusSnapshot(dir, statuses)
      }
    })
  }

  /** name 省略：由 server 生成随机 slug（两端一致的默认行为） */
  async createWorkspace(): Promise<{ ok: boolean; error?: string }> {
    if (!this.client || !this.currentProject) return { ok: false, error: "no project" }
    // global 非 git 项目：无 worktree 概念（左栏也不渲染该入口，此处兜底）
    if (this.currentProject.id === GLOBAL_PROJECT_ID) {
      return { ok: false, error: "global project has no worktree" }
    }
    try {
      const result = await this.client.createWorktree(this.currentProject.worktree)
      // worktree API 返回轻量对象，重拉列表拿完整 Workspace 记录
      await this.refreshWorkspacesForProject(this.currentProject)
      // 默认切换到新 worktree；setCurrentWorkspace 内含会话快照/文件树重置/开作用域 Tab。
      // 须校验重拉后 sandboxes 已含新目录（重拉失败/列表滞后时 currentWorkspace getter 会拒认，
      // 先行切换会把幻影 currentWorkspaceId 持久化、下次启动才延迟生效）——此时仅刷新展示
      // （SSE 单全局流常驻，新 worktree 事件天然到达，无需重订）
      if (this.currentProject?.sandboxes?.includes(result.directory)) {
        await this.setCurrentWorkspace(result.directory)
      } else {
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
      this.dropPendingForDirectories([directory])
      const ps = this.projectStateFor()
      if (ps.currentWorkspaceId === directory) {
        ps.currentWorkspaceId = null
        await this.persistProjectState()
      }
      await this.refreshSessionsForProject(this.currentProject)
      this.resetFileTree()
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
    // 全局默认值（per-profile）应用到 POST /session body（D-AM-4）。
    // 有效性校验（AM-IMPL3-4）：POST /session 不校验 model（实测无效模型 200 落库，
    // 首条 prompt 才爆且无明确错误）——目录已加载时按目录解析生效默认值；
    // 未加载（如引导页首条消息先于目录拉取完成）不阻塞，按原值应用
    const def = getDefaults(this.defaults, this.profileKey())
    const catalog = this.modelCatalogs.get(directory)
    const agent =
      def.agent && (!catalog || catalog.agents.some((a) => a.name === def.agent))
        ? def.agent
        : undefined
    // 模型（隐式默认）：目录已加载 → effectiveDefaultModel 校验显式默认
    // （模型失效回退首项、variant 失效只丢 variant 保模型，AM-IMPL4-1），
    // 未手动选择时取列表首项；目录未加载 → 显式默认按原值应用（无则不传，服务器默认）
    const explicitModel = normalizeModelRef(def.model)
    const model = catalog
      ? effectiveDefaultModel(explicitModel, catalog.models)
      : explicitModel
    try {
      const session = await this.client.createSession(directory, undefined, undefined, {
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
      })
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

  /** REST 页合并进会话 map（快照合并 + pending parts 回放），返回本页新增的消息条数 */
  private mergeMessagePage(sessionID: string, msgs: MessageWithParts[]) {
    const local = this.messagesBySession.get(sessionID) ?? new Map()
    const hadIds = new Set(local.keys())
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
    return msgs.filter((m) => !hadIds.has(m.info.id)).length
  }

  async loadSessionMessages(sessionID: string, directory: string) {
    const client = this.client
    if (!client) return
    const page = await client
      .listMessagesPage(sessionID, directory, { limit: 100 })
      .catch(() => null)
    // 世代守卫：await 期间断开/切 profile → 迟到响应不写新连接（同 loadEarlierMessages 模式）
    if (this.client !== client) return
    if (!page) {
      // 失败且无既有状态：置 error 种子（cursor null + 未穷尽 = 可重试态）——
      // 空内容会话无法触发滚动，error 行是唯一重试入口（review P2-1）
      if (!this.sessionPages.has(sessionID)) {
        this.sessionPages.set(sessionID, {
          nextCursor: null,
          exhausted: false,
          loading: false,
          error: true,
        })
        this.emit()
      }
      return
    }
    this.mergeMessagePage(sessionID, page.entries)
    // 种子分页状态（design-message-history-pagination §4.2）：
    // - 无状态（首次成功）→ 写入；
    // - 既有状态是**纯 error 种子**（挂载失败后内容经其他通道落地，本形状唯一
    //   标识"无任何需保护的分页进度"）→ 覆盖为正常种子——防"有完整内容却常驻
    //   加载失败行、链式加载被 error 态堵死"的矛盾态（review R3-P2）；
    // - 其余（已分页深入）不写——重激活窗口的 cursor 锚点更"新"，回退会重复
    //   拉取已加载区间
    const prev = this.sessionPages.get(sessionID)
    const isErrorSeed =
      prev != null && prev.error && prev.nextCursor == null && !prev.exhausted && !prev.loading
    if (!prev || isErrorSeed) {
      this.sessionPages.set(sessionID, {
        nextCursor: page.nextCursor,
        exhausted: page.nextCursor == null,
        loading: false,
        error: false,
      })
    }
    // finish 推断（design-typing-indicator §4 来源 5）：末条 assistant 终态 ⇒ idle；
    // tool-calls/null 不触发（进行中消息在 REST 可见，D-SS-A）——兜底断线丢
    // session.idle 的场景（手动刷新/激活重拉）
    const merged = this.messagesBySession.get(sessionID)
    if (
      merged &&
      inferIdleFromMessages([...merged.values()].sort(sortMessages).map((m) => m.info))
    ) {
      this.setSessionStatus(sessionID, { type: "idle" })
    }
    this.emit()
  }

  /** 是否还能加载更早历史（UI 链式加载消费；error 态不算——失败停链，重试走显式入口） */
  canLoadEarlier(sessionID: string): boolean {
    const s = this.sessionPages.get(sessionID)
    return s != null && !s.exhausted && !s.loading && !s.error
  }

  /**
   * 上滚分页加载更早消息（design-message-history-pagination §4.2）。
   * - 无状态（挂载窗口加载失败/SSE-only）→ 先窗口加载种子 cursor；种子失败置
   *   error——本路径是挂载加载失败的唯一重试入口（error 行点击/上滑可达）；
   * - in-flight 去重；穷尽直返（error 态允许重试）；
   * - 在途落地按状态对象身份守卫：关 Tab 快速重开重建了新状态时，旧页整体丢弃；
   * - 失败置 error（UI 重试行），不判穷尽可重试。
   */
  async loadEarlierMessages(sessionID: string) {
    const client = this.client
    const session = this.findSession(sessionID)
    if (!client || !session) return
    let state = this.sessionPages.get(sessionID)
    if (!state || state.nextCursor == null) {
      // 穷尽且非 error 态：无操作（error + cursor null = 种子失败，允许重试）
      if (state && state.exhausted && !state.error) return
      if (state?.loading) return
      state = { nextCursor: null, exhausted: false, loading: true, error: false }
      this.sessionPages.set(sessionID, state)
      this.emit()
      const seed = await client
        .listMessagesPage(sessionID, session.directory, { limit: 100 })
        .catch(() => null)
      if (this.sessionPages.get(sessionID) !== state) return
      state.loading = false
      if (!seed) {
        state.error = true
        this.emit()
        return
      }
      this.mergeMessagePage(sessionID, seed.entries)
      state.nextCursor = seed.nextCursor
      state.exhausted = seed.nextCursor == null
      state.error = false
      this.emit()
      if (state.exhausted) return
    }
    if (state.loading || state.exhausted) return
    const before = state.nextCursor!
    state.loading = true
    state.error = false
    this.emit()
    try {
      const page = await client.listMessagesPage(sessionID, session.directory, {
        limit: 100,
        before,
      })
      // 身份守卫：在途期间关 Tab 重开/断开重建了状态 → 旧页整体丢弃
      const cur = this.sessionPages.get(sessionID)
      if (cur !== state) return
      const added = this.mergeMessagePage(sessionID, page.entries)
      cur.loading = false
      cur.error = false
      // 无 cursor 头 = 历史穷尽；空页同理。防御违约 server（空/全重复页 + 非 null
      // cursor）触发链式死循环：本页零新增同样判穷尽停链
      cur.exhausted = page.nextCursor == null || added === 0
      // 保持不变式 exhausted ⇒ nextCursor == null（错误态除外，见字段注释）
      cur.nextCursor = cur.exhausted ? null : page.nextCursor
    } catch {
      const cur = this.sessionPages.get(sessionID)
      if (cur === state) {
        cur.loading = false
        cur.error = true
      }
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
      // 消除首字节延迟——dots 于预留槽内立即出现。仅 idle 时写：busy 幂等可不写，
      // retry 态写入会把退避提示（attempt/message）覆写成 dots——server 每个
      // backoff 窗口只发一次 retry 事件，错误指示将持续整个退避期（design-supplement-send §3.2）
      if (this.statusOf(sessionID).type === "idle") {
        this.setSessionStatus(sessionID, { type: "busy" }, session.directory)
      }
      this.emit()
      return { ok: true }
    } catch (e) {
      // 撤回乐观 + 提示（写操作不自动重试）；connectionError 经左栏状态行可见
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

  // ============ 待处理人机交互（授权/问题） ============

  /** 会话的问题卡（插入序排队） */
  questionsForSession(sessionID: string): PendingQuestion[] {
    return [...this.pendingQuestions.values()].filter((q) => q.sessionID === sessionID)
  }

  /** 会话待处理数（权限 ≤1 + 问题 N），指示器投影输入 */
  pendingCountFor(sessionID: string): number {
    return (this.pendingPermissions.has(sessionID) ? 1 : 0) + this.questionsForSession(sessionID).length
  }

  /**
   * 会话状态点投影（design-agent-status-indicator：waiting > running > idle，
   * waiting 显示时 busy 底层事实保留不覆写）。
   */
  dotStateFor(sessionID: string): SessionDotState {
    return sessionDotState(this.pendingCountFor(sessionID), this.isSessionActive(sessionID))
  }

  /**
   * 目录级 pending 回填：成功目录权威合并（失败目录跳过、保留本地）。
   * 触发：冷启动 connect / 开项目 / 切工作区；SSE 重连走 reconciler 的
   * onPendingSnapshot（同一合并函数）。
   */
  private async backfillPending() {
    const client = this.client
    if (!client) return
    const dirs = this.openedDirectories()
    let changed = false
    await runLimited(dirs, 3, async (dir) => {
      // 两类别串行：每任务在途 ≤1 条，并发上限 3（预算克制，与 reconciler 的
      // 逐目录串行同答案——SSE 常驻 5 条后 REST 池仅 ~1 空闲）
      const permissions = await client.listPendingPermissions(dir).catch(() => null)
      const questions = await client.listPendingQuestions(dir).catch(() => null)
      // 在途闸门（同 applySessionsSnapshot）：disconnect/切 profile 后丢弃旧连接的
      // 迟到结果，防止写回已清空的 map；目录已出打开集合（关项目/删 worktree）同理
      if (this.client !== client || !this.openedDirectories().includes(dir)) return
      // 各类别独立合并；null = 失败保留本地（同 reconcile 路径）
      changed =
        mergePendingSnapshot(
          this.pendingPermissions,
          this.pendingQuestions,
          dir,
          permissions,
          questions,
        ) || changed
    })
    if (changed) this.emit()
  }

  /** 卸载会话的全部 pending（会话删除时；归档不卸载——server 侧仍待处理，同移动端） */
  private dropPendingForSession(sessionID: string) {
    this.pendingPermissions.delete(sessionID)
    for (const q of this.questionsForSession(sessionID)) this.pendingQuestions.delete(q.id)
  }

  /** 卸载一组目录的 pending（关项目/删 worktree：目录失去订阅通道） */
  private dropPendingForDirectories(dirs: string[]) {
    const set = new Set(dirs)
    for (const [sid, p] of [...this.pendingPermissions]) {
      if (set.has(p.directory)) this.pendingPermissions.delete(sid)
    }
    for (const [qid, q] of [...this.pendingQuestions]) {
      if (set.has(q.directory)) this.pendingQuestions.delete(qid)
    }
  }

  /**
   * 回复权限卡。200 = 成功；404 = 已被其他端处理（静默移除，同移动端决策 3）；
   * 其他错误保留卡片由 UI 提示。
   */
  async respondPermission(
    sessionID: string,
    response: "once" | "always" | "reject",
  ): Promise<{ ok: boolean; error?: string }> {
    const client = this.client
    const p = this.pendingPermissions.get(sessionID)
    if (!client || !p) return { ok: false, error: "no pending permission" }
    try {
      await client.respondPermission(sessionID, p.id, p.directory, response)
      // 按 id 守卫移除（移动端 removeWhere(p.id == pid) 教训）：in-flight 期间他端
      // 应答 + agent 立即发出同会话新卡会落入同 key，无条件 delete 会误删新卡
      if (this.pendingPermissions.get(sessionID)?.id === p.id) {
        this.pendingPermissions.delete(sessionID)
      }
      this.emit()
      return { ok: true }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        if (this.pendingPermissions.get(sessionID)?.id === p.id) {
          this.pendingPermissions.delete(sessionID)
        }
        this.emit()
        return { ok: true }
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 回答问题卡（answers 按子问题顺序，每项为选中 label 数组）；404 语义同上 */
  async replyQuestion(
    questionID: string,
    answers: string[][],
  ): Promise<{ ok: boolean; error?: string }> {
    const client = this.client
    const q = this.pendingQuestions.get(questionID)
    if (!client || !q) return { ok: false, error: "no pending question" }
    try {
      await client.replyQuestion(questionID, q.directory, answers)
      this.pendingQuestions.delete(questionID)
      this.emit()
      return { ok: true }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        this.pendingQuestions.delete(questionID)
        this.emit()
        return { ok: true }
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** 拒绝问题卡；404 语义同上 */
  async rejectQuestion(questionID: string): Promise<{ ok: boolean; error?: string }> {
    const client = this.client
    const q = this.pendingQuestions.get(questionID)
    if (!client || !q) return { ok: false, error: "no pending question" }
    try {
      await client.rejectQuestion(questionID, q.directory)
      this.pendingQuestions.delete(questionID)
      this.emit()
      return { ok: true }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        this.pendingQuestions.delete(questionID)
        this.emit()
        return { ok: true }
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // ============ agent/模型目录与切换（design-agent-model-switch）===========

  /** 当前 profile 的默认值（只读快照）。 */
  defaultsFor(): ModelDefaults {
    return getDefaults(this.defaults, this.profileKey())
  }

  /** 写入默认值并持久化（设置对话框 / 引导页工具条 / 会话内手动切换隐式写入共用）。 */
  async setModelDefaults(patch: ModelDefaults): Promise<void> {
    const next = setDefaults(this.defaults, this.profileKey(), patch)
    if (next === this.defaults) return
    this.defaults = next
    await window.desktop.storeSet("model.defaults", this.defaults).catch(() => {})
    this.emit()
  }

  /**
   * 目录级 agent/模型缓存（SWR）：命中即返回缓存，未命中返回空 catalog，
   * 同时触发后台拉取（in-flight 去重 + client 身份守卫）。
   * popover 打开时再调一次以刷新（后台覆盖，失败保留缓存）。
   */
  modelCatalogFor(directory: string): ModelCatalog {
    return this.modelCatalogs.get(directory) ?? emptyCatalog
  }

  refreshModelCatalog(directory: string | null): Promise<void> {
    const client = this.client
    if (!client || !directory) return Promise.resolve()
    const existing = this.modelCatalogLoading.get(directory)
    if (existing) return existing
    let p!: Promise<void>
    p = (async () => {
      let agents: AgentInfo[] | null = null
      let providers: ConfigProviders | null = null
      try {
        ;[agents, providers] = await Promise.all([
          client.listAgents(directory).catch(() => null),
          client.listConfigProviders(directory).catch(() => null),
        ])
      } catch {
        // 两个请求均保留 null（失败即按失败处理）
      }
      // client 身份守卫：迟到于 teardown 的旧 fetch 不写新连接
      if (this.client !== client) return
      const prev = this.modelCatalogs.get(directory)
      if (agents === null && providers === null) {
        // 失败保留好缓存（设计错误表"目录加载失败"）；
        // 完全失败且无缓存 → 记入失败态，工具条显示重试
        if (!prev) this.modelCatalogFailed.add(directory)
      } else {
        this.modelCatalogFailed.delete(directory)
        // 按数据源分别保留：单源失败不覆盖该源的好缓存
        const catalog: ModelCatalog = {
          agents: agents !== null ? parseAgents(agents) : (prev?.agents ?? []),
          models: providers !== null ? parseModels(providers) : (prev?.models ?? []),
        }
        this.modelCatalogs.set(directory, catalog)
      }
      this.emit()
    })().finally(() => {
      if (this.modelCatalogLoading.get(directory) === p) this.modelCatalogLoading.delete(directory)
    })
    this.modelCatalogLoading.set(directory, p)
    return p
  }

  /** 目录是否处于"加载失败且无缓存"态——工具条重试入口的判断依据。 */
  modelCatalogFailedFor(directory: string): boolean {
    return this.modelCatalogFailed.has(directory)
  }

  /** 拉取目录数据（首次挂载工具条用：缓存命中且非失败态才跳过）。 */
  async ensureModelCatalog(directory: string): Promise<void> {
    if (this.modelCatalogs.has(directory) && !this.modelCatalogFailed.has(directory)) return
    await this.refreshModelCatalog(directory)
  }

  /** 切换会话 agent：POST 204 → 乐观写本地记录；失败不改本地。 */
  async switchSessionAgent(sessionID: string, agent: string): Promise<boolean> {
    const client = this.client
    if (!client) return false
    try {
      await client.switchAgent(sessionID, agent)
      this.patchSessionAgent(sessionID, agent)
      return true
    } catch (e) {
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.emit()
      return false
    }
  }

  /**
   * 切换会话 model：POST 204 → 乐观写本地记录。
   * variant 携带规则（carriedVariant）：切到另一模型时同名 variant 沿用，否则省略。
   * 隐式默认（D-AM-4 修订）：手动切换即最后一次选择 → 成功后同步写全局默认值。
   */
  async switchSessionModel(
    sessionID: string,
    providerID: string,
    id: string,
    variant?: string,
  ): Promise<boolean> {
    const client = this.client
    if (!client) return false
    const session = this.findSession(sessionID)
    // 切模型时若未显式传 variant，按携带规则推导（仅当新模型有同名 variant 才沿用）
    let model: ModelRef
    let carryVariant = variant
    if (carryVariant === undefined && session) {
      const catalog = this.modelCatalogFor(session.directory)
      const target = findModel(catalog.models, providerID, id)
      if (target) carryVariant = carriedVariant(session.model?.variant, target)
    }
    if (carryVariant) model = { id, providerID, variant: carryVariant }
    else model = { id, providerID }
    try {
      await client.switchModel(sessionID, model)
      this.patchSessionModel(sessionID, model)
      await this.setModelDefaults({ model })
      return true
    } catch (e) {
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.emit()
      return false
    }
  }

  /**
   * 切换会话思考强度（variant）。variant=undefined 表示「默认」（省略字段清掉已设值）。
   * 隐式默认（D-AM-4 修订）：同 switchSessionModel，成功后同步写全局默认值。
   */
  async switchSessionVariant(
    sessionID: string,
    providerID: string,
    id: string,
    variant: string | undefined,
  ): Promise<boolean> {
    const client = this.client
    if (!client) return false
    const model: ModelRef = variant ? { id, providerID, variant } : { id, providerID }
    try {
      await client.switchModel(sessionID, model)
      this.patchSessionModel(sessionID, model)
      await this.setModelDefaults({ model })
      return true
    } catch (e) {
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.emit()
      return false
    }
  }

  /**
   * 乐观/事件补丁共用的写路径（幂等）：更新 sessionsByProject 中该会话的 agent 字段。
   * 闸门同 session.updated：会话须仍存在（关项目/删会话的迟到事件/迟到写直接丢弃）。
   */
  private patchSessionAgent(sessionID: string, agent: string) {
    const session = this.findSession(sessionID)
    if (!session) return
    if (session.agent === agent) return
    const updated: Session = { ...session, agent }
    this.mergeSessionUpdate(updated)
  }

  private patchSessionModel(sessionID: string, model: ModelRef) {
    const session = this.findSession(sessionID)
    if (!session) return
    const prevModel = session.model
    if (
      prevModel &&
      prevModel.id === model.id &&
      prevModel.providerID === model.providerID &&
      prevModel.variant === model.variant
    )
      return
    const updated: Session = { ...session, model }
    this.mergeSessionUpdate(updated)
  }

  /** 将更新后的 session 合并回 sessionsByProject 并触发 emit（与 session.updated 事件同路径）。 */
  private mergeSessionUpdate(updated: Session) {
    const map = this.sessionsByProject.get(updated.projectID)
    if (map) map.set(updated.id, updated)
    this.emit()
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

  async setShowThinking(value: boolean) {
    this.showThinking = value
    await window.desktop.storeSet("chat.showThinking", value)
    this.emit()
  }

  // ============ 对账挂载 ============

  mountReconciler() {
    this.reconciler = new Reconciler({
      client: () => this.client,
      // 对账目录源 = 打开项目全集（与事件闸门同源；单全局流下无"订阅集"概念；
      // global 分支 = 已打开目录 entry，见 openedDirectories）
      getOpenedDirectories: () => this.openedDirectories(),
      // 状态快照目录集同源（全集内每个目录都有事件通道，stale busy 纠正覆盖全部）
      getStatusDirectories: () => this.openedDirectories(),
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
        // 对账回填成功：清同形状 error 种子（挂载失败种子 vs 已回填内容的矛盾态，
        // review R3-P2）——回到无状态，重激活/上滚走正常种子
        const prev = this.sessionPages.get(sessionID)
        if (prev && prev.error && prev.nextCursor == null && !prev.exhausted && !prev.loading) {
          this.sessionPages.delete(sessionID)
        }
        // finish 推断兜底（断线期间完成的会话不再卡 busy）
        if (inferIdleFromMessages([...merged.values()].sort(sortMessages).map((m) => m.info))) {
          this.setSessionStatus(sessionID, { type: "idle" })
        }
      },
      onPendingSnapshot: (dir, permissions, questions) => {
        // 在途闸门：连接已拆或目录已出打开集合（in-flight reconcile 跨越了 teardown/
        // 关项目）时丢弃，防止写回已清空的 map
        if (!this.client || !this.openedDirectories().includes(dir)) return
        // 各类别独立合并；null = 该目录该类别抓取失败，保留本地
        mergePendingSnapshot(this.pendingPermissions, this.pendingQuestions, dir, permissions, questions)
      },
      onReconcileStateChange: (active) => {
        this.reconciling = active
        this.emit()
      },
      log: (...args) => console.debug("[reconcile]", ...args),
    })
  }

  /** 窗口 focus：kick 退避（design-sse-reconnect-recovery 的 resume 语义） */
  kickReconnect() {
    this.sseSubscriber?.reconnectNow()
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
