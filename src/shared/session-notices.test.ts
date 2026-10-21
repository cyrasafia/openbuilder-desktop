import { describe, expect, it } from "vitest"
import type { Part, Session, ToolPart } from "./api-types"
import {
  backgroundStartedNotice,
  backgroundConvertedNotice,
  mergeNotices,
  normalizeBackgroundState,
  subagentSyntheticNotice,
  shellBackgroundDispatchFromPart,
  shellStartedNotice,
  shellConvertedNotice,
  shellSyntheticNotice,
  foregroundClaimedChildIds,
  activeClaimedChildIds,
  convertedBackgroundChildIds,
  toolChildSessionId,
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
  if (status === "error")
    return { ...base, state: { status: "error", input, error: "x", ...(metadata ? { metadata } : {}) } } as ToolPart
  return { ...base, state: { status, input, ...(metadata ? { metadata } : {}) } } as ToolPart
}

describe("toolMetadataSessionId", () => {
  it("读 metadata.sessionId 与 sessionID 两种大小写", () => {
    expect(toolMetadataSessionId(toolPart("task", {}, { sessionId: "ses_a" }) as ToolPart)).toBe("ses_a")
    expect(toolMetadataSessionId(toolPart("subagent", {}, { sessionID: "ses_b" }) as ToolPart)).toBe("ses_b")
    expect(toolMetadataSessionId(toolPart("task", {}, undefined) as ToolPart)).toBeUndefined()
  })
})

