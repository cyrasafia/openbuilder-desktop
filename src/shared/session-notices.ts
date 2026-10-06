/**
 * 用户后台任务通知（design-subagent-background，2026-10-03）。
 *
 * 只服务命令型 `subagent: true` 的异步子会话：启动提示由客户端本地合成，
 * 完成提示由服务端 synthetic（inbox / REST）解析。工具型 `task`/`subagent`
 * tool part 不算后台任务。
 *
 * 纯逻辑层：解析、状态归一、通知合并都放这里，便于单测；store 只做编排。
 */
import type { Part, Session, ToolPart } from "./api-types"

export type BackgroundTaskState = "completed" | "error" | "cancelled"

export type SessionNoticeKind = "background-started" | "background-finished"

export interface SessionNotice {
  /** 启动 = `bg-start:<childID>`；完成 = synthetic 消息 id（`msg_…`） */
  id: string
  kind: SessionNoticeKind
  created: number
  label: string
  /** 仅 background-finished */
  state?: BackgroundTaskState
  /** 后台任务子会话（查看入口）；解析不到时缺省 */
  childID?: string
}

/** 承载工具型子会话的 tool 名（task = 主 agent 调用；subagent = v2 独立工具） */
const TOOL_FORM_TOOLS = new Set(["task", "subagent"])

/** tool part 的 `metadata.sessionId`（兼容 `sessionID` 大小写） */
export function toolMetadataSessionId(part: ToolPart): string | undefined {
  const state = part.state as { metadata?: Record<string, unknown> }
  const md = state?.metadata
  const sid = md?.sessionId ?? md?.sessionID
  return typeof sid === "string" && sid.length > 0 ? sid : undefined
}

/**
 * 工具型子会话 id 集合（design-subagent-background 识别）：
 * - 权威：tool part 的 `metadata.sessionId` / `sessionID`；
 * - 兜底：part 仍 pending/running 且 `input.description` 命中某子会话 title 前缀
 *   （刚发起、metadata 未写入的窗口；与 findChildSession 同口径）。
 *
 * 备注：该判据同时被 D1（任务条排除）与 D3（启动提示撤回）消费，二者必须一致。
 */
export function toolFormChildIds(parentParts: Part[], children: Session[]): Set<string> {
  const ids = new Set<string>()
  for (const part of parentParts) {
    if (part.type !== "tool") continue
    const tool = part as ToolPart
    if (!TOOL_FORM_TOOLS.has(tool.tool)) continue
    const authoritative = toolMetadataSessionId(tool)
    if (authoritative) {
      ids.add(authoritative)
      continue
    }
    const status = tool.state?.status
    if (status !== "pending" && status !== "running") continue
    const desc = toolDescription(tool)
    if (!desc) continue
    for (const child of children) {
      if (child.title && child.title.startsWith(desc)) ids.add(child.id)
    }
  }
  return ids
}

function toolDescription(part: ToolPart): string {
  const input = (part.state as { input?: unknown }).input
  if (!input || typeof input !== "object") return ""
  const desc = (input as { description?: unknown }).description
  return typeof desc === "string" ? desc : ""
}

/** 启动提示（D3）：本地合成，id 稳定以幂等。 */
export function backgroundStartedNotice(child: Session): SessionNotice {
  const label = child.title || child.id
  return {
    id: `bg-start:${child.id}`,
    kind: "background-started",
    created: child.time.created,
    label,
    childID: child.id,
  }
}

/** synthetic state 归一（D4）：主枚举 completed/error/cancelled + 防御性别名。 */
export function normalizeBackgroundState(raw: unknown): BackgroundTaskState {
  if (raw === "error" || raw === "failed") return "error"
  if (raw === "cancelled" || raw === "interrupted") return "cancelled"
  return "completed"
}

/** 解析 synthetic 文本里的 `<subagent sessionID="…" state="…" description="…">` */
function parseSubagentTag(text: string): { description?: string; sessionID?: string } {
  const tag = /<subagent\b([^>]*)>/i.exec(text)
  if (!tag) return {}
  const attrs = tag[1]
  const pick = (name: string): string | undefined => {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs)
    return m?.[1] || undefined
  }
  return { description: pick("description"), sessionID: pick("sessionID") }
}

/**
 * 完成提示（D4）：从 synthetic payload 解析。
 * `metadata.source != "subagent"` 返回 null（其它 synthetic 不进通知流）。
 */
export function subagentSyntheticNotice(
  id: string,
  created: number,
  payload: { text?: string; description?: string; metadata?: Record<string, unknown> } | undefined,
): SessionNotice | null {
  const metadata = payload?.metadata
  if (!metadata || metadata.source !== "subagent") return null
  const text = typeof payload?.text === "string" ? payload.text : ""
  const tag = parseSubagentTag(text)
  const childID =
    typeof metadata.childID === "string" && metadata.childID
      ? metadata.childID
      : tag.sessionID
  const agent = typeof metadata.agent === "string" ? metadata.agent : undefined
  // label 兜底链：标签 description → payload.description → agent → childID（review 三轮 #4）
  const label = tag.description || payload?.description || agent || childID || ""
  return {
    id,
    kind: "background-finished",
    created,
    label,
    state: normalizeBackgroundState(metadata.state),
    childID,
  }
}

/**
 * 通知表按 id 合并（去重）并按 created 排序。
 * 返回 null = 无变化（调用方可跳过 emit）；否则返回新数组。
 */
export function mergeNotices(
  existing: SessionNotice[] | undefined,
  incoming: SessionNotice[],
): SessionNotice[] | null {
  if (incoming.length === 0 && !existing) return null
  const byId = new Map<string, SessionNotice>()
  for (const n of existing ?? []) byId.set(n.id, n)
  const before = byId.size
  for (const n of incoming) byId.set(n.id, n)
  const changed =
    byId.size !== before ||
    incoming.some((n) => {
      const prev = existing?.find((e) => e.id === n.id)
      return !prev || prev.label !== n.label || prev.state !== n.state || prev.created !== n.created
    })
  if (!changed) return null
  return [...byId.values()].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1))
}

/** 从通知集合中剔除已被工具型 tool part 认领的启动提示（D3 竞态收敛）。 */
export function withdrawToolFormStartNotices(
  notices: SessionNotice[],
  toolFormIds: Set<string>,
): SessionNotice[] | null {
  if (toolFormIds.size === 0) return null
  const kept = notices.filter(
    (n) => !(n.kind === "background-started" && n.childID && toolFormIds.has(n.childID)),
  )
  return kept.length === notices.length ? null : kept
}
