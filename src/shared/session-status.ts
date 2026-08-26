/**
 * 会话状态（busy/idle/retry）合并与推断——纯逻辑层。
 * 参考 openbuilder design-session-status（双层修复）+ review-session-status
 * （SS-1 回归：`clear()+addAll()` 在某目录 fetch 失败返回 {} 时把已知 busy 全误清）。
 *
 * 状态只在内存（不落盘）；合并语义：
 * - 成功目录 fresh 权威：返回里缺该会话 ⇒ idle（不卡 busy）；
 * - 失败目录保留旧值（调用方不调本函数，防 SS-1）；
 * - "该目录来源"的判定基于来源索引（事件流目录 / REST 查询目录），不依赖会话元数据。
 */
import type { Message, SessionStatusValue } from "./api-types"

export type StatusSourceIndex = Map<string, string>

/**
 * 按目录覆盖合并一份 REST 状态快照（仅对来自该目录的条目拥有权威）。
 * 返回新 Map（immutable 风格，与 session-merge/message-merge 一致）。
 */
export function mergeStatusSnapshot(
  status: Map<string, SessionStatusValue>,
  sources: StatusSourceIndex,
  directory: string,
  fresh: Record<string, SessionStatusValue>,
): { status: Map<string, SessionStatusValue>; sources: StatusSourceIndex } {
  const nextStatus = new Map(status)
  const nextSources = new Map(sources)
  const freshIds = new Set(Object.keys(fresh))
  for (const [sid, st] of Object.entries(fresh)) {
    if (!st?.type) continue
    if (st.type === "idle") {
      nextStatus.delete(sid)
      nextSources.delete(sid)
    } else {
      nextStatus.set(sid, st)
      nextSources.set(sid, directory)
    }
  }
  // covered ⇒ idle：记录来源为本目录、但 fresh 里缺席 ⇒ 已结束（server 侧 idle 即删除条目）
  for (const [sid, dir] of nextSources) {
    if (dir === directory && !freshIds.has(sid)) {
      nextStatus.delete(sid)
      nextSources.delete(sid)
    }
  }
  return { status: nextStatus, sources: nextSources }
}

/** 终态 finish 判定（D-SS-B：stop/error 是终态；tool-calls 中间步骤、null 生成中，均不触发） */
export function isTerminalFinish(finish: unknown): boolean {
  return finish === "stop" || finish === "error"
}

/**
 * 消息 finish 推断（design-typing-indicator §4 来源 5）：
 * 末条 assistant 且 finish 为终态 ⇒ 该会话应置 idle；其余情况不触发。
 * 输入应为排序后的消息（流式 assistant 排最后，见 message-merge sortMessages）。
 */
export function inferIdleFromMessages(messages: Message[]): boolean {
  const last = messages[messages.length - 1]
  return last?.role === "assistant" && isTerminalFinish(last.finish)
}

/**
 * 报错终局推断（design-error-message §3.4）：末条消息是携带非中止错误的
 * assistant ⇒ 会话以报错结束（静态红点）。中止（MessageAbortedError）是用户
 * 主动停止，不算错误；错误名是 server NamedError 契约（processor halt 路径）。
 */
export function inferFailedFromMessages(messages: Message[]): boolean {
  const last = messages[messages.length - 1]
  if (last?.role !== "assistant") return false
  const err = last.error as { name?: string } | null | undefined
  if (!err) return false
  return err.name !== "MessageAbortedError"
}
