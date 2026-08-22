/**
 * 应用状态层：连接 → 项目/工作区 → 会话 → 消息 → Tab。
 * 事件闸门、乐观消息、SSE 生命周期都在这里收敛。
 */
import { RestClient } from "@shared/rest-client"
import { SseSubscriber, type SseStatus } from "@shared/sse-subscriber"
import { Reconciler } from "@shared/reconciler"
import {
  mergeSnapshotIntoMessages,
  sortEntries,
  type ChatEntry,
  type OptimisticMessage,
} from "@shared/message-merge"
import type {
  ConnectionProfile,
} from "@shared/ipc"
import "@shared/ipc-global"
import type {
  FileNode,
  HealthInfo,
  Message,
  MessageWithParts,
  OpencodeEvent,
  Part,
  Project,
  Session,
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
  busySessions = new Set<string>()

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
    this.busySessions.clear()
    this.tabs = []
    this.activeTabKey = null
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
    const client = this.client!
    await Promise.all(
      this.openedProjects.map(async (p) => {
        const sessions = await client.listSessions(p.worktree).catch(() => [] as Session[])
        this.mergeSessionsSnapshot(p.id, sessions)
      }),
    )
  }

  /**
   * 会话快照合并（与消息层同原则：不清空重置，防 async gap 丢失 SSE 事件）。
   * REST 权威覆盖同 id；本地新增（SSE-only）保留；updated 落在快照窗口开区间
   * 且不在快照中的本地项视为已删除。
   */
  private mergeSessionsSnapshot(projectId: string, sessions: Session[]) {
    const filtered = sessions.filter((s) => s.projectID === projectId)
    const existing = this.sessionsByProject.get(projectId) ?? new Map<string, Session>()
    const next = new Map<string, Session>()
    const snapIds = new Set<string>()
    for (const s of filtered) {
      snapIds.add(s.id)
      next.set(s.id, s)
    }
    if (filtered.length >= 2) {
      const minUpdated = Math.min(...filtered.map((s) => s.time.updated))
      const maxUpdated = Math.max(...filtered.map((s) => s.time.updated))
      for (const [id, s] of existing) {
        if (snapIds.has(id)) continue
        if (s.time.updated > minUpdated && s.time.updated < maxUpdated) continue
        next.set(id, s)
      }
    } else {
      for (const [id, s] of existing) {
        if (!snapIds.has(id)) next.set(id, s)
      }
    }
    this.sessionsByProject.set(projectId, next)
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
        onReconnected: () => this.reconciler?.request(),
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
        if (info.role === "assistant") {
          const completed = info.time.completed != null
          if (completed) this.busySessions.delete(sessionID)
          else this.busySessions.add(sessionID)
        }
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
      default:
        // 未知事件透传忽略（AGENTS.md 风险对策）
        break
    }
    this.emit()
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

  async openProject(projectId: string) {
    const ps = this.projectStateFor()
    if (!ps.opened.includes(projectId)) ps.opened.push(projectId)
    ps.currentProjectId = projectId
    ps.currentWorkspaceId = null
    await this.persistProjectState()
    await this.switchProjectContext()
    this.emit()
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
    // 卸载该项目的会话状态（关闭 = 不展示 + 不更新）
    this.sessionsByProject.delete(projectId)
    await this.persistProjectState()
    await this.switchProjectContext()
    this.emit()
  }

  async setCurrentProject(projectId: string) {
    await this.openProject(projectId)
  }

  /** 切工作区：参数是 worktree directory（null = 主工作区） */
  async setCurrentWorkspace(directory: string | null) {
    const ps = this.projectStateFor()
    ps.currentWorkspaceId = directory
    await this.persistProjectState()
    // 切工作区：重拉会话列表 + SSE 重订（scope 目录变化）+ 文件树重置
    await this.refreshSessionsForProject(this.currentProject!)
    this.startSse()
    this.resetFileTree()
    this.emit()
  }

  /** 切项目/开项目后：归档旧 chat Tab + 快照 + SSE 重订阅 + 文件树重置 */
  private async switchProjectContext() {
    if (!this.client) return
    // 锁定语义：chat Tab 关闭即归档——切项目 = 旧项目 Tab 全关 → 逐个归档
    await this.archiveAllChatTabs()
    await this.refreshAllOpenedProjects()
    this.startSse()
    this.resetFileTree()
  }

  /** 归档当前所有 chat Tab（流式中先 abort），并卸载其会话状态 */
  private async archiveAllChatTabs() {
    const chatTabs = this.tabs.filter((t) => t.kind === "chat")
    this.tabs = []
    this.activeTabKey = null
    for (const tab of chatTabs) {
      const sessionID = tab.key.slice(5)
      if (this.busySessions.has(sessionID)) {
        await this.abortSession(sessionID).catch(() => {})
      }
      await this.patchSessionArchive(sessionID, Date.now()).catch(() => {})
      this.cleanupSessionState(sessionID)
    }
    this.emit()
  }

  /** 卸载单个会话的运行时状态（关 Tab/删会话/切项目时调用，防无界增长） */
  private cleanupSessionState(sessionID: string) {
    this.messagesBySession.delete(sessionID)
    this.pendingPartsMap.delete(sessionID)
    this.optimisticBySession.delete(sessionID)
    this.busySessions.delete(sessionID)
  }

  private resetFileTree() {
    this.fileTreeExpanded.clear()
    this.fileTreeNodes.clear()
    this.fileContents.clear()
  }

  async refreshSessionsForProject(project: Project) {
    if (!this.client) return
    const sessions = await this.client.listSessions(project.worktree).catch(() => [] as Session[])
    this.mergeSessionsSnapshot(project.id, sessions)
  }

  async createWorkspace(name?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.client || !this.currentProject) return { ok: false, error: "no project" }
    try {
      await this.client.createWorktree(this.currentProject.worktree, name)
      // worktree API 返回轻量对象，重拉列表拿完整 Workspace 记录
      await this.refreshWorkspacesForProject(this.currentProject)
      // 新 worktree 目录需要 SSE 订阅（worktree 事件流独立于项目根）
      this.startSse()
      this.emit()
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
      const ps = this.projectStateFor()
      if (ps.currentWorkspaceId === directory) {
        ps.currentWorkspaceId = null
        await this.persistProjectState()
      }
      await this.refreshSessionsForProject(this.currentProject)
      this.resetFileTree()
      this.startSse()
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
  get workspacesOfCurrentProject(): Array<{ name: string; directory: string }> {
    const p = this.currentProject
    if (!p) return []
    return (p.sandboxes ?? []).map((dir) => ({
      name: dir.split("/").pop() ?? dir,
      directory: dir,
    }))
  }

  // ============ 会话 ============

  /** 当前作用域的 directory（客户端 worktree 过滤：directory 精确匹配） */
  private scopeDirectory(): string {
    return this.currentWorkspace?.directory ?? this.currentProject?.worktree ?? ""
  }

  get visibleSessions(): Session[] {
    const project = this.currentProject
    if (!project) return []
    const dir = this.scopeDirectory()
    return [...(this.sessionsByProject.get(project.id)?.values() ?? [])]
      .filter((s) => !s.time.archived && s.directory === dir)
      .sort((a, b) => b.time.updated - a.time.updated)
  }

  get archivedSessions(): Session[] {
    const project = this.currentProject
    if (!project) return []
    const dir = this.scopeDirectory()
    return [...(this.sessionsByProject.get(project.id)?.values() ?? [])]
      .filter((s) => s.time.archived && s.directory === dir)
      .sort((a, b) => b.time.updated - a.time.updated)
  }

  async createSession(): Promise<Session | null> {
    if (!this.client || !this.currentProject) return null
    const { directory } = this.scopeQuery
    try {
      const session = await this.client.createSession(directory)
      const map = this.sessionsByProject.get(this.currentProject.id) ?? new Map()
      map.set(session.id, session)
      this.sessionsByProject.set(this.currentProject.id, map)
      this.openChatTab(session)
      // 加载历史（新会话通常为空）
      void this.loadSessionMessages(session.id, directory)
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
    this.reevaluateBusy(sessionID, merged)
    this.emit()
  }

  /** busy 重估：仅当存在未完成 assistant 才 busy（防断线丢事件后永久卡 busy） */
  private reevaluateBusy(sessionID: string, messages?: Map<string, MessageWithParts>) {
    const msgs = messages ?? this.messagesBySession.get(sessionID)
    if (!msgs) return
    let busy = false
    for (const m of msgs.values()) {
      if (m.info.role === "assistant" && m.info.time.completed == null) {
        busy = true
        break
      }
    }
    if (busy) this.busySessions.add(sessionID)
    else this.busySessions.delete(sessionID)
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

  async renameSession(sessionID: string, title: string): Promise<boolean> {
    if (!this.client) return false
    const session = this.findSession(sessionID)
    if (!session) return false
    try {
      const updated = await this.client.updateSession(sessionID, session.directory, { title })
      if (!updated) return false
      const map = this.sessionsByProject.get(updated.projectID)
      map?.set(updated.id, updated)
      this.emit()
      return true
    } catch {
      return false
    }
  }

  async deleteSession(sessionID: string): Promise<boolean> {
    if (!this.client) return false
    const session = this.findSession(sessionID)
    // 已不存在：本地收尾即成功
    if (!session) {
      this.closeTab(`chat:${sessionID}`, { archive: false })
      this.cleanupSessionState(sessionID)
      return true
    }
    try {
      await this.client.deleteSession(sessionID, session.directory)
      this.sessionsByProject.get(session.projectID)?.delete(sessionID)
      this.closeTab(`chat:${sessionID}`, { archive: false })
      this.cleanupSessionState(sessionID)
      this.emit()
      return true
    } catch {
      return false
    }
  }

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
      return { ok: true }
    } catch (e) {
      // 撤回乐观 + 提示（写操作不自动重试）
      this.optimisticBySession.set(
        sessionID,
        (this.optimisticBySession.get(sessionID) ?? []).filter((o) => o.localId !== optimistic.localId),
      )
      this.emit()
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async abortSession(sessionID: string) {
    if (!this.client) return
    const session = this.findSession(sessionID)
    if (!session) return
    await this.client.abortSession(sessionID, session.directory).catch(() => {})
  }

  // ============ Tab ============

  openChatTab(session: Session) {
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
    this.tabs.splice(idx, 1)
    if (this.activeTabKey === key) {
      this.activeTabKey = this.tabs[Math.min(idx, this.tabs.length - 1)]?.key ?? null
    }
    this.emit()
  }

  setActiveTab(key: string) {
    this.activeTabKey = key
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
    if (nodes) {
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
      getActiveSessions: () =>
        this.tabs
          .filter((t) => t.kind === "chat")
          .map((t) => ({ sessionID: t.key.slice(5), directory: t.directory! })),
      onSessionsSnapshot: (dir, sessions) => {
        // 按项目合并（不清空重置）；同一 dir 可能含多项目会话
        const byProject = new Map<string, Session[]>()
        for (const s of sessions) {
          const list = byProject.get(s.projectID) ?? []
          list.push(s)
          byProject.set(s.projectID, list)
        }
        for (const [pid, list] of byProject) {
          this.mergeSessionsSnapshot(pid, list)
        }
        // 无 Tab 的 busy 会话：会话快照到达即重置（若仍在流式，后续事件会重新置位）
        const tabSessions = new Set(
          this.tabs.filter((t) => t.kind === "chat").map((t) => t.key.slice(5)),
        )
        for (const sid of [...this.busySessions]) {
          if (!tabSessions.has(sid)) this.busySessions.delete(sid)
        }
        void dir
      },
      onMessagesSnapshot: (sessionID, msgs) => {
        const local = this.messagesBySession.get(sessionID) ?? new Map()
        const merged = mergeSnapshotIntoMessages(local, msgs)
        this.messagesBySession.set(sessionID, merged)
        // 对账后重估 busy（断线期间完成的会话不再卡 busy）
        this.reevaluateBusy(sessionID, merged)
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
