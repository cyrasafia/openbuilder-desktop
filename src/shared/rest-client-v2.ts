/**
 * opencode **v2** REST client（renderer 直连，fetch 封装；迁移期与 v1 rest-client.ts
 * 并存，最终命名——收敛步删除 v1 面后此模块即唯一 client，见 docs/plan-v2-protocol.md）。
 * 契约见 api-v2-types.ts 头注释。错误分类与 fetch 管道自持（不 import v1 模块，
 * 避免 v1 删除时的反向依赖）。
 */
import type {
  CursorPage,
  ListSessionsInput,
  LocationInfo,
  ProjectInfo,
  ServerInfo,
  SessionInfo,
} from "./api-v2-types"

export interface RestClientV2Options {
  baseUrl: string
  /** v2 强制 Basic auth；用户名固定 "opencode"（server auth.ts 硬编码校验） */
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
      | "unsupported"
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

/** Basic 头（UTF-8 字节 base64）：btoa 直拼对非 Latin1 密码（如中文）抛
 *  InvalidCharacterError；服务端按 UTF-8 解码凭据，此编码与其对齐（ASCII 两者逐字节一致） */
function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return "Basic " + btoa(binary)
}

export class RestClientV2 {
  private base: string
  private authHeader: string | undefined
  private f: typeof fetch

  constructor(opts: RestClientV2Options) {
    this.base = opts.baseUrl.replace(/\/+$/, "")
    if (opts.username || opts.password) {
      this.authHeader = basicAuthHeader(opts.username ?? "opencode", opts.password ?? "")
    }
    // Electron renderer 的 fetch 是绑定 window 的包装，脱离 this 调用会 Illegal invocation
    this.f = opts.fetchImpl ?? fetch.bind(globalThis)
  }

  /**
   * pty WebSocket 连接基址：http(s) → ws(s) 换 scheme。
   * **⚠️ v2 的 WS connect/ticket 契约未核对**（plan-v2-terminal 首项任务，
   * 评审 V2D-2）——M1+ 代码不得在核对前调用本方法。
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
      throw new ApiError(res.status, kind, `HTTP ${res.status}`)
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
    let path = "/api/location"
    if (directory !== undefined) {
      const q = new URLSearchParams()
      q.set("location[directory]", directory)
      path += `?${q.toString()}`
    }
    return this.fetchJson<LocationInfo>(path)
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
}