describe("toolChildSessionId（面板/认领共用权威判据）", () => {
  it("metadata 双键优先，续跑 input.sessionID 兜底", () => {
    expect(toolChildSessionId(toolPart("subagent", {}, { sessionID: "ses_a" }) as ToolPart)).toBe("ses_a")
    expect(toolChildSessionId(toolPart("subagent", { sessionID: "ses_b" }) as ToolPart)).toBe("ses_b")
    // metadata 在场时不被 input.sessionID 顶掉
    expect(
      toolChildSessionId(
        toolPart("subagent", { sessionID: "ses_input" }, { sessionID: "ses_meta" }) as ToolPart,
      ),
    ).toBe("ses_meta")
  })

  it("两路都缺失（流式字符串 input / 无 metadata）返回 undefined", () => {
    expect(toolChildSessionId(toolPart("subagent", "") as ToolPart)).toBeUndefined()
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

  it("续跑认领：input.sessionID 与 metadata 同为权威（任意 part 状态，REST 持久）", () => {
    const running = foregroundClaimedChildIds(
      [toolPart("subagent", { description: "别的描述", sessionID: "ses_task" })],
      children,
    )
    expect([...running]).toEqual(["ses_task"])
    const completed = foregroundClaimedChildIds(
      [toolPart("subagent", { sessionID: "ses_task" }, undefined, "completed")],
      children,
    )
    expect([...completed]).toEqual(["ses_task"])
  })

  it("续跑 + background:true：非前台认领（后台续跑照插/不撤）", () => {
    const ids = foregroundClaimedChildIds(
      [toolPart("subagent", { sessionID: "ses_bg", background: true })],
      children,
    )
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

describe("backgroundConvertedNotice（③转后台提示）", () => {
  it("id 稳定、kind 区分、created 取合成时刻", () => {
    expect(backgroundConvertedNotice(child("ses_x", "Task A"), 1234)).toMatchObject({
      id: "bg-convert:ses_x",
      kind: "background-converted",
      created: 1234,
      label: "Task A",
      childID: "ses_x",
    })
  })
})

describe("convertedBackgroundChildIds（③转后台检测）", () => {
  const children = [child("ses_fg", "Build docs"), child("ses_bg", "Review changes")]

  it("前台认领 + part completed：命中（调用方再以子会话运行中为闸）", () => {
    const ids = convertedBackgroundChildIds(
      [toolPart("subagent", { description: "Build docs" }, { sessionId: "ses_fg" }, "completed")],
      children,
    )
    expect([...ids]).toEqual(["ses_fg"])
  })

  it("前台认领 + part 仍 running：不命中（还是前台阻塞，未转换）", () => {
    const ids = convertedBackgroundChildIds(
      [toolPart("subagent", { description: "Build docs" }, { sessionId: "ses_fg" })],
      children,
    )
    expect(ids.size).toBe(0)
  })

  it("background:true + part completed：不命中（②派发完成的正常态）", () => {
    const ids = convertedBackgroundChildIds(
      [toolPart("subagent", { background: true }, { sessionId: "ses_bg" }, "completed")],
      children,
    )
    expect(ids.size).toBe(0)
  })

  it("前台认领 + part error：不命中（失败/中断不是转后台）", () => {
    const ids = convertedBackgroundChildIds(
      [toolPart("subagent", { description: "Build docs" }, { sessionId: "ses_fg" }, "error")],
      children,
    )
    expect(ids.size).toBe(0)
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

/* ---------- 后台 shell（design-shell-background，2026-10-20） ---------- */

function shellPart(input: unknown, metadata: Record<string, unknown> | undefined, status = "completed"): Part {
  return toolPart("shell", input, metadata, status)
}

describe("shellBackgroundDispatchFromPart（判据单点化——②③/前台/failed 分流）", () => {
  it("② background:true + metadata status running：命中且非转换", () => {
    expect(
      shellBackgroundDispatchFromPart(shellPart({ command: "npm run dev", background: true }, { shellID: "sh_1", status: "running" })),
    ).toEqual({ shellID: "sh_1", command: "npm run dev", converted: false })
  })

  it("③ background 缺省（前台转后台）：命中且标记转换", () => {
    expect(
      shellBackgroundDispatchFromPart(shellPart({ command: "make build" }, { shellID: "sh_2", status: "running" })),
    ).toEqual({ shellID: "sh_2", command: "make build", converted: true })
  })

  it("前台正常完成（metadata status completed）：排除", () => {
    expect(
      shellBackgroundDispatchFromPart(shellPart({ command: "ls" }, { shellID: "sh_3", status: "completed" })),
    ).toBeUndefined()
  })

  it("无 shellID / 非 shell 工具 / 非 completed（running、error）：排除", () => {
    expect(shellBackgroundDispatchFromPart(shellPart({ command: "ls" }, { status: "running" }))).toBeUndefined()
    expect(shellBackgroundDispatchFromPart(shellPart({ command: "ls" }, undefined))).toBeUndefined()
    expect(
      shellBackgroundDispatchFromPart(toolPart("task", {}, { shellID: "sh_4", status: "running" })),
    ).toBeUndefined()
    expect(
      shellBackgroundDispatchFromPart(shellPart({ command: "ls" }, { shellID: "sh_5", status: "running" }, "running")),
    ).toBeUndefined()
    expect(
      shellBackgroundDispatchFromPart(shellPart({ command: "ls" }, { shellID: "sh_6", status: "running" }, "error")),
    ).toBeUndefined()
  })
})

describe("shellStartedNotice / shellConvertedNotice（id 幂等 + label 兜底）", () => {
  it("id 前缀区分②③；label 空 command 回退 shellID", () => {
    expect(shellStartedNotice("sh_1", "npm run dev", 5)).toMatchObject({
      id: "bg-shell-start:sh_1",
      kind: "background-started",
      label: "npm run dev",
      shellID: "sh_1",
    })
    expect(shellConvertedNotice("sh_2", "", 6)).toMatchObject({
      id: "bg-shell-convert:sh_2",
      kind: "background-converted",
      label: "sh_2",
      shellID: "sh_2",
    })
  })
})

describe("shellSyntheticNotice（source:shell 完成回执解析）", () => {
  const payload = {
    text: '<shell id="job_1" state="completed" command="npm run build">\nok\n</shell>',
    metadata: {
      source: "shell",
      shellID: "sh_1",
      jobID: "job_1",
      state: "completed",
      truncated: false,
    },
  }

  it("source 判别：非 shell 返回 null", () => {
    expect(shellSyntheticNotice("msg_1", 1, { ...payload, metadata: { ...payload.metadata, source: "subagent" } })).toBeNull()
    expect(shellSyntheticNotice("msg_1", 1, { text: "", metadata: undefined })).toBeNull()
  })

  it("label 取 text 内 <shell command>（metadata 无 command 字段）；shellID/state 透传", () => {
    expect(shellSyntheticNotice("msg_1", 1, payload)).toMatchObject({
      id: "msg_1",
      kind: "background-finished",
      label: "npm run build",
      state: "completed",
      shellID: "sh_1",
    })
  })

  it("超时细分（缺口 #1）：state completed + timeout:true → timedOut 独立字段", () => {
    const notice = shellSyntheticNotice("msg_2", 2, {
      ...payload,
      metadata: { ...payload.metadata, state: "completed", timeout: true },
    })
    expect(notice).toMatchObject({ state: "completed", timedOut: true })
  })

  it("state 归一：error/cancelled 别名收敛；label 兜底链 description → shellID", () => {
    expect(
      shellSyntheticNotice("msg_3", 3, { ...payload, metadata: { ...payload.metadata, state: "error" } })?.state,
    ).toBe("error")
    expect(
      shellSyntheticNotice("msg_4", 4, {
        text: "no tag here",
        description: "fallback desc",
        metadata: { source: "shell", shellID: "sh_9", state: "cancelled" },
      }),
    ).toMatchObject({ label: "fallback desc", state: "cancelled", shellID: "sh_9" })
    expect(
      shellSyntheticNotice("msg_5", 5, {
        metadata: { source: "shell", shellID: "sh_8", state: "completed" },
      })?.label,
    ).toBe("sh_8")
  })
})

describe("shellBackgroundDispatchFromPart input 容错（review #2：SSE 缺口下 input 为原始 JSON 字符串）", () => {
  it("字符串 input 可解析：按解析对象分流（②不误判为③）", () => {
    expect(
      shellBackgroundDispatchFromPart(
        shellPart('{"command":"npm run dev","background":true}', { shellID: "sh_s", status: "running" }),
      ),
    ).toEqual({ shellID: "sh_s", command: "npm run dev", converted: false })
  })

  it("字符串 input 不可解析：按缺省处理（converted，label 兜底由 live 守卫不插）", () => {
    expect(
      shellBackgroundDispatchFromPart(shellPart("not json", { shellID: "sh_s", status: "running" })),
    ).toEqual({ shellID: "sh_s", command: "", converted: true })
  })
})
