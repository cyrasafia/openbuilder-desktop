/**
 * opencode server API 契约的手写最小子集。
 * 依据：../openbuilder/opencode_openapi.json（server 1.18.x 实测对齐）。
 * 字段按需添加，不追求全覆盖；契约变更以 openapi diff 为准。
 */

export interface ProjectTime {
  created: number
  updated: number
  initialized?: number
}

export interface Project {
  id: string
  worktree: string
  vcs?: "git"
  name?: string
  /** 契约 ProjectIcon：override（用户自定义图片 URL/data URL）> url（server 自动发现，需实验开关）；color 为命名色 */
  icon?: { url?: string; override?: string; color?: string }
  time: ProjectTime
  sandboxes?: string[]
}

export interface SessionTime {
  created: number
  updated: number
  archived?: number
}

export interface SessionTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

/**
 * 回滚暂存态（`POST /session/:id/revert` 后挂在 Session 上，design-message-revert §3.2）。
 * messageID = 回滚点（含起删除）；提交发生在下一条 prompt（server cleanup）。
 */
export interface SessionRevert {
  messageID: string
  partID?: string
  snapshot?: string
  diff?: string
}

export interface Session {
  id: string
  slug?: string
  projectID: string
  workspaceID?: string
  directory: string
  title?: string
  agent?: string
  model?: ModelRef
  time: SessionTime
  /** 回滚暂存（staging）；unrevert/提交后为 null/缺省 */
  revert?: SessionRevert | null
  /** 会话改动汇总（staging 时 = 被回滚区间的改动；契约 Session.summary） */
  summary?: { additions: number; deletions: number; files: number }
  /** 父会话 ID（subagent 子会话非空，指向发起 task 工具的父会话） */
  parentID?: string
  [k: string]: unknown
}

export type MessageRole = "user" | "assistant"

export interface UserMessage {
  id: string
  sessionID: string
  role: "user"
  time: { created: number }
  [k: string]: unknown
}

/**
 * server NamedError 序列化形态（design-error-message §2 实测契约）：
 * `{name: "APIError"|"UnknownError"|"MessageAbortedError"|…, data: {message, statusCode?, isRetryable?, …}}`。
 * 人读文案在 `data.message`（顶层无 message）；解析见 message-error.ts extractErrorMessage。
 */
export interface NamedErrorShape {
  name?: string
  data?: { message?: string; [k: string]: unknown } | string
  [k: string]: unknown
}

export interface AssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: NamedErrorShape | null
  /** 终态：stop（正常）/ error（异常）；tool-calls（中间步骤）与 null（生成中）非终态。
   *  (string & {}) 防联合类型坍缩——保留已知字面量的补全提示，同时容忍未来新值 */
  finish?: "stop" | "error" | "tool-calls" | (string & {}) | null
  [k: string]: unknown
}

export type Message = UserMessage | AssistantMessage

/**
 * 会话任务（`GET /session/{id}/todo` 与 SSE `todo.updated` 载荷；openapi Todo）。
 * 无 id 字段（additionalProperties:false）；status/priority 语义见 session-todos.ts。
 */
export interface Todo {
  content: string
  /** pending | in_progress | completed | cancelled */
  status: string
  /** high | medium | low */
  priority: string
}

export type PartType =
  | "text"
  | "reasoning"
  | "tool"
  | "step-start"
  | "snapshot"
  | "patch"
  | "agent"
  | "repl"
  | "repl-frontend"
  | "subtask"
  | "retry"
  | "file"

export interface PartBase {
  id: string
  sessionID: string
  messageID: string
  type: PartType
}

export interface TextPart extends PartBase {
  type: "text" | "reasoning"
  text: string
  synthetic?: boolean
  time?: { start: number; end?: number }
  metadata?: Record<string, unknown>
}

export interface ToolStatePending {
  status: "pending"
  input: unknown
}
export interface ToolStateRunning {
  status: "running"
  input: unknown
}
export interface ToolStateCompleted {
  status: "completed"
  input: unknown
  output: string
  title: string
  metadata?: Record<string, unknown>
}
export interface ToolStateError {
  status: "error"
  input: unknown
  error: string
}
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface ToolPart extends PartBase {
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  metadata?: Record<string, unknown>
}

export interface StepStartPart extends PartBase {
  type: "step-start"
  snapshot?: string
}

/**
 * 斜杠命令回显 part（POST /session/:id/command 后真实 user 消息里出现）。
 * 实测坑（openbuilder design-slash-command-echo SC-1）：展开 prompt 在 `prompt`
 * 字段，`text` 恒为 null——读 text 会得到空气泡。
 */
export interface SubtaskPart extends PartBase {
  type: "subtask"
  command: string
  description?: string | null
  agent?: string | null
  model?: { providerID: string; modelID: string } | null
  prompt?: string | null
  text?: string | null
}

