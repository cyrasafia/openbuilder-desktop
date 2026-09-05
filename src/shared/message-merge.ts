/**
 * 消息排序与合并——竞态防护层。
 * 参考 openbuilder design-sort-order-race：流式 assistant（time.completed 为空）
 * 始终排最后，完成后才按 created 排序；乐观消息 created 用 maxCreated+1 只是
 * 第一道防线，排序层保底才是可靠防线。
 */
import type { Attachment } from "./attachment-pipeline"
import type { FileRef, Message, MessageWithParts, Part } from "./api-types"
import { isSyntheticTextPart } from "./api-types"

export interface OptimisticMessage {
  optimistic: true
  localId: string
  text: string
  createdAt: number
  /** 引用 chip（design-file-reference §4）：纯文本可能为空（纯引用发送） */
  refs?: FileRef[]
  /** 附件（design-session-attachments §2）：图片缩略图/文件 chip 随乐观上屏 */
  attachments?: Attachment[]
}

export type ChatEntry =
  | { kind: "message"; data: MessageWithParts }
  | { kind: "optimistic"; data: OptimisticMessage }

/**
 * 稳定排序：user 按 created；流式 assistant（time.completed 为空）排最后。
 * 流式保底只在「不早于对方 created」时生效：server 会把中断/半截消息的
 * completed 永远留空（实测 ses_fcdd86e4…/msg_0322894ea：abort 后首个 tool
 * 卡 running、completed 恒 null），若无条件排最后，这类历史半截消息会被
 * 永久压在所有更晚消息之下（展示顺序错乱）。活跃流式 assistant 的 created
 * 必然晚于触发它的 user 消息，created 守卫不影响其排尾。
 */
export function sortMessages(a: MessageWithParts, b: MessageWithParts): number {
  const sa = isStreaming(a.info)
  const sb = isStreaming(b.info)
  const ca = a.info.time.created
  const cb = b.info.time.created
  if (sa && !sb && ca >= cb) return 1
  if (!sa && sb && cb >= ca) return -1
  if (ca !== cb) return ca - cb
  return a.info.id < b.info.id ? -1 : 1
}

function isStreaming(m: Message): boolean {
  return m.role === "assistant" && m.time.completed == null
}

/**
 * 乐观消息锚定 maxCreated+1，与消息走**同一比较器**（含流式 created 守卫）。
 * 不用固定分层（乐观 < 流式、乐观 > 已完成）：分层与 sortMessages 的 created
 * 守卫构成环（O<半截、半截<更晚已完成、已完成<O），环 comparator 下
 * Array.prototype.sort 结果未定义——半截消息会话里每次发送乐观气泡都可能
 * 插进历史中间（§7.12）。锚定值不取 Date.now()：客户端钟与服务器钟可能偏差。
 * 并发发送已放开（design-supplement-send：busy 中补充发送）：乐观与活跃流式
 * 可共存，乐观按时间序排活跃流式之下（锚定 maxCreated+1 天然满足）。
 */
export function sortEntries(entries: ChatEntry[]): ChatEntry[] {
  const maxCreated = entries.reduce(
    (m, e) => (e.kind === "message" ? Math.max(m, e.data.info.time.created) : m),
    0,
  )
  const createdOf = (e: ChatEntry): number =>
    e.kind === "optimistic" ? maxCreated + 1 : e.data.info.time.created
  const streamingOf = (e: ChatEntry): boolean =>
    e.kind === "message" && isStreaming(e.data.info)
  return [...entries].sort((a, b) => {
    if (a.kind === "optimistic" && b.kind === "optimistic") {
      return a.data.createdAt - b.data.createdAt
    }
    const sa = streamingOf(a)
    const sb = streamingOf(b)
    const ca = createdOf(a)
    const cb = createdOf(b)
    if (sa && !sb && ca >= cb) return 1
    if (!sa && sb && cb >= ca) return -1
    if (ca !== cb) return ca - cb
    // created 并列（含毫秒碰撞）：乐观视为最新排后；同为 message 再走稳定 tie-break
    if (a.kind !== b.kind) return a.kind === "optimistic" ? 1 : -1
    if (a.kind === "message" && b.kind === "message") {
      return a.data.info.id < b.data.info.id ? -1 : 1
    }
    return 0
  })
}

