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
   * 状态快照目录集 = 打开项目全集（与 getOpenedDirectories 同源）。单全局流下
   * 全集每个目录都有事件通道，但断线窗口内丢失的 status 变化（busy→idle 等）
   * 仍需快照纠正——范围若小于会话快照，会出现"会话复活、状态卡 busy"的错位。
   */
  getStatusDirectories: () => string[]
  getActiveSessions: () => Array<{ sessionID: string; directory: string }>
  onSessionsSnapshot: (directory: string, sessions: Session[]) => void
  /** 目录状态快照；fetch 失败时以 null 回调（调用方保留旧值，防 SS-1） */
  onStatusSnapshot: (directory: string, statuses: Record<string, SessionStatusValue> | null) => void
  onMessagesSnapshot: (sessionID: string, messages: MessageWithParts[]) => void
  /**
   * 目录级 pending（授权/问题）回填。permissions/questions 为 null 表示该目录
   * 抓取失败——调用方必须保留本地条目（review-permissions.md R-Perm-2 教训），
   * 只把成功目录当权威。SSE 只在 asked 时推送一次，断线期间的请求全靠这里补齐。
   */
  onPendingSnapshot?: (
    directory: string,
    permissions: Record<string, unknown>[] | null,
    questions: Record<string, unknown>[] | null,
  ) => void
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
    // 在途闸门：client() 变化（disconnect/切 profile/teardown）即丢弃本轮剩余
    // 结果——防止旧连接的迟到快照写回已清空/新连接的状态
    const stale = () => this.d.client() !== client
    // 会话快照逐目录并发受限 + 容错：目录数 = 打开项目全集（单全局流后无
    // 5 条订阅上限，可达几十），无界扇出会让排队请求的 15s 超时从分发起算、
    // 尾部饿死（run-limited 注释记录过的失败模式）；单目录失败跳过回调
    // （保留旧值），不拖垮其余目录
    const dirs = [...new Set(this.d.getOpenedDirectories())]
    await runLimited(dirs, 3, async (dir) => {
      const sessions = await client.listSessions(dir).catch(() => null)
      if (stale()) return
      if (sessions !== null) this.d.onSessionsSnapshot(dir, sessions)
    })
    if (this.d.onPendingSnapshot) {
      // pending 拉取逐目录串行（预算克制）；失败传 null（保留本地），与移动端
      // _backfillPermissions/_backfillQuestions 的 failedDirs 语义一致；单目录
      // 失败不拖垮整个 reconcile
      for (const dir of dirs) {
        const permissions = await client.listPendingPermissions(dir).catch(() => null)
        const questions = await client.listPendingQuestions(dir).catch(() => null)
        if (stale()) return
        this.d.onPendingSnapshot(dir, permissions, questions)
      }
    }
    // 状态快照同规则：失败目录回传 null（保留旧值，防 SS-1）
    const statusDirs = [...new Set(this.d.getStatusDirectories())]
    await runLimited(statusDirs, 3, async (dir) => {
      const statuses = await client.listSessionStatus(dir).catch(() => null)
      if (stale()) return
      this.d.onStatusSnapshot(dir, statuses)
    })
    // 消息快照同样并发受限：全量开 Tab 后 N 可达几十，无界扇出会挤占空闲槽
    // 导致整批超时（一损俱损）。逐项容错同上两阶段：对账在途时会话可能已被
    // 删除（404），失败项跳过回调，不拖垮整轮
    await runLimited(this.d.getActiveSessions(), 4, async ({ sessionID, directory }) => {
      const msgs = await client.listMessages(sessionID, directory, RECONCILE_WINDOW).catch(() => null)
      if (stale()) return
      if (msgs !== null) this.d.onMessagesSnapshot(sessionID, msgs)
    })
  }
}

