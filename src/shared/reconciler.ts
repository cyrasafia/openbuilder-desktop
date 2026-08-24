/**
 * 对账引擎：SSE 断连恢复后重拉快照覆盖本地状态。
 * 参考 openbuilder design-incremental-reconcile（窗口 K=100、互斥锁、
 * debounce）与 design-sse-reconnect-recovery（reconnecting→connected 触发）。
 */
import type { Session, SessionStatusValue } from "./api-types"
import type { RestClient } from "./rest-client"
import { mergeSnapshotIntoMessages } from "./message-merge"
import type { MessageWithParts } from "./api-types"
import { runLimited } from "./run-limited"

export interface ReconcilerDeps {
  /** 连接拆除后返回 null（reconcile 直接放弃，不再非空断言） */
  client: () => RestClient | null
  getOpenedDirectories: () => string[]
  /**
   * 状态快照目录集 = 打开项目全集（root ∪ sandboxes）。非当前 worktree 无 SSE
   * 事件通道（订阅集合仅含当前 scope），其 busy/retry 只能靠对账快照纠正——
   * 若与订阅集合一致，连上的 busy 会话结束后 dots 永久卡亮。
   */
  getStatusDirectories: () => string[]
  getActiveSessions: () => Array<{ sessionID: string; directory: string }>
  onSessionsSnapshot: (directory: string, sessions: Session[]) => void
  /** 目录状态快照；fetch 失败时以 null 回调（调用方保留旧值，防 SS-1） */
  onStatusSnapshot: (directory: string, statuses: Record<string, SessionStatusValue> | null) => void
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
    const client = this.d.client()
    if (!client) return
    const dirs = [...new Set(this.d.getOpenedDirectories())]
    await Promise.all(
      dirs.map(async (dir) => {
        const sessions = await client.listSessions(dir)
        this.d.onSessionsSnapshot(dir, sessions)
      }),
    )
    // 状态快照逐目录容错：失败目录回传 null（保留旧值），不拖垮其余目录。
    // 并发受限 2（浏览器对同 host 连接上限 6，5 条 SSE 常驻后仅 ~1 空闲——
    // 无限扇出会让排队请求从分发起算超时、尾部饿死，见 run-limited 注释）
    const statusDirs = [...new Set(this.d.getStatusDirectories())]
    await runLimited(statusDirs, 2, async (dir) => {
      const statuses = await client.listSessionStatus(dir).catch(() => null)
      this.d.onStatusSnapshot(dir, statuses)
    })
    // 消息快照同样并发受限（3）：全量开 Tab 后 N 可达几十，Promise.all 无界
    // 扇出会挤占 ~1 个空闲槽导致整批超时（一损俱损）
    await runLimited(this.d.getActiveSessions(), 3, async ({ sessionID, directory }) => {
      const msgs = await client.listMessages(sessionID, directory, RECONCILE_WINDOW)
      this.d.onMessagesSnapshot(sessionID, msgs)
    })
  }
}

