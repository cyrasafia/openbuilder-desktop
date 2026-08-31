/**
 * opencode REST client（renderer 直连，fetch 封装）。
 * 契约见 api-types.ts 头注释。
 */
import type {
  AgentInfo,
  CommandInfo,
  ConfigProviders,
  FileContentData,
  FileDiff,
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
import type { FilePartInput } from "./api-types"
import type { Pty, PtyShell, PtyTicket } from "./api-types"

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

/** /vcs/diff 默认 context 行数（对齐 git diff --unified=3）；server 省略时的
 *  内部默认值 = 整文件作 context，必须显式传小值绕过（见 listVcsDiff 注释） */
export const VCS_DIFF_CONTEXT = 3

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

  /** pty WebSocket 连接基址（design-terminal-tab §1.2）：http(s) → ws(s) 换 scheme */
  ptyWsOrigin(): string {
    return this.base.replace(/^http/, "ws")
  }

  /** 底层 fetch（鉴权 + 超时 + 错误分类）；需要读响应头的端点（cursor 分页）也走这里。
   *  `timeoutMs: 0` = 不设超时、无限等待（同步长时端点专用，见 sendCommand 注释） */
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

  /**
   * 目录解析/注册项目（`GET /project/current?directory=X`，server 源码核实）：
   * instance 路由中间件按 directory 引导实例时走 Project.fromDirectory——目录尚未
   * 注册时 **upsert 项目行**（git 仓库 → 独立项目；非 git → 归入 global 项目），
   * handler 返回的即该目录所属项目。新建项目（设计 design-new-project §2.2）即用
   * 此端点：注册 + 解析二合一，无会话等副产物。不做降级：契约源 opencode_openapi.json
   * 已含该 directory 参数（与移动端同源）。
   * 超时放宽 30s（默认 15s）：全新目录首次引导初始化 LSP/插件/format 等实例服务
   * （project/bootstrap.ts），冷启动可能超 15s。
   */
  resolveProject(directory: string): Promise<Project> {
    return this.request<Project>(`/project/current${RestClient.dirQuery(directory)}`, {
      timeoutMs: 30000,
    })
  }

  listSessions(directory: string, workspace?: string): Promise<Session[]> {
    return this.request<Session[]>(`/session${RestClient.dirQuery(directory, { workspace })}`)
  }

  // ============ pty（design-terminal-tab §1，契约经 opencode 源码核实） ============

  /** 可用 shell 列表（首个 acceptable 为客户端默认） */
  listShells(directory: string): Promise<PtyShell[]> {
    return this.request<PtyShell[]>(`/pty/shells${RestClient.dirQuery(directory)}`)
  }

  /** 创建 pty：cwd = 作用域目录；command 省略时 server 用默认 shell */
  createPty(
    directory: string,
    body: { command?: string; args?: string[]; cwd?: string; env?: Record<string, string> } = {},
  ): Promise<Pty> {
    return this.request<Pty>(`/pty${RestClient.dirQuery(directory)}`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }

  /** resize（TerminalView 节流调用；失败静默由调用方 catch） */
  updatePtySize(ptyID: string, directory: string, size: { rows: number; cols: number }): Promise<Pty> {
    return this.request<Pty>(
      `/pty/${encodeURIComponent(ptyID)}${RestClient.dirQuery(directory)}`,
      { method: "PUT", body: JSON.stringify({ size }) },
    )
  }

  /** 关 Tab = 杀 pty；404（已退出被 legacy 路由回收）由调用方视为成功 */
  deletePty(ptyID: string, directory: string): Promise<void> {
    return this.request<void>(`/pty/${encodeURIComponent(ptyID)}${RestClient.dirQuery(directory)}`, {
      method: "DELETE",
    })
  }

  /**
   * WS 连接票据（PtyTicketConnectToken）。**必须带头 `x-opencode-ticket: 1`**
   * （opencode pty-ticket.ts：无此头的请求 403 PtyForbiddenError——这是"我知道
   * 我在开 WS"的客户端确认信号，而非鉴权本身）；带 ticket 的 connect 路径跳过
   * Basic Auth（isPtyConnectPath），票据即 WS 鉴权。
   */
  ptyConnectToken(ptyID: string, directory: string): Promise<PtyTicket> {
    return this.request<PtyTicket>(
      `/pty/${encodeURIComponent(ptyID)}/connect-token${RestClient.dirQuery(directory)}`,
      // 必须 POST：GET 无此路由，落到 server web UI 的 SPA fallback（HTML，实测）
      { method: "POST", headers: { "x-opencode-ticket": "1" } },
    )
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

  /** 异步发消息：立即返回，回复走 SSE 事件流（长回复不受 HTTP 超时影响）。
   *  parts 支持文本与引用 file part（FilePartInput，design-file-reference §4） */
  promptAsync(
    sessionID: string,
    directory: string,
    parts: Array<{ type: "text"; text: string } | FilePartInput>,
  ): Promise<void> {
    return this.request<void>(
      `/session/${encodeURIComponent(sessionID)}/prompt_async${RestClient.dirQuery(directory)}`,
      { method: "POST", body: JSON.stringify({ parts }), timeoutMs: 15000 },
    )
  }

  /**
   * 文件名搜索（design-file-reference §3.1，@ 浮层数据源）：`GET /find/file`，
   * 返回**相对 directory 的路径字符串数组**（absolute 客户端拼）。type=file 固定
   * 过滤（@ 场景仅文件——返回字符串无目录标记，目录引用走右键/拖拽）。
   */
  findFiles(query: string, directory: string, limit = 20): Promise<string[]> {
    const qs = new URLSearchParams({ query, directory, type: "file", limit: String(limit) })
    return this.request<string[]>(`/find/file?${qs.toString()}`)
  }

  abortSession(sessionID: string, directory: string): Promise<void> {
    return this.request<void>(
      `/session/${encodeURIComponent(sessionID)}/abort${RestClient.dirQuery(directory)}`,
      { method: "POST" },
    )
  }

  /**
   * 回滚暂存（design-message-revert §2）：立即还原工作区文件并写 `session.revert`；
   * 消息删除延迟到下一条 prompt（server cleanup）。busy/retry 时 409（ApiError 透传）。
   */
  revertMessage(sessionID: string, directory: string, messageID: string): Promise<Session> {
    return this.request<Session>(
      `/session/${encodeURIComponent(sessionID)}/revert${RestClient.dirQuery(directory)}`,
      { method: "POST", body: JSON.stringify({ messageID }) },
    )
  }

  /** 撤销回滚暂存：恢复文件、清 `session.revert`（design-message-revert §2） */
  unrevertSession(sessionID: string, directory: string): Promise<Session> {
    return this.request<Session>(
      `/session/${encodeURIComponent(sessionID)}/unrevert${RestClient.dirQuery(directory)}`,
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
   * 均服务端解析），客户端零展开。
   *
   * **同步端点**（早期文档误以为"与 prompt_async 同、立即返回"，2026-08-25 订正）：
   * server handler 直接 await 完整执行循环，执行完才响应（openapi success =
   * 最终 assistant 消息 WithParts，对比 prompt_async 的 NoContent）。但执行
   * runner 挂在 server instance scope，客户端断连**不取消执行**——user 回显与
   * 回复全走 SSE。因此 timeoutMs: 0 无限等待，与参考实现一致：官方 app 走的
   * SDK v2 client 默认 `req.timeout = false`（整体关超时），移动端 dio 无
   * receiveTimeout。失败只剩快速真错误（400 未注册/404 会话不存在）与断网；
   * 若沿用 15s 默认超时，命令跑超 15s 即误判失败→撤乐观+草稿回填（回显 bug）。
   * 未注册命令走此端点会 400——发送前应先在注册表里匹配。
   */
  sendCommand(
    sessionID: string,
    directory: string,
    command: string,
    arguments_: string,
    fileParts?: FilePartInput[],
  ): Promise<void> {
    return this.request<void>(
      `/session/${encodeURIComponent(sessionID)}/command${RestClient.dirQuery(directory)}`,
      {
        method: "POST",
        // parts 可选携带（引用 file part，openapi command body 契约；无引用不传字段）
        body: JSON.stringify({
          command,
          arguments: arguments_,
          ...(fileParts?.length ? { parts: fileParts } : {}),
        }),
        timeoutMs: 0,
      },
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

  readFileContent(
    directory: string,
    path: string,
    workspace?: string,
  ): Promise<FileContentData> {
    const q = new URLSearchParams()
    q.set("path", path)
    q.set("directory", directory)
    if (workspace) q.set("workspace", workspace)
    // 实测（server 1.18.x）：文本 {type:"text", content}；
    // 二进制（图片等）{type:"binary", content:base64, encoding:"base64", mimeType}
    // （design-image-preview §2.1；type/mimeType 是图片预览分发依据，不可只取 content）
    return this.request<FileContentData | null>(`/file/content?${q.toString()}`, {
      timeoutMs: 30000,
    }).then((r) => {
      if (!r || typeof r.content !== "string") {
        throw new ApiError(0, "unknown", "文件内容响应格式异常")
      }
      return {
        type: r.type === "binary" ? "binary" : "text",
        content: r.content,
        ...(r.type === "binary" && r.encoding ? { encoding: r.encoding } : {}),
        ...(typeof r.mimeType === "string" && r.mimeType ? { mimeType: r.mimeType } : {}),
      }
    })
  }

  /**
   * VCS diff（design-diff-view §1）：mode=git 工作区未提交 / mode=branch 当前分支
   * vs 默认分支。非 git 目录 server 报错（调用方错误态呈现）。
   *
   * context 恒显式传值（缺省 VCS_DIFF_CONTEXT=3）：server 端省略时的内部默认值
   * 大到等价"整文件作 context"——无论两处改动相距多远都合并成单 hunk、patch
   * 恒为整文件，即移动端踩过的"展示完整文件"根因（参考 openbuilder 提交 086e32d
   * 与 design-diff-view §DV-CX1）。3 对齐 git diff --unified=3。
   * /session/:id/diff 无 context 参数，不受影响。
   */
  listVcsDiff(
    directory: string,
    mode: "git" | "branch",
    opts: { workspace?: string; context?: number } = {},
  ): Promise<FileDiff[]> {
    return this.request<FileDiff[]>(
      `/vcs/diff${RestClient.dirQuery(directory, {
        mode,
        workspace: opts.workspace,
        context: opts.context ?? VCS_DIFF_CONTEXT,
      })}`,
      { timeoutMs: 30000 },
    )
  }

  /** 会话一轮的改动（messageID 必须是 user 消息；缺省/非 user 返回空数组） */
  listSessionDiff(
    sessionID: string,
    directory: string,
    messageID: string,
  ): Promise<FileDiff[]> {
    return this.request<FileDiff[]>(
      `/session/${encodeURIComponent(sessionID)}/diff${RestClient.dirQuery(directory, {
        messageID,
      })}`,
      { timeoutMs: 30000 },
    )
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

  // ---- 会话任务列表（design-task-list）。契约：opencode_openapi.json session.todo。
  // 全量替换语义；directory 同 pending 系端点作实例路由。----

  listSessionTodos(sessionID: string, directory: string): Promise<unknown> {
    return this.request<unknown>(
      `/session/${encodeURIComponent(sessionID)}/todo${RestClient.dirQuery(directory)}`,
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
