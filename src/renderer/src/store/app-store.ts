/**
 * 应用状态层：连接 → 项目/工作区 → 会话 → 消息 → Tab。
 * 事件闸门、乐观消息、SSE 生命周期都在这里收敛。
 */
import { RestClient, ApiError } from "@shared/rest-client"
import { SseSubscriber, type SseStatus, type SseEventMeta } from "@shared/sse-subscriber"
import { Reconciler } from "@shared/reconciler"
import { mergeSessionsSnapshot } from "@shared/session-merge"
import { inferFailedFromMessages, inferIdleFromMessages, mergeStatusSnapshot } from "@shared/session-status"
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
import { normalizeTodoList } from "@shared/session-todos"
import {
  GLOBAL_PROJECT_ID,
  globalDirectoryName,
  globalDirectoryOfKey,
  globalDirectoryRows,
  globalEntryKey,
  migrateOpenedKeys,
  type GlobalDirectoryRow,
} from "@shared/project-entries"
import type { BrowserViewState, ConnectionProfile } from "@shared/ipc"
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
  FileContentData,
  FileDiff,
  FileNode,
  FilePartInput,
  FileRef,
  Message,
  MessageWithParts,
  Pty,
  ModelInfo,
  ModelRef,
  OpencodeEvent,
  Part,
  Project,
  RetryPart,
  Session,
  SessionStatusValue,
  TextPart,
  Todo,
  Workspace,
} from "@shared/api-types"

export type TabKind = "chat" | "file" | "diff" | "terminal" | "browser"

/** diff 的来源类型（design-diff-view §2）：单 Tab 内 segment 切换 */
export type DiffTabType = "round" | "uncommitted" | "branch"

export const DIFF_TAB_TYPES: readonly DiffTabType[] = ["round", "uncommitted", "branch"]

/** 文件监听失效去抖窗口（design-file-watcher §3.1/§3.2） */
export const FILE_WATCH_DEBOUNCE_MS = 300

/** 面板宽度约束（design-layout §2 / design-layout-collapse） */
const PANEL_LIMITS = {
  left: { min: 200, max: 360, def: 260 },
  right: { min: 240, max: 480, def: 300 },
} as const

/** 宽度 clamp（读入持久化值/拖拽输入共用；非法数值回退默认宽） */
function clampPanelWidth(side: "left" | "right", px: number): number {
  const l = PANEL_LIMITS[side]
  if (!Number.isFinite(px)) return l.def
  return Math.round(Math.min(l.max, Math.max(l.min, px)))
}

/** FileContentData → fileContents 缓存条目（design-image-preview §2.1） */
function fileContentEntry(fc: FileContentData): {
  content: string
  binary?: boolean
  mimeType?: string
} {
  return {
    content: fc.content,
    ...(fc.type === "binary" ? { binary: true } : {}),
    ...(fc.mimeType ? { mimeType: fc.mimeType } : {}),
  }
}

/** diff Tab key：每作用域单 Tab（2026-08-25 修订，原按 type 拆三 Tab） */
export function diffTabKey(directory: string): string {
  return `diff\0${directory}`
}

export function parseDiffTabKey(key: string): { directory: string } | null {
  if (!key.startsWith("diff\0")) return null
  const directory = key.slice("diff\0".length)
  // 防御：数据 key（diffDataKey）含两段 \0，误传时返回 null
  if (!directory || directory.includes("\0")) return null
  return { directory }
}

/** diff 数据缓存 key（type+directory 独立缓存，segment 切换互不丢数据） */
export function diffDataKey(type: DiffTabType, directory: string): string {
  return `diff\0${type}\0${directory}`
}

/**
 * 引用 → 发送 file part（design-file-reference §1/§2 契约）：url 必须 absolute
 * `file://`（相对被 server 静默丢弃）；mime 占位 text/plain（server 按 url 读真实
 * 内容，二进制回灌按真实类型重写）；source.text 留空（无需在正文插 @path）。
 */
export function fileRefToFilePart(ref: FileRef): FilePartInput {
  return {
    type: "file",
    mime: "text/plain",
    url: `file://${ref.absolute}`,
    filename: ref.filename,
    source: {
      type: "file",
      path: ref.path,
      text: { value: "", start: 0, end: 0 },
    },
  }
}

export interface TabEntity {
  kind: TabKind
  /** chat: sessionID; file: absolute path; diff: `diff\0{directory}` */
  key: string
  projectId: string
  title: string
  /** 全 kind 作用域归属（Tab 条按 directory 过滤）：chat = 会话目录；
   *  diff = 作用域目录；file = 打开时作用域目录 */
  directory?: string
  /** file Tab 锚定行号（1-based）：从 diff 跳转时携带，FileView 传给 CodeView
   *  滚动到目标行；仅首次挂载消费，不持久化（复用已开 Tab 时不覆盖已有值） */
  revealLine?: number
}

/** 关闭栈条目（design-keyboard-shortcuts §2）：TabEntity 快照，恢复按 kind 分流 */
export interface ClosedTabEntry {
  kind: TabKind
  key: string
  projectId: string
  directory: string
  title: string
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
  // ---- 布局状态（design-layout-collapse）：宽度/折叠态，layout.state 持久化 ----
  layoutLeftWidth = 260
  layoutRightWidth = 300
  layoutLeftCollapsed = false
  layoutRightCollapsed = false

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
  /**
   * retry 保持锁存（design-error-message §3.6）：server 在退避后的每次尝试起点都发
   * busy（processor 每轮首行 status.set(busy)），失败再回 retry——忠实投影会让状态点
   * 红绿交替闪。锁存后 busy 被扣住（投影保持 retry/红），直到出现真实流式进展
   * （内容 part 事件）或终态（idle）才解除。内存态，随 sessionStatus 生命周期。
   */
  private retryHold = new Set<string>()
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
  /**
   * 会话任务列表（design-task-list，纯展示）：sessionID → 全量列表（todo.updated
   * 与 REST 快照均整表替换，无合并）。生命周期随会话运行时（关 Tab/删会话经
   * cleanupSessionState 卸载，teardown 全清）——重开 Tab 由激活回填补齐。
   */
  sessionTodos = new Map<string, Todo[]>()