/**
 * 重试 part（openapi 1.18.x Part 联合成员，design-error-message §2）：
 * 退避窗口期到达、error 携带 APIError。消费语义（同 openbuilder conversation_store）：
 * 不入渲染部件列表，error 传播到所属消息 info.error 供错误卡呈现。
 * 本地 server 1.18.13 实测未持久化（retry 仅走 session.status 事件），防御式消费。
 */
export interface RetryPart extends PartBase {
  type: "retry"
  attempt: number
  error: NamedErrorShape
  time: { created: number }
}

/** GET /command 条目（v1 instance 路由，含 builtin/config/MCP/skill 四类） */
export interface CommandInfo {
  name: string
  description?: string
  agent?: string
  model?: string
  source?: "command" | "mcp" | "skill" | string
  template?: string
  subtask?: boolean
  hints?: string[]
  [k: string]: unknown
}

export type Part = TextPart | ToolPart | StepStartPart | SubtaskPart | RetryPart | (PartBase & Record<string, unknown>)

/**
 * 发送侧 file part（prompt_async / command 的 parts 成员，design-file-reference §1）：
 * 引用模式 = url 为 absolute `file://` + `source`（FileSource），零字节、server 注入内容。
 */
export interface FilePartInput {
  type: "file"
  mime: string
  url: string
  filename?: string
  source?: {
    type: "file"
    path: string
    text: { value: string; start: number; end: number }
  }
}

/** 引用值对象（design-file-reference §2，客户端域模型；乐观消息与 composer 共用） */
export interface FileRef {
  /** 相对 worktree（展示 + source.path；目录尾随 /） */
  path: string
  /** 绝对路径（拼 file:// url 用） */
  absolute: string
  filename: string
  isDir: boolean
}

// ---- pty（design-terminal-tab §1，openapi Pty/PtyTicketConnectToken/shells） ----

export interface Pty {
  id: string
  title?: string
  command: string
  args?: string[]
  cwd: string
  status: "running" | "exited"
  pid: number
  exitCode?: number
}

export interface PtyShell {
  path: string
  name: string
  acceptable: boolean
}

export interface PtyTicket {
  ticket: string
  expires_in: number
}

/** 回灌 file part（user 消息 parts 内，openapi FilePart 的消费子集）。
 *  source?.type==="file" 即引用回灌（乐观/接收侧渲染分流依据）；二进制回灌
 *  时 url 会被 server 重写为 data:（移动端 3R-B 实测）——跳转不得用 url。 */
export type FileDisplayPart = PartBase & {
  type: "file"
  url?: string
  mime?: string
  filename?: string
  source?: { type: string; path?: string } & Record<string, unknown>
  // 开放给 Part 联合的 Record<string, unknown> 成员（server 回灌字段超集）
  [k: string]: unknown
}

export function isFileRefPart(part: Part): part is FileDisplayPart {
  if (part.type !== "file") return false
  const source = (part as FileDisplayPart).source
  return !!source && typeof source === "object" && (source as { type?: unknown }).type === "file"
}

/** user 消息内任意 file part（引用回灌 source 型 + data: 附件回灌型） */
export function isFilePart(part: Part): part is FileDisplayPart {
  return part.type === "file"
}

/**
 * server 注入的合成 text part（synthetic:true——引用文件的 Read 回显与内容、
 * agent 提示、reminders、shell/后台任务回执等，server 源码仅对 text part 置此标）。
 * 面向模型的上下文工程，UI 一律不消费：回显只画用户文本 + 文件 chip。
 * 移动端同款过滤（openbuilder 1351f32 hide synthetic text parts）。
 */
export function isSyntheticTextPart(part: Part): boolean {
  return part.type === "text" && (part as TextPart).synthetic === true
}

export interface MessageWithParts {
  info: Message
  parts: Part[]
}

