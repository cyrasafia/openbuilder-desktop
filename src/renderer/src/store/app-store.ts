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
  private subscriber: SseSubscriber | null = null
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

  async init() {
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
    this.connectionState = "connecting"
    this.connectionError = null
    this.emit()

    let baseUrl = profile.baseUrl
    if (profile.mode === "managed") {
      const res = await window.desktop.managedStart()
      if (!res.ok || !res.baseUrl) {
        this.connectionState = "disconnected"
        this.connectionError = res.error ?? "managed 启动失败"
        this.emit()
        return
      }
      baseUrl = res.baseUrl
      this.managedBaseUrl = baseUrl
    }

    const client = new RestClient({
      baseUrl,
      username: profile.username,
      password: profile.password,
    })
    try {
      this.health = await client.health()
    } catch (e) {
      this.connectionState = "disconnected"
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.emit()
      return
    }
    this.client = client

    // 快照：项目
    try {
      this.projects = await client.listProjects()
    } catch (e) {
      this.connectionState = "disconnected"
      this.connectionError = `项目列表拉取失败: ${e instanceof Error ? e.message : e}`
      this.emit()
      return
    }

    // 首次连接默认打开 current + 最近 1 个（design-layout）
    await this.ensureDefaultProjects()

    // 打开项目的快照 + 订阅
    await this.refreshAllOpenedProjects()
    this.startSse()
    this.connectionState = "streaming"
    this.emit()
  }

  async disconnect() {
    this.subscriber?.stop()
    this.subscriber = null
    if (this.activeProfile?.mode === "managed") {
      await window.desktop.managedStop()
    }
    this.client = null
    this.connectionState = "disconnected"
    this.emit()
  }

  private async ensureDefaultProjects() {
    const ps = this.projectStateFor()
    if (ps.opened.length > 0) return
    try {
      const current = await this.client!.currentProject()
      ps.opened = [current.id]
      ps.currentProjectId = current.id
      this.projectStates[this.profileKey()] = ps
    } catch {
      // 无 current（如 global），fallback 第一个
      if (this.projects.length > 0) {
        ps.opened = [this.projects[0].id]
        ps.currentProjectId = this.projects[0].id
      }
    }
    await this.persistProjectState()
  }

  private async refreshAllOpenedProjects() {
    const client = this.client!
    await Promise.all(
      this.openedProjects.map(async (p) => {
        const dir = p.worktree
        const sessions = await client.listSessions(dir).catch(() => [] as Session[])
        this.sessionsByProject.set(
          p.id,
          new Map(sessions.filter((s) => s.projectID === p.id).map((s) => [s.id, s])),
        )
      }),
    )
  }

  private startSse() {
    const profile = this.activeProfile
    if (!profile || !this.client) return
    this.subscriber?.stop()
    const dirs = this.openedProjects.map((p) => p.worktree)
    // 每个打开的目录一条订阅（多目录聚合到一个订阅器实例组）
    this.sseGroup = []
    for (const dir of dirs) {
      const sub = new SseSubscriber({
        baseUrl: this.activeBaseUrl!,
        directory: dir,
        username: profile.username,
        password: profile.password,
        onEvent: (ev) => this.handleEvent(dir, ev),
        onReconnected: () => this.reconciler?.request(),
        onStatus: (s) => this.updateSseAggregate(),
        log: (...args) => console.debug("[sse]", ...args),
      })
      sub.start()
      this.sseGroup.push(sub)
    }
    this.updateSseAggregate()
  }

  private sseGroup: SseSubscriber[] = []

  private get activeBaseUrl(): string | null {
    return this.baseUrl
  }

  private updateSseAggregate() {
    const statuses = new Set(this.sseGroup.map((s) => s.getStatus()))
    const sseStatus: SseStatus = statuses.has("connected")
      ? "connected"
      : statuses.has("connecting")
        ? "connecting"
        : statuses.has("reconnecting")
          ? "reconnecting"
          : "stopped"
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
        break
      }
      case "message.updated": {
        const { sessionID, info } = ev.properties as { sessionID: string; info: Message }
        this.ensureConversation(sessionID)
        let m = this.messagesBySession.get(sessionID)
        const prev = m?.get(info.id)
        m!.set(info.id, prev ? { info, parts: prev.parts } : { info, parts: [] })
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
        const msg = this.messagesBySession.get(sessionID)!.get(part.messageID)
        if (msg) {
          const idx = msg.parts.findIndex((p) => p.id === part.id)
          if (idx >= 0) {
            msg.parts[idx] = part
          } else {
            msg.parts.push(part)
          }
          // 触发 immutable 更新
          this.messagesBySession.get(sessionID)!.set(part.messageID, { ...msg })
        } else {
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

  /** 惰性累积容器（design-message-accumulation）：事件到达即建容器，不发 REST */
  private ensureConversation(sessionID: string) {
    if (!this.messagesBySession.has(sessionID)) {
      this.messagesBySession.set(sessionID, new Map())
    }
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
      ps.currentProjectId = ps.opened[0] ?? null
      ps.currentWorkspaceId = null
    }
    // 卸载该项目的会话状态
    const project = this.projects.find((p) => p.id === projectId)
    if (project) this.sessionsByProject.delete(projectId)
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
    // 切工作区：重拉会话列表 + 文件树重置
    await this.refreshSessionsForProject(this.currentProject!)
    this.resetFileTree()
    this.emit()
  }

  /** 切项目/开项目后：快照 + SSE 重订阅 + Tab/文件树重置 */
  private async switchProjectContext() {
    if (!this.client) return
    await this.refreshAllOpenedProjects()
    this.startSse()
    this.resetWorkspaceTabs()
    this.resetFileTree()
  }

  private resetWorkspaceTabs() {
    // project-scoped：切项目 = Tab 全关（chat 关闭即归档，见 closeChatTab；
    // 这里直接卸载状态，归档由显式关闭路径处理——切换场景提示语在 UI 层确认）
    this.tabs = []
    this.activeTabKey = null
  }

  private resetFileTree() {
    this.fileTreeExpanded.clear()
    this.fileTreeNodes.clear()
    this.fileContents.clear()
  }

  async refreshSessionsForProject(project: Project) {
    if (!this.client) return
    const dir = project.worktree
    const sessions = await this.client.listSessions(dir).catch(() => [] as Session[])
    this.sessionsByProject.set(
      project.id,
      new Map(sessions.filter((s) => s.projectID === project.id).map((s) => [s.id, s])),
    )
  }

  async createWorkspace(name?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.client || !this.currentProject) return { ok: false, error: "no project" }
    try {
      await this.client.createWorktree(this.currentProject.worktree, name)
      // worktree API 返回轻量对象，重拉列表拿完整 Workspace 记录
      await this.refreshWorkspacesForProject(this.currentProject)
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
    // busy 推断：最后一条 assistant 未完成
    for (const m of merged.values()) {
      if (m.info.role === "assistant" && m.info.time.completed == null) {
        this.busySessions.add(sessionID)
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
    if (!session) return false
    try {
      await this.client.deleteSession(sessionID, session.directory)
      this.sessionsByProject.get(session.projectID)?.delete(sessionID)
      this.closeTab(`chat:${sessionID}`, { archive: false })
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

  /** 关闭 chat Tab = 归档（design-layout 锁定语义） */
  async closeChatTab(sessionID: string, opts: { streaming: boolean }): Promise<boolean> {
    if (opts.streaming) {
      await this.abortSession(sessionID)
    }
    const ok = await this.archiveSession(sessionID)
    if (ok) this.closeTab(`chat:${sessionID}`, { archive: false })
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
      client: () => this.client!,
      getOpenedDirectories: () => this.openedProjects.map((p) => p.worktree),
      getActiveSessions: () =>
        this.tabs
          .filter((t) => t.kind === "chat")
          .map((t) => ({ sessionID: t.key.slice(5), directory: t.directory! })),
      onSessionsSnapshot: (dir, sessions) => {
        const projectIds = new Set(sessions.map((s) => s.projectID))
        for (const pid of projectIds) {
          this.sessionsByProject.set(
            pid,
            new Map(sessions.filter((s) => s.projectID === pid).map((s) => [s.id, s])),
          )
        }
      },
      onMessagesSnapshot: (sessionID, msgs) => {
        const local = this.messagesBySession.get(sessionID) ?? new Map()
        this.messagesBySession.set(sessionID, mergeSnapshotIntoMessages(local, msgs))
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
