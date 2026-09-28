/**
 * opencode **v2** server API 契约的手写最小子集（迁移期与 v1 api-types.ts 并存，
 * 收敛步删除 v1 面，见 docs/plan-v2-protocol.md §模块策略）。
 * 依据：../openbuilder/opencode_openapi_v2.json（官方 packages/protocol/openapi.json
 * 2.0.18 拷贝）+ v2 分支源码核对（2026-09-28）。
 * 字段按里程碑增量添加，不追求全覆盖；契约变更以 openapi diff 为准。
 */

/** GET /api/info（v2 探活端点，取代 v1 /global/health） */
export interface ServerInfo {
  version: string
  pid: number
  urls: string[]
  paths: { tmp: string }
}

/** v2 Project.Info：worktree→canonical 改名；time 三字段必填（active 为 v2 新增） */
export interface ProjectInfo {
  id: string
  canonical: string
  vcs?: string
  name?: string
  icon?: { url?: string; override?: string; color?: string }
  commands?: { start?: string }
  time: { created: number; updated: number; active: number }
  sandboxes: string[]
}

/**
 * v2 Location.Ref。wire 上响应序列化为 PublicRef（只有 directory，workspaceID
 * 不出网）；请求侧 deepObject query 形如 ?location[directory]=<path>。
 * location 是 v2 的作用域单位（取代 v1 的裸 directory 参数），无独立 ID，
 * 唯一键 = 归一化 directory（+server 内部 workspaceID，客户端不可见）。
 */
export interface LocationRef {
  directory: string
  workspaceID?: string
}

/** GET /api/location 响应（Location.PublicInfo）：解析出的作用域与项目归属 */
export interface LocationInfo {
  directory: string
  project: { id: string; directory: string; canonical: string }
}

/** v2 会话创建/更新 payload 用的模型引用（与 v1 ModelRef 同构） */
export interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

/**
 * v2 Session.Info 列表最小面（M1；M2/M4 按需补 cost/tokens/outcome/model 等）。
 * time.archived 在 wire 上**可读**（v1 数据迁移/import 透传），但 v2 无 REST 写入
 * 路径——归档写走 D1 私约 metadata.archivedAt，识别读两者（见 plan-v2-protocol M2）。
 */
export interface SessionInfo {
  id: string
  parentID?: string
  projectID: string
  agent?: string
  model?: ModelRef
  title?: string
  time: { created: number; updated: number; idle?: number; viewed?: number; archived?: number }
  location: LocationRef
  subpath?: string
  metadata?: Record<string, unknown>
}

/** v2 分页 envelope：游标在响应体（v1 是 X-Next-Cursor 响应头），双向 */
export interface CursorPage<T> {
  data: T[]
  cursor: { previous?: string; next?: string }
}

/**
 * v2 SSE 事件信封（GET /api/event 单流，**volatile 契约**：断线丢事件、慢消费
 * 断流——重连后必须全量对账）。`type` 在顶层、数据在 `data`；`location` 为
 * PublicRef（只有 directory）——事件闸门键。server 以 15s comment 帧
 * （`: heartbeat`）保活，非 data 帧。
 */
export interface V2Event<T = Record<string, unknown>> {
  id: string
  created: number
  metadata?: Record<string, unknown>
  location?: { directory: string }
  type: string
  data: T
}

// ---- form / permission 待办（M6a，契约 Form.*/Permission.*）----

/** Form.Option：value 是 answer 回传值（label 仅展示——v1 question 回传 label，勿混淆） */
export interface V2FormOption {
  value: string
  label: string
  description?: string
}

/**
 * Form.Field 六型公共面（string/number/integer/boolean/multiselect/external；
 * 枚举型特有字段（format/min/max 等）按需读取，wire 宽松化）。
 */
export interface V2FormField {
  key: string
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external"
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  placeholder?: string
  custom?: boolean
  options?: V2FormOption[]
  default?: unknown
}

/** Form.Info（form.created 事件 data.form / GET /api/form 条目） */
export interface V2FormInfo {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: V2FormField[]
}

/** Form.Value（answer 的字段值；文本/数字/布尔/多选数组） */
export type V2FormValue = string | number | boolean | string[]

/** Form.Answer：`POST .../form/:formID/reply` 的 answer 体（键 = field.key） */
export type V2FormAnswer = Record<string, V2FormValue>

/** Permission.Reply（reply 端点的 decision 枚举，与 v1 response 同值域） */
export type V2PermissionDecision = "once" | "always" | "reject"

// ---- 文件系统 / diff / pty（M6b，契约 FileSystem.*/FileDiff.*/Pty.*）----

/** FileSystem.Entry：path 相对请求的 location（目录带尾随 /） */
export interface V2FsEntry {
  path: string
  type: "file" | "directory"
}

/** FileDiff.Info（/api/vcs/diff 与 /api/session/:id/diff 的条目；与内部 FileDiff 同构） */
export interface V2FileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

// ---- agent / model 目录（M6b 补换绑；LR-1 判断已过时，见 model-catalog 注释）----

/**
 * Agent.Info wire 形状（M6b 评审修复：**id 是标识符、name 是显示标签**——
 * 活体 2.0.18：`{id:"build", name:"Build", …}`。内部 AgentInfo 的 name 沿袭
 * v1 语义 = 标识符，wire name 映射到内部 label）。
 */
export interface V2AgentInfo {
  id: string
  name: string
  description?: string
  mode: "subagent" | "primary" | "all" | (string & {})
  hidden?: boolean
}

/**
 * Model.Info（wire 宽松化：仅目录消费面）。status 枚举 alpha/beta/deprecated/active；
 * enabled 是 provider 配置层的启用位（false = 未配 key 等，不进列表）。
 */
export interface V2ModelInfo {
  id: string
  providerID: string
  name?: string
  status?: string
  enabled?: boolean
  variants?: Array<{ id?: string } | Record<string, unknown>>
}

/** GET /api/session query（flat 风格；与 location 组的 deepObject 风格并存，勿统一） */
export interface ListSessionsInput {
  directory?: string
  project?: string
  subpath?: string
  limit?: number
  order?: "asc" | "desc"
  search?: string
  /** null = 只取根会话（wire 上是字符串 "null"） */
  parentID?: string | null
  cursor?: string
}
