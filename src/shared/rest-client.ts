/**
 * opencode REST client（renderer 直连，fetch 封装）。
 * 契约见 api-types.ts 头注释。
 */
import type {
  AgentInfo,
  CommandInfo,
  ConfigProviders,
  FileNode,
  HealthInfo,
  MessageWithParts,
  ModelRef,
  Project,
  Session,
  SessionStatusValue,
  Workspace,
  WorktreeResult,
} from "./api-types"
import type { Part } from "./api-types"

export interface RestClientOptions {
  baseUrl: string
  username?: string
  password?: string
  fetchImpl?: typeof fetch
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public kind:
      | "auth"
      | "not-found"
      | "server"
      | "timeout"
      | "network"
      | "unknown",
    message: string,
  ) {
    super(message)
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

export class RestClient {
  private base: string
  private authHeader: string | undefined
  private f: typeof fetch

  constructor(opts: RestClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "")
    if (opts.username || opts.password) {
      this.authHeader =
        "Basic " + btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)
    }
    // Electron renderer 的 fetch 是绑定 window 的包装，脱离 this 调用会 Illegal invocation
    this.f = opts.fetchImpl ?? fetch.bind(globalThis)
  }

  /** 底层 fetch（鉴权 + 超时 + 错误分类）；需要读响应头的端点（cursor 分页）也走这里 */
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
        signal: AbortSignal.timeout(timeoutMs),
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
      throw new ApiError(res.status, kind, `HTTP ${res.status}`)
    }
    return res
  }

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const res = await this.fetchResponse(path, init)
    if (res.status === 204) return undefined as T
    // void 端点可能返回 200 空体（如 prompt_async）；空体不解析
    const text = await res.text()
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ApiError(res.status, "unknown", "响应解析失败")
    }
  }

  private static dirQuery(directory: string, extra: Record<string, string | number | undefined> = {}) {
    const q = new URLSearchParams()
    q.set("directory", directory)
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) q.set(k, String(v))
    }
    return `?${q.toString()}`
  }

  health(): Promise<HealthInfo> {
    return this.request<HealthInfo>("/global/health", { timeoutMs: 5000 })
  }

  listProjects(): Promise<Project[]> {
    return this.request<Project[]>("/project")
  }

  currentProject(): Promise<Project> {
    return this.request<Project>("/project/current")
  }

  listSessions(directory: string, workspace?: string): Promise<Session[]> {
    return this.request<Session[]>(`/session${RestClient.dirQuery(directory, { workspace })}`)
  }

  /**
   * 项目级会话快照（`GET /session?directory=X&scope=project`，实测 server 1.18.x）：
   * 返回该项目**全部目录**（worktree + sandboxes；global 则为全部会话目录）的
   * 未归档会话，一次覆盖。用途：global 项目按 directory 拆分的发现查询——
   * 不用裸 `GET /session`（那是 server cwd 所在 instance 的会话，随启动目录漂移）。
   */
  listProjectSessions(worktreeDirectory: string): Promise<Session[]> {
    return this.request<Session[]>(
      `/session${RestClient.dirQuery(worktreeDirectory, { scope: "project" })}`,
    )
  }

  /**
   * 会话状态快照（`GET /session/status?directory=`）。
   * 契约：返回 {sessionID: status}，且 server 侧 map 在 idle 时删除条目——
   * 返回里只含非 idle 会话（缺该会话 ⇒ idle）。无 directory 时返回 {}，必须带目录查。
   */
  listSessionStatus(directory: string): Promise<Record<string, SessionStatusValue>> {
    return this.request<Record<string, SessionStatusValue>>(
      `/session/status${RestClient.dirQuery(directory)}`,
    )
  }

  createSession(
    directory: string,
    workspace?: string,
    title?: string,
    opts: { agent?: string; model?: ModelRef } = {},
  ): Promise<Session> {
    return this.request<Session>(
      `/session${RestClient.dirQuery(directory, { workspace })}`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(workspace ? { workspaceID: workspace } : {}),
          ...(title ? { title } : {}),
          ...(opts.agent ? { agent: opts.agent } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        }),
      },
    )
  }

  updateSession(
    sessionID: string,
    directory: string,
    patch: { title?: string; time?: { archived?: number } },
  ): Promise<Session> {
    return this.request<Session>(
      `/session/${encodeURIComponent(sessionID)}${RestClient.dirQuery(directory)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    )
  }

  deleteSession(sessionID: string, directory: string): Promise<void> {
    return this.request<void>(
      `/session/${encodeURIComponent(sessionID)}${RestClient.dirQuery(directory)}`,
      { method: "DELETE" },
    )
  }

  listMessages(sessionID: string, directory: string, limit?: number): Promise<MessageWithParts[]> {
    return this.request<MessageWithParts[]>(
      `/session/${encodeURIComponent(sessionID)}/message${RestClient.dirQuery(directory, { limit })}`,
      // 对账窗口 K=100（参考 openbuilder design-incremental-reconcile）
      { timeoutMs: 20000 },
    )
  }

  /**
   * cursor 分页版消息拉取（design-message-history-pagination §2）：
   * `X-Next-Cursor` 头存在 = 还有更早历史（值锚定本页最旧消息）；
   * 无头 = 穷尽。旧 server 忽略 limit 返回全量且无头 → entries 全量 + nextCursor
   * null，天然降级。`before` 不配 limit 会 400（server 契约），调用方保证成对传。
   */
  async listMessagesPage(
    sessionID: string,
    directory: string,
    opts: { limit: number; before?: string },
  ): Promise<{ entries: MessageWithParts[]; nextCursor: string | null }> {
    const res = await this.fetchResponse(
      `/session/${encodeURIComponent(sessionID)}/message${RestClient.dirQuery(directory, {
        limit: opts.limit,
        before: opts.before,
      })}`,
      { timeoutMs: 20000 },
    )
    const text = await res.text()
    let entries: MessageWithParts[] = []
    if (text) {
      try {
        entries = JSON.parse(text) as MessageWithParts[]
      } catch {
        throw new ApiError(res.status, "unknown", "响应解析失败")
      }
    }
    return { entries, nextCursor: res.headers.get("x-next-cursor") }
  }

  /** 异步发消息：立即返回，回复走 SSE 事件流（长回复不受 HTTP 超时影响） */
  promptAsync(
    sessionID: string,
    directory: string,
    parts: Array<{ type: "text"; text: string }>,
  ): Promise<void> {
    return this.request<void>(
      `/session/${encodeURIComponent(sessionID)}/prompt_async${RestClient.dirQuery(directory)}`,
      { method: "POST", body: JSON.stringify({ parts }), timeoutMs: 15000 },
    )
  }

  abortSession(sessionID: string, directory: string): Promise<void> {
    return this.request<void>(
      `/session/${encodeURIComponent(sessionID)}/abort${RestClient.dirQuery(directory)}`,
      { method: "POST" },
    )
  }

  /**
   * 斜杠命令注册表。单源 v1 instance 路由 `GET /command?directory=`——
   * 与 POST /session/:id/command 执行用同一注册表（builtin init/review +
   * config/插件 + MCP prompts + 全量 skill 含 ~/.claude、~/.agents 外部扫描）。
   * 不用 v2 `/api/command`/`/api/skill`：未 GA、source 注册制无外部扫描、
   * 不合并 skill，且只认 deepObject location 参数、忽略 flat ?directory=
   * （参考 openbuilder design-slash-command-refresh 2026-08-17 追加）。
   * 响应为裸数组。
   */
  listCommands(directory: string): Promise<CommandInfo[]> {
    return this.request<CommandInfo[]>(`/command${RestClient.dirQuery(directory)}`)
  }

  /**
   * 执行斜杠命令：服务端展开模板（$1..$n/$ARGUMENTS/sh 代码块/model/agent/subtask
   * 均服务端解析），客户端零展开。实测语义与 prompt_async 同：立即返回
   * （openbuilder opencode_client.dart 注释），回复与 user 回显走 SSE。
   * 未注册命令走此端点会 400——发送前应先在注册表里匹配。
   */
  sendCommand(sessionID: string, directory: string, command: string, arguments_: string): Promise<void> {
    return this.request<void>(
      `/session/${encodeURIComponent(sessionID)}/command${RestClient.dirQuery(directory)}`,
      { method: "POST", body: JSON.stringify({ command, arguments: arguments_ }) },
    )
  }

  /**
   * 工作区（git worktree）。
   * 用 /experimental/worktree（与移动端同源、实测可用），不用 /experimental/workspace
   * （其 create 需要的 type 契约不稳定）。name 省略时 server 生成随机 slug。
   */
  createWorktree(directory: string, name?: string): Promise<WorktreeResult> {
    return this.request<WorktreeResult>(`/experimental/worktree${RestClient.dirQuery(directory)}`, {
      method: "POST",
      body: JSON.stringify({ ...(name ? { name } : {}) }),
      timeoutMs: 60000,
    })
  }

  removeWorktree(directory: string, worktreeDir: string): Promise<void> {
    return this.request<void>(`/experimental/worktree${RestClient.dirQuery(directory)}`, {
      method: "DELETE",
      body: JSON.stringify({ directory: worktreeDir }),
      timeoutMs: 60000,
    })
  }

  listFiles(directory: string, path: string, workspace?: string): Promise<FileNode[]> {
    const q = new URLSearchParams()
    q.set("path", path)
    q.set("directory", directory)
    if (workspace) q.set("workspace", workspace)
    return this.request<FileNode[]>(`/file?${q.toString()}`)
  }

  readFileContent(directory: string, path: string, workspace?: string): Promise<string> {
    const q = new URLSearchParams()
    q.set("path", path)
    q.set("directory", directory)
    if (workspace) q.set("workspace", workspace)
    // 实测（server 1.18.x）返回 {type:"text", content:string} 包装对象
    return this.request<{ type: string; content: string } | null>(
      `/file/content?${q.toString()}`,
      { timeoutMs: 30000 },
    ).then((r) => {
      if (!r || typeof r.content !== "string") {
        throw new ApiError(0, "unknown", "文件内容响应格式异常")
      }
      return r.content
    })
  }

  // ---- 待处理人机交互（授权/问题）。契约：opencode_openapi.json
  // permission.list / permission.respond / question.list / question.reply / question.reject。
  // pending 按 directory 隔离在 per-instance 内存 Map（移动端 design-question-card-reply.md
  // 实测），所有调用必须带 directory query 才能命中所在实例。----

  listPendingPermissions(directory: string): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>(
      `/permission${RestClient.dirQuery(directory)}`,
    )
  }

  /** 会话作用域端点（移动端验证可用）；directory 透传给路由中间件兜底 */
  respondPermission(
    sessionID: string,
    permissionID: string,
    directory: string,
    response: "once" | "always" | "reject",
  ): Promise<void> {
    return this.request<void>(
      `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}${RestClient.dirQuery(directory)}`,
      { method: "POST", body: JSON.stringify({ response }) },
    )
  }

  listPendingQuestions(directory: string): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>(
      `/question${RestClient.dirQuery(directory)}`,
    )
  }

  /** 全局端点 + directory（session 作用域端点契约上无 directory，移动端实测 404） */
  replyQuestion(questionID: string, directory: string, answers: string[][]): Promise<void> {
    return this.request<void>(
      `/question/${encodeURIComponent(questionID)}/reply${RestClient.dirQuery(directory)}`,
      { method: "POST", body: JSON.stringify({ answers }) },
    )
  }

  rejectQuestion(questionID: string, directory: string): Promise<void> {
    return this.request<void>(
      `/question/${encodeURIComponent(questionID)}/reject${RestClient.dirQuery(directory)}`,
      { method: "POST" },
    )
  }

  // ---- agent / model（design-agent-model-switch）----

  /** 列 agents（v1 `GET /agent?directory=`）。过滤逻辑在 model-catalog.ts。 */
  listAgents(directory: string): Promise<AgentInfo[]> {
    return this.request<AgentInfo[]>(`/agent${RestClient.dirQuery(directory)}`)
  }

  /**
   * 列模型（v1 `GET /config/providers?directory=`，**不用** v2 `/api/model`——LR-1）。
   * 响应 Provider 含明文 API `key`，此处按 ConfigProviders 类型只解构需要字段；
   * key 解析期丢弃（不进任何对象/日志/持久化）。
   */
  listConfigProviders(directory: string): Promise<ConfigProviders> {
    return this.request<ConfigProviders>(
      `/config/providers${RestClient.dirQuery(directory)}`,
    )
  }

  /** 切会话 agent（v2 `POST /api/session/:id/agent`，204）。无 directory 参数。 */
  switchAgent(sessionID: string, agent: string): Promise<void> {
    return this.request<void>(`/api/session/${encodeURIComponent(sessionID)}/agent`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    })
  }

  /**
   * 切会话 model（v2 `POST /api/session/:id/model`，204）。
   * variant 条件包含（AM-3）：「默认」= 省略字段（实测可清掉已设值）。
   */
  switchModel(sessionID: string, model: ModelRef): Promise<void> {
    const body: Record<string, unknown> = { id: model.id, providerID: model.providerID }
    if (model.variant) body.variant = model.variant
    return this.request<void>(`/api/session/${encodeURIComponent(sessionID)}/model`, {
      method: "POST",
      body: JSON.stringify({ model: body }),
    })
  }
}
