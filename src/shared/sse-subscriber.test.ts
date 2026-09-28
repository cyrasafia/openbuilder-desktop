import { describe, expect, it, vi } from "vitest"
import { SseSubscriber, type EventSourceLike, type SseEventMeta } from "./sse-subscriber"
import type { V2Event } from "./api-v2-types"

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

/** /api/event 信封帧（V2Event：type 顶层、数据在 data、location.directory 闸门键） */
function heartbeatFrame(): V2Event {
  return { id: "evt_hb", created: 1, type: "server.heartbeat", data: {} }
}

function sessionCreatedFrame(directory: string): V2Event {
  return {
    id: "evt_1",
    created: 1,
    location: { directory },
    type: "session.created",
    data: { sessionID: "ses_1", info: { id: "ses_1" } },
  }
}

function makeSubscriber(opts: Partial<ConstructorParameters<typeof SseSubscriber>[0]> = {}) {
  const sources: FakeEventSource[] = []
  const events: {
    directory: string
    event: { type: string; properties: Record<string, unknown> }
    meta?: SseEventMeta
  }[] = []
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
  it("连接 /api/event（无 query 单流）", async () => {
    const { sub, sources } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    expect(sources[0].url).toBe("http://x/api/event")
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

  it("fetch 工厂：v2 comment 心跳帧（`: heartbeat`）转空 data 喂看门狗，data 帧正常派发", async () => {
    const received: string[] = []
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode(": heartbeat\n\n"))
        controller.enqueue(enc.encode('data: {"id":"e1","created":1,"type":"server.connected","data":{}}\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })),
    )
    const open = vi.fn()
    let errored = false
    const { defaultEventSourceFactory } = await import("./sse-subscriber")
    const es = defaultEventSourceFactory("http://x/api/event", { headers: {} })
    es.onopen = open
    es.onerror = () => (errored = true)
    es.onmessage = (ev) => received.push(ev.data)
    await vi.waitFor(() => expect(errored).toBe(true)) // 流关闭 → onerror
    expect(open).toHaveBeenCalled()
    // comment 帧转空 data（喂心跳看门狗）+ data 帧内容原样
    expect(received).toEqual(["", '{"id":"e1","created":1,"type":"server.connected","data":{}}'])
    vi.unstubAllGlobals()
  })

  it("无 location 的帧（server.connected）缺省 global；comment 心跳帧喂看门狗不产事件", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send({ id: "evt_c", created: 1, type: "server.connected", data: {} })
    expect(events).toHaveLength(1)
    expect(events[0].directory).toBe("global")
    // v2 保活：`: heartbeat` comment 帧——空 data 喂心跳看门狗，不进事件表
    sources[0].sendRaw("")
    expect(events).toHaveLength(1)
    sub.stop()
  })

  it("metadata.project 透传到 onEvent 的 meta（v2 信封无 project 字段）", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send({
      id: "evt_wt",
      created: 1,
      metadata: { project: "proj_abc" },
      location: { directory: "/repo/.git/opencode-worktrees/new-wt" },
      type: "worktree.ready",
      data: { name: "new-wt", branch: "main" },
    })
    expect(events).toHaveLength(1)
    expect(events[0].meta?.project).toBe("proj_abc")
    expect(events[0].directory).toBe("/repo/.git/opencode-worktrees/new-wt")
    expect(events[0].event.type).toBe("worktree.ready")
    expect(events[0].event.properties).toEqual({ name: "new-wt", branch: "main" })
    sub.stop()
  })

  it("无 metadata.project 的帧：meta 只含 created（v2 信封恒有 created）", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    sources[0].send(sessionCreatedFrame("/proj"))
    expect(events).toHaveLength(1)
    expect(events[0].meta).toEqual({ created: 1 })
    sub.stop()
  })

  it("畸形帧（无 type 字段）静默丢弃，不回调不抛错", async () => {
    const { sub, sources, events } = makeSubscriber()
    sub.start()
    await vi.waitFor(() => expect(sources[0]).toBeTruthy())
    sources[0].open()
    // v1 的 sync 双发包装在 v2 单流已不存在；无 type 的载荷按畸形丢弃
    sources[0].send({ directory: "/proj", payload: { syncEvent: { type: "session.created.1", seq: 0 } } })
    sources[0].send({ id: "e2", created: 1, data: {} })
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
