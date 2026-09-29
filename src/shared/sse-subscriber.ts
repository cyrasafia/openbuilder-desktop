/**
 * SSE 订阅器（v2：GET /api/event 单全局流，V2Event 信封——type 顶层、数据在
 * data、location.directory 为闸门键；**volatile 契约**：断线丢事件、慢消费者
 * 被断流，重连（reconnecting→connected）必触发全量对账——onReconnected 即此信号）。
 * server 以 15s comment 帧（`: heartbeat`）保活：comment 帧以空 data 回调喂
 * 心跳看门狗（帧到达即连接活着，与 data 帧无关）。
 * 重连策略来源：openbuilder design-sse-reconnect-recovery（退避 1→2→4→8→16→30s、
 * 60s 心跳超时、15s 建连总超时、kick 无条件重置退避、health probe 门控）。
 */
import type { V2Event } from "./api-v2-types"

export type SseStatus = "connecting" | "connected" | "reconnecting" | "stopped"

/**
 * onEvent 的可选信封元数据（design-worktree-sync）：worktree.ready/failed 事件
 * 的目录闸门不能按 directory 判断（新 directory 尚未进本地 sandboxes），须按
 * 信封的 project 字段（projectID）判断"该项目是否打开"。其余事件不读此参数。
 */
export interface SseEventMeta {
  /** v2：metadata.project（信封无独立 project 字段）；worktree.updated 携带 */
  project?: string
  /** v2：信封 created（事件时间戳，session.created 骨架播种用） */
  created?: number
}

export interface SseSubscriberOptions {
  baseUrl: string
  username?: string
  password?: string
  /** 事件以宽松 {type, properties} 形态回调（v2 事件名不在 v1 联合内）；
   *  v1→v2 语义收敛在 app-store handleEvent（M3a 翻译层） */
  onEvent: (
    directory: string,
    event: { type: string; properties: Record<string, unknown> },
    meta?: SseEventMeta,
  ) => void
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
        this.opts.log?.(`sse backoff ${delay}s`)
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

      const url = this.opts.baseUrl + "/api/event"
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
        this.opts.log?.("sse connected")
      }

      es.onerror = () => {
        this.opts.log?.(`sse error (connected=${connected})`)
        settle(connected)
      }

      es.onmessage = (ev: { data: string }) => {
        this.bumpHeartbeat()
        if (!ev.data.trim()) return
        try {
          const wire = JSON.parse(ev.data) as V2Event
          // v1 信封 {directory, payload} 的双发 sync 包装已不存在（v2 单流）；
          // 事件闸门键 = location.directory（无 location 的全局事件缺省 global，
          // 由 handleEvent 的目录闸门丢弃）
          if (wire && typeof wire.type === "string") {
            const directory = wire.location?.directory || "global"
            const meta: SseEventMeta | undefined =
              wire.metadata?.project != null || wire.created != null
                ? {
                    ...(wire.metadata?.project != null
                      ? { project: String(wire.metadata.project) }
                      : {}),
                    ...(wire.created != null ? { created: wire.created } : {}),
                  }
                : undefined
            this.opts.onEvent(
              directory,
              { type: wire.type, properties: (wire.data ?? {}) as never },
              meta,
            )
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

/** 带自定义 header 的 EventSource（原生 EventSource 不支持 header，用 fetch 流实现）。
 *  v2 保活：comment 帧（`: heartbeat`）转空 data 回调喂心跳看门狗。测试导出。 */
export function defaultEventSourceFactory(url: string, init: { headers: Record<string, string> }): EventSourceLike {
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
          // v2 保活：comment 帧（`: heartbeat`，15s）非 data 帧——以空 data 回调
          // 喂心跳看门狗（onmessage 首行 bumpHeartbeat，空 data 早退）
          let sawData = false
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              sawData = true
              shim.onmessage?.({ data: line.slice(5).trimStart() })
            }
          }
          if (!sawData && frame.trim().startsWith(":")) {
            shim.onmessage?.({ data: "" })
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
