import { describe, expect, it } from "vitest"
import { inferFailedFromMessages, inferIdleFromMessages } from "./session-status"
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

/** 带 NamedError 错误的 assistant（design-error-message §2 实测契约形态） */
function failedAssistant(name: string, created: number): Message {
  return {
    ...assistant(null, created),
    error: { name, data: { message: "boom" } },
  } as Message
}

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

describe("inferFailedFromMessages（design-error-message §3.4）", () => {
  it("末条 assistant 携带非中止错误 ⇒ failed", () => {
    expect(inferFailedFromMessages([failedAssistant("APIError", 1)])).toBe(true)
    expect(inferFailedFromMessages([failedAssistant("UnknownError", 1)])).toBe(true)
  })

  it("中止（MessageAbortedError）不算失败——用户主动停止", () => {
    expect(inferFailedFromMessages([failedAssistant("MessageAbortedError", 1)])).toBe(false)
  })

  it("无错误 assistant / 末条 user / 空列表不触发", () => {
    const user = { id: "u", sessionID: "s", role: "user", time: { created: 2 } } as Message
    expect(inferFailedFromMessages([assistant("stop", 1)])).toBe(false)
    expect(inferFailedFromMessages([failedAssistant("APIError", 1), user])).toBe(false)
    expect(inferFailedFromMessages([])).toBe(false)
  })
})
