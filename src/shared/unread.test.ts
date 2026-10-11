import { describe, expect, it } from "vitest"
import { isSessionUnread } from "./unread"

const t = (idle?: number, viewed?: number) => ({ time: { created: 1, updated: 1, idle, viewed } })

describe("isSessionUnread（design-unread-marker §2.1）", () => {
  it("无 idle（从未跑完）→ 未读 false", () => {
    expect(isSessionUnread(t())).toBe(false)
  })

  it("idle 存在且无 viewed → 未读", () => {
    expect(isSessionUnread(t(100))).toBe(true)
  })

  it("viewed < idle → 未读", () => {
    expect(isSessionUnread(t(100, 50))).toBe(true)
  })

  it("viewed >= idle → 已读（水位单调）", () => {
    expect(isSessionUnread(t(100, 100))).toBe(false)
    expect(isSessionUnread(t(100, 150))).toBe(false)
  })
})
