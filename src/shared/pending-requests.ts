/**
 * 待处理人机交互请求（授权 permission / 问题 question）的归一化与指示器投影。
 * 参考移动端：openbuilder models.dart Permission/QuestionRequest.fromJson
 * （permission ?? action ?? type、patterns ?? resources 的兼容映射）与
 * design-agent-status-indicator.md（pending > busy 的确定性显示投影）。
 *
 * directory 是回复路由参数（design-question-card-reply.md：opencode 的
 * pending 按 directory 隔离在 per-instance 内存 Map，reply 不带 directory
 * 会 404）——在事件/回填到达时捕获，不依赖会话信息已知。
 */

/** 权限请求（per_/sse 会话最多一张，Map 以 sessionID 为 key，与移动端一致） */
export interface PendingPermission {
  /** per_* */
  id: string
  sessionID: string
  /** permission ?? action ?? type（v1/v2 字段名兼容） */
  type: string
  patterns: string[]
  metadata: Record<string, unknown> | null
  always: string[]
  /** 捕获自 SSE 订阅目录 / 回填查询目录（reply 路由用） */
  directory: string
}

export interface PendingQuestionOption {
  label: string
  description: string
}

export interface PendingQuestionInfo {
  question: string
  header: string
  options: PendingQuestionOption[]
  multiple: boolean
  custom: boolean
}

/** 问题请求（que_*，Map 以问题 id 为 key；一个会话可能多张排队） */
export interface PendingQuestion {
  /** que_* */
  id: string
  sessionID: string
  questions: PendingQuestionInfo[]
  directory: string
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

/** 权限事件/回填负载 → PendingPermission；id/sessionID 缺失返回 null（丢弃） */
export function normalizePermission(
  props: Record<string, unknown> | undefined,
  directory: string,
): PendingPermission | null {
  if (!props) return null
  const id = str(props.id)
  const sessionID = str(props.sessionID)
  if (!id || !sessionID) return null
  const type = str(props.permission) || str(props.action) || str(props.type)
  const metadata =
    props.metadata && typeof props.metadata === "object"
      ? (props.metadata as Record<string, unknown>)
      : null
  return {
    id,
    sessionID,
    type,
    patterns: strArray(props.patterns).length > 0 ? strArray(props.patterns) : strArray(props.resources),
    metadata,
    always: strArray(props.always),
    directory,
  }
}

/** 问题事件/回填负载 → PendingQuestion；id/sessionID/questions 缺失返回 null */
export function normalizeQuestion(
  props: Record<string, unknown> | undefined,
  directory: string,
): PendingQuestion | null {
  if (!props) return null
  const id = str(props.id)
  const sessionID = str(props.sessionID)
  if (!id || !sessionID) return null
  const questions = Array.isArray(props.questions)
    ? props.questions
        .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
        .map((q) => ({
          question: str(q.question),
          header: str(q.header),
          options: Array.isArray(q.options)
            ? q.options
                .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
                .map((o) => ({ label: str(o.label), description: str(o.description) }))
            : [],
          multiple: q.multiple === true,
          custom: q.custom === true,
        }))
    : []
  if (questions.length === 0) return null
  return { id, sessionID, questions, directory }
}

/**
 * external_directory 权限的可读路径（best-effort，移动端 l10n_ext.dart 同源）：
 * metadata.parentDir → metadata.filepath → 首个 pattern（去尾部 /*）。
 */
export function externalDirectoryPath(p: PendingPermission): string | null {
  const meta = p.metadata
  const parentDir = meta && typeof meta.parentDir === "string" ? meta.parentDir : ""
  if (parentDir) return parentDir
  const filepath = meta && typeof meta.filepath === "string" ? meta.filepath : ""
  if (filepath) return filepath
  for (const pat of p.patterns) {
    if (pat.endsWith("/*")) return pat.slice(0, -2)
    if (pat) return pat
  }
  return null
}

/** bash/shell 权限的完整命令（server 在 metadata.command 提供） */
export function permissionCommand(p: PendingPermission): string | null {
  const cmd = p.metadata && typeof p.metadata.command === "string" ? p.metadata.command : ""
  return cmd || null
}

/**
 * 会话状态点的确定性投影（design-agent-status-indicator.md）：
 * 有待处理人机交互 = waiting（琥珀、静态、优先级最高，busy 底层事实保留）；
 * 否则流式中 = running；否则 idle。
 */
export type SessionDotState = "waiting" | "running" | "idle"

export function sessionDotState(pendingCount: number, busy: boolean): SessionDotState {
  if (pendingCount > 0) return "waiting"
  return busy ? "running" : "idle"
}

/** 权限 map 的内容签名（sessionID+权限 id 对）：捕获同数量换血（他端答掉一张、
 *  server 又发一张新的）——仅比 size 会漏检，导致卡片不刷新 */
function permissionSignature(map: Map<string, PendingPermission>): string {
  return [...map.entries()]
    .map(([sid, p]) => `${sid}>${p.id}`)
    .sort()
    .join("|")
}

function questionSignature(map: Map<string, PendingQuestion>): string {
  return [...map.keys()].sort().join("|")
}

/**
 * 将目录级 pending 快照合并进本地两份 Map（对账回填）。
 * null 表示该类别在该目录抓取失败——保留本地条目（review-permissions.md
 * R-Perm-2/R-Perm-4 教训：成功目录权威覆盖、失败目录不得误清 SSE 已送达的
 * 条目）；成功目录里已不在快照中的本地条目视为已在他端处理，删除。
 * 变化检测按内容签名（id 对集合）而非数量。返回是否有变化（调用方据此
 * 决定是否 notify）。
 */
export function mergePendingSnapshot(
  permissions: Map<string, PendingPermission>,
  questions: Map<string, PendingQuestion>,
  directory: string,
  freshPermissions: Record<string, unknown>[] | null,
  freshQuestions: Record<string, unknown>[] | null,
): boolean {
  const prevPermSig = permissionSignature(permissions)
  const prevQSig = questionSignature(questions)
  if (freshPermissions) {
    for (const [sid, p] of [...permissions]) {
      if (p.directory === directory && !freshPermissions.some((x) => str(x.id) === p.id)) {
        permissions.delete(sid)
      }
    }
    for (const x of freshPermissions) {
      const p = normalizePermission(x, directory)
      if (p) permissions.set(p.sessionID, p)
    }
  }
  if (freshQuestions) {
    for (const [qid, q] of [...questions]) {
      if (q.directory === directory && !freshQuestions.some((x) => str(x.id) === qid)) {
        questions.delete(qid)
      }
    }
    for (const x of freshQuestions) {
      const q = normalizeQuestion(x, directory)
      if (q) questions.set(q.id, q)
    }
  }
  return permissionSignature(permissions) !== prevPermSig || questionSignature(questions) !== prevQSig
}
