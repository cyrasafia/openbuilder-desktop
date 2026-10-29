/**
 * 待处理人机交互请求（授权 permission / 问题 form 卡）的归一化与指示器投影。
 * 参考移动端：openbuilder models.dart Permission/FormInfo.fromJson 与
 * design-agent-status-indicator.md（pending > busy 的确定性显示投影）。
 *
 * directory 现仅作事件闸门/回填归属键（v2 reply 端点按 id 寻址，无 directory
 * 参数）；在事件/回填到达时捕获，不依赖会话信息已知。
 */
import type { SessionStatusValue } from "./api-types"
import type { V2FormInfo, V2FormValue } from "./api-v2-types"

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
  /** 捕获自 SSE 订阅目录 / 回填查询目录（v1 reply 路由用；v2 端点无 directory） */
  directory: string
}

/**
 * 问题卡（v2 form 体系，M6a）：frm_* 表单投影。fields 是六型 Form.Field 的
 * UI 归一化——选项式（select/multiselect）、boolean（UI 合成是/否选项）、
 * 输入式（text/number）、external（授权确认，无输入 UI）。
 *
 * hidden/external 字段**保留**（2026-10-29 T5，对齐移动端
 * todo-form-card-v2-parity T2/T3 三层方案）：v2.0.26 活体实测——hidden+
 * required 缺键/空值 400（Missing required form field）、external 缺键 400
 * （External form field must be acknowledged），无差别剔除会让混合表单
 * 提交必现 400、全 hidden/external 卡整卡丢弃（会话永久 pending）。三层：
 * 模型层保留（本层）→ UI 层跳过（formVisibleSteps）→ answer 层补键
 * （buildFormAnswer）。
 */
export type PendingQuestionFieldKind =
  | "select"
  | "multiselect"
  | "boolean"
  | "text"
  | "number"
  | "external"

export interface PendingQuestionOption {
  /** answer 回传值（v2 Form.Option.value；v1 question 回传 label，勿混淆） */
  value: string
  label: string
  description: string
}

export interface PendingQuestionField {
  /** Form.Field.key——answer 的键 */
  key: string
  /** field.title（问题文本） */
  question: string
  /** field.description */
  description: string
  kind: PendingQuestionFieldKind
  options: PendingQuestionOption[]
  placeholder: string
  /** Form.Field.required——输入步的空值门控（选项步未选恒禁前进，Q-7） */
  required: boolean
  /**
   * Form.StringField/MultiselectField.custom——选项式字段允许选项外的
   * 自定义答案（server 校验放行：custom:true 不再要求值命中 options）。
   * question 工具所有字段恒 true；UI 在选项列表末尾追加「其他」哨兵行。
   */
  custom: boolean
  /**
   * Form.Field.hidden——服务端条件隐藏标志（T5）。非降级 hidden 字段不
   * 进可见步（answer 由 buildFormAnswer 补键）；hidden+required+default
   * 空的组合降级为可见步让用户填（isDegradedField——任何空值兜底都会
   * 400，唯一不死锁路径）。
   */
  hidden: boolean
  /**
   * Form.Field.default 原始值（T5，hidden+required 补键依据）。保留原始
   * JSON 形态（string/number/boolean/string[]）——数组/数值直传，避免
   * 移动端 join/split(',') 的逗号失真已知限制；其余形态丢弃（undefined）。
   */
  defaultValue?: string | number | boolean | string[]
}

/**
 * 「其他（自定义答案）」合成选项的哨兵 value（\u0000 不可见字符，preset
 * options 的 value 域不可能碰撞）。与移动端 _kCustomOptionValue 同值跨端
 * 同源；仅存在于 UI 选中集合，buildFormAnswer 剥离并替换为自定义文本。
 */
export const CUSTOM_OPTION_VALUE = "\u0000custom"

/** 问题请求（frm_*，Map 以表单 id 为 key；一个会话可能多张排队） */
export interface PendingQuestion {
  /** frm_* */
  id: string
  sessionID: string
  /** form.title（卡片标题） */
  title: string
  fields: PendingQuestionField[]
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
    always: strArray(props.always).length > 0 ? strArray(props.always) : strArray(props.save),
    directory,
  }
}

/**
 * Form.Field → UI 字段投影（T5：hidden/external 不再剔除）；类型归一化：
 * external → external（授权确认，无输入 UI）；string+options → select；
 * string 无 options → text；multiselect/boolean 直通；number/integer →
 * number（UI 数值输入）。无 key 丢弃；title 空回落 key。
 */
