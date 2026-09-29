import { describe, expect, it, vi } from "vitest"
import { Reconciler } from "./reconciler"
import type { RestClient } from "./rest-client"

function fakeClient() {
  return {
    listSessions: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
  } as unknown as RestClient
}

describe("Reconciler client 判空", () => {
  it("连接拆除（client null）时 reconcile 不抛错且状态复位", async () => {
    vi.useFakeTimers()
    try {
      const onState = vi.fn()
      const r = new Reconciler({
        client: () => null,
        getOpenedDirectories: () => ["/proj"],
        getActiveSessions: () => [],
        onSessionsSnapshot: () => {},
        onMessagesSnapshot: () => {},
        onReconcileStateChange: onState,
      })
      r.request()
      await vi.advanceTimersByTimeAsync(900)
      // 不抛错；状态最终复位为 false（不悬挂"对账中"）
      const calls = onState.mock.calls.map((c) => c[0])
      expect(calls[calls.length - 1]).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
