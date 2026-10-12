/**
 * v2 wire → 内部模型适配层（docs/plan/plan-v2-protocol.md §模块策略）。
 * 内部 Project/Session 沿用 v1 时代的字段名（worktree/directory），v2 的
 * canonical/location 映射进来（M6d 收敛后字段改名未做——收益小于触碰面，
 * 留待自然演进；本层是唯一映射点，改名时只动这里）。
 */
import type { ProjectInfo, SessionInfo } from "./api-v2-types"
import type { Project, Session } from "./api-types"
import { isAbortError } from "./message-error"

// ============ 消息 id 铸造（design-optimistic-id-anchor §5.1） ============

/** server identifier.ts 同构字符表（62 字符） */
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let mintLastTimestamp = 0
let mintCounter = 0

/**
 * 铸造 `msg_` 形状消息 id（server `packages/schema/src/identifier.ts` 同构编码：
 * 6 字节 hex 时间戳前缀（ts×0x1000+counter 高 48 位）+ 14 字符随机）。跨进程
 * 碰撞概率可忽略（62^14 随机空间，官方客户端同风险）。
 * sendPrompt 乐观条目以它为 localId 随 `POST /prompt` 的 `id` 字段传递——
 * server 准入按 id 幂等（同 id 重复准入不双计），乐观消解锚从创建起即存在。
 */
