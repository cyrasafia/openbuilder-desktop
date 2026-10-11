/**
 * 未读判定（design-unread-marker §2.1）——纯服务端水位派生，无本地「已读」事实。
 *
 * ```
 * unread ⟺ time.idle !== undefined && (time.viewed === undefined || time.idle > time.viewed)
 * ```
 *
 * `time.idle` = 最近一次 run 终态时刻；`time.viewed` = 已读水位（标记已读走
 * `POST /api/session/:id/view`，服务端 `viewed = max(idle, viewed)` 单调）。
 */
import type { Session } from "./api-types"

export function isSessionUnread(session: Pick<Session, "time">): boolean {
  const { idle, viewed } = session.time
  return idle !== undefined && (viewed === undefined || idle > viewed)
}
