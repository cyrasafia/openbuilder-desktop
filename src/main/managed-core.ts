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
    // 仅已成活（健康通过）的 child 才直接返回现行信息：重启尝试在途时 child
    // 存在但未成活，返回其 baseUrl 是过期地址（review P3）——改返回在途 promise
    if (this.child && this.established) return Promise.resolve(this.currentInfo())
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

  /** 主动杀掉的 child 集合（review 第二轮 P2）：intentionalStop 是控制器级全局、
   *  会被下一次 start() 复位——旧 child 的 SIGTERM exit 晚到时须按 per-child
   *  标记判定，否则误发 exit 事件（renderer 重新挂"异常退出"提示） */
  private killedChildren = new WeakSet<ChildProcess>()

  private killChild() {
    const c = this.child
    this.child = null
    if (c && !c.killed) {
      this.killedChildren.add(c)
      try {
        c.kill("SIGTERM")
      } catch {
        // ignore
      }
    }
  }

  private async doStart(binaryPath?: string): Promise<ManagedStartResult> {
    const bin = this.resolveBinaryPath(binaryPath)
    // probe/findFreePort rejection 兜底（review 第三轮 P3）：裸 rejection 经 IPC
    // 传导为 renderer 未处理 rejection 且卡 "connecting"
    let version: string | null
    try {
      version = await this.deps.probeVersion(bin)
    } catch {
      version = null
    }
    if (version === null) {
      return { ok: false, error: `无法执行 ${bin} --version（不存在或不可执行）` }
    }
    // doStart 自身 await 边界校验（review 第二轮 P2）：stop() 落在探测/找端口
    // 窗口时 killChild 是 no-op（child 未 spawn），不校验会继续 spawn 出孤儿 server
    if (this.intentionalStop) {
      return { ok: false, error: "已停止" }
    }
    this.version = version
    let port: number
    try {
      port = await this.deps.findFreePort()
    } catch (err) {
      return { ok: false, error: `寻找空闲端口失败: ${String(err)}` }
    }
    if (this.intentionalStop) {
      return { ok: false, error: "已停止" }
    }
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
              // 钉死 username（review P3）：用户 shell 若设 OPENCODE_SERVER_USERNAME，
              // spawn 出的 server 会按它鉴权 → renderer 用 "opencode" 永久 401
              OPENCODE_SERVER_USERNAME: "opencode",
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
        // per-child 主动停止判定（review 第二轮 P2）：stop→快速 start 会复位全局
        // intentionalStop，旧 child 的 SIGTERM exit 晚到时按 killedChildren 判定
        const intentional = this.killedChildren.has(child)
        // 主动停止不发 exit：SIGTERM 的退出不是"异常退出"（review 第一轮 P2）
        if (!intentional) {
          this.deps.emit({ event: "exit", data: { code, signal } })
        }
        if (this.child === child) this.child = null
        // 未成活即退出：fail-fast（不等 20s 健康超时——秒崩场景"启动超时"的报错
        // 既误导又拖慢重启节奏；主动停止的退出文案区分，review 第一/二轮）
        if (!this.established) {
          if (intentional) {
            fail("已停止")
          } else {
            fail(`opencode serve 启动即退出（code=${code} signal=${signal}）。stderr 尾部:\n${stderrTail}`)
          }
          return
        }
        // 主动停止或已 fail 的退出不进重启环
        if (intentional) return
        this.scheduleRestart()
      })

      void this.deps
        .waitHealthy(baseUrl, healthTimeout, basicAuthHeader("opencode", password))
        .then(() => {
          if (settled) return
          // TOCTOU 防御（review 第一轮 P3 → 第二轮 P1）：健康 200 返回时进程可能
          // 已退出/已被停止——不按成活 resolve，但**必须 settle**（裸 return 会让
          // start promise 永悬挂、startInFlight 永不清空，后续 start 全部不可用）
          if (this.child !== child) {
            settled = true
            resolve({ ok: false, error: "已停止" })
            return
          }
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
        // 停止后迟到的失败不再发 restart-error/restart（review 第二轮 P3）：
        // renderer 已清空 notice，纯展示层噪音
        if (!res.ok && this.intentionalStop) return
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
