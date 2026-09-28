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
