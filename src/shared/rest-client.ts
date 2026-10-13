/**
 * opencode **v2** REST client（renderer 直连，fetch 封装；v0.5 起唯一 client——
 * v1 面已删除，见 docs/plan/plan-v2-protocol.md M6d）。契约以
 * ../openbuilder/opencode_openapi_v2.json 为准（2.0.18 pin）；例外：credential/
 * integration 面以 docs/design/v2/design-provider-config.md §1 实测表为准
 * （2.0.23 生成的 openapi.json 滞后漏收 DELETE 等端点，源码+活体已核）。
 */
import type {
  CursorPage,
  ListSessionsInput,
  LocationInfo,
  ModelRef,
  ProjectInfo,
  ServerInfo,
  SessionInfo,
  V2AgentInfo,
  V2FileDiff,
  V2FormAnswer,
  V2FsEntry,
  V2IntegrationInfo,
  V2ModelInfo,
  V2PermissionDecision,
  ShellInfo,
  VcsFileStatus,
  WorktreeDirectory,
} from "./api-v2-types"
import { toInternalMessages, type V2MessageEntry } from "./v2-adapter"
import { normalizeForm, type PendingQuestion } from "./pending-requests"
import type {
  AgentInfo,
  CommandInfo,
  FileContentData,
  FileDiff,
  FileNode,
  MessageWithParts,
  Pty,
  PtyTicket,
} from "./api-types"

export interface RestClientOptions {
  baseUrl: string
  /** v2 强制 Basic auth；用户名固定 "opencode"（server auth.ts 硬编码校验） */
  username?: string
  password?: string
  fetchImpl?: typeof fetch
}

export class ApiError extends Error {
  /** 4xx/5xx 的结构化错误体（`{name, data}`，v2 typed error）——SessionBusyError
   *  等判别用；无体/解析失败为 undefined */
  readonly body?: { name?: string; data?: Record<string, unknown> }

  constructor(
    public status: number,
    public kind:
      | "auth"
      | "not-found"
      | "server"
      | "timeout"
      | "network"
      | "unsupported"
      | "unknown",
    message: string,
    body?: { name?: string; data?: Record<string, unknown> },
  ) {
    super(message)
    this.body = body
  }
}

/** 错误分类转换（参考 openbuilder design-network-error-handling：不暴露响应体） */
export function classifyFetchError(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) {
    // AbortSignal.timeout 抛 TimeoutError（Chromium），手工 abort 抛 AbortError
    return new ApiError(0, "timeout", "请求超时")
  }
  if (e instanceof TypeError) {
    return new ApiError(0, "network", "无法连接服务器")
  }
  return new ApiError(0, "unknown", "未知错误")
}

/** Basic 头（UTF-8 字节 base64）：btoa 直拼对非 Latin1 密码（如中文）抛
 *  InvalidCharacterError；服务端按 UTF-8 解码凭据，此编码与其对齐（ASCII 两者逐字节一致） */
function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return "Basic " + btoa(binary)
}

export class RestClient {
  private base: string
  private authHeader: string | undefined
  private f: typeof fetch

