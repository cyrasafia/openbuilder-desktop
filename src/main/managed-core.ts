/**
 * managed server 状态机（design-managed-config §3.1）：spawn/退避重启/事件，
 * 不 import electron（BrowserWindow 广播由 wiring 层注入）。依赖注入供单测。
 */
import { spawn, type ChildProcess } from "node:child_process"

export interface ManagedStartResult {
  ok: boolean
  error?: string
  baseUrl?: string
  username?: string
  password?: string
  /** spawn 前 `--version` 探测结果 */
  version?: string
}

/** managed:event 信封（wiring 层 JSON.stringify 后经 IPC 广播） */
export type ManagedEvent =
  | { event: "log"; data: string }
  | { event: "exit"; data: { code: number | null; signal: string | null } }
  | { event: "restart"; data: { attempt: number; delayMs: number } }
  | { event: "restart-error"; data: { attempt: number; error: string } }
  | {
      event: "restarted"
      data: { baseUrl: string; username: string; password: string; version: string | null }
    }

export interface ControllerDeps {
  env: NodeJS.ProcessEnv
  spawnImpl: typeof spawn
  findFreePort: () => Promise<number>
  probeVersion: (bin: string) => Promise<string | null>
  /** 健康等待：authorization 为 spawn 注入密码构造的 Basic 头——/global/health
   *  在 server 的 RootHttpApi 上受 Authorization 中间件保护（联调实测 2026-09-04：
   *  裸 fetch 恒 401 → 永远"启动超时"），必须带凭据探测 */
  waitHealthy: (baseUrl: string, timeoutMs: number, authorization: string) => Promise<void>
  emit: (e: ManagedEvent) => void
  randomPassword: () => string
  healthTimeoutMs?: number
}

/** basic auth 头（与 server OPENCODE_SERVER_PASSWORD/USERNAME 对应） */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

/** 退避序列（与 SSE 订阅器/pty 重连同序列，design-terminal-tab §1.2a） */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]

/**
 * managed server 子进程环境净化：剥离本应用注入的内部 env——
 * - REMOTE_DEBUGGING_PORT：electron-vite dev 会把 --remote-debugging-port 写进
 *   env，opencode serve 读取它会自起 CDP 抢占同一端口（实测 2026-09-04：应用
 *   CDP 与 spawn 出的 server 端口冲突，后续应用实例 bind 失败）
 * - NODE_/ELECTRON_/VITE_ 前缀：dev 注入值泄漏改变子进程行为（同
 *   linux-open-with sanitizedChildEnv 的实证理由）
 */
export function sanitizedServerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (upper === "REMOTE_DEBUGGING_PORT") continue
    if (upper.startsWith("NODE_") || upper.startsWith("ELECTRON_") || upper.startsWith("VITE_")) {
      continue
    }
    out[key] = value
  }
  return out
}

export class ManagedServerController {
  private child: ChildProcess | null = null
  /** 本次 spawn 是否通过过健康检查——只有成活后的退出才进重启环 */
  private established = false
  private intentionalStop = false
  private restartAttempt = 0
  private restartTimer: NodeJS.Timeout | null = null
  private startInFlight: Promise<ManagedStartResult> | null = null
  private lastBinaryPath: string | undefined
  private baseUrl = ""
  private password = ""
  private version: string | null = null

  constructor(private deps: ControllerDeps) {}

  get alive(): boolean {
    return !!this.child
  }

  currentInfo(): ManagedStartResult {
    return {
      ok: true,
      baseUrl: this.baseUrl,
      username: "opencode",
      password: this.password,
      version: this.version ?? undefined,
    }
  }

  /** 二进制解析优先级：OPENCODE_BIN env → 显式路径 → PATH */
  resolveBinaryPath(explicit?: string): string {
    return this.deps.env.OPENCODE_BIN ?? explicit ?? "opencode"
  }

  start(opts: { binaryPath?: string } = {}): Promise<ManagedStartResult> {
    if (this.child) return Promise.resolve(this.currentInfo())
    if (this.startInFlight) return this.startInFlight
    // 显式启动取代退避排队（用户动作优先于定时器），attempt 归零
    this.cancelRestartTimer()
    this.intentionalStop = false
    this.restartAttempt = 0
    this.lastBinaryPath = opts.binaryPath
    this.startInFlight = this.doStart(opts.binaryPath).finally(() => {
      this.startInFlight = null
    })
    return this.startInFlight
  }