function toField(f: Record<string, unknown>): PendingQuestionField | null {
  const key = str(f.key)
  // 无 key 丢弃；title 空回落 key（同移动端 f.title ?? f.key）
  if (!key) return null
  const type = str(f.type)
  const options = optionsOf(f)
  let kind: PendingQuestionFieldKind
  if (type === "external") kind = "external"
  else if (type === "multiselect") kind = "multiselect"
  else if (type === "boolean") kind = "boolean"
  else if (type === "number" || type === "integer") kind = "number"
  else {
    // string：有 options = 选项式（单选），否则自由文本
    kind = options.length > 0 ? "select" : "text"
  }
  return {
    key,
    question: str(f.title) || key,
    description: str(f.description),
    kind,
    options,
    placeholder: str(f.placeholder),
    required: f.required === true,
    // custom 仅存在于 string/multiselect 契约面；boolean/number 等类型恒缺省 false
    custom: f.custom === true,
    hidden: f.hidden === true,
    defaultValue: narrowDefault(f.default),
  }
}

/** Form.Field.options 宽松归一（invalid 条目丢弃，value/label 互补回落） */
function optionsOf(f: Record<string, unknown>): PendingQuestionOption[] {
  return Array.isArray(f.options)
    ? f.options
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .map((o) => ({
          value: str(o.value) || str(o.label),
          label: str(o.label) || str(o.value),
          description: str(o.description),
        }))
    : []
}

/** Form.Field.default 宽松收窄：string/number/boolean/string[] 外的形态丢弃 */
function narrowDefault(v: unknown): string | number | boolean | string[] | undefined {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string")
  return undefined
}

/**
 * hidden+required+default 空（服务端违约组合）→ 降级为可见步让用户填
 * （T5，移动端 _FormCardState._degraded 同语义）：required 缺键/空值均
 * 400，default 空时任何补值兜底都会 400 或失真，唯一不死锁且诚实的路径。
 */
export function isDegradedField(f: PendingQuestionField): boolean {
  if (!f.hidden || f.kind === "external" || !f.required) return false
  const d = f.defaultValue
  if (d === undefined) return true
  if (typeof d === "string") return d === ""
  if (Array.isArray(d)) return d.length === 0
  return false
}

/**
 * UI 可见步的字段原下标序列（T5 三层方案的 UI 层，移动端 _steps 同构）：
 * external 恒跳过（answer 层 ack）、hidden 非降级跳过（answer 层补键）。
 * 空序列 = 全 hidden/external 的 ack-only 卡（UI 渲染单步确认文案）。
 * 返回原下标（非步序号）——组件输入状态与 buildFormAnswer 的 input 键
 * 均按字段原下标键控，步进序列与字段序列解耦。
 */
export function formVisibleSteps(question: PendingQuestion): number[] {
  const out: number[] = []
  question.fields.forEach((f, i) => {
    if (f.kind !== "external" && (!f.hidden || isDegradedField(f))) out.push(i)
  })
  return out
}

/** form.created 事件负载（`{form: Form.Info}`）/ 回填条目 → PendingQuestion */
export function normalizeForm(
  props: Record<string, unknown> | undefined,
  directory: string,
): PendingQuestion | null {
  if (!props) return null
  // 事件负载嵌套在 form 字段；回填条目是 Form.Info 本身
  const raw = (props.form && typeof props.form === "object" ? props.form : props) as Record<
    string,
    unknown
  >
  const id = str(raw.id)
  const sessionID = str(raw.sessionID)
  if (!id || !sessionID) return null
  const fields = Array.isArray(raw.fields)
    ? raw.fields
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .map(toField)
        .filter((f): f is PendingQuestionField => f !== null)
    : []
  // 空字段卡守卫（spec Form.Fields minItems:1——纯防御，正常不可达；移动端
  // SSE/backfill 双入口同守卫）。T5 后全 hidden/external 字段不再剔成空，
  // 该守卫不再吞掉 ack-only 卡
  if (fields.length === 0) return null
  return { id, sessionID, title: str(raw.title), fields, directory }
}

/** UI 每字段原始输入（选项选中值数组 / 自由文本 / 「其他」自定义文本） */
export interface PendingFieldInput {
  selected?: string[]
  text?: string
  /** 「其他」选项展开的自定义文本（选中哨兵行时生效，其余忽略） */
  customText?: string
}

/**
 * 构造 Form.Answer（`POST .../form/:formID/reply` 的 answer 体）：
 * select → 首个选中 value（未选 = ""）；multiselect → 选中数组；boolean →
 * value "true" 命中即 true（UI 合成选项，未选 = false）；text → 原文；
 * number → parseFloat（NaN 兜底 0，同移动端 tryParse ?? 0）。
 * 选项式字段选中「其他」哨兵（CUSTOM_OPTION_VALUE）：select 以自定义文本为
 * 答案；multiselect 将非空自定义文本追加到选中数组（空则丢弃，同移动端
 * _buildAnswer——UI 步进门控已保证非空，空丢弃是防御）。
 *
 * T5（2026-10-29）补键——v2.0.26 活体实测矩阵（移动端 todo-form-card-v2-parity）：
 * - external：缺键 400（must be acknowledged）→ 恒补 ack `true`（实测 204）；
 * - hidden 非 required：缺键 204 → 不发键；
 * - hidden + required：缺键/空值均 400 → 补类型化 defaultValue；
 * - hidden + required + default 空（降级步）：isDegradedField 判定进可见步，
 *   走下方普通输入构造（用户填写）。
 */