/**
 * 回滚暂存期隐藏回滚点起消息（design-message-revert §3.4）。
 * 边界与 server cleanup 一致：`id >= revertMessageID` 隐藏（回滚点本身含在内，
 * 提交时同删）；消息 id 升序可字典序比较（同 ../opencode revert.ts 比较语义）。
 * 乐观消息恒显（未达 server，不构成回滚对象）。纯呈现层：不改动数据。
 */
export function filterRevertedEntries(
  entries: ChatEntry[],
  revertMessageID: string | null,
): ChatEntry[] {
  if (!revertMessageID) return entries
  return entries.filter((e) => e.kind === "optimistic" || e.data.info.id < revertMessageID)
}

/**
 * REST 快照与本地 SSE 状态合并（不清空重置——openbuilder design-message-accumulation：
 * clear()+addAll() 会在 async gap 擦掉新到的 SSE 事件）。
 * - info 取 REST 权威
 * - parts 按 part-id 字段级并集：text 取更长者，tool 状态取非空者，其余 SSE 优先
 */
export function mergeSnapshotIntoMessages(
  local: Map<string, MessageWithParts>,
  snapshot: MessageWithParts[],
): Map<string, MessageWithParts> {
  // 快照入口过滤合成 text part（引用文件内容等 server 注入，isSyntheticTextPart
  // 注释）：本地侧由 SSE handler 同规则过滤，双侧一致保证 mergeParts 并集不回流
  const clean = snapshot.map((m) => ({ info: m.info, parts: m.parts.filter((p) => !isSyntheticTextPart(p)) }))
  const next = new Map(local)
  const snapshotIds = new Set<string>()
  for (const item of clean) {
    snapshotIds.add(item.info.id)
    const prev = next.get(item.info.id)
    if (!prev) {
      next.set(item.info.id, item)
      continue
    }
    next.set(item.info.id, {
      info: item.info,
      parts: mergeParts(prev.parts, item.parts),
    })
  }
  // 窗口区间删除：本地非乐观消息若 created 落在快照 (min, max) 开区间且不在快照中 → 已被删除
  if (snapshot.length >= 2) {
    const minCreated = Math.min(...snapshot.map((m) => m.info.time.created))
    const maxCreated = Math.max(...snapshot.map((m) => m.info.time.created))
    for (const [id, item] of next) {
      if (snapshotIds.has(id)) continue
      const c = item.info.time.created
      if (c > minCreated && c < maxCreated) {
        next.delete(id)
      }
    }
  }
  return next
}

export function mergeParts(restParts: Part[], sseParts: Part[]): Part[] {
  const byId = new Map<string, Part>()
  for (const p of restParts) byId.set(p.id, p)
  for (const p of sseParts) {
    const prev = byId.get(p.id)
    byId.set(p.id, prev ? mergePart(prev, p) : p)
  }
  return [...byId.values()]
}

function mergePart(a: Part, b: Part): Part {
  if (a.type === "text" || a.type === "reasoning") {
    const t1 = a as { text?: string }
    const t2 = b as { text?: string }
    const text = (t2.text?.length ?? 0) >= (t1.text?.length ?? 0) ? t2.text ?? "" : t1.text ?? ""
    return { ...b, text } as Part
  }
  if (a.type === "subtask") {
    // subtask：正文在 prompt（text 恒空），取更完整者（SSE 早事件可能缺 prompt）
    const len = (p: Part) => ((p as { prompt?: string }).prompt?.length ?? 0)
    return (len(b) >= len(a) ? b : a) as Part
  }
  if (a.type === "tool" && b.type === "tool") {
    // tool 状态：SSE 非 pending/空 优先（REST 可能是拉取时刻的旧状态）
    const sseState = b.state as { status?: string; output?: unknown }
    const restState = a.state as { status?: string; output?: unknown }
    const bBetter =
      sseState.status !== "pending" ||
      (sseState.output != null && restState.output == null)
    return { ...b, state: bBetter ? b.state : a.state } as Part
  }
  return b
}
