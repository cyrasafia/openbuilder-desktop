/**
 * SSE 订阅器（/event?directory=…）。
 * 策略来源：openbuilder design-sse-reconnect-recovery（退避 1→2→4→8→16→30s、
 * 60s 心跳超时、15s 建连总超时、kick 无条件重置退避、health probe 门控）。
 */
import type { OpencodeEvent } from "./api-types"

export type SseStatus = "connecting" | "connected" | "reconnecting" | "stopped"

export interface SseSubscriberOptions {
  baseUrl: string
  directory?: string
  username?: string
  password?: string
  onEvent: (event: OpencodeEvent) => void
  /** connecting->connected 或 reconnecting->connected 转换时触发（对账信号） */
  onReconnected?: () => void
  onStatus?: (status: SseStatus) => void
  /** 注入以便测试 */
  eventSourceFactory?: (url: string, init: { headers: Record<string, string> }) => EventSourceLike
  log?: (...args: unknown[]) => void
}

/** EventSource 最小接口（便于测试替身） */
export interface EventSourceLike {
  onopen: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  close(): void
}

const CONNECT_TIMEOUT_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 60_000
const BACKOFF_SEQUENCE = [1, 2, 4, 8, 16, 30]
const TICK_MS = 200
const KICK = Symbol("kick")

export class SseSubscriber {
  private status: SseStatus = "stopped"
  private backoffIdx = 0
  private kickRequested = false
  private stopped = true
  private es: EventSourceLike | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private connectDeadline: ReturnType<typeof setTimeout> | null = null
  private everConnected = false
  private opts: SseSubscriberOptions

  constructor(opts: SseSubscriberOptions) {
    this.opts = opts
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.backoffIdx = 0
    this.everConnected = false
    void this.loop()
  }

  stop() {
    this.stopped = true
    this.teardown()
    this.setStatus("stopped")
  }

  /** 无条件 kick：重置退避并请求立即重连（窗口 focus、health probe 成功时调用） */
  reconnectNow() {
    this.backoffIdx = 0
    this.kickRequested = true
    if (this.stopped) return
    // 连接挂起时直接掐掉重建，避免等 15s 超时
    if (this.status === "connecting") {
      this.teardown()
    }
  }

  getStatus() {
    return this.status
  }

  private setStatus(s: SseStatus) {
    if (this.status === s) return
    const wasReconnecting = this.status === "reconnecting"
    this.status = s
    this.opts.onStatus?.(s)
    if (s === "connected" && wasReconnecting) {
      this.opts.onReconnected?.()
    }
  }

  private teardown() {
    if (this.es) {
      this.es.close()
      this.es = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.connectDeadline) {
      clearTimeout(this.connectDeadline)
      this.connectDeadline = null
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.kickRequested) {
        this.kickRequested = false
      } else if (this.everConnected) {
        const delay = BACKOFF_SEQUENCE[Math.min(this.backoffIdx, BACKOFF_SEQUENCE.length - 1)]
        this.backoffIdx++
        this.opts.log?.(`sse backoff ${delay}s dir=${this.opts.directory ?? ""}`)
        const slept = await this.interruptibleSleep(delay * 1000)
        if (this.stopped) return
        if (slept === KICK) {
          this.kickRequested = false
        }
      }

      this.setStatus(this.everConnected ? "reconnecting" : "connecting")
      const ok = await this.connectOnce()
      if (this.stopped) return
      if (!ok) continue
      // connectOnce resolve ok = 连接已断；回到循环重连
    }
  }

  private interruptibleSleep(ms: number): Promise<typeof KICK | true> {
    return new Promise((resolve) => {
      const deadline = Date.now() + ms
      const timer = setInterval(() => {
        if (this.stopped) {
          clearInterval(timer)
          resolve(true)
          return
        }
        if (this.kickRequested) {
          clearInterval(timer)
          resolve(KICK)
          return
        }
        if (Date.now() >= deadline) {
          clearInterval(timer)
          resolve(true)
        }
      }, TICK_MS)
    })
  }

  /** resolve(true) 表示建立过连接后断开；resolve(false) 表示从未连上（走退避） */
  private connectOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      let connected = false
      const settle = (v: boolean) => {
        if (settled) return
        settled = true
        this.teardown()
        resolve(v)
      }

      const url =
        this.opts.baseUrl +
        "/event" +
        (this.opts.directory ? `?directory=${encodeURIComponent(this.opts.directory)}` : "")
      const headers: Record<string, string> = { Accept: "text/event-stream" }
      if (this.opts.username || this.opts.password) {
        headers.Authorization =
          "Basic " + btoa(`${this.opts.username ?? ""}:${this.opts.password ?? ""}`)
      }

      const factory = this.opts.eventSourceFactory ?? defaultEventSourceFactory
      let es: EventSourceLike
      try {
        es = factory(url, { headers })
      } catch (e) {
        this.opts.log?.("sse factory error", e)
        settle(false)
        return
      }
      this.es = es

      // 建连总超时（覆盖 TCP+响应头挂起场景）
      this.connectDeadline = setTimeout(() => {
        this.opts.log?.("sse connect timeout")
        settle(connected)
      }, CONNECT_TIMEOUT_MS)

      es.onopen = () => {
        connected = true
        this.everConnected = true
        this.backoffIdx = 0
        this.kickRequested = false
        if (this.connectDeadline) {
          clearTimeout(this.connectDeadline)
          this.connectDeadline = null
        }
        this.startHeartbeatWatch()
        this.setStatus("connected")
        this.opts.log?.(`sse connected dir=${this.opts.directory ?? ""}`)
      }

      es.onerror = () => {
        this.opts.log?.(`sse error (connected=${connected}) dir=${this.opts.directory ?? ""}`)
        settle(connected)
      }

      es.onmessage = (ev: { data: string }) => {
        this.bumpHeartbeat()
        if (!ev.data.trim()) return
        try {
          const parsed = JSON.parse(ev.data) as OpencodeEvent
          if (parsed && typeof parsed.type === "string") {
            this.opts.onEvent(parsed)
          }
        } catch {
          this.opts.log?.("sse parse error", ev.data.slice(0, 100))
        }
      }
    })
  }

  private startHeartbeatWatch() {
    this.bumpHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      const silent = Date.now() - (this.lastEventAt ?? 0)
      if (silent > HEARTBEAT_TIMEOUT_MS) {
        this.opts.log?.("sse heartbeat timeout, dropping connection")
        this.es?.close()
        // onerror 触发 settle
        this.es!.onerror?.()
      }
    }, 5_000)
  }

  private lastEventAt: number | null = null

  private bumpHeartbeat() {
    this.lastEventAt = Date.now()
  }
}

/** 带自定义 header 的 EventSource（原生 EventSource 不支持 header，用 fetch 流实现） */
function defaultEventSourceFactory(url: string, init: { headers: Record<string, string> }): EventSourceLike {
  const controller = new AbortController()
  const shim: EventSourceLike = {
    onopen: null,
    onerror: null,
    onmessage: null,
    close: () => controller.abort(),
  }
  void (async () => {
    try {
      const res = await fetch(url, {
        headers: init.headers,
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        shim.onerror?.()
        return
      }
      shim.onopen?.()
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE 帧：空行分隔；仅处理 data: 行（server 只发 data 帧，实测确认）
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              shim.onmessage?.({ data: line.slice(5).trimStart() })
            }
          }
        }
      }
      shim.onerror?.()
    } catch {
      shim.onerror?.()
    }
  })()
  return shim
}
