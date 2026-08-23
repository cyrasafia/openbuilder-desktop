/**
 * 会话快照合并——按 directory 分域（与消息层 message-merge 同原则：不清空重置，
 * 防 async gap 丢失 SSE 事件）。
 *
 * 实测契约：`GET /session?directory=X` 精确匹配，只返回 directory === X 的会话
 * （项目根快照不含 worktree 会话）。因此每份快照只对**同 directory** 的本地
 * 会话拥有权威：REST 覆盖与"updated 窗口开区间删除"审判均不得跨 directory——
 * 否则项目根快照的窗口会把 SSE 已收到的 worktree 会话误判为已删除
 * （2026-08-23 联调实测病灶）。
 */
import type { Session } from "./api-types"

export function mergeSessionsSnapshot(
  local: Map<string, Session>,
  directory: string,
  snapshot: Session[],
): Map<string, Session> {
  const next = new Map(local)
  const snapIds = new Set<string>()
  for (const s of snapshot) {
    snapIds.add(s.id)
    next.set(s.id, s)
  }
  // 窗口区间删除（仅本 directory）：本地同目录会话 updated 落在快照 (min, max)
  // 开区间且不在快照 id 集 → 已删除；<2 条无开区间，保守保留（catch 兜底的空
  // 快照不得清空本地状态）
  if (snapshot.length >= 2) {
    const minUpdated = Math.min(...snapshot.map((s) => s.time.updated))
    const maxUpdated = Math.max(...snapshot.map((s) => s.time.updated))
    for (const [id, s] of next) {
      if (snapIds.has(id)) continue
      if (s.directory !== directory) continue
      if (s.time.updated > minUpdated && s.time.updated < maxUpdated) next.delete(id)
    }
  }
  return next
}
