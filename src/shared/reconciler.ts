/**
 * 对账引擎：SSE 断连恢复后重拉快照覆盖本地状态。
 * 参考 openbuilder design-incremental-reconcile（窗口 K=100、互斥锁、
 * debounce）与 design-sse-reconnect-recovery（reconnecting→connected 触发）。
 */
import type { OpencodeEvent, Session } from "./api-types"
import type { RestClient } from "./rest-client"
import { mergeSnapshotIntoMessages } from "./message-merge"
import type { MessageWithParts } from "./api-types"

export interface ReconcilerDeps {
  client: () => RestClient
  getOpenedDirectories: () => string[]
  getActiveSessions: () => Array<{ sessionID: string; directory: string }>
  onSessionsSnapshot: (directory: string, sessions: Session[]) => void
  onMessagesSnapshot: (sessionID: string, messages: MessageWithParts[]) => void
  onReconcileStateChange: (active: boolean) => void
  log?: (...args: unknown[]) => void
}

const RECONCILE_WINDOW = 100
const DEBOUNCE_MS = 800

export class Reconciler {
  private running = false
  private pendingKick = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private d: ReconcilerDeps

  constructor(deps: ReconcilerDeps) {
    this.d = deps
  }

  /** 请求对账（debounce 800ms，合并短时间内的多次触发） */
  request() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.run()
    }, DEBOUNCE_MS)
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.pendingKick = true
      return
    }
    this.running = true
    this.d.onReconcileStateChange(true)
    try {
      for (;;) {
        this.pendingKick = false
        await this.reconcileOnce()
        if (!this.pendingKick) break
      }
    } catch (e) {
      this.d.log?.("reconcile failed", e)
    } finally {
      this.running = false
      this.d.onReconcileStateChange(false)
    }
  }

  private async reconcileOnce() {
    const dirs = [...new Set(this.d.getOpenedDirectories())]
    await Promise.all(
      dirs.map(async (dir) => {
        const sessions = await this.d.client().listSessions(dir)
        this.d.onSessionsSnapshot(dir, sessions)
      }),
    )
    await Promise.all(
      this.d.getActiveSessions().map(async ({ sessionID, directory }) => {
        const msgs = await this.d.client().listMessages(sessionID, directory, RECONCILE_WINDOW)
        this.d.onMessagesSnapshot(sessionID, msgs)
      }),
    )
  }
}

/** 事件闸门：按打开项目集合过滤（design-layout：关闭项目事件一律忽略） */
export function eventGate(
  event: OpencodeEvent,
  openedDirectories: Set<string>,
): boolean {
  const props = event.properties as Record<string, unknown>
  const dir = typeof props.directory === "string" ? props.directory : null
  if (dir != null) return openedDirectories.has(dir)
  // session/message 事件经 directory 归属判断（由调用方在 store 层做 sessionID→project 映射）
  return true
}
