/**
 * 消息排序与合并——竞态防护层。
 * 参考 openbuilder design-sort-order-race：流式 assistant（time.completed 为空）
 * 始终排最后，完成后才按 created 排序；乐观消息 created 用 maxCreated+1 只是
 * 第一道防线，排序层保底才是可靠防线。
 */
import type { Attachment } from "./attachment-pipeline"
import type { FileRef, Message, MessageWithParts, Part } from "./api-types"
import { isSyntheticTextPart } from "./api-types"
import type { SessionNotice } from "./session-notices"

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
  | { kind: "notice"; data: SessionNotice }

/** created 并列时的 kind 秩（design-subagent-background D5）：显式定义且反对称。
 *  现有二值比较器加入第三种 kind 后会退化为非自洽（sort 结果未定义）。 */
const KIND_RANK: Record<ChatEntry["kind"], number> = { message: 0, notice: 1, optimistic: 2 }

/** 已落地条目（message/notice）的排序时间；乐观锚定另见 sortEntries 内闭包。
 *  optimistic 由调用方排除（reduce 跳过、createdOf 先拦截），落 0 占位。 */
function settledCreated(entry: ChatEntry): number {
  if (entry.kind === "message") return entry.data.info.time.created
  if (entry.kind === "notice") return entry.data.created
  return 0
}

function entryId(entry: ChatEntry): string {
  if (entry.kind === "message") return entry.data.info.id
  if (entry.kind === "optimistic") return entry.data.localId
  return entry.data.id
}

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
    (m, e) => (e.kind === "optimistic" ? m : Math.max(m, settledCreated(e))),
    0,
  )
  // 乐观锚定 maxCreated+1（沿用旧语义，见上方注释）
  const createdOf = (e: ChatEntry): number =>
    e.kind === "optimistic" ? maxCreated + 1 : settledCreated(e)
  const streamingOf = (e: ChatEntry): boolean =>
    e.kind === "message" && isStreaming(e.data.info)
  return [...entries].sort((a, b) => {
    const sa = streamingOf(a)
    const sb = streamingOf(b)
    const ca = createdOf(a)
    const cb = createdOf(b)
    if (sa && !sb && ca >= cb) return 1
    if (!sa && sb && cb >= ca) return -1
    if (ca !== cb) return ca - cb
    // created 并列（含毫秒碰撞）：先按 kind 秩（反对称，见 KIND_RANK），
    // 同 kind 内乐观按 createdAt、其余按 id 字典序稳定 tie-break
    const ra = KIND_RANK[a.kind]
    const rb = KIND_RANK[b.kind]
    if (ra !== rb) return ra - rb
    if (a.kind === "optimistic" && b.kind === "optimistic") {
      return a.data.createdAt - b.data.createdAt
    }
    const ia = entryId(a)
    const ib = entryId(b)
    return ia < ib ? -1 : ia > ib ? 1 : 0
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
  // 通知不参与回滚隐藏（design-subagent-background）：客户端 bg-start id 与服务端
  // msg_ id 不可比，只隐藏消息；乐观消息亦恒显
  return entries.filter((e) => e.kind !== "message" || e.data.info.id < revertMessageID)
}

/**
 * REST 快照与本地 SSE 状态合并（不清空重置——openbuilder design-message-accumulation：
 * clear()+addAll() 会在 async gap 擦掉新到的 SSE 事件）。
 * - info 取 REST 权威
 * - parts 按 part-id 字段级并集：text 取更长者，tool 状态见 mergePart（快照
 *   非 pending 优先），其余取快照
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

/** parts 按 id 并集：第二参数（快照）覆盖/合并第一参数（本地）。
 *  参数名正名（2026-10-08，reviewer 附注）：唯一调用点 mergeSnapshotIntoMessages
 *  以（本地 SSE 累积, REST 快照页）传入——历史命名 restParts/sseParts 与实际
 *  相反，行为不变，仅消除误导。 */
export function mergeParts(localParts: Part[], snapshotParts: Part[]): Part[] {
  const byId = new Map<string, Part>()
  for (const p of localParts) byId.set(p.id, p)
  for (const p of snapshotParts) {
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
    // tool 状态：b=快照（REST）非 pending 优先（快照 pending 视为拉取窗口
    // 残影，回退本地）。已知代价（design-subagent-background 契约表，
    // 2026-10-08 正名）：运行中 part 的 live progress metadata 会被快照的
    // metadata:{} 覆盖——认领判据由 input.sessionID（续跑）与 success/failed
    // 持久化 metadata 兜住，兜底 description 前缀不依赖 metadata
    const bState = b.state as { status?: string; output?: unknown }
    const aState = a.state as { status?: string; output?: unknown }
    const bBetter =
      bState.status !== "pending" ||
      (bState.output != null && aState.output == null)
    return { ...b, state: bBetter ? b.state : a.state } as Part
  }
  return b
}
