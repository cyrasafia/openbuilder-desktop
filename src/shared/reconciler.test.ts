import { describe, expect, it, vi } from "vitest"
import { Reconciler } from "./reconciler"
import { RestClient } from "./rest-client"
import type { RestClientV2 } from "./rest-client-v2"
import type { Session } from "./api-types"

function fakeClient() {
  return {
    listSessions: vi.fn(async () => [
      { id: "ses_1", projectID: "p1", directory: "/proj", time: { created: 1, updated: 2 } },
    ] as Session[]),
    listMessages: vi.fn(async () => []),
    listPendingPermissions: vi.fn(async () => []),
    listPendingQuestions: vi.fn(async () => []),
  } as unknown as RestClient
}

/** v2 fake：listSessions/listMessagesPage 经 reconciler 内部 toInternal 收敛——
 *  fake 直接产 v2 wire 形状 */
function fakeClientV2() {
  return {
    listSessions: vi.fn(async () => ({
      data: [
        { id: "ses_1", projectID: "p1", time: { created: 1, updated: 2 }, location: { directory: "/proj" } },
      ],
      cursor: {},
    })),
    listMessagesPage: vi.fn(async () => ({ entries: [], nextCursor: null })),
  } as unknown as RestClientV2
}

function makeReconciler(overrides: Partial<ConstructorParameters<typeof Reconciler>[0]> = {}) {
  const client = fakeClient()
  const clientV2 = fakeClientV2()
  const onSessions = vi.fn()
  const onMessages = vi.fn()
  const onState = vi.fn()
  const r = new Reconciler({
    client: () => client,
        clientV2: () => clientV2,
    getOpenedDirectories: () => ["/proj"],
    getActiveSessions: () => [{ sessionID: "ses_1", directory: "/proj" }],
    onSessionsSnapshot: onSessions,
    onMessagesSnapshot: onMessages,
    onReconcileStateChange: onState,
    ...overrides,
  })
  return { r, client, clientV2, onSessions, onMessages, onState }
}

describe("Reconciler", () => {
  it("request → 拉会话/消息快照（M3a：状态快照阶段退役，事件驱动）", async () => {
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
      const { r, clientV2 } = makeReconciler()
      r.request()
      await vi.advanceTimersByTimeAsync(500)
      r.request()
      await vi.advanceTimersByTimeAsync(500)
      r.request()
      await vi.advanceTimersByTimeAsync(900)
      expect(clientV2.listSessions).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("对账失败不抛出、状态复位", async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient()
      const clientV2f = fakeClientV2()
      const onState = vi.fn()
      const r = new Reconciler({
        client: () => client,
        clientV2: () => clientV2f,
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

  it("会话快照多目录：单目录失败跳过回调，其余目录与 messages 阶段不受拖垮", async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient()
      // v2 侧目录级失败（/bad 拒绝、/good 正常）
      const clientV2m = fakeClientV2()
      clientV2m.listSessions = vi.fn(async (input: { directory?: string }) => {
        if (input.directory === "/bad") throw new Error("boom")
        return {
          data: [
            {
              id: "ses_1",
              projectID: "p1",
              time: { created: 1, updated: 2 },
              location: { directory: input.directory ?? "/good" },
            },
          ],
          cursor: {},
        }
      }) as never
      const onSessions = vi.fn()
      const onMessages = vi.fn()
      const r = new Reconciler({
        client: () => client,
        clientV2: () => clientV2m,
        getOpenedDirectories: () => ["/bad", "/good"],
        getActiveSessions: () => [{ sessionID: "ses_1", directory: "/good" }],
        onSessionsSnapshot: onSessions,
        onMessagesSnapshot: onMessages,
        onReconcileStateChange: () => {},
      })
      r.request()
      await vi.advanceTimersByTimeAsync(900)
      expect(onSessions).toHaveBeenCalledTimes(1)
      expect(onSessions).toHaveBeenCalledWith("/good", expect.any(Array))
      expect(onMessages).toHaveBeenCalledWith("ses_1", [])
    } finally {
      vi.useRealTimers()
    }
  })
})
