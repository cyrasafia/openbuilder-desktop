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

/** 错误分类转换（参考 openbuilder design-network-error-handling：不暴露响应体）。
 *  v2 下连到 v1 server 的 legacy 端点会返回 200 HTML（SPA fallback）——
 *  "unsupported" 分类由调用方在 JSON 解析失败时标记（探活逻辑用，M1 接线）。 */
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

export class RestClientV2 {
  private base: string
  private authHeader: string | undefined
  private f: typeof fetch

  constructor(opts: RestClientV2Options) {
    this.base = opts.baseUrl.replace(/\/+$/, "")
    if (opts.username || opts.password) {
      this.authHeader = "Basic " + btoa(`${opts.username ?? "opencode"}:${opts.password ?? ""}`)
    }
    // Electron renderer 的 fetch 是绑定 window 的包装，脱离 this 调用会 Illegal invocation
    this.f = opts.fetchImpl ?? fetch.bind(globalThis)
  }

  /** pty WebSocket 连接基址：http(s) → ws(s) 换 scheme（与 v1 同规则） */
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

  /** JSON 响应统一解析：空体容忍为 null（对齐 v1 client 防御行为） */
  private async fetchJson<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T | null> {
    const res = await this.fetchResponse(path, init)
    const text = await res.text()
    if (!text) return null
    return JSON.parse(text) as T
  }

  /** GET /api/info：v2 探活/版本识别（取代 v1 /global/health） */
  async serverInfo(): Promise<ServerInfo> {
    const info = await this.fetchJson<ServerInfo>("/api/info")
    if (!info) throw new ApiError(0, "unknown", "空响应")
    return info
  }

  /** GET /api/project：项目列表（无 query、无 envelope；左栏数据源，canonical 取代 worktree） */
  async listProjects(): Promise<ProjectInfo[]> {
    const list = await this.fetchJson<ProjectInfo[]>("/api/project")
    return list ?? []
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
    const info = await this.fetchJson<LocationInfo>(path)
    if (!info) throw new ApiError(0, "unknown", "空响应")
    return info
  }

  /**
   * GET /api/session：会话列表（flat query + `{data, cursor}` envelope）。
   * 无过滤 = 全量（global 发现用，翻页拉取）；parentID null = 只取根会话
   * （wire 上是字符串 "null"）。cursor 与 order 不可并用（v2 契约）。
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
    const page = await this.fetchJson<CursorPage<SessionInfo>>(`/api/session${suffix ? `?${suffix}` : ""}`)
    if (!page) return { data: [], cursor: {} }
    return page
  }
}
