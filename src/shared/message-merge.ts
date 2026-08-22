/**
 * 消息排序与合并——竞态防护层。
 * 参考 openbuilder design-sort-order-race：流式 assistant（time.completed 为空）
 * 始终排最后，完成后才按 created 排序；乐观消息 created 用 maxCreated+1 只是
 * 第一道防线，排序层保底才是可靠防线。
 */
import type { Message, MessageWithParts, Part } from "./api-types"

export interface OptimisticMessage {
  optimistic: true
  localId: string
  text: string
  createdAt: number
}

export type ChatEntry =
  | { kind: "message"; data: MessageWithParts }
  | { kind: "optimistic"; data: OptimisticMessage }

/** 稳定排序：user 按 created；assistant 未完成排最后 */
export function sortMessages(a: MessageWithParts, b: MessageWithParts): number {
  const sa = isStreaming(a.info)
  const sb = isStreaming(b.info)
  if (sa && !sb) return 1
  if (!sa && sb) return -1
  const ca = a.info.time.created
  const cb = b.info.time.created
  if (ca !== cb) return ca - cb
  return a.info.id < b.info.id ? -1 : 1
}

function isStreaming(m: Message): boolean {
  return m.role === "assistant" && m.time.completed == null
}

/** 乐观消息排在流式 assistant 之前、所有已完成消息之后 */
export function sortEntries(entries: ChatEntry[]): ChatEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind === "optimistic" && b.kind === "optimistic") {
      return a.data.createdAt - b.data.createdAt
    }
    if (a.kind === "optimistic") {
      // 乐观消息永远不在流式 assistant 之后
      return b.kind === "message" && isStreaming(b.data.info) ? -1 : 1
    }
    if (b.kind === "optimistic") {
      return a.kind === "message" && isStreaming(a.data.info) ? 1 : -1
    }
    return sortMessages(a.data, b.data)
  })
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
  const next = new Map(local)
  const snapshotIds = new Set<string>()
  for (const item of snapshot) {
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
