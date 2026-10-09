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

  it("中止标记在 v2 事件形态 type 键（{type,message}）同样不算失败（design-session-retry-recovery §2）", () => {
    const eventShaped = {
      ...assistant(null, 1),
      error: { type: "MessageAbortedError", message: "Aborted" },
    } as Message
    expect(inferFailedFromMessages([eventShaped])).toBe(false)
    // v2.0.18 活体值（2026-10-09 核验）：中止 type 是 "aborted" 而非
    // "MessageAbortedError"——打断误投影 failed 红点的根因回归
    const liveShaped = {
      ...assistant(null, 1),
      error: { type: "aborted", message: "Step interrupted" },
    } as Message
    expect(inferFailedFromMessages([liveShaped])).toBe(false)
    // 非中止错误的 v2 事件形态照常投影 failed
    const apiError = {
      ...assistant(null, 2),
      error: { type: "APIError", message: "overloaded" },
    } as Message
    expect(inferFailedFromMessages([apiError])).toBe(true)
  })

  it("无错误 assistant / 末条 user / 空列表不触发", () => {
    const user = { id: "u", sessionID: "s", role: "user", time: { created: 2 } } as Message
    expect(inferFailedFromMessages([assistant("stop", 1)])).toBe(false)
    expect(inferFailedFromMessages([failedAssistant("APIError", 1), user])).toBe(false)
    expect(inferFailedFromMessages([])).toBe(false)
  })
})
