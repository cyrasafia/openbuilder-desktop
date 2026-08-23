/**
 * 应用状态层：连接 → 项目/工作区 → 会话 → 消息 → Tab。
 * 事件闸门、乐观消息、SSE 生命周期都在这里收敛。
 */
import { RestClient } from "@shared/rest-client"
import { SseSubscriber, type SseStatus } from "@shared/sse-subscriber"
import { Reconciler } from "@shared/reconciler"
import { mergeSessionsSnapshot } from "@shared/session-merge"
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
    await AppStore.runLimited(this.openedProjects, 2, (p) => this.refreshSessionsForProject(p))
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
    this.sessionsByProject.set(projectId, mergeSessionsSnapshot(local, directory, filtered))
  }

  /** 并发受限执行（REST 池约束：5 条 SSE 常驻后仅 ~1 空闲连接，无限扇出会让
   *  排队请求的 AbortSignal.timeout 从分发起算、尾部请求饿死超时——降级为空
   *  快照虽保守保命，但该目录会一直陈旧到下次刷新） */
  private static async runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const item = items[next++]
          await fn(item)
        }
      }),
    )
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
    // 该项目的 chat Tab 随之关闭（仅关 Tab，不归档——归档只发生在显式关闭 Tab）
    const project = this.projects.find((p) => p.id === projectId)
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
    // 切工作区：重拉会话列表 + SSE 重订（scope 目录变化）+ 文件树重置 + 打开作用域会话 Tab
    await this.refreshSessionsForProject(this.currentProject!)
    this.startSse()
    this.resetFileTree()
    await this.openScopeSessionTabs()
    this.emit()
  }

  /** 切项目/开项目后：快照 + SSE 重订阅 + 文件树重置 + 打开该作用域的会话 Tab */
  private async switchProjectContext() {
    if (!this.client) return
    await this.refreshAllOpenedProjects()
    this.startSse()
    this.resetFileTree()
    // 打开当前作用域的未归档非 subagent 会话为 chat Tab（复用已开的）
    await this.openScopeSessionTabs()
  }

  /**
   * 打开当前作用域的会话 Tab（不关不归档已有 Tab——Tab 跨项目混排）。
   * 数量约束：最多打开 8 个最近活跃会话，避免一次灌入过多 Tab。
   * 作用域无会话（或激活 Tab 不属于本作用域）时清空激活 → 中栏显示会话列表。
   */
  private async openScopeSessionTabs() {
    const sessions = this.visibleSessions.slice(0, 8)
    for (const s of sessions) {
      const key = `chat:${s.id}`
      if (!this.tabs.some((t) => t.key === key)) {
        this.tabs.push({
          kind: "chat",
          key,
          projectId: s.projectID,
          title: s.title || s.slug || "",
          directory: s.directory,
        })
      }
    }
    const scopeDir = this.scopeQuery.directory
    const active = this.tabs.find((t) => t.key === this.activeTabKey)
    if (active?.kind === "file") {
      // file Tab 不受作用域切换影响
    } else if (active && active.directory === scopeDir) {
      // 激活的 chat Tab 已属于本作用域：保持
    } else if (sessions.length > 0) {
      this.activeTabKey = `chat:${sessions[0].id}`
    } else {
      this.activeTabKey = null
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

  /**
   * 拉取项目会话快照：项目根 + 各 worktree 目录**逐目录**拉取（实测
   * /session?directory=X 精确匹配，项目根快照不含 worktree 会话，切进工作区/
   * 左栏指示器都依赖 worktree 目录有自己的快照）；合并按 directory 分域。
   */
  async refreshSessionsForProject(project: Project) {
    const client = this.client
    if (!client) return
    const dirs = [...new Set([project.worktree, ...(project.sandboxes ?? [])])]
    await AppStore.runLimited(dirs, 3, async (dir) => {
      const sessions = await client.listSessions(dir).catch(() => [] as Session[])
      this.applySessionsSnapshot(project.id, dir, sessions)
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
      // 卸载已删目录的会话（目录已出 sandboxes，此后无快照/订阅通道覆盖它）
      const map = this.sessionsByProject.get(this.currentProject.id)
      if (map) {
        for (const [id, s] of map) {
          if (s.directory === directory) {
            map.delete(id)
            this.busySessions.delete(id)
          }
        }
      }
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

  /** 指定目录的未归档 + 非 subagent 会话（updated 降序）——中栏会话列表与左栏指示器共用 */
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
        // 无 Tab 的 busy 会话：会话快照到达即重置（若仍在流式，后续事件会重新置位）
        const tabSessions = new Set(
          this.tabs.filter((t) => t.kind === "chat").map((t) => t.key.slice(5)),
        )
        for (const sid of [...this.busySessions]) {
          if (!tabSessions.has(sid)) this.busySessions.delete(sid)
        }
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