export interface FileNode {
  name: string
  /** 相对当前 directory 的路径，目录以 / 结尾 */
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

/** GET /file/content 响应（FileContent schema；binary 时 content 为 base64） */
export interface FileContentData {
  type: "text" | "binary"
  content: string
  encoding?: "base64"
  mimeType?: string
}

export interface Workspace {
  id: string
  type: string
  name: string
  branch?: string | null
  directory?: string | null
  projectID: string
  timeUsed?: number
}

/** POST /experimental/worktree 响应（server 1.18.x 实测） */
export interface WorktreeResult {
  name: string
  branch?: string
  directory: string
}

/** GET /vcs/diff 与 GET /session/{id}/diff 的文件级 diff（契约同 SnapshotFileDiff） */
export interface FileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

export interface HealthInfo {
  healthy: boolean
  version: string
}

/** 会话状态（SSE session.status / GET /session/status 的值；server 仅保留非 idle 项） */
export type SessionStatusValue =
  | { type: "busy" }
  | { type: "idle" }
  | {
      type: "retry"
      attempt: number
      message: string
      next: number
      action?: {
        reason: string
        provider: string
        title: string
        message: string
        label: string
        link?: string
      }
    }

/**
 * Agent 列表（`GET /agent?directory=`，v1 裸数组）。
 * 过滤规则见 model-catalog.ts：`!hidden && mode !== 'subagent'`。
 */
export interface AgentInfo {
  name: string
  description?: string
  /** "subagent" | "primary" | "all"（config 自定义 agent 默认 "all"） */
  mode: string
  hidden?: boolean
}

/**
 * 模型（`GET /config/providers` 拍平后的项）。`variants` 为 dict/List 双形态解析后的 keys。
 * 思考强度 = variant id（如 low/high/max）。
 */
export interface ModelInfo {
  id: string
  providerID: string
  name: string
  /** alpha | beta | deprecated | active | …；黑名单语义见 model-catalog.ts */
  status?: string
  variants: string[]
}

/** `GET /config/providers` 响应。`default` = 每家 provider 的默认 model id（v0.2 不展示）。 */
export interface ConfigProviders {
  providers: Array<{
    id: string
    name?: string
    /** 明文 API key——解析期丢弃（LR-2），rest-client 不读此字段 */
    key?: unknown
    models: Record<string, { name?: string; status?: string; variants?: unknown }>
  }>
  default?: Record<string, string>
}

/** SSE 事件（/event）。仅声明 v0.1/v0.2 消费的事件，未知类型透传忽略。 */
export type OpencodeEvent =
  | { id: string; type: "server.connected"; properties: Record<string, unknown> }
  | { id: string; type: "session.created"; properties: { sessionID: string; info: Session } }
  | { id: string; type: "session.updated"; properties: { sessionID: string; info: Session } }
  | { id: string; type: "session.deleted"; properties: { sessionID: string; info: Session } }
  | {
      id: string
      type: "session.status"
      properties: { sessionID: string; status: SessionStatusValue }
    }
  | { id: string; type: "session.idle"; properties: { sessionID: string } }
  | {
      id: string
      type: "session.next.agent.switched"
      // timestamp 实测为 ISO 字符串（1.18.20）；pin 的 spec（1.17.18）标 number，以实测为准。
      // 字段未被消费，仅契约记录。
      properties: { sessionID: string; messageID: string; timestamp: string; agent: string }
    }
  | {
      id: string
      type: "session.next.model.switched"
      properties: {
        sessionID: string
        messageID: string
        timestamp: string
        model: ModelRef
      }
    }
  | {
      id: string
      type: "message.updated"
      properties: { sessionID: string; info: Message }
    }
  | {
      id: string
      type: "message.removed"
      properties: { sessionID: string; messageID: string }
    }
  | {
      id: string
      type: "message.part.updated"
      properties: { sessionID: string; part: Part; time: number }
    }
  | {
      id: string
      type: "message.part.removed"
      properties: { sessionID: string; messageID: string; partID: string }
    }
  // ---- 文件监听（design-file-watcher）：server 侧 @parcel/watcher 磁盘变化广播 ----
  | {
      id: string
      type: "file.watcher.updated"
      properties: { file: string; event: "add" | "change" | "unlink" }
    }
  // ---- worktree 生命周期（design-worktree-sync）：create boot 结束时广播，
  // 删除无 SSE 事件（靠刷新对账检测）。directory = 新 worktree 路径；project 字段
  // 在信封里，由订阅层透传给 onEvent 的 meta 参数（事件闸门按 projectID 判断）。
  | { id: string; type: "worktree.ready"; properties: { name: string; branch?: string } }
  | { id: string; type: "worktree.failed"; properties: { message: string } }
  // ---- 待处理人机交互（授权/问题）。properties 防御式解析（pending-requests.ts 归一化）----
  | { id: string; type: "permission.asked" | "permission.v2.asked" | "permission.updated"; properties: Record<string, unknown> }
  | { id: string; type: "permission.replied" | "permission.v2.replied"; properties: Record<string, unknown> }
  | { id: string; type: "question.asked" | "question.v2.asked"; properties: Record<string, unknown> }
  | { id: string; type: "question.replied" | "question.v2.replied" | "question.rejected" | "question.v2.rejected"; properties: Record<string, unknown> }
  // ---- 会话任务列表（design-task-list）。properties 防御式解析（session-todos.ts 归一化）----
  | { id: string; type: "todo.updated"; properties: Record<string, unknown> }
  | { id: string; type: string; properties: Record<string, unknown> }

/**
 * /global/event 信封（design-sse-global-event.md §3 实测契约）：
 * - directory 缺省视为 "global"（server.connected/heartbeat 帧无 directory 字段）
 * - payload.type === "sync" 是 durable 事件的重复包装，订阅层丢弃
 */
export interface GlobalEventEnvelope {
  directory?: string
  project?: string
  workspace?: string
  payload: OpencodeEvent | { type: "sync"; syncEvent: unknown }
}
