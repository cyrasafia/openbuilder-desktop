import { describe, expect, it } from "vitest"
import type { Part, Session, ToolPart } from "./api-types"
import {
  backgroundStartedNotice,
  mergeNotices,
  normalizeBackgroundState,
  subagentSyntheticNotice,
  foregroundClaimedChildIds,
  activeClaimedChildIds,
  toolMetadataSessionId,
  withdrawForegroundStartNotices,
  type SessionNotice,
} from "./session-notices"

function child(id: string, title?: string): Session {
  return {
    id,
    projectID: "proj",
    directory: "/repo",
    parentID: "ses_parent",
    title,
    time: { created: 100, updated: 100 },
  } as Session
}

function toolPart(tool: string, input: unknown, metadata?: Record<string, unknown>, status = "running"): Part {
  const base = { id: `prt_${tool}`, sessionID: "ses_parent", messageID: "msg_1", type: "tool" as const, callID: `c_${tool}`, tool }
  if (status === "completed") return { ...base, state: { status: "completed", input, output: "", title: tool, ...(metadata ? { metadata } : {}) } } as ToolPart
  if (status === "error") return { ...base, state: { status: "error", input, error: "x" } } as ToolPart
  return { ...base, state: { status, input, ...(metadata ? { metadata } : {}) } } as ToolPart
}

describe("toolMetadataSessionId", () => {
  it("读 metadata.sessionId 与 sessionID 两种大小写", () => {
    expect(toolMetadataSessionId(toolPart("task", {}, { sessionId: "ses_a" }) as ToolPart)).toBe("ses_a")
    expect(toolMetadataSessionId(toolPart("subagent", {}, { sessionID: "ses_b" }) as ToolPart)).toBe("ses_b")
    expect(toolMetadataSessionId(toolPart("task", {}, undefined) as ToolPart)).toBeUndefined()
  })
})

describe("foregroundClaimedChildIds（启动通知闸门/撤回判据，2026-10-08 升格）", () => {
  const children = [child("ses_bg", "Build docs"), child("ses_task", "Review changes")]

  it("权威 metadata.sessionId + 非 background 输入：命中（含 completed——转后台/对账后的撤回依据）", () => {
    const running = foregroundClaimedChildIds(
      [toolPart("task", { description: "Review changes" }, { sessionId: "ses_task" })],
      children,
    )
    expect([...running]).toEqual(["ses_task"])
    const completed = foregroundClaimedChildIds(
      [toolPart("task", { description: "Review changes" }, { sessionId: "ses_task" }, "completed")],
      children,
    )
    expect([...completed]).toEqual(["ses_task"])
  })

  it("权威 metadata.sessionId + background:true：不命中（后台派生，启动提示保留）", () => {
    // running = 派发窗口（progress 已写 metadata、success 未到）；completed = 派发完成
    const running = foregroundClaimedChildIds(
      [toolPart("subagent", { background: true }, { sessionId: "ses_bg" })],
      children,
    )
    expect(running.size).toBe(0)
    const completed = foregroundClaimedChildIds(
      [toolPart("subagent", { background: true }, { sessionId: "ses_bg" }, "completed")],
      children,
    )
    expect(completed.size).toBe(0)
  })

  it("无 metadata 时按 description ↔ title 前缀兜底（仅 pending/running）", () => {
    const running = foregroundClaimedChildIds([toolPart("task", { description: "Review" })], children)
    expect([...running]).toEqual(["ses_task"])
    // completed 且无 metadata：不兜底（权威路径本应已写入）
    const completed = foregroundClaimedChildIds(
      [toolPart("task", { description: "Review" }, undefined, "completed")],
      children,
    )
    expect(completed.size).toBe(0)
  })

  it("兜底 + background:true：不命中（派发窗口即插启动提示，不等 metadata）", () => {
    const ids = foregroundClaimedChildIds([toolPart("subagent", { description: "Build docs", background: true })], children)
    expect(ids.size).toBe(0)
  })

  it("只认 task/subagent 两个 tool", () => {
    const ids = foregroundClaimedChildIds([toolPart("bash", { description: "Review" })], children)
    expect(ids.size).toBe(0)
  })

  it("input 为字符串（SSE 流式/缺口）：不构成前台认领（误插由对账纠正）", () => {
    const ids = foregroundClaimedChildIds([toolPart("subagent", '{"description":"Review')], children)
    expect(ids.size).toBe(0)
  })
})

describe("activeClaimedChildIds（任务条排除判据）", () => {
  const children = [child("ses_bg", "Build docs"), child("ses_task", "Review changes")]

  it("pending/running part 认领（含 background:true 派发窗口）：排除", () => {
    const ids = activeClaimedChildIds(
      [
        toolPart("task", { description: "Review changes" }, { sessionId: "ses_task" }),
        toolPart("subagent", { background: true }, { sessionId: "ses_bg" }),
      ],
      children,
    )
    expect([...ids].sort()).toEqual(["ses_bg", "ses_task"])
  })

  it("completed part 认领不排除：background:true 派发完成与前台转后台都以 part completed + 子会话运行中为后台运行态", () => {
    const ids = activeClaimedChildIds(
      [toolPart("subagent", { background: true }, { sessionId: "ses_bg" }, "completed")],
      children,
    )
    expect(ids.size).toBe(0)
  })

  it("兜底同口径：仅 pending/running", () => {
    const running = activeClaimedChildIds([toolPart("task", { description: "Review" })], children)
    expect([...running]).toEqual(["ses_task"])
    const completed = activeClaimedChildIds(
      [toolPart("task", { description: "Review" }, undefined, "completed")],
      children,
    )
    expect(completed.size).toBe(0)
  })
})

