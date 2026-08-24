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
  icon?: { color?: string; emoji?: string }
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

export interface Session {
  id: string
  slug?: string
  projectID: string
  workspaceID?: string
  directory: string
  title?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  time: SessionTime
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

export interface AssistantMessage {
  id: string
  sessionID: string
  role: "assistant"
  time: { created: number; completed?: number }
  error?: { type?: string; message?: string } | null
  /** 终态：stop（正常）/ error（异常）；tool-calls（中间步骤）与 null（生成中）非终态。
   *  (string & {}) 防联合类型坍缩——保留已知字面量的补全提示，同时容忍未来新值 */
  finish?: "stop" | "error" | "tool-calls" | (string & {}) | null
  [k: string]: unknown
}

export type Message = UserMessage | AssistantMessage

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

export type Part = TextPart | ToolPart | StepStartPart | SubtaskPart | (PartBase & Record<string, unknown>)

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

/** SSE 事件（/event）。仅声明 v0.1 消费的事件，未知类型透传忽略。 */
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
  // ---- 待处理人机交互（授权/问题）。properties 防御式解析（pending-requests.ts 归一化）----
  | { id: string; type: "permission.asked" | "permission.v2.asked" | "permission.updated"; properties: Record<string, unknown> }
  | { id: string; type: "permission.replied" | "permission.v2.replied"; properties: Record<string, unknown> }
  | { id: string; type: "question.asked" | "question.v2.asked"; properties: Record<string, unknown> }
  | { id: string; type: "question.replied" | "question.v2.replied" | "question.rejected" | "question.v2.rejected"; properties: Record<string, unknown> }
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