  // ---- UI 状态 ----
  tabs: TabEntity[] = []
  activeTabKey: string | null = null
  /**
   * 关闭栈（design-keyboard-shortcuts §2，Ctrl+Shift+T 恢复）：仅用户主动关闭入栈
   * （pushClosed 选项），上限 20 弃最旧；纯内存不持久化（重启场景由 Tab 记忆覆盖）
   */
  closedTabs: ClosedTabEntry[] = []
  settingsOpen = false
  fileTreeExpanded = new Map<string, boolean>()
  fileTreeNodes = new Map<string, FileNode[]>()
  /** binary/mimeType：图片预览分发依据（design-image-preview §2.1）；二进制非图占位用 */
  fileContents = new Map<
    string,
    { content: string; binary?: boolean; mimeType?: string; error?: string }
  >()
  /** diff 数据（design-diff-view §3）：key = diffDataKey(type, directory) */
  diffData = new Map<string, { files: FileDiff[]; error?: string; loading?: boolean }>()
  /** diff Tab 选中来源（design-diff-view §2）：key = diffTabKey(directory)；缺省 = uncommitted */
  diffSelectedTypes = new Map<string, DiffTabType>()
  /**
   * 输入草稿（design-compose-draft，移植移动端同名设计）：切 Tab/作用域时输入框
   * 卸载，未发送内容暂存于此，重挂载恢复。纯内存（不跨重启持久化）；写入不
   * emit——高频键入不得触发整树重渲染，草稿仅在视图挂载时读一次，无渲染订阅。
   * 生命周期与清理点见 design-compose-draft §3
   */
  private chatDrafts = new Map<string, string>()
  /** 引导页草稿：按作用域目录（引导页随作用域 key 隔离，见 Workspace 渲染处） */
  private guideDrafts = new Map<string, string>()
  /**
   * 输入引用（design-file-reference §2）：key 与草稿同构——sessionID（chat
   * composer）/ 作用域目录（引导页 composer）。纯内存（同草稿 D1）；写入 emit
   * （低频增删，chip 条需重渲染）。清理挂点同草稿 §3：关 chat Tab / 目录卸载 /
   * teardown 全清 / 发送成功；失败保留供重发（移动端 6R-A 模式）
   */
  private fileRefs = new Map<string, FileRef[]>()
  /**
   * pty 运行时（design-terminal-tab §2，纯内存）：exited = 进程自然退出（只读态，
   * 仅 WS close code 1000 置位——异常断开不标，关闭 Tab 仍尝试 DELETE 防孤儿）。
   * cursor 记忆已移除：组件卸载即销毁 xterm buffer，重挂载是全新 Terminal，
   * connect 不带 cursor 让 server 全量回放（带 cursor 只回放其后增量——语义用
   * 反会导致切回空白，评审 H1）；同 buffer 重连场景本架构不存在。
   *
   * buffer = 已退出 pty 的序列化输出缓存（@xterm/addon-serialize）：组件卸载前
   * 若 pty 已 exited，serialize 导出 ANSI 序列存此（server attach 对 exited pty
   * 抛 ExitedError 无法回放，故需 client 侧缓存以保 Tab 切走再切回可读回滚，
   * 兑现 §1.2「Tab 保持可读回滚直至用户关闭」）。运行中 pty 不缓存——重挂载靠
   * server 全量回放恢复。
   */
  private ptyRuntimes = new Map<string, { exited: boolean; title: string; buffer?: string }>()
  /**
   * 浏览器 Tab（design-browser-tab §1.3）：tabKey → viewId（main 进程
   * WebContentsView）；browserStates = main 推送的视图状态（url/title/loading/
   * 前进后退）。纯内存；teardown/关 Tab 时 dispose view
   */
  private browserViewIds = new Map<string, number>()
  browserStates = new Map<number, BrowserViewState>()
  /**
   * 全局浮层计数（design-browser-tab §1.2 z-order 对策）：>0 时隐藏全部浏览器
   * 视图（原生视图恒在 DOM 之上，设置弹窗/右键菜单等会被挡）。设置弹窗与
   * 文件树右键菜单挂/卸时 +1/-1
   */
  overlayCount = 0
  /**
   * 作用域最后激活（design-tab-state-memory §2.1）：directory → 最后激活 Tab key；
   * null = 引导页。纯内存（重启无记录，冷启动激活仍走 design-tab-memory §7 记忆
   * 规则）。记录点 = 用户意图激活变更（点击/开 Tab/引导页）+ closeTab 激活回退
   *（含死会话收敛连带——回退结果即新的可见选中态）；restoreScopeTabs 激活解析
   * 本身是消费方不回写。**目录卸载路径（关项目/删工作区/关 global 目录）的清除
   * 必须放在关 Tab 循环之后**——回退钩子会重建条目，先删会被写回（重开误落引导页）
   */
  private scopeActiveKeys = new Map<string, string | null>()
  /**
   * 文件视图状态（design-tab-state-memory §2.2）：绝对路径 → {模式, 当前模式滚动偏移}。
   * 模式与偏移成对（非激活模式偏移不保留）；写入不 emit（滚动高频）
   */
  private fileViewStates = new Map<string, { mode: "preview" | "source"; top: number }>()
  /**
   * 消息流滚动位置（design-tab-state-memory §2.3）：sessionID → {scrollTop, 头部消息 id}。
   * 贴底 = 无条目（切回贴底是默认）；写入不 emit（滚动高频）
   */
  private chatScrollTops = new Map<string, { top: number; headId: string | null }>()
  /**
   * TOC 状态（design-tab-state-memory §2.4）：绝对路径 → {visible 用户显式显隐
   *（缺省 = 随宽度默认），folded 折叠章节的标题文本}。折叠按文本标识——重挂载
   * 后标题元素重建，按文本匹配仍存活的章节；章节文本重复则同折叠。低频写入不 emit
   */
  private tocStates = new Map<string, { visible?: boolean; folded: string[] }>()
  /**
   * diff 视图状态（design-tab-state-memory §2.5）：diffTabKey(directory) →
   * {foldOpen 全局折叠意图, closedFiles 折叠文件路径集, scrollTop 滚动偏移}。
   * 纯内存、不跨重启；写入不 emit（滚动高频 + 折叠低频同 fileViewState 模式）
   */
  private diffViewStates = new Map<
    string,
    { foldOpen: boolean; closedFiles: ReadonlySet<string>; scrollTop: number }
  >()

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
    // 浏览器视图状态订阅（design-browser-tab §1.1：main → renderer 推送）
    window.desktop.onBrowserViewState?.((state) => {
      if (state && typeof state.viewId === "number") this.applyBrowserState(state)
    })
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
    const layout = await window.desktop.storeGet("layout.state")
    if (layout) {
      // 读入 clamp：持久化值可能来自旧版本/手改 store.json，越界值收敛回约束区间，
      // 折叠态布尔归一（缺字段/非布尔值按 false）
      this.layoutLeftWidth = clampPanelWidth("left", layout.leftWidth)
      this.layoutRightWidth = clampPanelWidth("right", layout.rightWidth)
      this.layoutLeftCollapsed = !!layout.leftCollapsed
      this.layoutRightCollapsed = !!layout.rightCollapsed
    }

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
    this.startWorktreeSyncTimer()
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
    // pty 全杀（fire-and-forget）+ 运行时全清——**必须在 client 置 null 之前**
    // 执行（评审 H2：置 null 后再杀是死代码，远程 server 留孤儿进程）
    const killClient = this.client
    if (killClient) {
      for (const tab of this.tabs) {
        if (tab.kind !== "terminal" || !tab.directory) continue
        if (!this.ptyRuntimes.get(tab.key.slice("terminal:".length))?.exited) {
          void killClient.deletePty(tab.key.slice("terminal:".length), tab.directory).catch(() => {})
        }
      }
    }
    this.ptyRuntimes.clear()
    // 浏览器视图全部 dispose（main 侧注册表同步清理；teardown 后 renderer 仍可用 IPC）
    for (const viewId of this.browserViewIds.values()) window.desktop.browserViewDispose(viewId)
    this.browserViewIds.clear()
    this.browserStates.clear()
    this.overlayCount = 0
    this.client = null
    this.managedBaseUrl = null
    this.projects = []
    this.sessionsByProject.clear()
    this.messagesBySession.clear()
    this.sessionPages.clear()
    this.pendingPartsMap.clear()
    this.optimisticBySession.clear()
    // 引用全清（design-file-reference §2，与草稿同寿命）
    this.fileRefs.clear()
    this.sessionStatus.clear()
    this.statusSources.clear()
    this.retryHold.clear()
    this.pendingPermissions.clear()
    this.pendingQuestions.clear()
    this.sessionTodos.clear()
    this.revertDrafts.clear()
    this.revertDraftConsumed.clear()
    this.chatDrafts.clear()
    this.guideDrafts.clear()
    this.scopeActiveKeys.clear()
    this.fileViewStates.clear()
    this.chatScrollTops.clear()
    this.tocStates.clear()
    this.diffViewStates.clear()
    this.tabs = []
    this.activeTabKey = null
    this.diffData.clear()
    this.diffSelectedTypes.clear()
    this.commandCache = initialCommandCache()
    // 在途 fetch 无法中断；迟到的结果由 refreshCommands 的 client 身份守卫丢弃
    this.commandsInFlight.clear()
    if (this.catalogRefreshTimer != null) {
      clearTimeout(this.catalogRefreshTimer)
      this.catalogRefreshTimer = null
    }
    this.clearFileWatchTimers()
    this.stopWorktreeSyncTimer()
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
      onEvent: (dir, ev, meta) => this.handleEvent(dir, ev, meta),
      onReconnected: () => {
        this.reconciler?.request()
        // worktree 增删补偿（design-worktree-sync §2）：断连窗口内他端创建的 worktree
        // 若 SSE 丢 worktree.ready（只发一次，重连不补发），靠此刷新补齐；删除无 SSE
        // 事件，刷新是唯一通道
        void this.syncWorktrees()
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

  private handleEvent(directory: string, ev: OpencodeEvent, meta?: SseEventMeta) {
    // ---- worktree 生命周期（design-worktree-sync）：目录闸门不适用——新 directory
    // 尚未进本地 sandboxes，按信封 project 字段（projectID）判断"该项目是否打开"。
    // ready → 重拉项目列表拿 sandboxes（左栏即时多一行）；failed 仅日志（createWorkspace
    // 是同步 await，无 busy UI 需复位）。本端创建已 await refreshWorkspacesForProject，
    // 他端创建靠此事件刷新。
    if (ev.type === "worktree.ready" || ev.type === "worktree.failed") {
      const projectId = meta?.project
      if (!projectId || !this.openedProjects.some((p) => p.id === projectId)) return
      if (ev.type === "worktree.ready") {
        // 重拉项目列表（refreshWorkspacesForProject 全局拉取并覆盖 this.projects，
        // project 参数仅为文档化作用域，不参与请求——见该函数注释）
        const project = this.projects.find((p) => p.id === projectId)
        if (project) void this.refreshWorkspacesForProject(project)
      }
      return
    }
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
        // 同步更新已打开 chat Tab 的 title（会话重命名后 Tab 名跟随刷新）
        const tab = this.tabs.find((t) => t.kind === "chat" && t.key === `chat:${info.id}`)
        if (tab) tab.title = info.title || info.slug || ""
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
      case "todo.updated": {
        // 全量替换（design-task-list）：防御式归一化后整表 set；空表 = server 侧清空。
        // 非数组 todos = 畸形载荷（openapi 必填），忽略保留本地——与 REST 失败路径
        // 的「失败不清」对称（review 2026-08-28 #2），显式 [] 才是权威清空
        const { sessionID, todos } = ev.properties as { sessionID?: string; todos?: unknown }
        if (!sessionID || !Array.isArray(todos)) return
        this.sessionTodos.set(sessionID, normalizeTodoList(todos))
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
        // retry part 消费（design-error-message §3.2，同 openbuilder）：error 传播到
        // 所属消息 info.error（无错误时）供错误卡呈现，part 不入渲染部件列表
        if (part.type === "retry") {
          const msg = this.messagesBySession.get(sessionID)?.get(part.messageID)
          if (msg && msg.info.role === "assistant" && msg.info.error == null) {
            const err = (part as RetryPart).error
            if (err) {
              this.messagesBySession
                .get(sessionID)!
                .set(part.messageID, { info: { ...msg.info, error: err }, parts: msg.parts })
            }
          }
          break
        }
        // retry 保持解除（design-error-message §3.6）：真实流式进展（模型产出的内容
        // part）说明重试已成功——恢复 busy 投影（绿）。排除尝试起点的伴随 part
        // （step-start/snapshot）：它们每轮尝试都发，不构成进展信号，据此解除会让
        // 锁存失效、红绿交替闪回归。（step-finish/compaction 只可能晚于内容 part
        // 出现，无需排除）
        if (
          this.retryHold.has(sessionID) &&
          part.type !== "step-start" &&
          part.type !== "snapshot"
        ) {
          this.retryHold.delete(sessionID)
          this.setSessionStatus(sessionID, { type: "busy" }, directory)
        }
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
          // 消息 info 未到，先缓存 part（retry part 不缓存——其错误在 info 到达时
          // 已由权威 message.updated 携带，或随后 retry part 重发，缓存无消费方）
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
      case "file.watcher.updated": {
        const { file, event } = ev.properties
        if (typeof file === "string" && typeof event === "string") {
          this.onFileWatcherEvent(directory, file, event)
        }
        break
      }
      default:
        // 未知事件透传忽略（AGENTS.md 风险对策）
        break
    }
    this.emit()
  }

  private catalogRefreshTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * worktree 删除检测定时器（design-worktree-sync §2）：删除无 SSE 事件，靠周期
   * listProjects() diff 检测。60s 一次（低频，用户不操作时也兜底）。SSE 断连/
   * focus/重连时额外触发一次（补偿窗口）。连接拆除时停。
   */
  private worktreeSyncTimer: ReturnType<typeof setInterval> | null = null
  private static readonly WORKTREE_SYNC_INTERVAL_MS = 60_000

  private startWorktreeSyncTimer() {
    this.stopWorktreeSyncTimer()
    this.worktreeSyncTimer = setInterval(() => {
      void this.syncWorktrees()
    }, AppStore.WORKTREE_SYNC_INTERVAL_MS)
  }

  private stopWorktreeSyncTimer() {
    if (this.worktreeSyncTimer) {
      clearInterval(this.worktreeSyncTimer)
      this.worktreeSyncTimer = null
    }
  }

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
    // 子会话（subagent，design-subagent-status）无 Tab 但需在 SubagentPanel 内展示
    // 消息流——豁免容器上限，防 SSE 增量被拒导致展开后内容缺失
    const isChild = !!this.findSession(sessionID)?.parentID
    if (!hasTab && !isChild && this.messagesBySession.size >= 20) return
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
      this.retryHold.delete(sessionID)
    } else {
      // retry 保持（design-error-message §3.6）：锁存中的 busy 是退避后新一轮尝试的
      // 起点事件（往往零点几秒内失败回 retry），扣住不覆写——红点稳定整个重试期
      if (status.type === "busy" && this.retryHold.has(sessionID)) return
      if (status.type === "retry") this.retryHold.add(sessionID)
      this.sessionStatus.set(sessionID, status)
      if (directory) this.statusSources.set(sessionID, directory)
    }
  }

  /**
   * REST 状态快照按目录覆盖合并（冷启动/重连对账/项目打开）。
   * 失败目录（null）保留旧值——严禁 clear()+addAll()（SS-1 回归）。
   * retry 保持（design-error-message §3.6）双向维护：
   * - 已持有时快照撞上在途尝试报 busy（server 内存态即 busy）→ 改写为本地 retry
   *   再合并——直接丢弃会触发 merge 的 covered⇒idle 分支误清退避状态；
   * - 未持有时快照报 retry（重连对账落在退避窗口内）→ **补建锁存**，否则下一轮
   *   尝试起点的 busy 事件会覆写造成一次绿闪（SSE 路径 retry 事件建锁存，快照
   *   路径此前缺这一半）；
   * - 已非 retry（idle/缺席）的会话解除。
   */
  private applyStatusSnapshot(directory: string, fresh: Record<string, SessionStatusValue> | null) {
    if (!fresh) return
    const filtered: Record<string, SessionStatusValue> = {}
    for (const [sid, st] of Object.entries(fresh)) {
      filtered[sid] =
        st?.type === "busy" && this.retryHold.has(sid)
          ? (this.sessionStatus.get(sid) ?? st)
          : st
    }
    const merged = mergeStatusSnapshot(this.sessionStatus, this.statusSources, directory, filtered)
    this.sessionStatus = merged.status
    this.statusSources = merged.sources
    // 锁存生命周期跟随合并结果（对齐最终态，与来源无关）
    for (const sid of this.retryHold) {
      if (merged.status.get(sid)?.type !== "retry") this.retryHold.delete(sid)
    }
    for (const [sid, st] of merged.status) {
      if (st.type === "retry") this.retryHold.add(sid)
    }
  }

  /** 卸载目录级状态（关项目/删工作区：该目录来源的状态随会话状态一并卸载） */
  private purgeStatusForDirectories(dirs: string[]) {
    const set = new Set(dirs)
    for (const [sid, dir] of this.statusSources) {
      if (set.has(dir)) {
        this.statusSources.delete(sid)
        this.sessionStatus.delete(sid)
        this.retryHold.delete(sid)
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
    // 目录卸载随清引导页草稿（目录失去订阅/展示，草稿同灭，design-compose-draft §3）
    this.guideDrafts.delete(directory)
    this.fileRefs.delete(directory)
    this.killPtyInDirectory(directory)
    this.disposeBrowserViewsInDirectory(directory)
    // 该目录的 file/diff Tab 与 global 会话的 chat Tab 随之关闭（仅关 Tab，不归档——
    // 归档只发生在显式关闭 Tab；file Tab 作用域化后随目录卸载，2026-08-25 §18）。
    // 双行目录（git 项目 + global 会话共存）下按
    // projectId 过滤：git 项目的 Tab 归 closeProject 管，不随 global entry 关闭
    for (const tab of [...this.tabs]) {
      if (
        (tab.kind === "diff" || tab.kind === "file" || tab.kind === "terminal" || tab.kind === "browser") &&
        tab.directory === directory &&
        tab.projectId === GLOBAL_PROJECT_ID
      ) {
        this.closeTab(tab.key)
        continue
      }
      if (
        tab.kind === "chat" &&
        tab.directory === directory &&
        tab.projectId === GLOBAL_PROJECT_ID
      ) {
        this.closeTab(tab.key)
        this.cleanupSessionState(tab.key.slice(5))
      }
    }
    // 最后激活记录随目录卸载（须在关 Tab 之后——关激活 Tab 的回退钩子会
    // recordScopeActive 重建条目，先删会被写回 null 哨兵，重开误落引导页）
    this.scopeActiveKeys.delete(directory)
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
      // 误判为"真实空目录"而写零 Tab 哨兵；引导页草稿同随目录卸载
      //（design-compose-draft §3）
      for (const d of dirs) {
        this.snapshottedDirs.delete(d)
        this.guideDrafts.delete(d)
        this.fileRefs.delete(d)
        this.killPtyInDirectory(d)
        this.disposeBrowserViewsInDirectory(d)
      }
      // 该项目的 pending（授权/问题）一并卸载：目录失去订阅，replied 事件收不到，
      // 留着只会假亮；重开项目时 backfill 会按 server 权威重建
      this.dropPendingForDirectories(dirs)
    }
    // 该项目的 chat/file/diff Tab 随之关闭（仅关 Tab，不归档——归档只发生在显式
    // 关闭 Tab；file/diff 按 projectId 归属，否则成永久不可见的孤儿，2026-08-25 §18）。
    // 双行目录下按 projectId 过滤：global entry 的 Tab 归 closeGlobalDirectory 管，
    // 不随 git 项目关闭（与 chat 分支一致）
    for (const tab of [...this.tabs]) {
      if (tab.kind === "file" || tab.kind === "diff" || tab.kind === "terminal" || tab.kind === "browser") {
        if (tab.projectId === projectId) this.closeTab(tab.key)
        continue
      }
      if (tab.kind !== "chat") continue
      if (tab.projectId === projectId) {
        this.closeTab(tab.key)
        this.cleanupSessionState(tab.key.slice(5))
      } else if (project && tab.directory === project.worktree && tab.projectId !== GLOBAL_PROJECT_ID) {
        this.closeTab(tab.key)
        this.cleanupSessionState(tab.key.slice(5))
      }
    }
    // 各目录最后激活记录随项目卸载（须在关 Tab 之后——关激活 Tab 的回退钩子
    // 会 recordScopeActive 重建条目，先删会被写回，重开误落引导页/错激活）
    if (project) {
      for (const d of [project.worktree, ...(project.sandboxes ?? [])]) {
        this.scopeActiveKeys.delete(d)
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
      // 激活必须属于当前作用域：当前激活（任意 kind）属于本作用域 → 保持
      // （两阶段恢复异步窗口内用户已在新作用域开的 file/diff/点的 chat 不被顶替）；
      // 否则按记忆解析（§7）——切作用域后旧作用域 Tab（含 file）不得占据激活。
      // 保持分支的 chat 激活仍回写 next.active：上方死会话收敛的 closeTab 可能已
      // 经同步钩子派生了新 active，setMemory(next) 不得用陈旧解析结果覆写它
      const active = this.activeTab
      if (active != null && active.directory === directory) {
        if (active.kind === "chat") {
          const sid = active.key.slice(5)
          if (next.tabs.includes(sid)) next = { ...next, active: sid }
        }
      } else {
        // 规则 1.5（design-tab-state-memory §2.1）：运行期恢复最后选中态（任意
        // kind，含 file/diff 与引导页 null 哨兵）；记录失效（Tab 已关/死会话收敛）
        // 落规则 2；冷启动无记录（内存态）同落规则 2。命中不回写 mem.active——
        // 记忆 chat-only 语义仅约束冷启动恢复
        const last = this.scopeActiveKeyFor(directory)
        if (last === null) {
          this.activeTabKey = null
        } else if (last != null && this.tabs.some((t) => t.key === last && t.directory === directory)) {
          this.activeTabKey = last
        } else {
          const resolved = resolveRestoreActive(next)
          this.activeTabKey = resolved != null ? `chat:${resolved}` : null
          next = { ...next, active: resolved }
        }
      }
    }
    this.setMemory(directory, next)
    this.emit()
  }

  /** 激活不得指向其他作用域的 Tab（任意 kind）——Tab 条按作用域过滤不显示它，
   *  中栏却会渲染其内容（全 kind 作用域化，2026-08-25，design-tab-memory §18） */
  private clearCrossScopeActivation(directory: string) {
    const active = this.activeTab
    if (active && active.directory !== directory) {
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
    this.revertDrafts.delete(sessionID)
    this.revertDraftConsumed.delete(sessionID)
    // 草稿随会话运行时卸载（关 Tab/删会话/关项目/删工作区都经此，防无界增长）
    this.chatDrafts.delete(sessionID)
    // 引用同随会话卸载（design-file-reference §2 清理挂点）
    this.fileRefs.delete(sessionID)
    // 任务列表同随会话卸载（design-task-list：纯展示，重开 Tab 由激活回填补齐）
    this.sessionTodos.delete(sessionID)
    // 消息流滚动位置同随会话卸载（design-tab-state-memory §3）
    this.chatScrollTops.delete(sessionID)
  }

  private resetFileTree() {
    this.fileTreeExpanded.clear()
    this.fileTreeNodes.clear()
    this.fileContents.clear()
    // 挂起的树刷新随树重置作废：否则定时器在切换后落地会打进新作用域
    // （loadFileNodes 的闸门只挡在途期间切走，不挡落地前切走，design-file-watcher §3.2）
    for (const timer of this.treeRefreshTimers.values()) clearTimeout(timer)
    this.treeRefreshTimers.clear()
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

  /** name 省略：由 server 生成随机 slug（两端一致的默认行为）。
   *  projectId 省略 = 当前项目。指定非当前项目时在其下创建 worktree，但不切换
   *  当前项目作用域（setCurrentWorkspace 是当前项目作用域操作；非当前项目仅刷新展示，
   *  新 worktree 随 SSE 事件到达，用户切过去时即见）。 */
  async createWorkspace(projectId: string = this.currentProject?.id ?? ""): Promise<{ ok: boolean; error?: string }> {
    const project = this.projects.find((p) => p.id === projectId)
    if (!this.client || !project) return { ok: false, error: "no project" }
    // global 非 git 项目：无 worktree 概念（左栏也不渲染该入口，此处兜底）
    if (project.id === GLOBAL_PROJECT_ID) {
      return { ok: false, error: "global project has no worktree" }
    }
    const isCurrent = project.id === this.currentProject?.id
    try {
      const result = await this.client.createWorktree(project.worktree)
      // worktree API 返回轻量对象，重拉列表拿完整 Workspace 记录（刷新全局 projects）
      await this.refreshWorkspacesForProject(project)
      if (isCurrent && this.currentProject?.sandboxes?.includes(result.directory)) {
        // 默认切换到新 worktree；setCurrentWorkspace 内含会话快照/文件树重置/开作用域 Tab。
        // 须校验重拉后 sandboxes 已含新目录（重拉失败/列表滞后时 currentWorkspace getter 会拒认，
        // 先行切换会把幻影 currentWorkspaceId 持久化、下次启动才延迟生效）
        await this.setCurrentWorkspace(result.directory)
      } else {
        // 非当前项目：不切当前作用域，仅刷新展示（SSE 单全局流常驻，新 worktree 事件天然到达）
        this.emit()
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** projectId 省略 = 当前项目。指定非当前项目时删除其下 worktree 并清理该项目的
   *  会话/Tab/记忆/状态，但不扰动当前作用域（文件树/作用域 Tab 恢复仅对当前项目生效）。 */
  async removeWorkspace(
    directory: string,
    projectId: string = this.currentProject?.id ?? "",
  ): Promise<{ ok: boolean; error?: string }> {
    const project = this.projects.find((p) => p.id === projectId)
    if (!this.client || !project) return { ok: false, error: "no project" }
    const isCurrent = project.id === this.currentProject?.id
    try {
      await this.client.removeWorktree(project.worktree, directory)
      // worktree 列表数据源是 Project.sandboxes，重拉项目列表同步（刷新全局 projects）
      await this.refreshWorkspacesForProject(project)
      const restored = await this.unloadWorktreeDirectory(directory, project.id, isCurrent)
      if (restored) this.restoreScopeTabs(project.worktree, true)
      this.emit()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * 卸载一个 worktree directory 的全部本地状态（会话/Tab/记忆/状态/pty/浏览器视图）。
   * removeWorkspace 与 syncWorktrees（刷新检测他端删除）共用——后者无 API 调用，
   * 仅对 listProjects diff 出的消失目录执行此清理（design-worktree-sync §2）。
   * 返回是否复位了当前作用域（仅当前项目删当前 worktree 时为 true，调用方据此恢复根 Tab）。
   */
  private async unloadWorktreeDirectory(
    directory: string,
    projectId: string,
    isCurrent: boolean,
  ): Promise<boolean> {
    const project = this.projects.find((p) => p.id === projectId)
    // 卸载已删目录的会话与状态（目录已出 sandboxes，此后无快照/订阅通道覆盖它）
    const map = this.sessionsByProject.get(projectId)
    if (map) {
      for (const [id, s] of map) {
        if (s.directory === directory) map.delete(id)
      }
    }
    this.purgeStatusForDirectories([directory])
    this.snapshottedDirs.delete(directory)
    // 目录已死，引导页草稿同灭（design-compose-draft §3）
    this.guideDrafts.delete(directory)
    this.fileRefs.delete(directory)
    this.killPtyInDirectory(directory)
    this.disposeBrowserViewsInDirectory(directory)
    // 显式关闭该目录全部 live Tab：订阅即将拆除，chat 的 session.deleted 事件
    // 兜底存在窗口期（design-tab-memory §5）；file/diff 无事件兜底，随目录卸载
    // （全 kind 作用域化，2026-08-25 §18）。双行目录（git worktree 与 global 会话
    // 同路径）下按 projectId 过滤——与 closeGlobalDirectory 对称：global 会话 Tab
    // 归 global entry 管，删 git worktree 不得误关
    for (const tab of [...this.tabs]) {
      if (
        (tab.kind === "file" || tab.kind === "diff" || tab.kind === "terminal" || tab.kind === "browser") &&
        tab.directory === directory &&
        tab.projectId === projectId
      ) {
        this.closeTab(tab.key)
        continue
      }
      if (tab.kind === "chat" && tab.directory === directory && tab.projectId === projectId) {
        this.closeTab(tab.key)
        this.cleanupSessionState(tab.key.slice(5))
      }
    }
    // 最后激活记录随目录卸载（须在关 Tab 之后——关激活 Tab 的回退钩子会
    // recordScopeActive 重建条目，先删会被写回，重开误落引导页/错激活）
    this.scopeActiveKeys.delete(directory)
    // 删除该目录记忆（目录已死；须在关 Tab 之后——closeTab 同步会重建条目）。
    // 仅删该项目侧记忆：双行目录的记忆经 findProjectOwningDirectory 归属，
    // global 侧记忆（projectId === global）不随 worktree 删除——与 closeGlobalDirectory 对称
    const key = this.profileKey()
    if (this.tabMemory[key]?.[directory]?.projectId === projectId) {
      delete this.tabMemory[key][directory]
      void window.desktop.storeSet("tabs.memory", this.tabMemory).catch(() => {})
    }
    this.dropPendingForDirectories([directory])
    const ps = this.projectStateFor()
    // 仅当前项目删除当前 worktree 时需复位 currentWorkspaceId 并恢复根作用域；
    // 非当前项目的 worktree 不影响当前作用域（currentWorkspaceId 必不等于该目录）
    let restored = false
    if (isCurrent && ps.currentWorkspaceId === directory) {
      ps.currentWorkspaceId = null
      await this.persistProjectState()
      restored = true
    }
    if (project) await this.refreshSessionsForProject(project)
    if (isCurrent) this.resetFileTree()
    return restored
  }

  /**
   * 刷新对账检测他端 worktree 增删（design-worktree-sync §2）：删除无 SSE 事件，
   * 靠 listProjects() diff sandboxes 检测。新建由 worktree.ready SSE 实时刷新，
   * 此方法是 SSE 丢消息/断连/未收事件的补偿兜底（启动/focus/定时/reconnect 触发）。
   * 幂等：无变化时只重拉 projects（同 refreshWorkspacesForProject，无害 emit）。
   */
  async syncWorktrees(): Promise<void> {
    const client = this.client
    if (!client) return
    const before = this.projects
    const fresh = await client.listProjects().catch(() => null)
    if (!fresh) return
    // 在途闸门：diff 期间 client 可能已拆（disconnect/切 profile）
    if (this.client !== client) return
    // 比对每个打开项目（含未打开项目的 worktree 变化不影响左栏展示，跳过）
    const toUnload: Array<{ directory: string; projectId: string; isCurrent: boolean }> = []
    for (const old of before) {
      if (old.id === GLOBAL_PROJECT_ID) continue
      const opened = this.openedProjects.some((p) => p.id === old.id)
      if (!opened) continue
      const next = fresh.find((p) => p.id === old.id)
      const oldDirs = new Set([...(old.sandboxes ?? [])])
      const nextDirs = new Set([...(next?.sandboxes ?? [])])
      for (const d of oldDirs) {
        if (!nextDirs.has(d)) {
          toUnload.push({
            directory: d,
            projectId: old.id,
            isCurrent: old.id === this.currentProject?.id,
          })
        }
      }
    }
    this.projects = fresh
    for (const { directory, projectId, isCurrent } of toUnload) {
      const restored = await this.unloadWorktreeDirectory(directory, projectId, isCurrent)
      if (restored) {
        const p = this.projects.find((x) => x.id === projectId)
        if (p) this.restoreScopeTabs(p.worktree, true)
      }
    }
    this.emit()
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

  // 会话重命名入口 = chat Tab 双击行内编辑（design-tab-drag-rename §2，v0.3），
  // store 方法 renameSession 见下方；会话删除 UI 仍无入口（v0.1 已知取舍）

  findSession(sessionID: string): Session | null {
    for (const map of this.sessionsByProject.values()) {
      const s = map.get(sessionID)
      if (s) return s
    }
    return null
  }

  /**
   * 查找子会话（design-subagent-status §D3 降级路径）：
   * metadata.sessionId 缺失时按 parentID 在 sessionsByProject 中匹配，
   * title 前缀消歧（server title 派生自 task description），取 created 最新。
   */
  findChildSession(parentSessionID: string, description?: string): Session | null {
    const candidates: Session[] = []
    for (const map of this.sessionsByProject.values()) {
      for (const s of map.values()) {
        if (s.parentID === parentSessionID) candidates.push(s)
      }
    }
    if (candidates.length === 0) return null
    if (description) {
      const matched = candidates.filter((s) =>
        (s.title ?? "").startsWith(description),
      )
      if (matched.length > 0) {
        return matched.sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]
      }
    }
    return candidates.sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]
  }

  async sendPrompt(
    sessionID: string,
    text: string,
    refs?: FileRef[],
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: "not connected" }
    const session = this.findSession(sessionID)
    if (!session) return { ok: false, error: "session not found" }
    // 空守卫（design-file-reference §4，移动端 3R-A）：文本与引用全空才拒绝——
    // 纯引用发送合法
    if (!text && (!refs || refs.length === 0)) return { ok: false, error: "empty" }
    // 乐观消息（design-optimistic-messages：POST 不可信为已送达，真实 user 事件到达即清）
    const optimistic: OptimisticMessage = {
      optimistic: true,
      localId: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: Date.now(),
      ...(refs?.length ? { refs } : {}),
    }
    this.optimisticBySession.set(sessionID, [
      ...(this.optimisticBySession.get(sessionID) ?? []),
      optimistic,
    ])
    this.emit()
    try {
      const parts: Array<{ type: "text"; text: string } | FilePartInput> = []
      if (text) parts.push({ type: "text", text })
      for (const ref of refs ?? []) parts.push(fileRefToFilePart(ref))
      await this.client.promptAsync(sessionID, session.directory, parts)
      // 发送成功引用即清（失败保留供重发，design-file-reference §2）
      this.clearFileRefs(sessionID)
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

  // 会话重命名（design-tab-drag-rename §2，v0.3 恢复入口：chat Tab 双击行内编辑；
  // 删除入口仍无）。他端重命名经 session.updated 事件同步 Tab 标题（既有路径）。
  async renameSession(sessionID: string, title: string): Promise<boolean> {
    if (!this.client) return false
    const session = this.findSession(sessionID)
    if (!session) return false
    try {
      const updated = await this.client.updateSession(sessionID, session.directory, { title })
      this.mergeSessionUpdate(updated)
      // Tab 标题即时同步（SSE 回环亦可到达，此处消除本地等待）
      const tab = this.tabs.find((t) => t.key === `chat:${sessionID}`)
      if (tab) tab.title = updated.title || updated.slug || ""
      this.emit()
      return true
    } catch (e) {
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.emit()
      return false
    }
  }

  async abortSession(sessionID: string) {
    if (!this.client) return
    const session = this.findSession(sessionID)
    if (!session) return
    await this.client.abortSession(sessionID, session.directory).catch(() => {})
  }

  // ============ 回滚（design-message-revert） ============

  /**
   * 回滚草稿回填（官方 app revert → prompt.set(draft(messageID)) 语义）：
   * 回滚成功后把回滚点 user 消息的文本交给 ChatView 置入输入框（可编辑重发）。
   * effect 依赖版本号；take 即清，不重复消费。
   */
  private revertDrafts = new Map<string, string>()
  /**
   * 种子已被 ChatView 消费的会话（输入框正承载回填文本）。撤销回滚清输入框
   * 以此为据——跨客户端回滚（本端从未回填）或无文本回滚不得误清用户自输内容
   */
  private revertDraftConsumed = new Set<string>()
  revertDraftVersion = 0

  takeRevertDraft(sessionID: string): string | null {
    const v = this.revertDrafts.get(sessionID)
    if (v == null) return null
    this.revertDrafts.delete(sessionID)
    // 空种子是「清输入框」指令，不记消费（防二次撤销误判）
    if (v) this.revertDraftConsumed.add(sessionID)
    return v
  }

  /**
   * 回滚到指定消息（暂存）：立即还原工作区文件，消息删除延迟到下一条 prompt。
   * busy/retry 时先 abort 再回滚（官方 halt→stage）——UI 侧负责先 confirm。
   */
  async revertToMessage(
    sessionID: string,
    messageID: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: "not connected" }
    const session = this.findSession(sessionID)
    if (!session) return { ok: false, error: "session not found" }
    // abort 端点等待 run 完全停止后才响应（源码核对：run-state.cancel await
    // Fiber.interrupt + 置 Idle），随后 revert 不会撞 409 窗口；若仍 409，是
    // abort 与他端新 prompt 的竞争，文案「会话仍在进行中」如实成立
    if (this.isSessionActive(sessionID)) await this.abortSession(sessionID)
    try {
      const updated = await this.client.revertMessage(sessionID, session.directory, messageID)
      if (updated) this.mergeSessionUpdate(updated)
      if (!updated?.revert) {
        // server 未写回滚点（消息已不存在，如他端先行删除/提交——源码：
        // revert.ts `if (!rev) return session`）。不回填、显式失败呈现
        const msg = "回滚未生效：消息不存在或已被删除"
        this.connectionError = msg
        this.emit()
        return { ok: false, error: msg }
      }
      const seed = this.userMessageText(sessionID, updated.revert.messageID)
      if (seed) {
        this.revertDrafts.set(sessionID, seed)
        this.revertDraftVersion++
      }
      this.emit()
      return { ok: true }
    } catch (e) {
      const msg =
        e instanceof ApiError && e.status === 409
          ? "会话仍在进行中，请稍后再回滚"
          : e instanceof Error
            ? e.message
            : String(e)
      this.connectionError = msg
      this.emit()
      return { ok: false, error: msg }
    }
  }

  /** 撤销回滚暂存：恢复文件、清 session.revert */
  async unrevertSession(sessionID: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) return { ok: false, error: "not connected" }
    const session = this.findSession(sessionID)
    if (!session) return { ok: false, error: "session not found" }
    try {
      const updated = await this.client.unrevertSession(sessionID, session.directory)
      if (updated) this.mergeSessionUpdate(updated)
      // 撤销即清输入框：空种子 = 清空草稿（官方 restore→promptSession.reset 语义）。
      // 仅当输入框正承载本地回填文本（种子已消费）时清空——跨客户端回滚/无文本
      // 回滚不得误清用户自输内容
      this.revertDrafts.delete(sessionID)
      if (this.revertDraftConsumed.has(sessionID)) {
        this.revertDraftConsumed.delete(sessionID)
        this.revertDrafts.set(sessionID, "")
        this.revertDraftVersion++
      }
      this.emit()
      return { ok: true }
    } catch (e) {
      const msg =
        e instanceof ApiError && e.status === 409
          ? "会话仍在进行中，请稍后再操作"
          : e instanceof Error
            ? e.message
            : String(e)
      this.connectionError = msg
      this.emit()
      return { ok: false, error: msg }
    }
  }

  /** 回滚点 user 消息的文本（text parts 拼接）；无文本（附件/命令回显）返回 null */
  private userMessageText(sessionID: string, messageID: string): string | null {
    const msg = this.messagesBySession.get(sessionID)?.get(messageID)
    if (!msg || msg.info.role !== "user") return null
    const texts = (msg.parts.filter((p) => p.type === "text") as TextPart[])
      .map((p) => p.text)
      .filter((t) => t.trim().length > 0)
    return texts.length > 0 ? texts.join("\n") : null
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
   * 文件名搜索（design-file-reference §3.1，@ 浮层数据源）：失败返回 null
   * （浮层显示空态/加载态，不打扰输入）；结果为相对 directory 的路径。
   */
  async searchFiles(query: string, directory: string): Promise<string[] | null> {
    if (!this.client) return null
    try {
      return await this.client.findFiles(query, directory)
    } catch {
      return null
    }
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
    refs?: FileRef[],
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
      ...(refs?.length ? { refs } : {}),
    }
    this.optimisticBySession.set(sessionID, [
      ...(this.optimisticBySession.get(sessionID) ?? []),
      optimistic,
    ])
    this.emit()
    try {
      // 斜杠命令同样携带引用 parts（openapi command body 契约，移动端 6R-C）
      await this.client.sendCommand(
        sessionID,
        session.directory,
        command,
        arguments_,
        refs?.map(fileRefToFilePart),
      )
      this.clearFileRefs(sessionID)
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

  /** 会话任务列表（design-task-list；空数组 = 无/已全完成） */
  todosForSession(sessionID: string): Todo[] {
    return this.sessionTodos.get(sessionID) ?? []
  }

  /**
   * 会话任务快照（ChatView 激活时与 loadSessionMessages 同挂点调用，补 SSE
   * 断线窗口）。全量替换：200（含空数组）权威覆盖本地；失败静默保留（下一次
   * todo.updated 自愈）；client 同一性守卫丢弃跨 teardown 的迟到结果。
   */
  async loadSessionTodos(sessionID: string, directory: string) {
    const client = this.client
    if (!client) return
    const todos = await client.listSessionTodos(sessionID, directory).catch(() => null)
    if (this.client !== client) return
    if (todos === null) return
    this.sessionTodos.set(sessionID, normalizeTodoList(todos))
    this.emit()
  }

  /**
   * 会话状态点投影（design-agent-status-indicator + design-error-message §3/§3.4）：
   * waiting > error（retry 退避，红呼吸）> running > failed（报错终局，红静态）> idle。
   * waiting 显示时 busy 底层事实保留不覆写。
   * 终局是纯派生（无缓存/锁存）：idle 且末条消息为非中止错误的 assistant ⇒ failed——
   * 新 run 天然自愈（user/新 assistant 消息成为新末条），无事件清除路径的一致性风险；
   * busy/retry 期间跳过派生（进行中状态优先，也无终局语义）。
   */
  dotStateFor(sessionID: string): SessionDotState {
    const status = this.statusOf(sessionID).type
    let terminalError = false
    if (status === "idle") {
      const msgs = [...(this.messagesBySession.get(sessionID)?.values() ?? [])]
      terminalError = inferFailedFromMessages(msgs.sort(sortMessages).map((m) => m.info))
    }
    return sessionDotState(this.pendingCountFor(sessionID), status, terminalError)
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
    // 任意 kind 最后激活记录（design-tab-state-memory §2.1 挂点：开即激活）
    this.recordScopeActive(session.directory, key)
    this.emit()
  }

  /** file Tab 作用域化（§18）：directory = 打开时作用域；复用已开同路径 Tab 时
   *  归属当前作用域（directory + projectId 一并更新，使关项目/关 global entry 的
   *  projectId 守卫可靠——双行目录下同文件可从两个作用域打开，显式重开 = 要在当前作用域看） */
  openFileTab(absolutePath: string, revealLine?: number) {
    const key = `file:${absolutePath}`
    const existing = this.tabs.find((t) => t.key === key)
    if (!existing) {
      const name = absolutePath.split("/").pop() ?? absolutePath
      this.tabs.push({
        kind: "file",
        key,
        projectId: this.currentProject?.id ?? "",
        title: name,
        directory: this.scopeDirectory(),
        revealLine,
      })
      void this.loadFileContent(absolutePath)
    } else {
      existing.directory = this.scopeDirectory()
      existing.projectId = this.currentProject?.id ?? ""
      // 从 diff 跳转携带 revealLine 时更新锚定行（重新激活后 FileView 消费）；
      // undefined = 无锚点（侧栏/关闭栈恢复等），清除残留避免过时行号强制源码模式
      existing.revealLine = revealLine
    }
    this.activeTabKey = key
    // 任意 kind 最后激活记录（design-tab-state-memory §2.1 挂点：开即激活；
    // 复用已开 Tab 时 directory 已归属当前作用域，与之同步记录）
    this.recordScopeActive(this.scopeDirectory(), key)
    this.emit()
  }

  // ============ 终端 Tab（design-terminal-tab） ============

  /** pty 运行时读（TerminalView 挂载判断已退出态；无条目 = 全新） */
  ptyRuntimeFor(ptyID: string): { exited: boolean; title: string; buffer?: string } | null {
    return this.ptyRuntimes.get(ptyID) ?? null
  }

  /** 自然退出标记（WS close code 1000；emit 驱动叠加态渲染） */
  markPtyExited(ptyID: string) {
    const rt = this.ptyRuntimes.get(ptyID)
    if (rt && !rt.exited) {
      rt.exited = true
      this.emit()
    }
  }

  /**
   * 缓存已退出 pty 的序列化输出（TerminalView 卸载前调用）。
   * 重挂载时 TerminalView 读此还原 buffer（不建 WS——server attach 抛 ExitedError）。
   */
  cachePtyBuffer(ptyID: string, buffer: string) {
    const rt = this.ptyRuntimes.get(ptyID)
    // 空串不覆盖：重挂载后切走的 serialize 可能返回空（fit/resize 时序），
    // 覆盖会丢失首次缓存的好内容
    if (rt && rt.exited && buffer) rt.buffer = buffer
  }

  /**
   * 新建终端 Tab：command 省略——server 走 Shell.preferred($SHELL)，与
   * server 进程的默认登录 shell 一致（如 fish）；cwd = 当前作用域目录；Tab
   * 归作用域（directory 过滤通用）。失败经 connectionError 呈现（引导页按钮
   * 不额外提示）。
   *
   * 不取 /pty/shells 首个 acceptable：那会取 /etc/shells 顺序首个（实测
   * /bin/sh），反而覆盖 server 正确的 $SHELL 默认。/pty/shells 留待将来做
   * shell 选择器。
   */
  async openTerminalTab(): Promise<boolean> {
    if (!this.client || !this.scopeDirectory()) {
      this.connectionError = "无法创建终端：未连接或无作用域"
      this.emit()
      return false
    }
    // 入口同步捕获（M1）：await 期间作用域可能已切走——directory/projectId 用
    // 捕获值（Tab 归属创建时作用域），激活只在仍在该作用域时抢
    const directory = this.scopeDirectory()
    const projectId = this.currentProject?.id ?? ""
    try {
      const pty = await this.client.createPty(directory, { cwd: directory })
      this.ptyRuntimes.set(pty.id, { exited: false, title: pty.title ?? "terminal" })
      const key = `terminal:${pty.id}`
      this.tabs.push({
        kind: "terminal",
        key,
        projectId,
        title: pty.title ?? "terminal",
        directory,
      })
      // 在途切走作用域：Tab 照开（归 directory 作用域）但不抢激活、不记 scopeActive
      if (this.scopeDirectory() === directory) {
        this.activeTabKey = key
        this.recordScopeActive(directory, key)
      }
      this.emit()
      return true
    } catch (e) {
      this.connectionError = e instanceof Error ? e.message : String(e)
      this.emit()
      return false
    }
  }

  /**
   * WS 连接 URL 组装（design-terminal-tab §1.2）：connect-token（POST + 专用头）→
   * ws://…/pty/{id}/connect?ticket=&directory=（不带 cursor = 全量回放，见 §1.2）。
   * 失败/无 client → null（调用方呈现错误态）。
   */
  async ptyConnectUrl(ptyID: string): Promise<string | null> {
    if (!this.client) return null
    const directory = this.tabs.find((t) => t.key === `terminal:${ptyID}`)?.directory
    if (!directory) return null
    try {
      const ticket = await this.client.ptyConnectToken(ptyID, directory)
      // 不带 cursor：server cursor 省略 = 全量回放（重挂载全新 Terminal 的正确语义）
      // **必须带 directory**（实测）：pty 路由按 directory 实例路由，缺参落到
      // server cwd 实例 → pty NotFound 404
      const qs = new URLSearchParams({ ticket: ticket.ticket, directory })
      return `${this.client.ptyWsOrigin()}/pty/${encodeURIComponent(ptyID)}/connect?${qs.toString()}`
    } catch {
      return null
    }
  }

  /** pty resize 上报（TerminalView 节流调用；失败静默——尺寸下次再同步） */
  reportPtySize(ptyID: string, rows: number, cols: number) {
    if (!this.client) return
    const directory = this.tabs.find((t) => t.key === `terminal:${ptyID}`)?.directory
    if (!directory) return
    void this.client.updatePtySize(ptyID, directory, { rows, cols }).catch(() => {})
  }

  /**
   * 关终端 Tab = 杀 pty（design-terminal-tab §1.1）：DELETE（404 = 已退出被
   * legacy 路由回收，视为成功）；入关闭栈（Ctrl+Shift+T 恢复 = 原目录新建）。
   */
  async closeTerminalTab(ptyID: string): Promise<void> {
    const key = `terminal:${ptyID}`
    const tab = this.tabs.find((t) => t.key === key)
    const directory = tab?.directory
    if (this.client && directory && !this.ptyRuntimes.get(ptyID)?.exited) {
      try {
        await this.client.deletePty(ptyID, directory)
      } catch {
        // 404（已退出）/ 网络失败：本地 Tab 照关（server 侧孤儿由其自身回收）
      }
    }
    this.ptyRuntimes.delete(ptyID)
    this.closeTab(key, { pushClosed: true })
  }

  /** 目录卸载（关项目/删工作区/teardown）时杀该目录运行中 pty（fire-and-forget，防孤儿） */
  private killPtyInDirectory(directory: string) {
    if (!this.client) return
    for (const tab of this.tabs) {
      if (tab.kind !== "terminal" || tab.directory !== directory) continue
      const id = tab.key.slice("terminal:".length)
      if (!this.ptyRuntimes.get(id)?.exited) {
        void this.client.deletePty(id, directory).catch(() => {})
      }
      this.ptyRuntimes.delete(id)
    }
  }

  // ============ 浏览器 Tab（design-browser-tab） ============

  /** 文件 Tab 的 PDF 视图注册（design-pdf-preview：懒建后挂 Tab key，关 Tab 统一
   *  dispose）。注册即跑一次显隐协调——main 侧新建 view 默认可见，若此时有
   *  浮层/Tab 已切走而注册不 emit，sync 的 effect 依赖不会触发，视图会绘制在
   *  浮层之上（评审 M1） */
  registerFileTabView(tabKey: string, viewId: number) {
    this.browserViewIds.set(tabKey, viewId)
    this.syncBrowserViewVisibility()
  }

  /** 视图状态事件入口（main 推送；tab 标题取页面 title——仅浏览器 Tab，
   *  PDF 文件 Tab 标题恒文件名，不被 PDFium 的 title 覆写，评审 N3） */
  applyBrowserState(state: BrowserViewState) {
    this.browserStates.set(state.viewId, state)
    for (const [key, viewId] of this.browserViewIds) {
      if (viewId === state.viewId) {
        const tab = this.tabs.find((t) => t.key === key)
        if (tab && tab.kind === "browser") tab.title = state.title || state.url
        break
      }
    }
    this.emit()
  }

  browserViewIdFor(tabKey: string): number | null {
    return this.browserViewIds.get(tabKey) ?? null
  }

  /**
   * 打开（或复用）浏览器 Tab：key = 初始 URL（稳定标识）；Electron 不可用
   * （browser shim，view-create 返回 -1）时返回 false——.html 点击回退文件 Tab。
   */
  /** openBrowserTab 在途去重（评审 M2）：IPC 往返窗口内重复调用只建一个 view */
  private browserOpenInFlight = new Map<string, Promise<boolean>>()

  async openBrowserTab(url: string): Promise<boolean> {
    const key = `browser:${url}`
    const inFlight = this.browserOpenInFlight.get(key)
    if (inFlight) return inFlight
    const p = this.doOpenBrowserTab(key, url).finally(() => this.browserOpenInFlight.delete(key))
    this.browserOpenInFlight.set(key, p)
    return p
  }

  private async doOpenBrowserTab(key: string, url: string): Promise<boolean> {
    const existing = this.tabs.find((t) => t.key === key)
    if (existing) {
      if (existing.directory !== this.scopeDirectory()) {
        existing.directory = this.scopeDirectory()
        existing.projectId = this.currentProject?.id ?? ""
      }
      this.activeTabKey = key
      this.recordScopeActive(this.scopeDirectory(), key)
      this.emit()
      return true
    }
    const viewId = await window.desktop.browserViewCreate()
    if (viewId == null || viewId < 0) return false
    this.browserViewIds.set(key, viewId)
    this.browserStates.set(viewId, {
      viewId,
      url,
      title: url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })
    this.tabs.push({
      kind: "browser",
      key,
      projectId: this.currentProject?.id ?? "",
      title: url,
      directory: this.scopeDirectory(),
    })
    this.activeTabKey = key
    this.recordScopeActive(this.scopeDirectory(), key)
    this.emit()
    window.desktop.browserNavigate(viewId, url)
    return true
  }

  /** 关闭浏览器 Tab：dispose view + 关 Tab 入关闭栈（条目记当前页 URL，恢复按它重开） */
  closeBrowserTab(tabKey: string) {
    const viewId = this.browserViewIds.get(tabKey)
    const state = viewId != null ? this.browserStates.get(viewId) : null
    if (viewId != null) {
      window.desktop.browserViewDispose(viewId)
      this.browserViewIds.delete(tabKey)
      this.browserStates.delete(viewId)
    }
    // 关闭栈条目 URL = 当前页（restoreClosedTab 按 title 重开）。无条件写：
    // 未导航的 Tab title 是页面标题（applyBrowserState 持续覆写），不作恢复 URL
    const tab = this.tabs.find((t) => t.key === tabKey)
    if (tab && state?.url) tab.title = state.url
    this.closeTab(tabKey, { pushClosed: true })
  }

  /** 浮层计数（z-order 对策，§1.2） */
  pushOverlay() {
    this.overlayCount++
    this.emit()
  }

  popOverlay() {
    this.overlayCount = Math.max(0, this.overlayCount - 1)
    this.emit()
  }

  /** 激活视图显隐（Tab 切换协调：激活显示，其余隐藏；PDF 文件 Tab 视图同规则） */
  syncBrowserViewVisibility() {
    const active = this.activeTab
    for (const [key, viewId] of this.browserViewIds) {
      const show = this.overlayCount === 0 && active?.key === key && active.directory === this.scopeDirectory()
      if (show) window.desktop.browserViewShow(viewId)
      else window.desktop.browserViewHide(viewId)
    }
  }

  /** 目录卸载（关项目/删工作区/teardown）时随关 Tab dispose（closeTab 分支兜底） */
  private disposeBrowserViewsInDirectory(directory: string) {
    for (const [key, viewId] of [...this.browserViewIds]) {
      const tab = this.tabs.find((t) => t.key === key)
      if (tab?.directory === directory) {
        window.desktop.browserViewDispose(viewId)
        this.browserViewIds.delete(key)
        this.browserStates.delete(viewId)
      }
    }
  }
  /**
   * 打开（或复用）当前作用域的 diff Tab 并触发加载（design-diff-view §3）。
   * 每作用域单 Tab；来源类型 = 既有选中（复用时保留用户选择），缺省 uncommitted。
   */
  openDiffTab() {
    const directory = this.scopeDirectory()
    const project = this.currentProject
    if (!directory || !project) return
    const key = diffTabKey(directory)
    const existing = this.tabs.find((t) => t.key === key)
    if (!existing) {
      this.tabs.push({
        kind: "diff",
        key,
        projectId: project.id,
        title: "diff",
        directory,
      })
    }
    this.activeTabKey = key
    void this.loadDiffTab(this.diffTypeFor(key), directory)
    // 任意 kind 最后激活记录（design-tab-state-memory §2.1 挂点：开即激活）
    this.recordScopeActive(directory, key)
    this.emit()
  }

  /** diff Tab 选中来源（design-diff-view §2；缺省 uncommitted，同移动端 DiffListScreen 默认） */
  diffTypeFor(tabKey: string): DiffTabType {
    return this.diffSelectedTypes.get(tabKey) ?? "uncommitted"
  }

  /** segment 切换：更新选中 + 加载该来源数据（缓存作首帧；重复点击不动作，同移动端） */
  switchDiffType(tabKey: string, type: DiffTabType) {
    const parsed = parseDiffTabKey(tabKey)
    // 守卫比对有效选中（含缺省兜底）：新 Tab 无条目时 get 为 undefined，直接比对会漏
    if (!parsed || this.diffTypeFor(tabKey) === type) return
    this.diffSelectedTypes.set(tabKey, type)
    void this.loadDiffTab(type, parsed.directory)
    this.emit()
  }

  /**
   * 加载 diff 数据（激活即重拉，同 FileView 语义）：
   * - round：作用域最近会话的最后一条 user 消息（无会话/无 user 消息 = 空态）；
   * - uncommitted/branch：GET /vcs/diff 对应 mode（非 git 目录 server 报错 → 错误态）。
   */
  async loadDiffTab(type: DiffTabType, directory: string) {
    const client = this.client
    if (!client) return
    const tabKey = diffTabKey(directory)
    const key = diffDataKey(type, directory)
    const prev = this.diffData.get(key)
    this.diffData.set(key, { files: prev?.files ?? [], loading: true })
    this.emit()
    let files: FileDiff[] | null = null
    let error: string | undefined
    try {
      if (type === "round") {
        // 作用域最近会话（updated 降序；sessionsInDirectory 已过滤归档/subagent）
        const session = this.sessionsInDirectory(
          this.currentProject?.id ?? "",
          directory,
        )[0]
        if (session) {
          const page = await client
            .listMessagesPage(session.id, session.directory ?? directory, { limit: 100 })
            .catch(() => null)
          const lastUser = [...(page?.entries ?? [])]
            .reverse()
            .find((m) => m.info.role === "user")
          files =
            lastUser != null
              ? await client.listSessionDiff(session.id, session.directory ?? directory, lastUser.info.id)
              : []
        } else {
          files = []
        }
      } else {
        files = await client.listVcsDiff(directory, type === "uncommitted" ? "git" : "branch")
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    // 守卫：在途期间 Tab 可能已关闭/连接已拆（与项目其余 async 路径一致）
    if (this.client !== client || !this.tabs.some((t) => t.key === tabKey)) return
    this.diffData.set(key, { files: files ?? [], error })
    this.emit()
  }

  async loadFileContent(absolutePath: string) {
    const { directory, workspace } = this.scopeQuery
    try {
      const fc = await this.client!.readFileContent(directory, absolutePath, workspace)
      this.fileContents.set(absolutePath, fileContentEntry(fc))
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
      this.closeTab(`chat:${sessionID}`, { archive: false, pushClosed: true })
      this.cleanupSessionState(sessionID)
      return true
    }
    const ok = await this.archiveSession(sessionID)
    if (ok) {
      this.closeTab(`chat:${sessionID}`, { archive: false, pushClosed: true })
      this.cleanupSessionState(sessionID)
    }
    return ok
  }

  closeTab(key: string, _opts: { archive?: boolean; pushClosed?: boolean } = {}) {
    const idx = this.tabs.findIndex((t) => t.key === key)
    if (idx < 0) return
    const closed = this.tabs[idx]
    // 用户主动关闭 → 记入关闭栈（design-keyboard-shortcuts §2，Ctrl+Shift+T 恢复）。
    // 卸载路径（关项目/删工作区/死会话收敛/session.deleted）不传 pushClosed
    if (_opts.pushClosed) this.pushClosedTab(closed)
    // 激活回退须在 splice 之前算（splice 后 findIndex 恒得 -1，会恒落候选取样首位
    // 而非相邻）：同作用域候选取样中闭 Tab 的下标 → 左邻优先、无则右邻、再无则 null。
    // 全 kind 作用域化（2026-08-25 §18）：不能激活到隐藏的跨作用域 Tab
    let fallbackKey: string | null = null
    if (this.activeTabKey === key) {
      const scopeDir = closed.directory ?? null
      const sameScope =
        scopeDir != null ? this.tabs.filter((t) => t.directory === scopeDir) : this.tabs
      const pos = sameScope.findIndex((t) => t.key === key)
      // splice 后左邻下标不变（pos-1）；右邻 = before[pos]（闭 Tab 移除后右移补位）
      const after = sameScope.filter((t) => t.key !== key)
      fallbackKey =
        (pos > 0 ? after[pos - 1] : after[pos])?.key ?? null
    }
    this.tabs.splice(idx, 1)
    // diff Tab 关闭即卸载数据与选中（无归档语义；重开走 loadDiffTab）
    if (closed.kind === "diff") {
      for (const ty of DIFF_TAB_TYPES) this.diffData.delete(diffDataKey(ty, closed.directory ?? ""))
      this.diffSelectedTypes.delete(key)
      this.diffViewStates.delete(key)
    }
    // chat 草稿随 Tab 关闭终结（关 Tab = 归档决断，重开不复活旧草稿；死会话收敛
    // 路径只经 closeTab 不经 cleanupSessionState，须在此清，design-compose-draft §3）
    if (closed.kind === "chat") this.chatDrafts.delete(closed.key.slice(5))
    // 引用随 Tab 关闭终结（同草稿"关闭 = 决断"；死会话收敛只经 closeTab 须在此清）
    if (closed.kind === "chat") this.fileRefs.delete(closed.key.slice(5))
    // 视图状态随 Tab 关闭终结（同草稿"关闭 = 决断"语义，design-tab-state-memory §3）：
    // chat 滚动位置、文件模式/滚动。死会话收敛只经 closeTab，须在此清
    if (closed.kind === "chat") this.chatScrollTops.delete(closed.key.slice(5))
    // pty 运行时随 Tab 关闭终结（用户路径经 closeTerminalTab 已清，此处兜底卸载路径）
    if (closed.kind === "terminal") this.ptyRuntimes.delete(closed.key.slice("terminal:".length))
    // 视图随 Tab 关闭 dispose（浏览器 Tab 用户路径经 closeBrowserTab 已清；
    // PDF 文件 Tab（design-pdf-preview）与卸载路径在此兜底——按注册表命中）
    {
      const viewId = this.browserViewIds.get(closed.key)
      if (viewId != null) {
        window.desktop.browserViewDispose(viewId)
        this.browserViewIds.delete(closed.key)
        this.browserStates.delete(viewId)
      }
    }
    if (closed.kind === "file") {
      this.fileViewStates.delete(closed.key.slice(5))
      this.tocStates.delete(closed.key.slice(5))
    }
    if (this.activeTabKey === key) {
      this.activeTabKey = fallbackKey
      // 回退结果即新的最后选中态（design-tab-state-memory §2.1 挂点；
      // 无相邻 = null 哨兵 = 引导页）
      this.recordScopeActive(closed.directory ?? "", fallbackKey)
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
    // 任意 kind 最后激活记录（design-tab-state-memory §2.1 挂点；全 kind——
    // 记忆 active 的 chat-only 仅约束冷启动，运行期切回恢复任意 kind）
    if (tab?.directory) this.recordScopeActive(tab.directory, key)
    this.emit()
  }

  /**
   * Tab 条内拖拽重排序（design-tab-drag-rename §1）：作用于全局 tabs 数组
   * （作用域视图是投影）——取出拖拽项后按落位（目标前/后）插入。chat Tab
   * 顺序经记忆派生落盘（design-tab-memory §3.2 预留的顺序语义兑现）。
   * 位置无变化时早退（不发 emit，指示线残留由 UI 侧清理）。
   */
  moveTab(dragKey: string, targetKey: string, position: "before" | "after" = "before") {
    if (dragKey === targetKey) return
    const from = this.tabs.findIndex((t) => t.key === dragKey)
    const targetIdx = this.tabs.findIndex((t) => t.key === targetKey)
    if (from < 0 || targetIdx < 0) return
    const insertAt = position === "before" ? targetIdx : targetIdx + 1
    // 移除拖拽项后落点换算：落点在其后则前移一位；结果不变即 no-op
    const finalAt = insertAt > from ? insertAt - 1 : insertAt
    if (finalAt === from) return
    const [moved] = this.tabs.splice(from, 1)
    this.tabs.splice(finalAt, 0, moved!)
    if (moved!.kind === "chat" && moved!.directory) this.syncScopeMemory(moved!.directory)
    this.emit()
  }

  /** Tab 栏 "+"：清空激活进入新 Tab 引导页（无激活 Tab 的默认视图，design-layout §4） */
  showGuidePage() {
    this.activeTabKey = null
    // 引导页也是"最后选中态"（null 哨兵，design-tab-state-memory §2.1）：
    // 切走再切回仍落引导页，而非被记忆 chat 激活顶替
    this.recordScopeActive(this.scopeDirectory(), null)
    this.emit()
  }

  get activeTab(): TabEntity | null {
    return this.tabs.find((t) => t.key === this.activeTabKey) ?? null
  }

  // ============ 快捷键（design-keyboard-shortcuts） ============

  private pushClosedTab(tab: TabEntity) {
    this.closedTabs.push({
      kind: tab.kind,
      key: tab.key,
      projectId: tab.projectId,
      directory: tab.directory ?? "",
      title: tab.title,
    })
    if (this.closedTabs.length > 20) this.closedTabs.shift()
  }

  /**
   * Ctrl+Shift+T 恢复刚关闭的 Tab：自栈顶逐项尝试，不可恢复（会话已删/所属
   * 作用域已关）跳过下一项，直到成功或栈空。**全 kind 先过作用域落点判定**
   * （§2.1）——恢复的 Tab 必须落在其所属作用域（chat 恢复 = openChatTab 自带
   * 取消归档；file/diff 重开）；terminal/browser 待 M3/M4 接入。
   */
  restoreClosedTab() {
    while (this.closedTabs.length > 0) {
      const entry = this.closedTabs.pop()!
      if (entry.kind === "chat") {
        // 会话存在性是纯查询，先于作用域切换——跳过已删会话时不白切作用域
        const session = this.findSession(entry.key.slice(5))
        if (session && this.ensureScopeFor(entry)) {
          this.openChatTab(session)
          return
        }
        continue
      }
      if (!this.ensureScopeFor(entry)) continue
      if (entry.kind === "file") {
        this.openFileTab(entry.key.slice(5))
        return
      }
      if (entry.kind === "diff") {
        this.openDiffTab()
        return
      }
      if (entry.kind === "terminal") {
        // 终端恢复 = 原 directory 新建 pty（原 pty 已随关 Tab 销毁，spec #2）；
        // ensureScopeFor 已把作用域切到原目录（openTerminalTab 用当前作用域）
        void this.openTerminalTab()
        return
      }
      if (entry.kind === "browser") {
        // 浏览器恢复 = 按关闭时当前页 URL 重开（title 字段承载，closeBrowserTab 写入）
        void this.openBrowserTab(entry.title || entry.key.slice("browser:".length))
        return
      }
    }
  }

  /**
   * 恢复项作用域落点判定（design-keyboard-shortcuts §2.1）：directory ≠ 当前
   * 作用域时**同步段**切过去（开 Tab 在其后立即执行，作用域已就位）。
   * 返回 false = 所属项目/entry 已关闭，该项不可恢复。
   */
  private ensureScopeFor(entry: ClosedTabEntry): boolean {
    const dir = entry.directory
    if (!dir || this.scopeDirectory() === dir) return true
    // 当前项目内（仅普通项目——global 项目 sandboxes 恒空，跨目录恢复走 entry
    // 分支，否则会被误判不可达）：项目根或 worktree
    const cur = this.currentProject
    if (cur && entry.projectId === cur.id && cur.id !== GLOBAL_PROJECT_ID) {
      if (dir === cur.worktree) void this.setCurrentWorkspace(null)
      else if ((cur.sandboxes ?? []).includes(dir)) void this.setCurrentWorkspace(dir)
      else return false
      return true
    }
    // 其他已打开 entry：entry 根/global 目录走 openEntry；普通项目的 worktree
    // 一步直达 setCurrentProject（= openProject(projectId, dir)，同步段落位——
    // 先 openEntry 再补 setCurrentWorkspace 会把 Tab 开在项目根作用域）
    const target = this.openedEntries.find(
      (e) =>
        e.project.id === entry.projectId &&
        (e.directory === dir ||
          (!e.isGlobal && (e.project.sandboxes ?? []).includes(dir))),
    )
    if (!target) return false
    if (target.isGlobal || dir === target.directory) void this.openEntry(target.key)
    else void this.setCurrentProject(target.project.id, dir)
    return true
  }

  /** Ctrl+Tab / Ctrl+PgDn：作用域内可见 Tab 循环切换（无激活时取首/末） */
  cycleTab(dir: 1 | -1) {
    const visible = this.tabs.filter((t) => t.directory === this.scopeDirectory())
    if (visible.length === 0) return
    const idx = visible.findIndex((t) => t.key === this.activeTabKey)
    const next =
      idx < 0
        ? dir === 1
          ? 0
          : visible.length - 1
        : (idx + dir + visible.length) % visible.length
    this.setActiveTab(visible[next]!.key)
  }

  /**
   * Ctrl+Alt+↑/↓：左栏项目/工作区行按显示顺序遍历（design-keyboard-shortcuts §3）。
   * 平铺序列 = openedEntries 行 +（普通项目）其 worktree 行；当前位置 = worktree
   * 激活命中的工作区行，否则激活 entry 行；±1 循环。激活复用侧栏点击语义。
   */
  cycleScopeEntry(dir: 1 | -1) {
    type NavRow =
      | { kind: "entry"; key: string }
      | { kind: "ws"; projectId: string; directory: string }
    const rows: NavRow[] = []
    for (const e of this.openedEntries) {
      rows.push({ kind: "entry", key: e.key })
      if (!e.isGlobal) {
        for (const w of this.workspacesOfProject(e.project.id)) {
          rows.push({ kind: "ws", projectId: e.project.id, directory: w.directory })
        }
      }
    }
    if (rows.length === 0) return
    let idx = -1
    const cur = this.currentProject
    if (cur && this.currentWorkspace) {
      idx = rows.findIndex(
        (r) => r.kind === "ws" && r.projectId === cur.id && r.directory === this.currentWorkspace?.directory,
      )
    }
    if (idx < 0) idx = rows.findIndex((r) => r.kind === "entry" && this.isEntryActive(r.key))
    // 当前行未命中（瞬态：作用域行刚消失）时按"虚拟边界"取值——dir=1 落首行、
    // dir=-1 落末行（直接模运算会把 -1 当末行算成倒数第二行）
    const target =
      idx < 0
        ? rows[dir === 1 ? 0 : rows.length - 1]!
        : rows[(idx + dir + rows.length) % rows.length]!
    if (target.kind === "entry") {
      if (!this.isEntryActive(target.key)) void this.openEntry(target.key)
    } else if (target.projectId === this.currentProject?.id) {
      void this.setCurrentWorkspace(target.directory)
    } else {
      void this.setCurrentProject(target.projectId, target.directory)
    }
  }

  // ============ 输入草稿（design-compose-draft） ============

  /** chat 草稿读（无条目 = 空串）：ChatView 挂载初始化取回，恢复切走前未发送内容 */
  chatDraftFor(sessionID: string): string {
    return this.chatDrafts.get(sessionID) ?? ""
  }

  /** chat 草稿写：空文本 = 删条目（发送成功即清）。不 emit（见 chatDrafts 注释） */
  setChatDraft(sessionID: string, text: string) {
    if (text) this.chatDrafts.set(sessionID, text)
    else this.chatDrafts.delete(sessionID)
  }

  /** 引导页草稿读（无条目 = 空串）：GuidePage 挂载初始化取回，按作用域目录 */
  guideDraftFor(directory: string): string {
    return this.guideDrafts.get(directory) ?? ""
  }

  /** 引导页草稿写：空文本 = 删条目。不 emit（见 chatDrafts 注释） */
  setGuideDraft(directory: string, text: string) {
    if (text) this.guideDrafts.set(directory, text)
    else this.guideDrafts.delete(directory)
  }

  // ============ 输入引用（design-file-reference §2） ============

  /** 引用读（无条目 = 空数组）：composer 挂载初始化 + chip 条渲染 */
  fileRefsFor(key: string): FileRef[] {
    return this.fileRefs.get(key) ?? []
  }

  /** 引用写：按 absolute 去重（同文件重复引用无意义）；emit 驱动 chip 条 */
  addFileRef(key: string, ref: FileRef) {
    const list = this.fileRefs.get(key) ?? []
    if (list.some((r) => r.absolute === ref.absolute)) return
    this.fileRefs.set(key, [...list, ref])
    this.emit()
  }

  removeFileRef(key: string, absolute: string) {
    const list = this.fileRefs.get(key)
    if (!list) return
    const next = list.filter((r) => r.absolute !== absolute)
    if (next.length === 0) this.fileRefs.delete(key)
    else this.fileRefs.set(key, next)
    this.emit()
  }

  clearFileRefs(key: string) {
    if (this.fileRefs.delete(key)) this.emit()
  }

  // ============ Tab 状态记忆（design-tab-state-memory） ============

  /** 作用域最后激活读：无记录 = undefined（冷启动/未记录 → 走 §7 记忆规则）；
   *  null = 引导页 */
  scopeActiveKeyFor(directory: string): string | null | undefined {
    return this.scopeActiveKeys.get(directory)
  }

  /** 记录用户意图的激活变更（挂点见 scopeActiveKeys 注释；恢复路径不得调用） */
  private recordScopeActive(directory: string, key: string | null) {
    if (directory) this.scopeActiveKeys.set(directory, key)
  }

  /** 文件视图状态读（挂载初始化取模式 + 待恢复偏移） */
  fileViewStateFor(path: string): { mode: "preview" | "source"; top: number } | null {
    return this.fileViewStates.get(path) ?? null
  }

  /** 文件视图状态写：模式与当前模式偏移成对。不 emit（滚动高频，见字段注释） */
  setFileViewState(path: string, state: { mode: "preview" | "source"; top: number }) {
    this.fileViewStates.set(path, state)
  }

  /** 消息流滚动位置读（无条目 = 贴底默认） */
  chatScrollFor(sessionID: string): { top: number; headId: string | null } | null {
    return this.chatScrollTops.get(sessionID) ?? null
  }

  /** 消息流滚动位置写：null = 删条目（贴底）。不 emit（滚动高频，见字段注释） */
  setChatScroll(sessionID: string, value: { top: number; headId: string | null } | null) {
    if (value) this.chatScrollTops.set(sessionID, value)
    else this.chatScrollTops.delete(sessionID)
  }

  /** TOC 状态读（挂载恢复显隐选择 + 章节折叠） */
  tocStateFor(path: string): { visible?: boolean; folded: string[] } | null {
    return this.tocStates.get(path) ?? null
  }

  /** TOC 显隐用户选择写（与既有折叠条目合并；不 emit，见字段注释） */
  setTocVisible(path: string, visible: boolean) {
    const cur = this.tocStates.get(path)
    this.tocStates.set(path, { visible, folded: cur?.folded ?? [] })
  }

  /** TOC 章节折叠写（折叠标题文本列表；与既有显隐选择合并） */
  setTocFolded(path: string, folded: string[]) {
    const cur = this.tocStates.get(path)
    this.tocStates.set(path, { visible: cur?.visible, folded })
  }

  /** diff 视图状态读（无条目 = 缺省全展开 + 顶部） */
  diffViewStateFor(tabKey: string): { foldOpen: boolean; closedFiles: ReadonlySet<string>; scrollTop: number } | null {
    return this.diffViewStates.get(tabKey) ?? null
  }

  /** diff 视图状态写。不 emit（滚动高频 + 折叠低频同 fileViewState 模式） */
  setDiffViewState(
    tabKey: string,
    state: { foldOpen: boolean; closedFiles: ReadonlySet<string>; scrollTop: number },
  ) {
    this.diffViewStates.set(tabKey, state)
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

  // ============ 文件监听失效（design-file-watcher） ============

  private fileReloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private fileReloadInflight = new Set<string>()
  private fileReloadDirty = new Set<string>()
  private treeRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * file.watcher.updated 统一入口（官方 app invalidateFromWatcher 同语义）：
   * 内容失效 = 已打开文件 Tab 重拉；树失效 = 已加载目录重列。
   */
  private onFileWatcherEvent(directory: string, file: string, kind: string) {
    if (!file.startsWith("/")) return
    if (kind !== "add" && kind !== "change" && kind !== "unlink") return
    // 相对化：file 必须位于事件信封目录之内。之外的帧实测只有 git 元数据（服务端把
    // git 目录监听挂到 worktree location，index/refs 帧 file 在主仓 .git 内）——丢弃
    let rel: string
    if (file === directory) rel = ""
    else if (file.startsWith(directory + "/")) rel = file.slice(directory.length + 1)
    else return
    // .git 内（相对化判定，官方 app 同规则）：不得按绝对路径组件过滤——worktree
    // 可能物理位于项目 .git/ 之下（旧约定），绝对路径判定会误杀其全部事件
    if (rel === ".git" || rel.startsWith(".git/")) return

    // 内容失效：有已打开文件 Tab 才重拉（无 Tab 缓存不可见，重开必重拉）
    if (this.tabs.some((t) => t.kind === "file" && t.key === `file:${file}`)) {
      this.scheduleFileReload(file)
    }
    // 树失效：仅当前作用域（树只承载当前作用域；归属只认信封目录，不用路径前缀——
    // worktree 物理上可能在项目根内，scope=项目根时不得误刷）
    if (directory !== this.scopeQuery.directory) return
    if (kind === "change") {
      // 目录自身（已加载目录节点）重列；文件变化不改树形，不触发父目录重列
      const dirKey = rel === "" ? "." : rel + "/"
      if (this.fileTreeNodes.has(dirKey)) this.scheduleTreeRefresh(dirKey)
      return
    }
    // add/unlink：父目录已加载才重列（惰性树语义不变）
    const slash = rel.lastIndexOf("/")
    const parentKey = slash === -1 ? "." : rel.slice(0, slash) + "/"
    if (this.fileTreeNodes.has(parentKey)) this.scheduleTreeRefresh(parentKey)
  }

  /** 每路径去抖：burst（agent 连续写、git checkout）合并为一次重拉 */
  private scheduleFileReload(file: string) {
    const timer = this.fileReloadTimers.get(file)
    if (timer != null) clearTimeout(timer)
    this.fileReloadTimers.set(
      file,
      setTimeout(() => {
        this.fileReloadTimers.delete(file)
        void this.doFileReload(file)
      }, FILE_WATCH_DEBOUNCE_MS),
    )
  }

  /**
   * 监听重拉文件内容：singleflight + dirty 再武装——在途期间新事件只置 dirty，
   * 在途完成后补排一次，保证 fetch 期间落地的后续修改不丢。
   * 落地守卫同其余 async 路径：client 身份 + Tab 仍存在。
   * unlink 走同一路径：/file/content 报错 → 缓存落 error 条目 → FileView 错误态。
   */
  private async doFileReload(file: string) {
    if (this.fileReloadInflight.has(file)) {
      this.fileReloadDirty.add(file)
      return
    }
    const client = this.client
    const tab = this.tabs.find((t) => t.kind === "file" && t.key === `file:${file}`)
    if (!client || !tab || !tab.directory) return
    this.fileReloadInflight.add(file)
    try {
      // directory = Tab 打开时作用域（非当前 scopeQuery）：Tab 跨作用域混排，
      // 事件到达时当前作用域可能已不是该 Tab 的
      const fc = await client.readFileContent(tab.directory, file)
      if (this.client !== client || !this.tabs.some((t) => t.key === `file:${file}`)) return
      this.fileContents.set(file, fileContentEntry(fc))
      this.emit()
    } catch (e) {
      if (this.client !== client || !this.tabs.some((t) => t.key === `file:${file}`)) return
      this.fileContents.set(file, {
        content: "",
        error: e instanceof Error ? e.message : String(e),
      })
      this.emit()
    } finally {
      this.fileReloadInflight.delete(file)
      if (this.fileReloadDirty.delete(file)) this.scheduleFileReload(file)
    }
  }

  /** 每目录键去抖：整目录波动（git checkout）合并为一次重列 */
  private scheduleTreeRefresh(dirKey: string) {
    const timer = this.treeRefreshTimers.get(dirKey)
    if (timer != null) clearTimeout(timer)
    this.treeRefreshTimers.set(
      dirKey,
      setTimeout(() => {
        this.treeRefreshTimers.delete(dirKey)
        void this.loadFileNodes(dirKey)
      }, FILE_WATCH_DEBOUNCE_MS),
    )
  }

  /** teardown 清理：连接拆除后不得再有监听重拉/树刷新落地 */
  private clearFileWatchTimers() {
    for (const timer of this.fileReloadTimers.values()) clearTimeout(timer)
    this.fileReloadTimers.clear()
    for (const timer of this.treeRefreshTimers.values()) clearTimeout(timer)
    this.treeRefreshTimers.clear()
    this.fileReloadInflight.clear()
    this.fileReloadDirty.clear()
  }

  // ============ 设置 ============

  openSettings() {
    this.settingsOpen = true
    this.pushOverlay()
  }

  closeSettings() {
    this.settingsOpen = false
    this.popOverlay()
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

  // ============ 布局（design-layout-collapse） ============

  toggleLeftPanel() {
    this.layoutLeftCollapsed = !this.layoutLeftCollapsed
    this.emit()
    this.persistLayout()
  }

  toggleRightPanel() {
    this.layoutRightCollapsed = !this.layoutRightCollapsed
    this.emit()
    this.persistLayout()
  }

  /** 拖拽逐帧调宽：clamp 后写内存 + emit，不落盘（写放大防护，pointerup 走 persistLayout） */
  setPanelWidth(side: "left" | "right", px: number) {
    const v = clampPanelWidth(side, px)
    if (side === "left") {
      if (v === this.layoutLeftWidth) return
      this.layoutLeftWidth = v
    } else {
      if (v === this.layoutRightWidth) return
      this.layoutRightWidth = v
    }
    this.emit()
  }

  /** 布局整体落盘（toggle 即时 / 拖拽 pointerup 时）；失败静默（重启回退旧值，同 tabs.memory 取舍） */
  persistLayout() {
    void window.desktop
      .storeSet("layout.state", {
        leftWidth: this.layoutLeftWidth,
        rightWidth: this.layoutRightWidth,
        leftCollapsed: this.layoutLeftCollapsed,
        rightCollapsed: this.layoutRightCollapsed,
      })
      .catch(() => {})
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
