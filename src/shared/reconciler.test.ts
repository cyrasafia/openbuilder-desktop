import { describe, expect, it, vi } from "vitest"
import { Reconciler } from "./reconciler"
import { RestClient } from "./rest-client"
import type { Session } from "./api-types"

function fakeClient() {
  return {
    listSessions: vi.fn(async () => [
      { id: "ses_1", projectID: "p1", directory: "/proj", time: { created: 1, updated: 2 } },
    ] as Session[]),
    listMessages: vi.fn(async () => []),
  } as unknown as RestClient
}

function makeReconciler(overrides: Partial<ConstructorParameters<typeof Reconciler>[0]> = {}) {
  const client = fakeClient()
  const onSessions = vi.fn()
  const onMessages = vi.fn()
  const onState = vi.fn()
  const r = new Reconciler({
    client: () => client,
    getOpenedDirectories: () => ["/proj"],
    getActiveSessions: () => [{ sessionID: "ses_1", directory: "/proj" }],
    onSessionsSnapshot: onSessions,
    onMessagesSnapshot: onMessages,
    onReconcileStateChange: onState,
    ...overrides,
  })
  return { r, client, onSessions, onMessages, onState }
}

describe("Reconciler", () => {
  it("request → 拉会话与消息快照", async () => {
    vi.useFakeTimers()
    try {
      const { r, onSessions, onMessages, onState } = makeReconciler()
      r.request()
      await vi.advanceTimersByTimeAsync(900) // debounce 800ms
      expect(onSessions).toHaveBeenCalledWith(
        "/proj",
        expect.arrayContaining([expect.objectContaining({ id: "ses_1" })]),
      )
      expect(onMessages).toHaveBeenCalledWith("ses_1", [])
      expect(onState).toHaveBeenCalledWith(true)
      expect(onState).toHaveBeenLastCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("短时间多次 request 合并（debounce）", async () => {
    vi.useFakeTimers()
    try {
      const { r, client } = makeReconciler()
      r.request()
      await vi.advanceTimersByTimeAsync(500)
      r.request()
      await vi.advanceTimersByTimeAsync(500)
      r.request()
      await vi.advanceTimersByTimeAsync(900)
      expect(client.listSessions).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("对账失败不抛出、状态复位", async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient()
      ;(client.listSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"))
      const onState = vi.fn()
      const r = new Reconciler({
        client: () => client,
        getOpenedDirectories: () => ["/proj"],
        getActiveSessions: () => [],
        onSessionsSnapshot: () => {},
        onMessagesSnapshot: () => {},
        onReconcileStateChange: onState,
      })
      r.request()
      await vi.advanceTimersByTimeAsync(900)
      expect(onState).toHaveBeenLastCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