export function buildFormAnswer(
  question: PendingQuestion,
  input: Record<number, PendingFieldInput>,
): Record<string, V2FormValue> {
  const answer: Record<string, V2FormValue> = {}
  question.fields.forEach((f, i) => {
    if (f.kind === "external") {
      answer[f.key] = true
      return
    }
    if (f.hidden && !isDegradedField(f)) {
      if (f.required) answer[f.key] = hiddenDefaultValue(f)
      return
    }
    const raw = input[i] ?? {}
    const selected = (raw.selected ?? []).filter((v) => v !== CUSTOM_OPTION_VALUE)
    const customText = (raw.customText ?? "").trim()
    switch (f.kind) {
      case "multiselect":
        answer[f.key] =
          (raw.selected ?? []).includes(CUSTOM_OPTION_VALUE) && customText !== ""
            ? [...selected, customText]
            : selected
        break
      case "select":
        answer[f.key] =
          (raw.selected ?? []).includes(CUSTOM_OPTION_VALUE) && customText !== ""
            ? customText
            : (selected[0] ?? "")
        break
      case "boolean":
        answer[f.key] = selected.includes("true")
        break
      case "number": {
        const t = (raw.text ?? "").trim()
        const n = Number(t)
        answer[f.key] = Number.isFinite(n) ? n : 0
        break
      }
      default:
        answer[f.key] = raw.text ?? ""
    }
  })
  return answer
}

/**
 * hidden+required 的类型化补键值（移动端 _buildAnswer 同语义）：default 保留
 * 原始 JSON 形态优先——数值直传、数组直传（规避移动端 join/split(',') 的
 * 逗号失真）、字符串按 kind 解析（integer/number 合并 kind "number"，整数
 * 形态字符串解析结果自然为整数；NaN 兜底 0 同移动端 tryParse ?? 0；畸形
 * 小数 default（integer 字段配 3.5）直传诚实失败 400——移动端 int.tryParse
 * → 0 兜底能过，跨端分歧可接受，仅服务端自犯约束错误时触发）。
 */
function hiddenDefaultValue(f: PendingQuestionField): V2FormValue {
  const d = f.defaultValue
  switch (f.kind) {
    case "number":
      if (typeof d === "number") return d
      {
        const n = Number(typeof d === "string" ? d : "")
        return Number.isFinite(n) ? n : 0
      }
    case "boolean":
      return d === true || d === "true"
    case "multiselect":
      if (Array.isArray(d)) return d
      {
        const s = typeof d === "string" ? d : ""
        return s === "" ? [] : s.split(",")
      }
    default:
      // select/text（string）
      if (typeof d === "string") return d
      if (typeof d === "number") return String(d)
      return Array.isArray(d) ? d.join(",") : ""
  }
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
 * 会话状态点的确定性投影（design-agent-status-indicator.md + design-error-message §3）：
 * 有待处理人机交互 = waiting（琥珀、静态、优先级最高，busy 底层事实保留）；
 * 否则报错退避重试（status=retry）= error（红光晕呼吸）；流式中 = running；
 * 否则以报错结束（终局）= failed（红静态）；否则未读（服务端水位未清，design-unread-marker）= unread（蓝静态）；否则 idle。
 */
export type SessionDotState = "waiting" | "error" | "failed" | "running" | "unread" | "idle"

export function sessionDotState(
  pendingCount: number,
  statusType: SessionStatusValue["type"],
  terminalError = false,
  unread = false,
): SessionDotState {
  if (pendingCount > 0) return "waiting"
  if (statusType === "retry") return "error"
  if (statusType === "busy") return "running"
  if (terminalError) return "failed"
  // 未读（design-unread-marker §4.5）：finish 成功/中断、且服务端水位未清——「已产出未验收」
  if (unread) return "unread"
  return "idle"
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
 * questions 已是归一化形态（v2 form 体系，M6a——v1 question 回填端点退役，
 * M6c 接 `GET /api/form`）。变化检测按内容签名（id 对集合）而非数量。
 * 返回是否有变化（调用方据此决定是否 notify）。
 */
export function mergePendingSnapshot(
  permissions: Map<string, PendingPermission>,
  questions: Map<string, PendingQuestion>,
  directory: string,
  freshPermissions: Record<string, unknown>[] | null,
  freshQuestions: PendingQuestion[] | null,
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
      if (q.directory === directory && !freshQuestions.some((x) => x.id === qid)) {
        questions.delete(qid)
      }
    }
    for (const q of freshQuestions) questions.set(q.id, q)
  }
  return permissionSignature(permissions) !== prevPermSig || questionSignature(questions) !== prevQSig
}
