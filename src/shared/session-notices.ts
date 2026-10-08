/**
 * 用户后台任务通知（design-subagent-background，2026-10-03；2026-10-08 升格）。
 *
 * 服务异步子会话三路径：命令型 `subagent: true`、工具型 `subagent` tool
 * `background: true`、工具型前台转后台。启动提示由客户端本地合成（前台认领
 * 不插），完成提示由服务端 synthetic（inbox / REST）解析。工具型**前台**
 * （同步阻塞）不算后台任务（判据见 foregroundClaimedChildIds）。
 *
 * 纯逻辑层：解析、状态归一、通知合并都放这里，便于单测；store 只做编排。
 */
import type { Part, Session, ToolPart } from "./api-types"

export type BackgroundTaskState = "completed" | "error" | "cancelled"

export type SessionNoticeKind = "background-started" | "background-converted" | "background-finished"

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

/** part 输入是否声明了后台模式（`subagent` tool 的 `background: true`） */
function isBackgroundInput(part: ToolPart): boolean {
  const input = (part.state as { input?: unknown }).input
  if (!input || typeof input !== "object") return false
  return (input as { background?: unknown }).background === true
}

/**
 * 遍历父会话 tool part 对子会话的**认领**（design-subagent-background 2026-10-08
 * 升格修订）：
 * - 权威：part 的 `metadata.sessionId` / `sessionID`——progress 写入、success
 *   持久化（含 `background:true`，2026-10-07 活体证实）、REST 快照同带；任意
 *   part 状态可判；
 * - 兜底：part 仍 pending/running 且 `input.description` 命中某子会话 title 前缀
 *   （metadata 未写入窗口；与 findChildSession 同口径）。
 */
function forEachClaim(
  parentParts: Part[],
  children: Session[],
  visit: (childId: string, part: ToolPart) => void,
) {
  for (const part of parentParts) {
    if (part.type !== "tool") continue
    const tool = part as ToolPart
    if (!TOOL_FORM_TOOLS.has(tool.tool)) continue
    const authoritative = toolMetadataSessionId(tool)
    if (authoritative) {
      visit(authoritative, tool)
      continue
    }
    const status = tool.state?.status
    if (status !== "pending" && status !== "running") continue
    const desc = toolDescription(tool)
    if (!desc) continue
    for (const child of children) {
      if (child.title && child.title.startsWith(desc)) visit(child.id, tool)
    }
  }
}

/**
 * **同步（前台）认领集**——启动通知的插入闸门与撤回判据：
 * 被认领且认领 part 未声明 `background: true`。后台派生（`background:true`
 * 或运行中转后台）不在此集——它们是合法后台任务，启动通知保留。
 * 含 completed part（转换后/恢复对账后）的认领：SSE 缺口误插的前台启动
 * 提示靠它撤回。
 */
export function foregroundClaimedChildIds(parentParts: Part[], children: Session[]): Set<string> {
  const ids = new Set<string>()
  forEachClaim(parentParts, children, (id, part) => {
    if (!isBackgroundInput(part)) ids.add(id)
  })
  return ids
}

/**
 * **运行中 part 认领集**——任务条排除判据：被 pending/running part 认领的
 * 子会话正由前台 tool part 呈现（同步阻塞），不进任务条。completed part 的
 * 认领不排除——`background:true` 派发完成与前台转后台（`POST …/background`）
 * 都以 part completed + 子会话仍在跑为后台任务运行态。
 */
export function activeClaimedChildIds(parentParts: Part[], children: Session[]): Set<string> {
  const ids = new Set<string>()
  forEachClaim(parentParts, children, (id, part) => {
    const status = part.state?.status
    if (status === "pending" || status === "running") ids.add(id)
  })
  return ids
}

/**
 * **转后台检测集**（③，2026-10-08 对齐裁定）：被**前台**认领（`input.background
 * !== true`）且 part 已 **completed** 的子会话。前台正常完成时子会话先于 part
 * 归 idle（`jobs.block` 语义），调用方以「子会话仍在运行」为闸——命中即
 * 前台阻塞被转后台（`tool.success` 携带 `backgroundResult` 与②同款）。
 * `error` part 不算：前台失败/中断不是转后台。
 */
export function convertedBackgroundChildIds(parentParts: Part[], children: Session[]): Set<string> {
  const ids = new Set<string>()
  forEachClaim(parentParts, children, (id, part) => {
    if (part.state?.status === "completed" && !isBackgroundInput(part)) ids.add(id)
  })
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

/**
 * 转后台提示（③，2026-10-08 对齐裁定）：前台阻塞被 `POST /api/session/{父}/background`
 * 转为后台时本地合成。created 取合成时刻（服务端不暴露转换时间；live 路径
 * part completed 事件晚于转换仅毫秒级）。
 */
export function backgroundConvertedNotice(child: Session, created: number): SessionNotice {
  const label = child.title || child.id
  return {
    id: `bg-convert:${child.id}`,
    kind: "background-converted",
    created,
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

/** 从通知集合中剔除被同步（前台）认领的启动提示——SSE 缺口误插的纠正路径。
 *  后台派生（background:true / 转后台）的认领不在入参集合内，启动提示保留。 */
export function withdrawForegroundStartNotices(
  notices: SessionNotice[],
  foregroundIds: Set<string>,
): SessionNotice[] | null {
  if (foregroundIds.size === 0) return null
  const kept = notices.filter(
    (n) => !(n.kind === "background-started" && n.childID && foregroundIds.has(n.childID)),
  )
  return kept.length === notices.length ? null : kept
}
