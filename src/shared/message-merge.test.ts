import { describe, expect, it } from "vitest"
import {
  mergeParts,
  mergeSnapshotIntoMessages,
  sortEntries,
  sortMessages,
  type ChatEntry,
} from "./message-merge"
import type { AssistantMessage, MessageWithParts, Part, UserMessage } from "./api-types"

function userMsg(id: string, created: number): UserMessage {
  return { id, sessionID: "ses_1", role: "user", time: { created } }
}

function assistantMsg(id: string, created: number, completed?: number): AssistantMessage {
  return { id, sessionID: "ses_1", role: "assistant", time: { created, completed } }
}

function entry(info: UserMessage | AssistantMessage, parts: Part[] = []): MessageWithParts {
  return { info, parts }
}

function textPart(id: string, messageID: string, text: string, type: "text" | "reasoning" = "text"): Part {
  return { id, sessionID: "ses_1", messageID, type, text }
}

describe("sortMessages（sort-order 竞态防护）", () => {
  it("流式 assistant 始终排最后，即使 created 更小", () => {
    const optimisticUser = entry(userMsg("msg_u1", 100)) // T_client
    const streamingAssistant = entry(assistantMsg("msg_a1", 50)) // 占位 created 更小
    const serverUser = entry(userMsg("msg_u2", 200)) // T_server 更大
    const sorted = [streamingAssistant, serverUser, optimisticUser].sort(sortMessages)
    expect(sorted.map((m) => m.info.id)).toEqual(["msg_u1", "msg_u2", "msg_a1"])
  })

  it("assistant 完成后按 created 正常排序", () => {
    const done1 = entry(assistantMsg("msg_a1", 100, 200))
    const done2 = entry(assistantMsg("msg_a2", 300, 400))
    const user = entry(userMsg("msg_u1", 200))
    const sorted = [done2, user, done1].sort(sortMessages)
    expect(sorted.map((m) => m.info.id)).toEqual(["msg_a1", "msg_u1", "msg_a2"])
  })
})

describe("sortEntries（乐观消息）", () => {
  it("乐观消息在已完成消息之后、流式 assistant 之前", () => {
    const done: ChatEntry = { kind: "message", data: entry(assistantMsg("msg_a1", 100, 150)) }
    const optimistic: ChatEntry = {
      kind: "optimistic",
      data: { optimistic: true, localId: "opt_1", text: "hi", createdAt: 500 },
    }
    const streaming: ChatEntry = { kind: "message", data: entry(assistantMsg("msg_a2", 450)) }
    const sorted = sortEntries([streaming, optimistic, done])
    expect(sorted.map((e) => (e.kind === "optimistic" ? e.data.localId : e.data.info.id))).toEqual([
      "msg_a1",
      "opt_1",
      "msg_a2",
    ])
  })
})

describe("mergeParts", () => {
  it("text 取更长者", () => {
    const rest = [textPart("prt_1", "msg_1", "hello wo")]
    const sse = [textPart("prt_1", "msg_1", "hello world!")]
    const merged = mergeParts(rest, sse)
    expect((merged[0] as { text: string }).text).toBe("hello world!")
  })

  it("tool 状态 SSE 非 pending 优先", () => {
    const rest = [
      {
        id: "prt_t1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool" as const,
        callID: "call_1",
        tool: "read",
        state: { status: "pending", input: {} },
      },
    ]
    const sse = [
      {
        id: "prt_t1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool" as const,
        callID: "call_1",
        tool: "read",
        state: { status: "completed", input: {}, output: "data", title: "read" },
      },
    ]
    const merged = mergeParts(rest, sse)
    expect((merged[0] as { state: { status: string } }).state.status).toBe("completed")
  })

  it("REST-only part 不丢失（SSE 中途建连场景）", () => {
    const rest = [textPart("prt_r1", "msg_1", "rest-only")]
    const merged = mergeParts(rest, [])
    expect(merged).toHaveLength(1)
  })
})

describe("mergeSnapshotIntoMessages", () => {
  it("合并不清空：async gap 期间的 SSE-only 消息保留", () => {
    const local = new Map([
      ["msg_1", entry(userMsg("msg_1", 100))],
      ["msg_2", entry(assistantMsg("msg_2", 200))], // SSE 新到，快照无
    ])
    const snapshot = [entry(userMsg("msg_1", 100))]
    const merged = mergeSnapshotIntoMessages(local, snapshot)
    expect(merged.has("msg_2")).toBe(true)
  })

  it("窗口区间删除：快照 (min,max) 开区间内缺失的本地消息被删（revert 场景）", () => {
    const local = new Map([
      ["msg_1", entry(userMsg("msg_1", 100))],
      ["msg_2", entry(userMsg("msg_2", 200))], // 落在窗口内但快照缺失 → 删除
      ["msg_3", entry(userMsg("msg_3", 300))],
      ["msg_0", entry(userMsg("msg_0", 50))], // 窗口外（更早）→ 保留
    ])
    const snapshot = [entry(userMsg("msg_1", 100)), entry(userMsg("msg_3", 300))]
    const merged = mergeSnapshotIntoMessages(local, snapshot)
    expect(merged.has("msg_2")).toBe(false)
    expect(merged.has("msg_0")).toBe(true)
  })

  it("info 取 REST 权威，parts 并集", () => {
    const local = new Map([
      [
        "msg_1",
        {
          info: assistantMsg("msg_1", 100),
          parts: [textPart("prt_1", "msg_1", "short")],
        },
      ],
    ])
    const snapshot = [
      {
        info: assistantMsg("msg_1", 100, 999),
        parts: [textPart("prt_2", "msg_1", "rest-part")],
      },
    ]
    const merged = mergeSnapshotIntoMessages(local, snapshot)
    const m = merged.get("msg_1")!
    expect((m.info as AssistantMessage).time.completed).toBe(999)
    expect(m.parts.map((p) => p.id).sort()).toEqual(["prt_1", "prt_2"])
  })
})
