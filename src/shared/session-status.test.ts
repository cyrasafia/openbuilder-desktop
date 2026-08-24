import { describe, expect, it } from "vitest"
import { inferIdleFromMessages, mergeStatusSnapshot } from "./session-status"
import type { Message, SessionStatusValue } from "./api-types"

function assistant(finish: string | null, created: number): Message {
  return {
    id: `m${created}`,
    sessionID: "ses_1",
    role: "assistant",
    time: { created },
    ...(finish === null ? {} : { finish }),
  } as Message
}

describe("mergeStatusSnapshot", () => {
  it("成功目录 fresh 权威：返回里的会话写入，缺席的本目录来源会话 ⇒ idle", () => {
    const status = new Map<string, SessionStatusValue>([
      ["ses_a", { type: "busy" }],
      ["ses_b", { type: "busy" }],
    ])
    const sources = new Map([
      ["ses_a", "/repo"],
      ["ses_b", "/repo"],
    ])
    const { status: next, sources: nextSources } = mergeStatusSnapshot(
      status,
      sources,
      "/repo",
      { ses_a: { type: "busy" } },
    )
    expect(next.get("ses_a")).toEqual({ type: "busy" })
    expect(next.has("ses_b")).toBe(false) // covered ⇒ idle（默认）
    expect(nextSources.has("ses_b")).toBe(false)
  })

  it("SS-1 回归防护：其他目录来源的 busy 不被本目录快照误清", () => {
    const status = new Map<string, SessionStatusValue>([["ses_wt", { type: "busy" }]])
    const sources = new Map([["ses_wt", "/repo-wt"]])
    // /repo 快照成功但返回空（该目录确实无进行中会话）
    const { status: next } = mergeStatusSnapshot(status, sources, "/repo", {})
    expect(next.get("ses_wt")).toEqual({ type: "busy" })
  })

  it("快照返回 idle ⇒ 清出 map（缺省即 idle；失败目录保留旧值由调用方不调本函数保证）", () => {
    const { status: next, sources: nextSources } = mergeStatusSnapshot(
      new Map([["ses_a", { type: "busy" }]]),
      new Map([["ses_a", "/repo"]]),
      "/repo",
      { ses_a: { type: "idle" } },
    )
    expect(next.size).toBe(0)
    expect(nextSources.size).toBe(0)
  })

  it("retry 状态带 message/attempt 完整保留", () => {
    const retry: SessionStatusValue = {
      type: "retry",
      attempt: 2,
      message: "rate limited",
      next: 30,
    }
    const { status: next, sources: nextSources } = mergeStatusSnapshot(
      new Map(),
      new Map(),
      "/repo",
      { ses_a: retry },
    )
    expect(next.get("ses_a")).toEqual(retry)
    expect(nextSources.get("ses_a")).toBe("/repo")
  })

  it("非法条目（缺 type）跳过", () => {
    const { status: next } = mergeStatusSnapshot(new Map(), new Map(), "/repo", {
      ses_a: undefined as unknown as SessionStatusValue,
    })
    expect(next.size).toBe(0)
  })
})

describe("inferIdleFromMessages", () => {
  it("末条 assistant finish=stop/error ⇒ idle", () => {
    expect(inferIdleFromMessages([assistant("stop", 1)])).toBe(true)
    expect(inferIdleFromMessages([assistant("error", 1)])).toBe(true)
  })

  it("tool-calls（中间步骤）与 null（生成中）不触发", () => {
    expect(inferIdleFromMessages([assistant("tool-calls", 1)])).toBe(false)
    expect(inferIdleFromMessages([assistant(null, 1)])).toBe(false)
  })

  it("末条是 user 消息不触发；空列表不触发", () => {
    const user = { id: "u", sessionID: "s", role: "user", time: { created: 2 } } as Message
    expect(inferIdleFromMessages([assistant("stop", 1), user])).toBe(false)
    expect(inferIdleFromMessages([])).toBe(false)
  })
})
