/**
 * managed server 真二进制集成测试（design-managed-config §3）：
 * 真实 spawn opencode serve + 真实健康检查 + kill -9 → 退避自动重启。
 * 环境依赖本机 opencode（可执行），默认 skip，OB_MANAGED_INTEGRATION=1 启用。
 */
import { describe, expect, it, vi } from "vitest"
import { execFile as execFileCb, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import {
  ManagedServerController,
  basicAuthHeader,
  type ControllerDeps,
  type ManagedEvent,
} from "./managed-core"

const execFile = promisify(execFileCb)
const RUN = !!process.env.OB_MANAGED_INTEGRATION

describe.skipIf(!RUN)("ManagedServerController 集成（真二进制）", () => {
  it("spawn → 健康 → kill -9 → 退避重启 → restarted 事件（新端口/新密码）", async () => {
    const events: ManagedEvent[] = []
    const children: ChildProcess[] = []
    let port = 33000
    const deps: ControllerDeps = {
      env: { ...process.env, XDG_CONFIG_HOME: "/tmp/ob-managed-integration" },
      spawnImpl: ((bin: string, args: string[], opts: object) => {
        const c = spawn(bin, args, opts)
        children.push(c)
        return c
      }) as ControllerDeps["spawnImpl"],
      findFreePort: async () => ++port,
      probeVersion: async (bin) => {
        try {
          const { stdout } = await execFile(bin, ["--version"], { timeout: 3000 })
          return stdout.trim().split("\n")[0]?.trim() ?? null
        } catch {
          return null
        }
      },
      waitHealthy: async (baseUrl, timeoutMs, authorization) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          try {
            const res = await fetch(`${baseUrl}/global/health`, {
              signal: AbortSignal.timeout(2000),
              headers: { authorization },
            })
            if (res.ok) return
          } catch {
            // 未就绪
          }
          await new Promise((r) => setTimeout(r, 300))
        }
        throw new Error("健康检查超时")
      },
      emit: (e) => events.push(e),
      randomPassword: () => `int-${Math.random().toString(16).slice(2)}`,
      healthTimeoutMs: 15000,
    }

    const c = new ManagedServerController(deps)
    const first = await c.start()
    expect(first.ok).toBe(true)
    expect(first.baseUrl).toBeTruthy()
    expect(first.version).toMatch(/^\d/)

    // 健康端点带凭据可达（auth 修复回归点）
    const health = await fetch(`${first.baseUrl}/global/health`, {
      headers: { authorization: basicAuthHeader(first.username ?? "opencode", first.password ?? "") },
    })
    expect(health.ok).toBe(true)

    // kill -9 模拟崩溃；退避 1s + spawn + 健康均为真实时间——轮询等事件
    children[0]!.kill("SIGKILL")
    let restarted: Extract<ManagedEvent, { event: "restarted" }> | undefined
    for (let i = 0; i < 40 && !restarted; i++) {
      await new Promise((r) => setTimeout(r, 500))
      restarted = events.find((e) => e.event === "restarted") as typeof restarted
    }
    expect(restarted).toBeTruthy()
    expect(restarted!.data.baseUrl).not.toBe(first.baseUrl)
    expect(restarted!.data.password).not.toBe(first.password)
    expect(events.some((e) => e.event === "restart")).toBe(true)
    expect(c.alive).toBe(true)

    // 清理：stop 不再触发重启
    c.stop()
    await new Promise((r) => setTimeout(r, 1500))
    const aliveAfter = children.filter((ch) => ch.exitCode === null && !ch.killed).length
    expect(aliveAfter).toBe(0)
  }, 60000)
})