  stop() {
    this.intentionalStop = true
    this.cancelRestartTimer()
    this.restartAttempt = 0
    this.killChild()
  }

  killSync() {
    this.stop()
  }

  private cancelRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private killChild() {
    const c = this.child
    this.child = null
    if (c && !c.killed) {
      try {
        c.kill("SIGTERM")
      } catch {
        // ignore
      }
    }
  }

  private async doStart(binaryPath?: string): Promise<ManagedStartResult> {
    const bin = this.resolveBinaryPath(binaryPath)
    const version = await this.deps.probeVersion(bin)
    if (version === null) {
      return { ok: false, error: `无法执行 ${bin} --version（不存在或不可执行）` }
    }
    this.version = version
    const port = await this.deps.findFreePort()
    const password = this.deps.randomPassword()
    const baseUrl = `http://127.0.0.1:${port}`
    const healthTimeout = this.deps.healthTimeoutMs ?? 20000

    return new Promise<ManagedStartResult>((resolve) => {
      let child: ChildProcess
      try {
        child = this.deps.spawnImpl(
          bin,
          ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
          {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
            env: {
              ...sanitizedServerEnv(this.deps.env),
              OPENCODE_SERVER_PASSWORD: password,
            },
          },
        )
      } catch (err) {
        resolve({ ok: false, error: `spawn ${bin} 失败: ${String(err)}` })
        return
      }

      this.child = child
      this.established = false
      let stderrTail = ""
      let settled = false

      const fail = (msg: string) => {
        if (settled) return
        settled = true
        this.killChild()
        resolve({ ok: false, error: msg })
      }

      child.stdout?.on("data", (d: Buffer) => this.deps.emit({ event: "log", data: d.toString() }))
      child.stderr?.on("data", (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-2000)
        this.deps.emit({ event: "log", data: d.toString() })
      })
      child.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          fail(`未找到 opencode 二进制（${bin}）。请安装 opencode、检查二进制路径，或使用 attach 模式。`)
        } else {
          fail(`opencode 进程错误: ${err.message}`)
        }
      })
      child.on("exit", (code, signal) => {
        this.deps.emit({ event: "exit", data: { code, signal } })
        if (this.child === child) this.child = null
        // 主动停止（stop/killSync）或未成活的退出（fail 路径已 resolve 错误）不进重启环
        if (this.intentionalStop || !this.established) return
        this.scheduleRestart()
      })

      void this.deps
        .waitHealthy(baseUrl, healthTimeout, basicAuthHeader("opencode", password))
        .then(() => {
          if (settled) return
          settled = true
          this.established = true
          this.baseUrl = baseUrl
          this.password = password
          resolve({ ok: true, baseUrl, username: "opencode", password, version })
        })
        .catch(() => fail(`opencode serve 启动超时。stderr 尾部:\n${stderrTail}`))
    })
  }

  /** 崩溃后退避排队；每次重启完整走 doStart（重解析二进制、新端口/新密码） */
  private scheduleRestart() {
    const delayMs = BACKOFF_MS[Math.min(this.restartAttempt, BACKOFF_MS.length - 1)]
    this.restartAttempt++
    this.deps.emit({ event: "restart", data: { attempt: this.restartAttempt, delayMs } })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.intentionalStop || this.child || this.startInFlight) return
      const attempt = this.doStart(this.lastBinaryPath)
      this.startInFlight = attempt.finally(() => {
        this.startInFlight = null
      })
      void attempt.then((res) => {
        if (res.ok) {
          this.restartAttempt = 0
          this.deps.emit({
            event: "restarted",
            data: {
              baseUrl: res.baseUrl ?? "",
              username: "opencode",
              password: res.password ?? "",
              version: this.version,
            },
          })
        } else {
          this.deps.emit({
            event: "restart-error",
            data: { attempt: this.restartAttempt, error: res.error ?? "unknown" },
          })
          this.scheduleRestart()
        }
      })
    }, delayMs)
  }
}