describe("backgroundStartedNotice", () => {
  it("id 稳定、label 回退 id", () => {
    expect(backgroundStartedNotice(child("ses_x", "Task A"))).toMatchObject({
      id: "bg-start:ses_x",
      kind: "background-started",
      label: "Task A",
      childID: "ses_x",
    })
    expect(backgroundStartedNotice(child("ses_y")).label).toBe("ses_y")
  })
})

describe("normalizeBackgroundState", () => {
  it("主枚举与防御性别名", () => {
    expect(normalizeBackgroundState("completed")).toBe("completed")
    expect(normalizeBackgroundState("error")).toBe("error")
    expect(normalizeBackgroundState("failed")).toBe("error")
    expect(normalizeBackgroundState("cancelled")).toBe("cancelled")
    expect(normalizeBackgroundState("interrupted")).toBe("cancelled")
    expect(normalizeBackgroundState("weird")).toBe("completed")
    expect(normalizeBackgroundState(undefined)).toBe("completed")
  })
})

describe("subagentSyntheticNotice", () => {
  it("解析 <subagent> 标签的 description/state/sessionID，label 优先标签", () => {
    const n = subagentSyntheticNotice("msg_s", 500, {
      text: '<subagent sessionID="ses_c" state="error" description="Build docs">done</subagent>',
      metadata: { source: "subagent", childID: "ses_c", agent: "general", state: "error" },
    })
    expect(n).toMatchObject({
      id: "msg_s",
      kind: "background-finished",
      created: 500,
      state: "error",
      childID: "ses_c",
      label: "Build docs",
    })
  })

  it("无标签时回退 payload.description / agent / childID", () => {
    const n = subagentSyntheticNotice("msg_s", 1, {
      description: "desc",
      metadata: { source: "subagent", state: "completed", agent: "explore" },
    })
    expect(n?.label).toBe("desc")
    const byAgent = subagentSyntheticNotice("msg_s2", 2, {
      metadata: { source: "subagent", state: "completed", agent: "explore" },
    })
    expect(byAgent?.label).toBe("explore")
    const byChild = subagentSyntheticNotice("msg_s3", 3, {
      metadata: { source: "subagent", state: "completed", childID: "ses_c" },
    })
    expect(byChild?.label).toBe("ses_c")
  })

  it("非 subagent synthetic 返回 null", () => {
    expect(subagentSyntheticNotice("msg_s", 1, { metadata: { source: "other" } })).toBeNull()
    expect(subagentSyntheticNotice("msg_s", 1, {})).toBeNull()
  })
})

describe("mergeNotices", () => {
  const a: SessionNotice = { id: "n1", kind: "background-started", created: 10, label: "a" }
  const b: SessionNotice = { id: "n2", kind: "background-finished", created: 20, label: "b", state: "completed" }

  it("去重并按 created 排序", () => {
    expect(mergeNotices([b], [a])?.map((n) => n.id)).toEqual(["n1", "n2"])
  })

  it("无变化返回 null；同名覆盖更新", () => {
    expect(mergeNotices([a, b], [])).toBeNull()
    expect(mergeNotices([a], [a])).toBeNull()
    const updated = mergeNotices([a], [{ ...a, label: "a2" }])
    expect(updated?.find((n) => n.id === "n1")?.label).toBe("a2")
  })

  it("首次插入返回排序数组", () => {
    expect(mergeNotices(undefined, [b, a])?.map((n) => n.id)).toEqual(["n1", "n2"])
    expect(mergeNotices(undefined, [])).toBeNull()
  })
})

describe("withdrawForegroundStartNotices", () => {
  const start: SessionNotice = { id: "bg-start:ses_c", kind: "background-started", created: 1, label: "x", childID: "ses_c" }
  const done: SessionNotice = { id: "msg_s", kind: "background-finished", created: 2, label: "y", childID: "ses_c", state: "completed" }

  it("前台认领的启动提示被移除，完成提示与无关提示保留", () => {
    const other: SessionNotice = { ...start, id: "bg-start:ses_other", childID: "ses_other" }
    const kept = withdrawForegroundStartNotices([start, done, other], new Set(["ses_c"]))
    expect(kept?.map((n) => n.id)).toEqual(["msg_s", "bg-start:ses_other"])
  })

  it("无认领集返回 null（无变化）", () => {
    expect(withdrawForegroundStartNotices([start], new Set())).toBeNull()
    expect(withdrawForegroundStartNotices([start], new Set(["ses_z"]))).toBeNull()
  })
})
