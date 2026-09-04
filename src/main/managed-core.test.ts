/** managed server 状态机单测（design-managed-config §3.1）：崩溃退避重启/主动
 * 停止不重启/未成活不进环/显式启动取代退避/env 优先级/并发去重 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import {
  ManagedServerController,
  sanitizedServerEnv,
  type ControllerDeps,
  type ManagedEvent,
} from "./managed-core"

describe("sanitizedServerEnv", () => {
  it("剥离 REMOTE_DEBUGGING_PORT 与 NODE_/ELECTRON_/VITE_ 前缀（大小写不敏感）", () => {
    const out = sanitizedServerEnv({
      REMOTE_DEBUGGING_PORT: "9451",
      NODE_ENV: "development",
      remote_debugging_port: "1234",
      ELECTRON_RUN_AS_NODE: "1",
      vite_dev: "x",
      HOME: "/home/t",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/tmp/x",
    })
    expect(out).toEqual({ HOME: "/home/t", PATH: "/usr/bin", XDG_CONFIG_HOME: "/tmp/x" })
  })
})

function fakeChild(): ChildProcess {
  const ee = new EventEmitter() as unknown as ChildProcess & { killed: boolean }
  ee.killed = false
  ee.kill = vi.fn((): boolean => {
    ;(ee as unknown as { killed: boolean }).killed = true
    queueMicrotask(() => ee.emit("exit", null, "SIGTERM"))
    return true
  })
  ee.stdout = new EventEmitter() as never
  ee.stderr = new EventEmitter() as never
  return ee as ChildProcess
}

function makeDeps(over: Partial<ControllerDeps> = {}) {
  const events: ManagedEvent[] = []
  const spawns: ChildProcess[] = []
  const spawnArgs: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  let port = 20000
  const deps: ControllerDeps = {
    env: {},
    spawnImpl: ((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawnArgs.push({ bin, args, env: opts.env })
      const c = fakeChild()
      spawns.push(c)
      return c
    }) as unknown as ControllerDeps["spawnImpl"],
    findFreePort: async () => ++port,
    probeVersion: async () => "1.18.20",
    waitHealthy: async () => {},
    emit: (e) => events.push(e),
    randomPassword: () => `pw-${++port}`,
    ...over,
  }
  return { deps, events, spawns, spawnArgs }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("ManagedServerController", () => {
  it("start 成功：版本随行、密码注入 env、alive 可查", async () => {
    const { deps, events, spawnArgs } = makeDeps()
    const c = new ManagedServerController(deps)
    const res = await c.start({ binaryPath: "/custom/opencode" })
    expect(res.ok).toBe(true)
    expect(res.version).toBe("1.18.20")
    expect(res.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(res.username).toBe("opencode")
    expect(res.password).toBeTruthy()
    expect(spawnArgs[0]?.bin).toBe("/custom/opencode")
    expect(spawnArgs[0]?.env.OPENCODE_SERVER_PASSWORD).toBe(res.password)
    expect(c.alive).toBe(true)
    expect(events).toEqual([])
  })

  it("OPENCODE_BIN env 优先于显式路径", async () => {
    const { deps, spawnArgs } = makeDeps({ env: { OPENCODE_BIN: "/env/opencode" } })
    const c = new ManagedServerController(deps)
    await c.start({ binaryPath: "/custom/opencode" })
    expect(spawnArgs[0]?.bin).toBe("/env/opencode")
  })

  it("版本探测失败：ok:false 且不 spawn", async () => {
    const { deps, spawns } = makeDeps({ probeVersion: async () => null })
    const c = new ManagedServerController(deps)
    const res = await c.start()
    expect(res.ok).toBe(false)
    expect(res.error).toContain("--version")
    expect(spawns.length).toBe(0)
  })

  it("崩溃后退避重启：exit → restart 事件 → 定时器到点 respawn → restarted（新端口/密码）", async () => {
    const { deps, events, spawns } = makeDeps()
    const c = new ManagedServerController(deps)
    const first = await c.start()
    expect(first.ok).toBe(true)

    // 崩溃
    spawns[0]!.emit("exit", 1, null)
    expect(events).toContainEqual({ event: "exit", data: { code: 1, signal: null } })
    expect(events).toContainEqual({ event: "restart", data: { attempt: 1, delayMs: 1000 } })
    // 退避 1s 未到不 respawn
    await vi.advanceTimersByTimeAsync(500)
    expect(spawns.length).toBe(1)

    await vi.advanceTimersByTimeAsync(600)
    expect(spawns.length).toBe(2)
    const restarted = events.find((e) => e.event === "restarted")
    expect(restarted).toEqual({
      event: "restarted",
      data: {
        baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
        username: "opencode",
        password: expect.any(String),
        version: "1.18.20",
      },
    })
    if (restarted?.event === "restarted") {
      expect(restarted.data.baseUrl).not.toBe(first.baseUrl)
      expect(restarted.data.password).not.toBe(first.password)
    }
    expect(c.alive).toBe(true)
  })

  it("重启失败续退避：序列 1→2→4s，成功后清零", async () => {
    let healthyFail = false
    const { deps, events, spawns } = makeDeps({
      waitHealthy: async () => {
        if (healthyFail) throw new Error("timeout")
      },
    })
    const c = new ManagedServerController(deps)
    await c.start()

    // 崩溃 → attempt1 排队 1s
    spawns[0]!.emit("exit", 1, null)
    expect(events).toContainEqual({ event: "restart", data: { attempt: 1, delayMs: 1000 } })

    // 第一次重启失败（健康超时）→ restart-error + attempt2 排队 2s
    healthyFail = true
    await vi.advanceTimersByTimeAsync(1100)
    expect(events.some((e) => e.event === "restart-error")).toBe(true)
    expect(events).toContainEqual({ event: "restart", data: { attempt: 2, delayMs: 2000 } })

    // 第二次重启成功 → restarted；再崩溃 → attempt 重新从 1（1s）开始
    healthyFail = false
    await vi.advanceTimersByTimeAsync(2100)
    expect(events.some((e) => e.event === "restarted")).toBe(true)
    events.length = 0
    c["child"]!.emit("exit", 1, null)
    expect(events).toContainEqual({ event: "restart", data: { attempt: 1, delayMs: 1000 } })
  })

  it("退避封顶 30s 无限重试", async () => {
    let versionOk = true
    const { deps, events, spawns } = makeDeps({
      probeVersion: async () => (versionOk ? "1.18.20" : null),
    })
    const c = new ManagedServerController(deps)
    await c.start()
    versionOk = false // 后续重启尝试全部在版本探测处失败

    spawns[0]!.emit("exit", 1, null)
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      const restarts = events.filter((e) => e.event === "restart")
      const last = restarts[restarts.length - 1]
      if (!last || last.event !== "restart") break
      delays.push(last.data.delayMs)
      await vi.advanceTimersByTimeAsync(last.data.delayMs + 10)
    }
    // 序列 1,2,4,8,16,30,30,30…（首项在崩溃时已发出）
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })

  it("主动 stop：不重启、清退避", async () => {
    const { deps, events, spawns } = makeDeps()
    const c = new ManagedServerController(deps)
    await c.start()
    c.stop()
    // kill 触发的 exit 不进环
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events.some((e) => e.event === "restart")).toBe(false)
    expect(spawns.length).toBe(1)
    expect(c.alive).toBe(false)
  })

  it("未成活退出（健康超时前崩溃）不进重启环", async () => {
    const { deps, events, spawns } = makeDeps({
      waitHealthy: () => new Promise((_r, rej) => setTimeout(rej, 5000)),
    })
    const c = new ManagedServerController(deps)
    const p = c.start()
    // 健康检查挂起期间进程崩溃（先冲刷微任务让 spawn 落地）
    await vi.advanceTimersByTimeAsync(0)
    spawns[0]!.emit("exit", 1, null)
    const res = await vi.advanceTimersByTimeAsync(5000).then(() => p)
    expect(res.ok).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events.some((e) => e.event === "restart")).toBe(false)
    expect(spawns.length).toBe(1)
  })

  it("显式 start 取代排队退避并清零 attempt", async () => {
    const { deps, events, spawns } = makeDeps()
    const c = new ManagedServerController(deps)
    await c.start()
    spawns[0]!.emit("exit", 1, null)
    expect(events.some((e) => e.event === "restart" && e.data.delayMs === 1000)).toBe(true)

    // 退避排队期间显式启动
    const res = await c.start({ binaryPath: "/new/bin" })
    expect(res.ok).toBe(true)
    expect(spawns.length).toBe(2)
    expect(spawns[1]).toBeDefined()
    // 定时器被取消：不再自动 spawn
    await vi.advanceTimersByTimeAsync(5000)
    expect(spawns.length).toBe(2)
    expect(events.some((e) => e.event === "restarted")).toBe(false)
  })

  it("并发 start 去重（单次 spawn）", async () => {
    const { deps, spawns } = makeDeps()
    const c = new ManagedServerController(deps)
    const [a, b] = await Promise.all([c.start(), c.start()])
    expect(spawns.length).toBe(1)
    expect(a.baseUrl).toBe(b.baseUrl)
    expect(a.password).toBe(b.password)
  })

  it("child 存活时 start 直接返回现行信息（不 respawn）", async () => {
    const { deps, spawns } = makeDeps()
    const c = new ManagedServerController(deps)
    const first = await c.start()
    const second = await c.start({ binaryPath: "/other/bin" })
    expect(spawns.length).toBe(1)
    expect(second.baseUrl).toBe(first.baseUrl)
    expect(second.password).toBe(first.password)
  })
})
