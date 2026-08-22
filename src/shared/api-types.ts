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

export type Part = TextPart | ToolPart | StepStartPart | (PartBase & Record<string, unknown>)

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

/** SSE 事件（/event）。仅声明 v0.1 消费的事件，未知类型透传忽略。 */
export type OpencodeEvent =
  | { id: string; type: "server.connected"; properties: Record<string, unknown> }
  | { id: string; type: "session.created"; properties: { sessionID: string; info: Session } }
  | { id: string; type: "session.updated"; properties: { sessionID: string; info: Session } }
  | { id: string; type: "session.deleted"; properties: { sessionID: string; info: Session } }
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
  | { id: string; type: string; properties: Record<string, unknown> }

export function isStreamingAssistant(msg: Message): boolean {
  return msg.role === "assistant" && !(msg as AssistantMessage).time.completed
}
