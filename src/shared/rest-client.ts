/**
 * opencode REST client（renderer 直连，fetch 封装）。
 * 契约见 api-types.ts 头注释。
 */
import type {
  FileNode,
  HealthInfo,
  MessageWithParts,
  Project,
  Session,
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

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
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

  createSession(directory: string, workspace?: string, title?: string): Promise<Session> {
    return this.request<Session>(
      `/session${RestClient.dirQuery(directory, { workspace })}`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(workspace ? { workspaceID: workspace } : {}),
          ...(title ? { title } : {}),
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
}
