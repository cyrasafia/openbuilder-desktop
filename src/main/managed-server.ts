/**
 * managed server 单例接线（design-managed-config §3.1）：状态机在 managed-core.ts，
 * 本文件只注入 electron 环境（BrowserWindow 广播 emit）与真实探测实现。
 */
import { execFile as execFileCb, spawn } from "node:child_process"
import { createServer } from "node:net"
import { randomBytes } from "node:crypto"
import { promisify } from "node:util"
import { BrowserWindow } from "electron"
import { sanitizedChildEnv } from "./linux-open-with"
import {
  ManagedServerController,
  type ManagedEvent,
  type ManagedStartResult,
} from "./managed-core"

const execFile = promisify(execFileCb)

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

/** 健康等待：v2 `GET /api/info`（v0.5 起唯一支持面）。受 Authorization 中间件
 *  保护（密码注入后裸 fetch 恒 401），必须带凭据——授权头由控制器按本次
 *  spawn 密码构造传入。v1 /global/health 已随 v2 server 消亡（404/HTML） */
async function waitHealthy(baseUrl: string, timeoutMs: number, authorization: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/info`, {
        signal: AbortSignal.timeout(2000),
        headers: { authorization },
      })
      // JSON + v2 版本校验（fail-fast：v1 二进制 + SPA fallback 的 200 HTML
      // 在此淘汰，错误不延迟到 renderer 连接期——与 scan 同口径）
      if (res.ok) {
        const info = (await res.json()) as { version?: unknown }
        if (typeof info.version === "string" && info.version.startsWith("2.")) return
      }
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error("opencode server 健康检查超时")
}

function emit(e: ManagedEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("managed:event", JSON.stringify(e))
  }
}

const controller = new ManagedServerController({
  env: process.env,
  spawnImpl: spawn,
  findFreePort,
  probeVersion: async (bin) => {
    try {
      const { stdout } = await execFile(bin, ["--version"], {
        timeout: 3000,
        env: sanitizedChildEnv(process.env),
      })
      const line = stdout.trim().split("\n")[0]?.trim()
      return line || null
    } catch {
      return null
    }
  },
  waitHealthy,
  emit,
  randomPassword: () => randomBytes(16).toString("hex"),
})

export type { ManagedStartResult }

export function startManagedServer(opts: { binaryPath?: string } = {}): Promise<ManagedStartResult> {
  return controller.start(opts)
}

export async function stopManagedServer() {
  controller.stop()
}

export function killManagedSync() {
  controller.killSync()
}
