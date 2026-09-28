/**
 * 对账引擎：SSE 断连恢复后重拉快照覆盖本地状态。
 * 参考 openbuilder design-incremental-reconcile（窗口 K=100、互斥锁、
 * debounce）与 design-sse-reconnect-recovery（reconnecting→connected 触发）。
 */
import type { Session, SessionStatusValue } from "./api-types"
import type { RestClient } from "./rest-client"
import type { RestClientV2 } from "./rest-client-v2"
import { toInternalMessages, toInternalSession as toInternalSessionForReconcile } from "./v2-adapter"
import { mergeSnapshotIntoMessages } from "./message-merge"
import type { MessageWithParts } from "./api-types"
import { runLimited } from "./run-limited"

export interface ReconcilerDeps {
  /** 连接拆除后返回 null（reconcile 直接放弃，不再非空断言） */
  client: () => RestClient | null
  /** v2 client（M6：消息快照换绑——v1 listMessages 在 v2 server 全 404） */
  clientV2: () => RestClientV2 | null
  getOpenedDirectories: () => string[]
  getActiveSessions: () => Array<{ sessionID: string; directory: string }>
  onSessionsSnapshot: (directory: string, sessions: Session[]) => void
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
    const clientV2 = this.d.clientV2()
    if (!clientV2) return
    // 在途闸门：client() 变化（disconnect/切 profile/teardown）即丢弃本轮剩余
    // 结果——防止旧连接的迟到快照写回已清空/新连接的状态
    const stale = () => this.d.client() !== client || this.d.clientV2() !== clientV2
    // 会话快照逐目录并发受限 + 容错：目录数 = 打开项目全集（单全局流后无
    // 5 条订阅上限，可达几十），无界扇出会让排队请求的 15s 超时从分发起算、
    // 尾部饿死（run-limited 注释记录过的失败模式）；单目录失败跳过回调
    // （保留旧值），不拖垮其余目录
    const dirs = [...new Set(this.d.getOpenedDirectories())]
    await runLimited(dirs, 3, async (dir) => {
      // M6：消息快照换绑 v2（v1 listMessages 在 v2 server 全 404——typed union
      // 经 toInternalMessages 收敛为内部形状，与 loadSessionMessages 同管道）
      const page = await clientV2.listSessions({ directory: dir, limit: 200 }).catch(() => null)
      if (stale()) return
      if (page !== null) this.d.onSessionsSnapshot(dir, page.data.map((s) => toInternalSessionForReconcile(s)))
    })
    if (this.d.onPendingSnapshot) {
      // M6：pending 拉取仍走 v1 端点（v2 的 permission/form 待办端点在 M6 决策）——
      // v2 server 上全 404 → null（保留本地），无功能但无阻塞
      for (const dir of dirs) {
        const permissions = await client.listPendingPermissions(dir).catch(() => null)
        const questions = await client.listPendingQuestions(dir).catch(() => null)
        if (stale()) return
        this.d.onPendingSnapshot(dir, permissions, questions)
      }
    }
    // 消息快照（M6：换绑 v2——typed union + cursor，与 loadSessionMessages 同管道）
    await runLimited(this.d.getActiveSessions(), 4, async ({ sessionID, directory }) => {
      const page = await clientV2.listMessagesPage(sessionID, { limit: RECONCILE_WINDOW }).catch(() => null)
      if (stale()) return
      if (page !== null) this.d.onMessagesSnapshot(sessionID, page.entries)
    })
  }
}