  constructor(opts: RestClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "")
    if (opts.username || opts.password) {
      this.authHeader = basicAuthHeader(opts.username ?? "opencode", opts.password ?? "")
    }
    // Electron renderer 的 fetch 是绑定 window 的包装，脱离 this 调用会 Illegal invocation
    this.f = opts.fetchImpl ?? fetch.bind(globalThis)
  }

  /**
   * pty WebSocket 连接基址：http(s) → ws(s) 换 scheme。
   * v2 WS 契约已活体核对（M6b，V2D-2 关闭）：
   * `GET /api/pty/:id/connect?ticket=&location[directory]=&cursor=`（HTTP 101
   * 升级）；帧协议 TEXT=输出流、二进制 0x00+`{cursor:N}`=锚点回执；close
   * 1000=live 内自然退出 / 4404 "session exited"=连接时已退出——terminal-view
   * 既有分流不变。
   */
  ptyWsOrigin(): string {
    return this.base.replace(/^http/, "ws")
  }

  /** 底层 fetch（鉴权 + 超时 + 错误分类）；`timeoutMs: 0` = 不设超时（同步长时端点） */
  private async fetchResponse(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = 15000, ...rest } = init
    let res: Response
    try {
      res = await this.f(this.base + path, {
        ...rest,
        headers: {
          ...(this.authHeader ? { Authorization: this.authHeader } : {}),
          ...(rest.body ? { "Content-Type": "application/json" } : {}),
          ...(rest.headers ?? {}),
        },
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      })
    } catch (e) {
      throw classifyFetchError(e)
    }
    if (!res.ok) {
      const kind =
        res.status === 401 || res.status === 403
          ? "auth"
          : res.status === 404
            ? "not-found"
            : res.status >= 500
              ? "server"
              : "unknown"
      // 结构化错误体尽力解析（v2 typed error `{name, data}`）；失败仅留状态码
      let body: { name?: string; data?: Record<string, unknown> } | undefined
      try {
        const text = await res.text()
        if (text) body = JSON.parse(text) as { name?: string; data?: Record<string, unknown> }
      } catch {
        // 非 JSON 错误体（代理页等）——无 body 判别
      }
      const detail = body?.data?.message
      throw new ApiError(res.status, kind, detail ? `HTTP ${res.status}: ${String(detail)}` : `HTTP ${res.status}`, body)
    }
    return res
  }

  /**
   * JSON 响应统一解析（**严格**契约，评审修复 2026-09-28）：
   * - `res.text()` 中途失败 → classifyFetchError（网络中断/中止）；
   * - 200 + 非 JSON（v1 server 的 SPA fallback HTML 即此形态）→ ApiError
   *   `unsupported`——M1 探活以此判定「server 版本不支持」；
   * - 空响应体 → ApiError（v2 各读端点必有 JSON 体，空体即异常信号）；
   * - JSON.parse 失败不再裸抛 SyntaxError（违反模块「只抛 ApiError」契约，
   *   v1 client 同场景为 catch 后抛 ApiError——修复前 v2 漏掉了这层）。
   */
  private async fetchJson<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const res = await this.fetchResponse(path, init)
    let text: string
    try {
      text = await res.text()
    } catch (e) {
      throw classifyFetchError(e)
    }
    if (!text) throw new ApiError(0, "unknown", "空响应")
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ApiError(res.status, "unsupported", "响应不是 JSON（疑似 server 版本不支持）")
    }
  }

  /** GET /api/info：v2 探活/版本识别（取代 v1 /global/health） */
  async serverInfo(): Promise<ServerInfo> {
    return this.fetchJson<ServerInfo>("/api/info")
  }

  /** GET /api/project：项目列表（无 query、无 envelope；左栏数据源，canonical 取代 worktree） */
  async listProjects(): Promise<ProjectInfo[]> {
    return this.fetchJson<ProjectInfo[]>("/api/project")
  }

  /**
   * GET /api/location：作用域解析（取代 v1 /project/current?directory=）。
   * deepObject query（location 组专用风格；session 组是 flat directory，勿统一）：
   * directory 省略 = server 默认 location（cwd）。
   */
  async resolveLocation(directory?: string): Promise<LocationInfo> {
    return this.withLocation(directory, async () => {
      let path = "/api/location"
      if (directory !== undefined) {
        const q = new URLSearchParams()
        q.set("location[directory]", directory)
        path += `?${q.toString()}`
      }
      return this.fetchJson<LocationInfo>(path)
    })
  }

  /**
   * GET /api/session：会话列表（flat query + `{data, cursor}` envelope）。
   * 无过滤 = 全量（global 发现用，翻页拉取）；parentID null = 只取根会话
   * （wire 上是字符串 "null"）。cursor 为不透明锚点（方向自含），调用方
   * 翻页时不需重传 order——**messages 端点**的契约则明确 cursor 与 order
   * 互斥（M4 实现时注意，见 protocol groups/message.ts）。
   */
  async listSessions(input: ListSessionsInput = {}): Promise<CursorPage<SessionInfo>> {
    const q = new URLSearchParams()
    if (input.directory !== undefined) q.set("directory", input.directory)
    if (input.project !== undefined) q.set("project", input.project)
    if (input.subpath !== undefined) q.set("subpath", input.subpath)
    if (input.limit !== undefined) q.set("limit", String(input.limit))
    if (input.order !== undefined) q.set("order", input.order)
    if (input.search !== undefined) q.set("search", input.search)
    if (input.parentID !== undefined) q.set("parentID", input.parentID === null ? "null" : input.parentID)
    if (input.cursor !== undefined) q.set("cursor", input.cursor)
    const suffix = q.toString()
    return this.fetchJson<CursorPage<SessionInfo>>(`/api/session${suffix ? `?${suffix}` : ""}`)
  }

  /**
   * GET /api/session/active：server 前台 drain 执行集合快照（**无目录参数，
   * 全局集合**），值恒 `{type:"running"}`——契约语义「absent = inactive」，
   * 缺席即不活跃。状态对账（design-typing-indicator §4 来源 5）的权威源：
   * drain 与 SessionStatus 生命周期绑定（runner onBusy/onIdle、retry 在 drain
   * 内），在场 ⇒ busy/retry，缺席 ⇒ idle。v2.0.18 活体核对 2026-09-29；
   * 完整 per-session 状态端点（`/api/session/status`）已在官方源码但未随
   * 2.0.18 发布，回归后可换绑以恢复 retry 细节。
   */
  async listActiveSessions(): Promise<Set<string>> {
    const res = await this.fetchJson<{ data: Record<string, { type: string }> }>("/api/session/active")
    return new Set(Object.keys(res.data ?? {}))
  }

  /**
   * POST /api/session：创建会话（payload 为 location 对象，取代 v1 的
   * directory query）。响应 `{data: SessionInfo}`；model 形状与 v1 ModelRef 同构。
   */
  async createSession(input: {
    directory: string
    title?: string
    agent?: string
    model?: ModelRef
  }): Promise<SessionInfo> {
    // withLocation（§3.5）：POST body 也带 location（session 创建在 server 侧
    // resolve 目录，session.ts:271）——与 query 形式同等纳入屏障
    return this.withLocation(input.directory, async () => {
      const page = await this.fetchJson<{ data: SessionInfo }>("/api/session", {
        method: "POST",
        body: JSON.stringify({
          location: { directory: input.directory },
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.agent !== undefined ? { agent: input.agent } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
        }),
      })
      return page.data
    })
  }

  /**
   * PATCH /api/session/:sessionID：改 title/**metadata**（**204 无返回体**——
   * 调用方本地乐观落地）。v2 无 REST 归档字段（D1 私约：metadata.archivedAt，
   * 服务端 REPLACE 语义须整包合并写入）。
   */
  async updateSession(
    sessionID: string,
    payload: { title?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await this.fetchResponse(`/api/session/${encodeURIComponent(sessionID)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    })
  }

  /** DELETE /api/session/:sessionID（无 directory 参数；服务端连子会话级联删） */
  async deleteSession(sessionID: string): Promise<void> {
    await this.fetchResponse(`/api/session/${encodeURIComponent(sessionID)}`, {
      method: "DELETE",
    })
  }

  /** GET /api/session/:sessionID：单会话（含 `time.idle`/`viewed`）——终态补拉用
   *  （design-unread-marker §4.3：`Execution.*` 事件不带 idle 时间戳，取权威值）。 */
  async getSession(sessionID: string): Promise<SessionInfo> {
    const page = await this.fetchJson<{ data: SessionInfo }>(`/api/session/${encodeURIComponent(sessionID)}`)
    return page.data
  }

  /**
   * POST /api/session/:sessionID/view：标记已读水位（design-unread-marker §2.2）。
   * body `{idle}` = **观察到的** idle 值（须精确——服务端 `viewed = max(idle, viewed)`
   * 单调，且拒绝 `input.idle > 服务端 idle`；偏小则仍未读）；204 无返回体。
   */
  async markSessionViewed(sessionID: string, idle: number): Promise<void> {
    await this.fetchResponse(`/api/session/${encodeURIComponent(sessionID)}/view`, {
      method: "POST",
      body: JSON.stringify({ idle }),
    })
  }

  /**
   * DELETE /api/worktree（payload `{projectID, directory, force}`，**force 必填**；
   * 60s 超时——git worktree remove 大目录可慢，对齐 v1 语义）。**调用方恒传
   * force=true（2026-10-12 修订，design-keyboard-shortcuts §4.1）**：server 的
   * 400 WorktreeError{forceRequired} 判别依赖英文 git stderr（`contains
   * modified or untracked files` 正则），中文 locale 恒 false（活体核实
   * 2026-10-12）——脏态提示改由客户端 vcsStatus 预检承担，不再依赖该字段。
   * 库存行不存在或目录已从磁盘消失 → 400（InvalidDirectory /
   * DirectoryUnavailable——幽灵条目只剩 sandboxes 残留时删除必拒，对账清理由
   * refresh 承担）。
   */
  async deleteWorktree(projectID: string, directory: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.fetchResponse("/api/worktree", {
      method: "DELETE",
      body: JSON.stringify({ projectID, directory, force: opts.force ?? false }),
      timeoutMs: 60000,
    })
  }

  /**
   * DELETE /api/debug/location?location[directory]=：evict 单个 warm location
   * （ref-pseudo-project-cleanup §3.4 燃料 6——server 每 5 分钟刷新 warm location，
   * 已删目录的刷新会兜底 upsert 伪项目行；唯一断法 = evict 或 server 重启）。
   * pin 的 openapi_v2.json **含**该端点（debug 组：GET `debug.location.list` /
   * DELETE `debug.location.evict`，deepObject query，204/400/401）——原「未文档化」
   * 为误判（2026-10-12 订正）；debug 面语义稳定性弱于业务组，server 升级随 pin
   * 核对。唯一调用点 = removeWorkspace 删除成功后 best-effort（失败 warn 留痕，
   * 不阻塞删除）。requestRef 取参兜底是 `process.cwd()`——裸调会 evict server
   * cwd 的 location，故 directory 必填（签名层面杜绝裸调）。204 无返回体。
   */
  async evictLocation(directory: string): Promise<void> {
    const q = new URLSearchParams()
    q.set("location[directory]", directory)
    await this.fetchResponse(`/api/debug/location?${q.toString()}`, {
      method: "DELETE",
    })
  }

  // ============ location 请求屏障（design-worktree-sync §3.5，ref §3.4 三订） ============

  /** 删除窗口中的目录（gate）：新 location 请求一律拒绝 */
  private suspendedLocationDirs = new Set<string>()
  /** 按目录的在途 location 请求计数（barrier） */
  private locationInflight = new Map<string, number>()

  /**
   * 包装带 location[directory] 的请求（design-worktree-sync §3.5）：
   * - 目录在挂起集（removeWorkspace 删除窗口）→ **立即拒绝**——作用域已切走，
   *   此时还打向该目录的只能是迟到 timer/竞态漏网；放行会在 server 侧按需
   *   boot 该目录的 location → `project.resolve` → 死目录兜底建档伪行
   *   （ref §3.4 三订：一发请求一行，与 warm/刷新无关）；
   * - 否则按目录计数在途，供 `awaitLocationIdle` 屏障。
   * evictLocation **不包装**（删除链路自身要用，且其请求只 invalidate 不 boot）。
   */
  private async withLocation<T>(directory: string | undefined, run: () => Promise<T>): Promise<T> {
    if (!directory) return run()
    if (this.suspendedLocationDirs.has(directory)) {
      throw new ApiError(0, "unknown", `location 请求已挂起（删除窗口）：${directory}`)
    }
    const n = (this.locationInflight.get(directory) ?? 0) + 1
    this.locationInflight.set(directory, n)
    try {
      return await run()
    } finally {
      const left = (this.locationInflight.get(directory) ?? 1) - 1
      if (left <= 0) this.locationInflight.delete(directory)
      else this.locationInflight.set(directory, left)
    }
  }

  /** 挂起某目录的全部 location 请求（removeWorkspace 删除窗口开启；gate） */
  suspendLocationRequests(directory: string): void {
    this.suspendedLocationDirs.add(directory)
  }

  /** 解除挂起（removeWorkspace finally 兜底，失败路径也解除） */
  resumeLocationRequests(directory: string): void {
    this.suspendedLocationDirs.delete(directory)
  }

  /**
   * 等某目录在途 location 请求清零（barrier）——removeWorkspace 在
   * `DELETE /api/worktree` 前调用：在途请求落地后再删，防其落在删除之后
   * （迟到的 location 请求 = 兜底建档，ref §3.4）。**超时放行**（best-effort，
   * 同 evict 降级风格——慢请求如 30s 超时的 vcs diff 不阻塞删除）。
   */
  async awaitLocationIdle(directory: string, timeoutMs = 1500): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.locationInflight.get(directory) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  /**
   * GET /api/vcs/status（deepObject query，location 组专用风格——同
   * resolveLocation；URLSearchParams 编码括号，活体两种形式均可）：未提交
   * 变更文件清单。响应裸 `{location, data}`（无 envelope，2.0.18 活体核对
   * 2026-10-12），data 空数组 = 干净；缺 data 按干净容忍（调用方在弹窗
   * 状态行展示，违约体不致卡死检查态）。删除确认弹窗预检用（实测 p50 <
   * 100ms，300 脏文件 88ms——非阻塞预检性能前提成立）。
   */
  async vcsStatus(directory: string): Promise<VcsFileStatus[]> {
    return this.withLocation(directory, async () => {
      const q = new URLSearchParams()
      q.set("location[directory]", directory)
      const res = await this.fetchJson<{ location: unknown; data?: VcsFileStatus[] }>(`/api/vcs/status?${q.toString()}`)
      return res.data ?? []
    })
  }

  // ============ 消息域（M4a） ============

  /**
   * GET /api/session/:sessionID/message：typed union 列表 + body cursor（双向）。
   * 分页语义对齐 v1 管线：order=desc（新→旧）翻页取 cursor.next（更旧方向 =
   * v1 before 参数）；返回经 toInternalMessages 收敛为内部 MessageWithParts。
   */
  async listMessagesPage(
    sessionID: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ entries: MessageWithParts[]; nextCursor: string | null }> {
    const q = new URLSearchParams({ limit: String(opts.limit) })
    if (opts.cursor !== undefined) q.set("cursor", opts.cursor)
    const page = await this.fetchJson<{ data: unknown[]; cursor?: { previous?: string; next?: string } }>(
      `/api/session/${encodeURIComponent(sessionID)}/message?${q.toString()}`,
      { timeoutMs: 20000 },
    )
    return {
      entries: toInternalMessages(sessionID, (page?.data ?? []) as V2MessageEntry[]),
      nextCursor: page?.cursor?.next ?? null,
    }
  }

  /**
   * POST /api/session/:sessionID/prompt：200 + `{data: Session.Inbox.User}` 准入
   * 回执（非 v1 的 204 盲发）。回执 `data.id` = inboxID = 投影后消息 id
   * （三体同 id，inbox-admission §1 活体双证）。
   * - 请求体 `id`（design-optimistic-id-anchor）：client-minted `msg_` id，
   *   server 准入按 id 幂等（同 id 重复准入不双计）——乐观条目的消解锚
   * - 回执 id 仅作校验（不匹配时调用方 warn），user 消息落地仍由 post-200
   *   首页重取 + 事件/快照消解承接（回执≠投影）
   * - files = v1 FilePartInput → v2 {uri, name}
   * - skills = v2 skill 激活通道（design-slash-command 2026-10-12 修订）：
   *   `{id}` 最简形态（SkillAttachment required 仅 id，name/text 由 server 按
   *   id 查注册表回填——2026-10-12 活体验证），与 files 并列无互斥
   */
  async prompt(
    sessionID: string,
    input: {
      id?: string
      text: string
      files?: Array<{ uri: string; name?: string }>
      skills?: Array<{ id: string }>
    },
  ): Promise<{ id: string }> {
    const res = await this.fetchResponse(`/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        ...(input.id ? { id: input.id } : {}),
        text: input.text,
        ...(input.files?.length ? { files: input.files } : {}),
        ...(input.skills?.length ? { skills: input.skills } : {}),
      }),
      // 大附件同 v1 放宽（design-session-attachments §6）：data URL 总长 >1MB → 120s
      timeoutMs:
        (input.files ?? []).reduce((s, f) => s + (f.uri.startsWith("data:") ? f.uri.length : 0), 0) >
          1024 * 1024
          ? 120000
          : 15000,
    })
    // 回执尽力解析（防御：无体/非 JSON → {id: ""}——200 恒有 body 为活体事实，
    // 异常形态只降级校验，不承载清除语义）
    try {
      const text = await res.text()
      if (text) {
        const body = JSON.parse(text) as { data?: { id?: unknown } }
        if (typeof body.data?.id === "string") return { id: body.data.id }
      }
    } catch {
      // 无体/非 JSON——防御静默
    }
    return { id: "" }
  }

  /** POST /api/session/:sessionID/interrupt（取代 v1 abort） */
  async interrupt(sessionID: string): Promise<void> {
    await this.fetchResponse(`/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
      method: "POST",
      // 中断在途执行需等待结算（server awaitSettlement）——放宽超时
      timeoutMs: 30000,
    })
  }

  // ============ worktree / revert / fork（M5；库存直连 2026-09-29） ============

  /**
   * GET /api/worktree?projectID=：项目的 worktree 库存（WorktreeTable，**裸数组**
   * 无 envelope，2.0.18 活体核对）。v2 GA 起 worktree 增删只写 WorktreeTable，
   * `Project.sandboxes` 不再随之维护（legacy 冻结列）——库存是左栏工作区行的
   * 权威数据源（官方 v2 app 同源：withWorktreeInventory 以此覆盖 sandboxes）。
   * 返回含主 checkout 行（strategy 缺省），展示层须排除项目 canonical。
   */
  async listWorktrees(projectID: string): Promise<WorktreeDirectory[]> {
    const q = new URLSearchParams({ projectID })
    return this.fetchJson<WorktreeDirectory[]>(`/api/worktree?${q.toString()}`)
  }

  /**
   * POST /api/worktree/refresh：跨已知 checkout 根发现 + reconcile 库存
   * （外部 git worktree 增删、死行清理），204。变更时发 worktree.updated
   * SSE（data.projectID，无 location）。对账触发点：连接/打开项目/60s 定时
   * ——外部删除（rm -rf 后库存行残留）只有此端点能清。
   */
  async refreshWorktrees(projectID: string): Promise<void> {
    await this.fetchResponse("/api/worktree/refresh", {
      method: "POST",
      body: JSON.stringify({ projectID }),
      timeoutMs: 60000,
    })
  }

  /**
   * POST /api/worktree：创建 worktree（payload {projectID, from?, branch?, name?}；
   * 父目录省略 = 项目配置/默认 `worktree/<projectID 前 6 字符>`，2.0.18 实测）。
   * 响应**裸 `Worktree.Info`（`{directory}`，无 `{data}` envelope**——openapi v2
   * + 活体核对 2026-09-29；全 client 唯一的非 envelope 单对象 POST）。
   * 成功即写库存 + 发 worktree.updated；不再维护 Project.sandboxes。
   */
  async createWorktree(projectID: string, opts: { name?: string } = {}): Promise<{ directory: string }> {
    return this.fetchJson<{ directory: string }>("/api/worktree", {
      method: "POST",
      body: JSON.stringify({ projectID, ...(opts.name !== undefined ? { name: opts.name } : {}) }),
      timeoutMs: 60000,
    })
  }

  /**
   * POST /api/shell：server 侧执行一次性命令至终态（design-worktree-branch-sync
   * 的分支挂载/清理通道——纯 API，移动端同构，PC 不依赖本地 git）。轮询
   * `GET /api/shell/:id`（300ms 间隔）至 `status !== "running"`，再取
   * `:id/output` 累积输出，best-effort `DELETE :id` 清理。超时抛 ApiError
   * ("timeout")，端点缺失等由调用方降级（挂载失败 = 保持 server 默认 detached）。
   * 命令跨 shell 可移植（见 ShellInfo 注释）。
   */
  async runShell(
    command: string,
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ exit: number | null; output: string }> {
    const timeoutMs = opts.timeoutMs ?? 15000
    const created = await this.fetchJson<{ data: ShellInfo }>("/api/shell", {
      method: "POST",
      body: JSON.stringify({
        command,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        timeout: timeoutMs,
      }),
      timeoutMs: timeoutMs + 5000,
    })
    const id = created.data.id
    const deadline = Date.now() + timeoutMs
    let info = created.data
    while (info.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      info = (await this.fetchJson<{ data: ShellInfo }>(`/api/shell/${encodeURIComponent(id)}`)).data
    }
    if (info.status === "running") {
      throw new ApiError(0, "timeout", `shell 未在 ${timeoutMs}ms 内退出: ${command}`)
    }
    try {
      const out = await this.fetchJson<{ data: { output?: string } }>(`/api/shell/${encodeURIComponent(id)}/output`)
      return { exit: info.exit ?? null, output: out.data.output ?? "" }
    } finally {
      // best-effort 清理（退出态 shell 记录；失败吞掉不影响结果）
      void this.fetchResponse(`/api/shell/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {})
    }
  }

  /**
   * POST /api/session/:sessionID/revert/stage：暂存回滚（v1 revert 的 v2 三段式
   * 第一段）。files 缺省 true = 同时还原工作区文件（v1 行为）。响应
   * `{data: Session.Revert {messageID, snapshot?, files?}}`；busy 409（SessionBusyError）。
   */
  async revertStage(
    sessionID: string,
    messageID: string,
    opts: { files?: boolean } = {},
  ): Promise<{ messageID: string; partID?: string; snapshot?: string; files?: unknown[] }> {
    const res = await this.fetchJson<{
      data: { messageID: string; partID?: string; snapshot?: string; files?: unknown[] }
    }>(`/api/session/${encodeURIComponent(sessionID)}/revert/stage`, {
      method: "POST",
      body: JSON.stringify({ messageID, files: opts.files ?? true }),
    })
    return res.data
  }

  /** DELETE /api/session/:sessionID/revert：撤销回滚暂存（v1 unrevert） */
  async revertClear(sessionID: string): Promise<void> {
    await this.fetchResponse(`/api/session/${encodeURIComponent(sessionID)}/revert`, {
      method: "DELETE",
    })
  }

  /**
   * POST /api/session/:sessionID/fork：复制历史（同步长操作，timeoutMs: 0 沿袭
   * v1——大会话实测 24s）。payload `before` 省略 = 全量；响应 `{data: SessionInfo}`。
   */
  async forkSession(
    sessionID: string,
    opts: { messageID?: string } = {},
  ): Promise<SessionInfo> {
    const res = await this.fetchJson<{ data: SessionInfo }>(
      `/api/session/${encodeURIComponent(sessionID)}/fork`,
      {
        method: "POST",
        body: JSON.stringify(opts.messageID !== undefined ? { before: opts.messageID } : {}),
        timeoutMs: 0,
      },
    )
    return res.data
  }

  // ============ 待办人机交互（M6a：permission reply / form 体系） ============

  /**
   * POST /api/session/:sessionID/permission/:requestID/reply
   * （body `{decision}`，取代 v1 `/session/:id/permissions/:pid` 的 `{response}`）。
   * 无 directory 参数——请求 id 全局唯一。
   */
  async respondPermission(
    sessionID: string,
    requestID: string,
    decision: V2PermissionDecision,
  ): Promise<void> {
    await this.fetchResponse(
      `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
      { method: "POST", body: JSON.stringify({ decision }) },
    )
  }

  /**
   * POST /api/session/:sessionID/form/:formID/reply（v2 form 体系，取代 v1
   * question reply 的 `answers: string[][]`）。answer 键 = field.key，值按字段
   * 类型（select→value、multiselect→value[]、boolean→bool、number→数值、文本→string）。
   */
  async replyForm(sessionID: string, formID: string, answer: V2FormAnswer): Promise<void> {
    await this.fetchResponse(
      `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`,
      { method: "POST", body: JSON.stringify({ answer }) },
    )
  }

  /** DELETE /api/session/:sessionID/form/:formID（取消表单，取代 v1 question reject） */
  async cancelForm(sessionID: string, formID: string): Promise<void> {
    await this.fetchResponse(
      `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`,
      { method: "DELETE" },
    )
  }

  // ============ 会话 agent / model 切换（M6a，路径同 v1 过渡面） ============

  /** POST /api/session/:sessionID/agent（204；无 directory 参数） */
  async switchAgent(sessionID: string, agent: string): Promise<void> {
    await this.fetchResponse(`/api/session/${encodeURIComponent(sessionID)}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    })
  }

  /**
   * POST /api/session/:sessionID/model（204）。variant 条件包含（AM-3）：
   * 「默认」= 省略字段（实测可清掉已设值）。
   */
  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    const body: Record<string, unknown> = { id: model.id, providerID: model.providerID }
    if (model.variant) body.variant = model.variant
    await this.fetchResponse(`/api/session/${encodeURIComponent(sessionID)}/model`, {
      method: "POST",
      body: JSON.stringify({ model: body }),
    })
  }

  // ============ agent / model 目录（M6b 补换绑） ============

  /**
   * GET /api/agent：agent 目录。**wire→内部映射（评审修复 #1）**：v2 的
   * id 是标识符（"build"）、name 是显示标签（"Build"）——内部 AgentInfo.name
   * 沿袭 v1 语义 = 标识符（切换键/默认值匹配/选中态），wire name 落 label。
   * 过滤在 model-catalog。
   */
  async listAgents(directory: string): Promise<AgentInfo[]> {
    const res = await this.withLocation(directory, () =>
      this.fetchJson<{ data: V2AgentInfo[] }>(`/api/agent${this.locationQuery(directory)}`),
    )
    return res.data.map((a) => ({
      name: a.id,
      label: a.name,
      description: a.description,
      mode: a.mode,
      hidden: a.hidden,
    }))
  }

  /**
   * GET /api/model：模型目录（平铺 Model.Info[]，取代 v1 /config/providers 的
   * providers→models 拍平——LR-1「只返回 opencode 一家」的判断在 2.0.18 实测
   * 已不成立：65 模型跨 5 provider）。转换/过滤在 model-catalog.parseModelsV2。
   */
  async listModels(directory: string): Promise<V2ModelInfo[]> {
    const res = await this.withLocation(directory, () =>
      this.fetchJson<{ data: V2ModelInfo[] }>(`/api/model${this.locationQuery(directory)}`),
    )
    return res.data
  }

  /**
   * GET /api/integration：integration 目录 + 连接状态（design-provider-config
   * v2 恢复，A1）。全目录平铺（2.0.23 活体 229 项），面板取 connections 非空项。
   * connections 每条存储凭据各一行（更换 key 不删旧凭据 → 多行）；env 连接由
   * server 进程环境变量在场生成。目录不存在 → data 空数组。
   */
  async listIntegrations(directory: string): Promise<V2IntegrationInfo[]> {
    const res = await this.withLocation(directory, () =>
      this.fetchJson<{ data: V2IntegrationInfo[] }>(`/api/integration${this.locationQuery(directory)}`),
    )
    return res.data
  }

  /**
   * POST /api/integration/:id/connect/key：设置/更换 API key（body {key}，204）。
   * 内部 = create credential 默认 activate——旧凭据置 inactive 但保留（core 源码
   * 核对），单槽语义由调用方补 removeCredential 完成。2.0.18 起可用。
   */
  async connectIntegrationKey(integrationID: string, key: string, directory: string): Promise<void> {
    await this.withLocation(directory, () =>
      this.fetchResponse(
        `/api/integration/${encodeURIComponent(integrationID)}/connect/key${this.locationQuery(directory)}`,
        {
          method: "POST",
          body: JSON.stringify({ key }),
        },
      ),
    )
  }

  /**
   * DELETE /api/credential/:credentialID（204；不存在的 id 幂等 204）。
   * **2.0.23 起**——2.0.18–22 路由不存在（404 经 ApiError 呈现）。
   */
  async removeCredential(credentialID: string): Promise<void> {
    await this.fetchResponse(`/api/credential/${encodeURIComponent(credentialID)}`, {
      method: "DELETE",
    })
  }

  // ============ 文件系统（M6b：fs 组，deepObject location + Entry 模型） ============

  /** location 组共用的 deepObject query（`location[directory]=`） */
  private locationQuery(directory?: string): string {
    if (directory === undefined) return ""
    const q = new URLSearchParams()
    q.set("location[directory]", directory)
    return `?${q.toString()}`
  }

  /**
   * GET /api/fs/list：目录列表。Entry.path 相对请求的 location（目录带尾 /），
   * 响应 envelope 的 location.directory 是解析基址（server 可规范化入参）——
   * absolute 以其为基拼接。**ignored 降级**：v2 Entry 无 gitignore 标记
   * （v1 /file 的 ignored 字段），恒 false（弱化样式退役，同移动端）。
   */
  async listFiles(directory: string, path: string): Promise<FileNode[]> {
    return this.withLocation(directory, async () => {
      const q = new URLSearchParams()
      q.set("location[directory]", directory)
      if (path && path !== ".") q.set("path", path)
      const res = await this.fetchJson<{
        location: { directory: string }
        data: V2FsEntry[]
      }>(`/api/fs/list?${q.toString()}`)
      const base = res.location.directory.replace(/\/+$/, "")
      return res.data.map((e) => {
        const isDir = e.type === "directory"
        const withoutSlash = isDir && e.path.endsWith("/") ? e.path.slice(0, -1) : e.path
        const segs = withoutSlash.split("/").filter(Boolean)
        return {
          name: segs.length === 0 ? withoutSlash : segs[segs.length - 1],
          path: e.path,
          absolute: withoutSlash ? `${base}/${withoutSlash}` : base,
          type: e.type,
          ignored: false,
        }
      })
    })
  }

  /**
   * GET /api/fs/read/*：原始字节流（application/octet-stream 等）——路径作 URL
   * 剩余段（逐段编码，`?`/`#` 等特殊字符不致截断）。文本/二进制由客户端判定
   * （v1 是 server 返回 type 字段）：**NUL 嗅探为主**（前 8K 含 0x00 = 二进制，
   * 救回 server MIME 库对 .ts 的 video/mp2t 误判）+ image/* mime 直判二进制
   * （svg 例外：文本源码，imageSrcFor 的 svg 分支依赖 text）。
   * 图片 binary 时 content 为 base64（mimeType 透传，图片预览分发依据）。
   *
   * 流式消费（design-file-load-streaming，2026-10-12）：整包 arrayBuffer +
   * 同步 base64 会长时间阻塞渲染主线程（142MB 实测 ~3.3s，且非图片二进制的
   * base64 无任何消费者），故 res.body 可读时按 chunk 消费：
   * - 前 8K 攒齐做嗅探；**非图片二进制即刻 cancel**——占位分支不读 content，
   *   余量不下载、不做 base64，返回空 content（FileContentData 契约不变）；
   * - 图片：chunk 增量拼 binary string（转换成本摊进下载等待），完结 btoa；
   * - 文本：TextDecoder stream 模式增量解码（多字节序列跨 chunk 安全）；
   * - 每 chunk 上报 onProgress（total = Content-Length，chunked 响应缺省）。
   * res.body 缺失（非流式环境兜底）回退旧的整包缓冲路径。
   */
  async readFileContent(
    directory: string,
    path: string,
    opts: { onProgress?: (received: number, total: number | undefined) => void } = {},
  ): Promise<FileContentData> {
    const encoded = path
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/")
    const res = await this.withLocation(directory, () =>
      this.fetchResponse(
        `/api/fs/read/${encoded}${this.locationQuery(directory)}`,
        { timeoutMs: 30000 },
      ),
    )
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim() || undefined
    const isImage = !!mime && mime.startsWith("image/") && mime !== "image/svg+xml"
    const reader = res.body?.getReader()
    if (!reader) return this.readFileContentBuffered(res, mime, isImage)

    const SNIFF = 8192
    const CHUNK = 0x8000
    const totalRaw = Number(res.headers.get("content-length"))
    const total = Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : undefined
    // 嗅探窗口缓冲：decision 未定期间逐 chunk 攒入（只取前 SNIFF 字节）
    let head = new Uint8Array(0)
    // undefined = 未攒齐嗅探窗口；image 由 mime 头预判（与旧路径 isImage 直判一致）
    let decision: "image" | "text" | undefined = isImage ? "image" : undefined
    let received = 0
    let binaryStr = ""
    let text = ""
    const decoder = new TextDecoder("utf-8")

    // 读取中途断网/超时中止与 fetchJson 同契约：包成 ApiError（模块只抛 ApiError）
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        if (decision === undefined) {
          const room = SNIFF - head.length
          const headPart = value.subarray(0, room)
          const rest = value.subarray(room)
          const merged = new Uint8Array(head.length + headPart.length)
          merged.set(head)
          merged.set(headPart, head.length)
          head = merged
          if (head.length >= SNIFF) {
            if (head.includes(0)) {
              // 非图片二进制：content 无消费者——cancel 省掉余量下载
              await reader.cancel().catch(() => {})
              return { type: "binary", content: "", encoding: "base64", mimeType: mime }
            }
            decision = "text"
            text += decoder.decode(head, { stream: true })
            if (rest.length > 0) text += decoder.decode(rest, { stream: true })
          }
        } else if (decision === "image") {
          // 分块 base64 前置段（spread 大文件会栈溢出）
          for (let i = 0; i < value.length; i += CHUNK) {
            binaryStr += String.fromCharCode(...value.subarray(i, i + CHUNK))
          }
        } else {
          text += decoder.decode(value, { stream: true })
        }
        opts.onProgress?.(received, total)
      }
    } catch (e) {
      throw classifyFetchError(e)
    }
    // 流完结仍无 decision = 整文件不足嗅探窗口：对整包嗅探（与旧路径同口径）
    if (decision === undefined) {
      if (head.includes(0)) {
        return { type: "binary", content: "", encoding: "base64", mimeType: mime }
      }
      text += decoder.decode(head, { stream: true })
    }
    if (decision === "image") {
      return { type: "binary", content: btoa(binaryStr), encoding: "base64", mimeType: mime }
    }
    return { type: "text", content: text + decoder.decode() }
  }

  /**
   * 非流式兜底（res.body 缺失）：整包缓冲 + 同步转换——2026-10-12 流式化前的
   * 原路径原样保留（仅非图片二进制不再产 base64 改为空 content，与流式路径
   * 对齐：占位分支不消费 content）。
   */
  private async readFileContentBuffered(
    res: Response,
    mime: string | undefined,
    isImage: boolean,
  ): Promise<FileContentData> {
    let buffer: ArrayBuffer
    try {
      buffer = await res.arrayBuffer()
    } catch (e) {
      throw classifyFetchError(e)
    }
    const bytes = new Uint8Array(buffer)
    const binary = isImage || bytes.subarray(0, 8192).includes(0)
    if (binary) {
      if (!isImage) return { type: "binary", content: "", encoding: "base64", mimeType: mime }
      // 分块 base64（spread 大文件会栈溢出）
      let binaryStr = ""
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binaryStr += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      return { type: "binary", content: btoa(binaryStr), encoding: "base64", mimeType: mime }
    }
    return { type: "text", content: new TextDecoder("utf-8").decode(bytes) }
  }

  /**
   * GET /api/fs/find：模糊搜索。返回相对 directory 的 path 数组（目录带尾 /，
   * 与 v1 /find/file 的返回形态对齐——@ 浮层数据源直接消费 string[]）。
   */
  async findFiles(query: string, directory: string, limit = 20): Promise<string[]> {
    return this.withLocation(directory, async () => {
      const q = new URLSearchParams()
      q.set("location[directory]", directory)
      q.set("query", query)
      q.set("limit", String(limit))
      const res = await this.fetchJson<{ data: V2FsEntry[] }>(
        `/api/fs/find?${q.toString()}`,
      )
      return res.data.map((e) => e.path)
    })
  }

  // ============ diff（M6b：vcs 组 deepObject + session turn 语义） ============

  /**
   * GET /api/vcs/diff：mode 映射 v1 → v2（git 工作区未提交 → working、分支对比
   * → branch）。context 恒显式传（v2 端点明确「Omit for full-file patches」——
   * 与 v1 相同的全文件 patch 陷阱，3 对齐 git diff --unified=3）。
   */
  async listVcsDiff(
    directory: string,
    mode: "git" | "branch",
    opts: { context?: number } = {},
  ): Promise<FileDiff[]> {
    return this.withLocation(directory, async () => {
      const q = new URLSearchParams()
      q.set("location[directory]", directory)
      q.set("mode", mode === "git" ? "working" : "branch")
      q.set("context", String(opts.context ?? 3))
      const res = await this.fetchJson<{ data: V2FileDiff[] }>(
        `/api/vcs/diff?${q.toString()}`,
        { timeoutMs: 30000 },
      )
      return res.data
    })
  }

  /**
   * GET /api/session/:sessionID/diff：turn 语义（v1 是 messageID query）——
   * from = user 消息 ID（其 turn 的改动），缺省 server 取最新 user turn。
   * context 同 vcs（显式传 3，v1 时代只能靠 diff-parse 的 narrowHunk 客户端
   * 收窄——v2 可从请求侧根治，收窄层保留为无害冗余）。
   */
  async listSessionDiff(
    sessionID: string,
    messageID: string | undefined,
    opts: { context?: number } = {},
  ): Promise<FileDiff[]> {
    const q = new URLSearchParams()
    if (messageID !== undefined) q.set("from", messageID)
    q.set("context", String(opts.context ?? 3))
    const res = await this.fetchJson<{ data: V2FileDiff[] }>(
      `/api/session/${encodeURIComponent(sessionID)}/diff?${q.toString()}`,
      { timeoutMs: 30000 },
    )
    return res.data
  }

  // ============ pty（M6b：契约经活体核对，design-terminal-tab §1） ============

  /**
   * POST /api/pty：创建 pty（cwd = 作用域目录；command 省略时 server 用默认
   * shell）。body 同 v1（command/args/cwd/title/env——env 的显示环境注入见
   * app-store ptyDisplayEnvForServer）。
   */
  async createPty(
    directory: string,
    body: { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string> } = {},
  ): Promise<Pty> {
    const res = await this.withLocation(directory, () =>
      this.fetchJson<{ data: Pty }>(`/api/pty${this.locationQuery(directory)}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    )
    return res.data
  }

  /** PUT /api/pty/:ptyID（resize；失败静默由调用方 catch） */
  async updatePtySize(ptyID: string, directory: string, size: { rows: number; cols: number }): Promise<Pty> {
    const res = await this.withLocation(directory, () =>
      this.fetchJson<{ data: Pty }>(
        `/api/pty/${encodeURIComponent(ptyID)}${this.locationQuery(directory)}`,
        { method: "PUT", body: JSON.stringify({ size }) },
      ),
    )
    return res.data
  }

  /** DELETE /api/pty/:ptyID（关 Tab = 杀 pty；404 = 已退出，调用方视为成功）。
   *  §3.5 **豁免 withLocation**：pty 清理属删除链路自身（removeWorkspace 删
   *  worktree 前先行 killPtyInDirectory），挂起会拒绝清理；顺序保证其落在
   *  目录存活期。他端删除（syncWorktrees）路径的残留见 §3.5 兜底。 */
  async deletePty(ptyID: string, directory: string): Promise<void> {
    await this.fetchResponse(`/api/pty/${encodeURIComponent(ptyID)}${this.locationQuery(directory)}`, {
      method: "DELETE",
    })
  }

  /**
   * POST /api/pty/:ptyID/connect-token：WS 连接票据。**必须带头
   * `x-opencode-ticket: 1`**（无此头 403 PtyForbiddenError——"我知道我在开 WS"
   * 的客户端确认信号，v1 同规则沿用）；响应 envelope `{location, data}`。
   */
  async ptyConnectToken(ptyID: string, directory: string): Promise<PtyTicket> {
    const res = await this.withLocation(directory, () =>
      this.fetchJson<{ data: PtyTicket }>(
        `/api/pty/${encodeURIComponent(ptyID)}/connect-token${this.locationQuery(directory)}`,
        { method: "POST", headers: { "x-opencode-ticket": "1" } },
      ),
    )
    return res.data
  }

  // ============ 命令面板（M6c：/api/command + /api/skill 合并） ============

  /**
   * 命令目录 = `GET /api/command` ∪ `GET /api/skill`（v2 注册制不再合并外部
   * skill，移动端同源合并——skill 以斜杠触发，source 标记供 UI 分流）。
   * 单源失败保留该源空缺（不拖垮另一源）。
   */
  async listCommands(directory: string): Promise<CommandInfo[]> {
    const [commands, skills] = await this.withLocation(directory, () =>
      Promise.all([
        this.fetchJson<{ data: CommandInfo[] }>(`/api/command${this.locationQuery(directory)}`)
          .then((r) => r.data)
          .catch(() => null),
        this.fetchJson<{ data: Array<{ id: string; name?: string; description?: string }> }>(
          `/api/skill${this.locationQuery(directory)}`,
        )
          .then((r) => r.data)
          .catch(() => null),
      ]),
    )
    const out: CommandInfo[] = commands ?? []
    if (skills) {
      for (const s of skills) {
        if (!s?.id) continue
        out.push({ name: s.id, description: s.description ?? s.name, source: "skill" })
      }
    }
    return out
  }

  /**
   * POST /api/session/:sessionID/command：body `{name, text, files?}`（text =
   * v2 必填、无参传 ""；files =
   * v2 {uri, name}，同 prompt 契约）。同步执行，NoContent/200 即完成——
   * **timeoutMs: 0 不设超时**（design-slash-command SC-4：命令跑超 15s 客户端
   * 会误判失败撤乐观 + 回填草稿，而 server 继续执行不随断连取消；v1 同判）。
   */
  async sendCommand(
    sessionID: string,
    command: string,
    arguments_?: string,
    files?: Array<{ uri: string; name?: string }>,
  ): Promise<void> {
    await this.fetchResponse(`/api/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      // text 是 v2 必填字段（required: ["name","text"]）：无参命令传 ""，
      // 省略整个键会被 server 400 "Missing key [text]" 拒绝——2026-09-29
      // 实测修复；files 才是"空则省略"（同移动端 command() 契约）
      body: JSON.stringify({
        name: command,
        text: arguments_ ?? "",
        ...(files?.length ? { files } : {}),
      }),
      timeoutMs: 0,
    })
  }

  // ============ 待办回填（M6c：permission/form 快照） ============

  /** GET /api/permission/request：目录级 pending 权限（Record[]，归一化在 pending-requests） */
  async listPendingPermissionRequests(directory: string): Promise<Record<string, unknown>[]> {
    const res = await this.withLocation(directory, () =>
      this.fetchJson<{ data: Record<string, unknown>[] }>(
        `/api/permission/request${this.locationQuery(directory)}`,
      ),
    )
    return res.data
  }

  /** GET /api/form：目录级 pending 表单（Form.Info[] → 归一化 PendingQuestion） */
  async listPendingForms(directory: string): Promise<PendingQuestion[]> {
    const res = await this.withLocation(directory, () =>
      this.fetchJson<{ data: unknown[] }>(`/api/form${this.locationQuery(directory)}`),
    )
    return res.data
      .map((f) => normalizeForm(f as Record<string, unknown>, directory))
      .filter((q): q is PendingQuestion => q !== null)
  }
}