export function mintMessageID(): string {
  const ts = Date.now()
  if (ts !== mintLastTimestamp) {
    mintLastTimestamp = ts
    mintCounter = 0
  }
  mintCounter++
  const current = BigInt(ts) * 0x1000n + BigInt(mintCounter)
  let time = ""
  for (let i = 0; i < 6; i++) {
    time += Number((current >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")
  }
  const bytes = new Uint8Array(14)
  crypto.getRandomValues(bytes)
  let suffix = ""
  for (const b of bytes) suffix += ID_CHARS[b % 62]
  return `msg_${time}${suffix}`
}

/** v2 ProjectInfo → 内部 Project：canonical → worktree 字段名（basename 展示/
 *  作用域键逻辑不变）；v2 无 initialized（active 取代），置 undefined。
 *  v2 无 global 项目行（用户裁定 2026-09-28：非 git 目录 = 目录哈希伪项目行，
 *  以普通项目进列表——v1 global 拆分语义退役，特殊路径 M1b 删除）。 */
export function toInternalProject(p: ProjectInfo): Project {
  return {
    id: p.id,
    worktree: p.canonical,
    vcs: p.vcs === "git" ? "git" : undefined,
    name: p.name,
    icon: p.icon,
    time: {
      created: p.time.created,
      updated: p.time.updated,
      initialized: undefined,
    },
    sandboxes: p.sandboxes ?? [],
  }
}

/** v2 SessionInfo → 内部 Session：directory ← location.directory。
 *  metadata 透传（D1 归档私约 metadata.archivedAt 的识别数据源）；
 *  agent/model 透传（创建回显/默认模型链路消费）；outcome 透传（§3.4b
 *  冷启动 failed 红点，null 归一 undefined）。 */
export function toInternalSession(s: SessionInfo): Session {
  return {
    id: s.id,
    parentID: s.parentID,
    projectID: s.projectID,
    agent: s.agent,
    model: s.model,
    directory: s.location.directory,
    title: s.title,
    time: {
      created: s.time.created,
      updated: s.time.updated,
      archived: s.time.archived,
      // 未读水位（design-unread-marker §4.1）：idle = run 终态时刻、viewed = 已读水位
      idle: s.time.idle,
      viewed: s.time.viewed,
    },
    metadata: s.metadata,
    outcome: s.outcome ?? undefined,
    // 回滚暂存映射（design-sse-event-surface 层 3）：快照整条替换不得抹 staged
    // 态——否则 60s 对账把回滚条/隐藏态打回原形，与 server 真态背离
    revert: s.revert ?? undefined,
  }
}

/**
 * 归档判定（D1，双源）：v2 的 REST 归档字段不可写（官方 app 占位 + TODO），
 * 关 Tab = 归档走 metadata.archivedAt 私约；存量会话（v1 迁移/import 透传）
 * 带 time.archived。v1 server 端过滤归档，v2 返回全部——客户端统一过滤（对齐
 * 官方 v2 app 的 client-side filter 行为）。parentID 过滤（子/后台会话）是
 * M2 会话域的决策点，本层不做。
 */
export function isArchivedSession(s: Session): boolean {
  if (s.time.archived) return true
  return archivedAtOf(s) !== null
}

/** 归档时间戳（排序用）：time.archived ?? metadata.archivedAt；未归档 null。
 *  time.archived 判定用 truthy——v1 以 archived:0 为取消归档标记（v1 展示层
 *  全部 falsy 判定），v2 wire 侧 fromRow 同口径归一（0 → undefined） */
export function archivedAtOf(s: Session): number | null {
  if (s.time.archived) return s.time.archived
  const at = s.metadata?.archivedAt
  return typeof at === "number" && at > 0 ? at : null
}

// ============ 消息域（M4a）：v2 typed union → v1 {info, parts} ============

import type { FileDisplayPart, FileRef, Message, MessageWithParts, Part, TextPart, ToolPart } from "./api-types"
import type { Attachment } from "./attachment-pipeline"

/** v2 消息条目的宽松形状（typed union 过大不强镜像；按 type 判别 + 防御读取） */
export type V2MessageEntry = { id: string; type: string; time?: { created?: number } } & Record<string, unknown>

/** v2 Content（tool 输出）→ 文本（拼接 text 型内容；image 等非文本省略为占位） */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((c) => ((c as { type?: string }).type === "text" && typeof (c as { text?: string }).text === "string" ? (c as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n")
}

/** v2 SessionError → 展示消息（message > name 兜底） */
export function errorMessage(err: unknown): string {
  const e = err as { message?: string; name?: string } | undefined
  return e?.message ?? e?.name ?? "error"
}

/** v2 ToolState → v1 ToolState（streaming/running → running；completed/error 逐字段） */
function toToolPartState(name: string, state: { status?: string } & Record<string, unknown>): ToolPart["state"] {
  switch (state?.status) {
    case "completed":
      return {
        status: "completed",
        input: state.input,
        output: contentText(state.content),
        title: name,
        ...(state.metadata != null ? { metadata: state.metadata as Record<string, unknown> } : {}),
      }
    case "error": {
      const err = state.error as { message?: string; name?: string; type?: string } | undefined
      return {
        status: "error",
        input: state.input,
        error: err?.message ?? err?.name ?? "tool error",
        // 中止降级标记（design-error-message §3.1 修订）：打断未结算工具的
        // failed 非出错——与 SSE 路径（app-store session.tool.failed）同用
        // isAbortError 单一判定源（review 2026-10-09，不内联重复键集）
        ...(isAbortError(err) ? { aborted: true } : {}),
      }
    }
    default:
      // streaming（input 为拼接字符串）/running（input 对象）→ v1 无 streaming 态，归 running
      return { status: "running", input: state?.input }
  }
}

/** v2 AssistantContent[] → v1 Part[]（text/reasoning 按序号铸稳定 id；tool 用其 id） */
function assistantContentToParts(sessionID: string, messageID: string, content: unknown[]): Part[] {
  const parts: Part[] = []
  let textOrdinal = 0
  for (const item of content) {
    const c = item as { type?: string } & Record<string, unknown>
    if (c?.type === "text" || c?.type === "reasoning") {
      parts.push({
        id: `${messageID}:c:${textOrdinal++}`,
        sessionID,
        messageID,
        type: c.type,
        text: typeof c.text === "string" ? c.text : "",
      } as TextPart)
    } else if (c?.type === "tool") {
      const t = c as unknown as { id: string; name: string; state?: { status?: string } & Record<string, unknown> }
      parts.push({
        id: t.id,
        sessionID,
        messageID,
        type: "tool",
        callID: t.id,
        tool: t.name,
        state: toToolPartState(t.name, t.state ?? {}),
      } as ToolPart)
    }
    // 其他 content 类型（未来扩展）跳过——渲染层按未知 part 容忍（既有行为）
  }
  return parts
}

/**
 * v2 消息列表（typed union）→ 内部 MessageWithParts[]。
 * - user/synthetic → v1 user 消息（synthetic 文本 part 带 synthetic:true，
 *   渲染层既有过滤规则原样生效）
 * - assistant → info + content[] 部件化
 * - system/skill/shell/compaction/idle/agent-switched/model-switched/location-
 *   switched：v1 渲染层无对应，跳过（对账权威，不进渲染）；M6 评估原生渲染
 */
/**
 * inbox user 项 → 内部 user 消息（design-inbox-admission §3.2，准入即物化）。
 * `session.inbox.enqueued` 的 item（{type, payload, delivery}——无 time，created
 * 由调用方传信封值）以 inboxID（= 投影后消息 id，活体+源码双证）铸消息：
 * 投影落地后 REST 权威 info 按 id 覆盖、parts 并集，物化→投影零跳变。
 * - bridge（自有发送，按 payload.text 匹配乐观条目）：refs/attachments 铸
 *   file part（chip 可点/图片缩略图随物化保留——移动端 _bridgeOptimisticParts
 *   同构），跳过 payload files 兜底解析（同源数据，防重复 chip）
 * - payload files 兜底（他端发送）：wireFilesToFileParts 统一铸造（2.0.18
 *   REST/inbox 活体形状见其注释）——file:// 源铸引用回灌型 chip、data 源铸
 *   附件型（图片缩略图）；id 与 bridge/REST 投影同 scheme，投影置换不双 chip
 */
export function inboxItemToUserMessage(
  sessionID: string,
  inboxID: string,
  item: unknown,
  created: number,
  bridge?: { refs?: FileRef[]; attachments?: Attachment[] } | null,
): MessageWithParts | null {
  const payload = (item as { payload?: Record<string, unknown> } | undefined)?.payload
  if (!payload) return null
  const text = typeof payload.text === "string" ? payload.text : ""
  const parts: Part[] = []
  if (text) {
    parts.push({ id: `${inboxID}:text`, sessionID, messageID: inboxID, type: "text", text })
  }
  let n = 0
  const filePartId = () => `${inboxID}:file:${n++}`
  if (bridge && (bridge.refs?.length || bridge.attachments?.length)) {
    // bridge 铸造（自有发送）与 wireFilesToFileParts（投影/他端）共用同一 id
    // scheme（`${id}:file:${n}`）——投影合并按 id 命中置换（mergePart 快照
    // 优先），不并集出双 chip
    for (const ref of bridge.refs ?? []) {
      parts.push({
        id: filePartId(),
        sessionID,
        messageID: inboxID,
        type: "file",
        mime: "text/plain",
        url: `file://${ref.absolute}`,
        filename: ref.filename,
        // 引用回灌型（isFileRefPart）：path 相对、absolute 由会话目录拼合
        //（fileRefToFilePart 发送侧同款 shape）
        source: { type: "file", path: ref.path, text: { value: "", start: 0, end: 0 } },
      } as FileDisplayPart)
    }
    for (const a of bridge.attachments ?? []) {
      parts.push({
        id: filePartId(),
        sessionID,
        messageID: inboxID,
        type: "file",
        mime: a.mime,
        url: a.dataUrl,
        filename: a.filename,
      } as FileDisplayPart)
    }
  } else {
    const files = Array.isArray(payload.files) ? payload.files : []
    parts.push(...wireFilesToFileParts(sessionID, inboxID, files))
  }
  return { info: { id: inboxID, sessionID, role: "user", time: { created } }, parts }
}

/**
 * v2 wire files[]（REST user 消息 / inbox payload 同构数据）→ file parts。
 * 活体 2.0.18 探针（2026-10-12，POST files uri=data:/file: 回读 GET /message）：
 * - data 附件 → `{data, mime, source:{type:"inline"}, name}`（无 uri）
 * - file:// 引用 → `{data, mime, source:{type:"uri", uri:"file://…"}, name}`
 *   （内容被 server 内联进 data）；裸 `{uri, name}`（2.0.18 inbox payload）防御兼容。
 * 铸造对齐渲染契约（design-session-attachments §4 / design-file-reference §5）：
 * - file:// uri 源 → 引用回灌型 `source:{type:"file",path}`（chip 可点；
 *   path 取 uri 绝对路径——userFileChipItems 绝对 rel 直接作 absolute）
 * - 其余（inline/无 source/非 file uri）→ 附件回灌型（**无 source**）：url
 *   重组 `data:`——可显示图片走缩略图（userImageParts 判 `!p.source`）、
 *   其余文件名 chip。source 原样透传会让 inline 图片两侧判定全 skip（不可见，
 *   2026-10-12 修复根因之二）
 */
function wireFilesToFileParts(sessionID: string, messageID: string, files: unknown[]): Part[] {
  const parts: Part[] = []
  let n = 0
  for (const f of files) {
    if (!f || typeof f !== "object") continue
    const file = f as Record<string, unknown>
    const name = typeof file.name === "string" ? file.name : typeof file.filename === "string" ? file.filename : ""
    const mime = typeof file.mime === "string" ? file.mime : undefined
    const uri = typeof file.uri === "string" ? file.uri : undefined
    const source = file.source && typeof file.source === "object" ? (file.source as Record<string, unknown>) : undefined
    const srcUri = typeof source?.uri === "string" ? source.uri : undefined
    const data = typeof file.data === "string" ? file.data : undefined
    const partId = `${messageID}:file:${n++}`
    const fileUri = uri ?? srcUri
    if (fileUri?.startsWith("file://")) {
      // 引用回灌：path 取 uri 去 scheme。decode 收 round-trip 校验（review
      // 2026-10-12）：本端发送侧不编码（fileRefToFilePart 裸拼 absolute），
      // 文件名字面含 %XX（如 100%41.txt）会被误解码成 100A.txt——只有
      // encodeURI(decode) 还原出原文（确系他端编码产物）才采信，否则保留字面
      const rawPath = fileUri.slice("file://".length)
      let path = rawPath
      try {
        const decoded = decodeURIComponent(rawPath)
        if (encodeURI(decoded) === rawPath) path = decoded
      } catch {
        /* 非 legal 编码序列，保留原文 */
      }
      parts.push({
        id: partId,
        sessionID,
        messageID,
        type: "file",
        ...(mime != null ? { mime } : {}),
        url: fileUri,
        ...(name ? { filename: name } : {}),
        source: { type: "file", path, text: { value: "", start: 0, end: 0 } },
      } as FileDisplayPart)
      continue
    }
    const url = fileUri ?? (data != null && mime ? `data:${mime};base64,${data}` : undefined)
    parts.push({
      id: partId,
      sessionID,
      messageID,
      type: "file",
      ...(url != null ? { url } : {}),
      ...(mime != null ? { mime } : {}),
      ...(name ? { filename: name } : {}),
    } as FileDisplayPart)
  }
  return parts
}

export function toInternalMessages(sessionID: string, entries: V2MessageEntry[]): MessageWithParts[] {
  const out: MessageWithParts[] = []
  for (const e of entries) {
    if (!e || typeof e.id !== "string") continue
    const created = e.time?.created ?? 0
    if (e.type === "user") {
      const parts: Part[] = []
      if (typeof e.text === "string" && e.text) {
        parts.push({ id: `${e.id}:text`, sessionID, messageID: e.id, type: "text", text: e.text })
      }
      // files → file parts（2026-10-12 修复：此前整组丢弃——引导页流无 inbox
      // 物化桥接兜底，投影合并 + 乐观按 id 锚消解后附件/chip 直接消失；冷加载
      // 带附件的历史会话同不显示。形状/铸造规则见 wireFilesToFileParts）
      parts.push(...wireFilesToFileParts(sessionID, e.id, Array.isArray(e.files) ? e.files : []))
      out.push({ info: { id: e.id, sessionID, role: "user", time: { created } }, parts })
    } else if (e.type === "synthetic") {
      out.push({
        info: {
          id: e.id,
          sessionID,
          role: "user",
          time: { created },
          // metadata 透传（design-subagent-background D4）：完成回执从 REST 快照
          // 重建通知，需 `{source:"subagent", childID, agent, state}`。
          ...(e.metadata != null ? { metadata: e.metadata as Record<string, unknown> } : {}),
        },
        parts: [
          {
            id: `${e.id}:text`,
            sessionID,
            messageID: e.id,
            type: "text",
            text: typeof e.text === "string" ? e.text : "",
            synthetic: true,
          },
        ],
      })
    } else if (e.type === "assistant") {
      const time = e.time as { created?: number; completed?: number } | undefined
      const info = {
        id: e.id,
        sessionID,
        role: "assistant" as const,
        time: { created: time?.created ?? created, ...(time?.completed != null ? { completed: time.completed } : {}) },
        ...(e.agent != null ? { agent: e.agent as string } : {}),
        ...(e.model != null ? { model: e.model } : {}),
        ...(e.finish != null ? { finish: e.finish as string } : {}),
        ...(e.error != null ? { error: e.error } : {}),
        ...(e.cost != null ? { cost: e.cost } : {}),
        ...(e.tokens != null ? { tokens: e.tokens } : {}),
      } as Message
      out.push({ info, parts: assistantContentToParts(sessionID, e.id, (e.content as unknown[]) ?? []) })
    }
  }
  return out
}
