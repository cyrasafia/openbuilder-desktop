import { describe, expect, it, vi } from "vitest"
import { Reconciler } from "./reconciler"
import { RestClient } from "./rest-client"
import type { Session } from "./api-types"

function fakeClient() {
  return {
    listSessions: vi.fn(async () => [
      { id: "ses_1", projectID: "p1", directory: "/proj", time: { created: 1, updated: 2 } },
    ] as Session[]),
    listSessionStatus: vi.fn(async () => ({ ses_1: { type: "busy" } })),
    listMessages: vi.fn(async () => []),
  } as unknown as RestClient
}

function makeReconciler(overrides: Partial<ConstructorParameters<typeof Reconciler>[0]> = {}) {
  const client = fakeClient()
  const onSessions = vi.fn()
  const onMessages = vi.fn()
  const onStatus = vi.fn()
  const onState = vi.fn()
  const r = new Reconciler({
    client: () => client,
    getOpenedDirectories: () => ["/proj"],
    getStatusDirectories: () => ["/proj"],
    getActiveSessions: () => [{ sessionID: "ses_1", directory: "/proj" }],
    onSessionsSnapshot: onSessions,
    onStatusSnapshot: onStatus,
    onMessagesSnapshot: onMessages,
    onReconcileStateChange: onState,
    ...overrides,
  })
  return { r, client, onSessions, onMessages, onStatus, onState }
}

describe("Reconciler", () => {
  it("request → 拉会话/状态/消息快照；状态失败目录回传 null 不拖垮对账", async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient()
      ;(client.listSessionStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"))
      const { r, onSessions, onMessages, onStatus, onState } = makeReconciler({
        client: () => client,
      })
      r.request()
      await vi.advanceTimersByTimeAsync(900) // debounce 800ms
      expect(onSessions).toHaveBeenCalledWith(
        "/proj",
        expect.arrayContaining([expect.objectContaining({ id: "ses_1" })]),
      )
      expect(onStatus).toHaveBeenCalledWith("/proj", null)
      expect(onMessages).toHaveBeenCalledWith("ses_1", [])
      expect(onState).toHaveBeenCalledWith(true)
      expect(onState).toHaveBeenLastCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("request → 状态快照成功目录回传 fresh；目录集用 getStatusDirectories（含非订阅 worktree）", async () => {
    vi.useFakeTimers()
    try {
      const { r, onStatus } = makeReconciler({
        getStatusDirectories: () => ["/proj", "/proj-wt"],
      })
      r.request()
      await vi.advanceTimersByTimeAsync(900)
      expect(onStatus).toHaveBeenCalledWith("/proj", { ses_1: { type: "busy" } })
      expect(onStatus).toHaveBeenCalledWith("/proj-wt", { ses_1: { type: "busy" } })
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
        getStatusDirectories: () => ["/proj"],
        getActiveSessions: () => [],
        onSessionsSnapshot: () => {},
        onStatusSnapshot: () => {},
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

  it("会话快照多目录：单目录失败跳过回调，其余目录与 status/messages 阶段不受拖垮", async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient()
      ;(client.listSessions as ReturnType<typeof vi.fn>).mockImplementation(
        async (dir: string) => {
          if (dir === "/bad") throw new Error("boom")
          return [{ id: "ses_1", projectID: "p1", directory: dir, time: { created: 1, updated: 2 } }] as Session[]
        },
      )
      const onSessions = vi.fn()
      const onStatus = vi.fn()
      const onMessages = vi.fn()
      const r = new Reconciler({
        client: () => client,
        getOpenedDirectories: () => ["/bad", "/good"],
        getStatusDirectories: () => ["/bad", "/good"],
        getActiveSessions: () => [{ sessionID: "ses_1", directory: "/good" }],
        onSessionsSnapshot: onSessions,
        onStatusSnapshot: onStatus,
        onMessagesSnapshot: onMessages,
        onReconcileStateChange: () => {},
      })
      r.request()
      await vi.advanceTimersByTimeAsync(900)
      expect(onSessions).toHaveBeenCalledTimes(1)
      expect(onSessions).toHaveBeenCalledWith("/good", expect.any(Array))
      expect(onStatus).toHaveBeenCalledTimes(2)
      expect(onMessages).toHaveBeenCalledWith("ses_1", [])
    } finally {
      vi.useRealTimers()
    }
  })
})
