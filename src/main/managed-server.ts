import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { randomBytes } from "node:crypto"
import { BrowserWindow } from "electron"

let child: ChildProcess | null = null

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

function emit(event: string, data: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("managed:event", JSON.stringify({ event, data }))
  }
}

async function waitHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error("opencode server 健康检查超时")
}

export interface ManagedStartResult {
  ok: boolean
  error?: string
  baseUrl?: string
  /** basic auth 凭据：spawn 时注入 server，renderer 连接时使用 */
  username?: string
  password?: string
}

export async function startManagedServer(): Promise<ManagedStartResult> {
  if (child) {
    return { ok: true, baseUrl: childEnvBaseUrl, username: "opencode", password: childPassword }
  }

  const bin = process.env.OPENCODE_BIN ?? "opencode"
  const port = await findFreePort()
  const password = randomBytes(16).toString("hex")
  childEnvBaseUrl = `http://127.0.0.1:${port}`
  childPassword = password

  return new Promise((resolve) => {
    try {
      child = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: password,
        },
      })
    } catch (err) {
      child = null
      resolve({ ok: false, error: `spawn ${bin} 失败: ${String(err)}` })
      return
    }

    let stderrTail = ""
    const fail = (msg: string) => {
      cleanupChild()
      resolve({ ok: false, error: msg })
    }

    child.stdout?.on("data", (d: Buffer) => emit("log", d.toString()))
    child.stderr?.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000)
      emit("log", d.toString())
    })
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        fail(`未在 PATH 中找到 opencode（${bin}）。请安装 opencode 或使用 attach 模式。`)
      } else {
        fail(`opencode 进程错误: ${err.message}`)
      }
    })
    child.on("exit", (code, signal) => {
      emit("exit", { code, signal })
      if (child) {
        // 非主动停止的退出视为崩溃
        child = null
      }
    })

    void waitHealthy(childEnvBaseUrl, 20000)
      .then(() => resolve({ ok: true, baseUrl: childEnvBaseUrl, username: "opencode", password }))
      .catch(() => fail(`opencode serve 启动超时。stderr 尾部:\n${stderrTail}`))
  })
}

let childEnvBaseUrl = ""
let childPassword = ""

export async function stopManagedServer() {
  if (child && !child.killed) {
    child.kill("SIGTERM")
  }
  cleanupChild()
}

function cleanupChild() {
  child = null
}

export function killManagedSync() {
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM")
    } catch {
      // ignore
    }
  }
  child = null
}
