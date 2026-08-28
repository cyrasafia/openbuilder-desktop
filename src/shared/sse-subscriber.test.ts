import { describe, expect, it, vi } from "vitest"
import { SseSubscriber, type EventSourceLike, type SseEventMeta } from "./sse-subscriber"
import type { OpencodeEvent } from "./api-types"

/** 可控的 EventSource 替身：手动触发 open/error/message */
class FakeEventSource implements EventSourceLike {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  closed = false
  constructor(public url: string) {}
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.()
  }
  fail() {
    this.onerror?.()
  }
  send(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  sendRaw(data: string) {
    this.onmessage?.({ data })
  }
}

/** /global/event 信封帧（心跳用于 bump 看门狗） */
function heartbeatFrame(): { payload: OpencodeEvent } {
  return { payload: { id: "evt_hb", type: "server.heartbeat", properties: {} } }
}

function sessionCreatedFrame(directory: string): { directory: string; payload: OpencodeEvent } {
  return {
    directory,
    payload: {
      id: "evt_1",
      type: "session.created",
      properties: { sessionID: "ses_1", info: { id: "ses_1" } } as never,
    },
  }
}

function makeSubscriber(opts: Partial<ConstructorParameters<typeof SseSubscriber>[0]> = {}) {
  const sources: FakeEventSource[] = []
  const events: { directory: string; event: OpencodeEvent; meta?: SseEventMeta }[] = []
  const statuses: string[] = []
  const reconnected = vi.fn()
  const sub = new SseSubscriber({
    baseUrl: "http://x",
    onEvent: (directory, event, meta) => events.push({ directory, event, meta }),
    onReconnected: reconnected,
    onStatus: (s) => statuses.push(s),
    eventSourceFactory: (url) => {
      const es = new FakeEventSource(url)
      sources.push(es)
      return es
    },
    log: () => {},
    ...opts,
  })
  return { sub, sources, events, statuses, reconnected }
}

describe("SseSubscriber", () => {
  it("连接 /global/event（无 directory 参数）", async () => {
    const { sub, sources } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    expect(sources[0].url).toBe("http://x/global/event")
    sub.stop()
  })

  it("信封事件按 directory 回调", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send(sessionCreatedFrame("/proj/worktree"))
    expect(events).toHaveLength(1)
    expect(events[0].directory).toBe("/proj/worktree")
    expect(events[0].event.type).toBe("session.created")
    sub.stop()
  })

  it("无 directory 字段的帧（connected/heartbeat）缺省 global", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send({ payload: { id: "evt_c", type: "server.connected", properties: {} } })
    expect(events).toHaveLength(1)
    expect(events[0].directory).toBe("global")
    sub.stop()
  })

  it("信封 project/workspace 字段透传到 onEvent 的 meta（worktree.ready）", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send({
      directory: "/repo/.git/opencode-worktrees/new-wt",
      project: "proj_abc",
      workspace: "wrk_123",
      payload: {
        id: "evt_wt",
        type: "worktree.ready",
        properties: { name: "new-wt", branch: "main" },
      },
    })
    expect(events).toHaveLength(1)
    expect(events[0].meta?.project).toBe("proj_abc")
    expect(events[0].meta?.workspace).toBe("wrk_123")
    expect(events[0].directory).toBe("/repo/.git/opencode-worktrees/new-wt")
    sub.stop()
  })

  it("无 project/workspace 的帧 meta 为 undefined（不创建空对象）", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send(sessionCreatedFrame("/proj"))
    expect(events).toHaveLength(1)
    expect(events[0].meta).toBeUndefined()
    sub.stop()
  })

  it("durable 事件的 sync 双发包装被丢弃", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send({
      directory: "/proj",
      payload: { type: "sync", syncEvent: { type: "session.created.1", seq: 0 } },
    })
    expect(events).toHaveLength(0)
    sub.stop()
  })

  it("连接成功后收到事件", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send(heartbeatFrame())
    expect(events).toHaveLength(1)
    sub.stop()
  })

  it("首次连接失败走退避重连", async () => {
    vi.useFakeTimers()
    try {
      const { sub, sources } = makeSubscriber()
      sub.start()
      await vi.advanceTimersByTimeAsync(10)
      sources[0].fail() // 未连上
      // 退避 1s
      await vi.advanceTimersByTimeAsync(1100)
      expect(sources.length).toBe(2)
      sub.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("断连后重连成功触发 onReconnected（对账信号）", async () => {
    vi.useFakeTimers()
    try {
      const { sub, sources, reconnected } = makeSubscriber()
      sub.start()
      await vi.advanceTimersByTimeAsync(10)
      sources[0].open()
      sources[0].fail() // 连上后断 → 退避
      await vi.advanceTimersByTimeAsync(1100)
      sources[1].open()
      expect(reconnected).toHaveBeenCalledTimes(1)
      sub.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("建连超时（挂起连接）15s 后放弃", async () => {
    vi.useFakeTimers()
    try {
      const { sub, sources } = makeSubscriber()
      sub.start()
      await vi.advanceTimersByTimeAsync(10)
      // 不 open 也不 error，模拟服务端接受 TCP 但不发响应头
      await vi.advanceTimersByTimeAsync(15_000)
      expect(sources[0].closed).toBe(true)
      await vi.advanceTimersByTimeAsync(1100)
      expect(sources.length).toBe(2)
      sub.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("reconnectNow 无条件 kick：退避中立即重连", async () => {
    vi.useFakeTimers()
    try {
      const { sub, sources } = makeSubscriber()
      sub.start()
      await vi.advanceTimersByTimeAsync(10)
      sources[0].open()
      sources[0].fail()
      // 退避 1s 才会重试，但 kick 立即生效（tick 粒度 200ms 内）
      await vi.advanceTimersByTimeAsync(200)
      sub.reconnectNow()
      await vi.advanceTimersByTimeAsync(250)
      expect(sources.length).toBe(2)
      sub.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("心跳静默 60s 判死连接（半开检测）", async () => {
    vi.useFakeTimers()
    try {
      const { sub, sources } = makeSubscriber()
      sub.start()
      await vi.advanceTimersByTimeAsync(10)
      sources[0].open()
      sources[0].send(heartbeatFrame())
      // 静默 60s+：心跳看门狗（5s 间隔）在 65s tick 检测到，主动断开并重连
      await vi.advanceTimersByTimeAsync(70_000)
      await vi.advanceTimersByTimeAsync(1100)
      expect(sources.length).toBe(2)
      sub.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("坏 JSON 不炸、不发事件", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].sendRaw("{broken json")
    expect(events).toHaveLength(0)
    sub.stop()
  })

  it("非信封结构（payload 缺失）不炸、不发事件", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send({ directory: "/proj" })
    sources[0].send({})
    expect(events).toHaveLength(0)
    sub.stop()
  })
})
