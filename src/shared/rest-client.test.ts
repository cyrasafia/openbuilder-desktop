/**
 * RestClient cursor 分页契约测试（design-message-history-pagination §4.1）：
 * X-Next-Cursor 头解析 / 无头判穷尽 / before+limit 透传 / 非法 before 400 透传。
 * fetch 走构造注入（fetchImpl），不依赖网络。
 */
import { describe, expect, it } from "vitest"
import { ApiError, RestClient } from "./rest-client"

function mkClient(handler: (url: string, init: RequestInit) => Response) {
  return new RestClient({
    baseUrl: "http://server",
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
      handler(String(url), init ?? {})) as typeof fetch,
  })
}

const MSG = (id: string, created: number) => ({
  info: { id, role: "user", time: { created } },
  parts: [],
})

describe("listMessagesPage", () => {
  it("带 X-Next-Cursor 头：解析为 nextCursor（还有更早历史）", async () => {
    const client = mkClient(() =>
      new Response(JSON.stringify([MSG("m2", 2), MSG("m1", 1)]), {
        headers: { "X-Next-Cursor": "Y3Vyc29y" },
      }),
    )
    const page = await client.listMessagesPage("ses_1", "/repo", { limit: 100 })
    expect(page.entries.map((m) => m.info.id)).toEqual(["m2", "m1"])
    expect(page.nextCursor).toBe("Y3Vyc29y")
  })

  it("无头：nextCursor null（历史穷尽或旧 server 全量）", async () => {
    const client = mkClient(() => new Response(JSON.stringify([MSG("m1", 1)])))
    const page = await client.listMessagesPage("ses_1", "/repo", { limit: 100 })
    expect(page.nextCursor).toBeNull()
    expect(page.entries).toHaveLength(1)
  })

  it("before 与 limit 成对透传到 query；directory 同带", async () => {
    let called = ""
    const client = mkClient((url) => {
      called = url
      return new Response("[]")
    })
    await client.listMessagesPage("ses_1", "/repo", { limit: 100, before: "CUR" })
    expect(called).toBe(
      "http://server/session/ses_1/message?directory=%2Frepo&limit=100&before=CUR",
    )
  })

  it("空响应体：entries 空数组、不抛解析错", async () => {
    const client = mkClient(() => new Response(""))
    const page = await client.listMessagesPage("ses_1", "/repo", { limit: 100 })
    expect(page.entries).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it("非法 before（400）：按 ApiError 透传状态码", async () => {
    const client = mkClient(() => new Response("{}", { status: 400 }))
    await expect(
      client.listMessagesPage("ses_1", "/repo", { limit: 100, before: "bad" }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      client.listMessagesPage("ses_1", "/repo", { limit: 100, before: "bad" }),
    ).rejects.toBeInstanceOf(ApiError)
  })
})
