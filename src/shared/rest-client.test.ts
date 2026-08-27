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

describe("超时策略（design-slash-command SC-4）", () => {
  it("sendCommand 不挂超时 signal：同步端点执行完才响应，无限等待", async () => {
    let seen: RequestInit | undefined
    const client = mkClient((_url, init) => {
      seen = init
      return new Response("")
    })
    await client.sendCommand("ses_1", "/repo", "review", "--help")
    expect(seen?.signal).toBeUndefined()
  })

  it("默认端点仍挂 15s AbortSignal（回归防护）", async () => {
    let seen: RequestInit | undefined
    const client = mkClient((_url, init) => {
      seen = init
      return new Response("[]")
    })
    await client.listCommands("/repo")
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
  })
})

// 回滚到指定消息（design-message-revert §3.1）：POST /session/:id/revert|unrevert，
// directory 走 query；body 仅 messageID；409 busy 经 ApiError 透传
describe("revert / unrevert（design-message-revert）", () => {
  const SESSION = JSON.stringify({
    id: "ses_1",
    projectID: "proj1",
    directory: "/repo",
    time: { created: 0, updated: 1 },
    revert: { messageID: "msg_1" },
  })

  it("revertMessage：POST revert，directory 走 query、body 带 messageID、返回 Session", async () => {
    let url = ""
    let seen: RequestInit | undefined
    const client = mkClient((u, init) => {
      url = u
      seen = init
      return new Response(SESSION)
    })
    const s = await client.revertMessage("ses_1", "/repo", "msg_1")
    expect(url).toBe("http://server/session/ses_1/revert?directory=%2Frepo")
    expect(seen?.method).toBe("POST")
    expect(seen?.body).toBe(JSON.stringify({ messageID: "msg_1" }))
    expect(s.revert?.messageID).toBe("msg_1")
  })

  it("unrevertSession：POST unrevert，无 body、返回 Session", async () => {
    let url = ""
    let seen: RequestInit | undefined
    const client = mkClient((u, init) => {
      url = u
      seen = init
      return new Response(SESSION)
    })
    const s = await client.unrevertSession("ses_1", "/repo")
    expect(url).toBe("http://server/session/ses_1/unrevert?directory=%2Frepo")
    expect(seen?.method).toBe("POST")
    expect(seen?.body).toBeUndefined()
    expect(s.id).toBe("ses_1")
  })

  it("409 busy：ApiError 透传状态码", async () => {
    const client = mkClient(() =>
      new Response(JSON.stringify({ _tag: "SessionBusyError" }), { status: 409 }),
    )
    await expect(client.revertMessage("ses_1", "/repo", "msg_1")).rejects.toMatchObject({
      status: 409,
    })
    await expect(client.unrevertSession("ses_1", "/repo")).rejects.toBeInstanceOf(ApiError)
  })
})

describe("listVcsDiff context（参考 openbuilder 086e32d）", () => {
  it("省略 context：恒显式传 3——绕过 server\"整文件作 context\"默认值", async () => {
    let called = ""
    const client = mkClient((url) => {
      called = url
      return new Response("[]")
    })
    await client.listVcsDiff("/repo", "git")
    expect(called).toBe("http://server/vcs/diff?directory=%2Frepo&mode=git&context=3")
  })

  it("显式 context 覆盖默认值", async () => {
    let called = ""
    const client = mkClient((url) => {
      called = url
      return new Response("[]")
    })
    await client.listVcsDiff("/repo", "branch", { context: 10 })
    expect(called).toBe("http://server/vcs/diff?directory=%2Frepo&mode=branch&context=10")
  })
})

describe("readFileContent（design-image-preview §2.1）", () => {
  it("文本文件：返回 type:text 完整对象（不只 content 字符串）", async () => {
    const client = mkClient(() =>
      new Response(JSON.stringify({ type: "text", content: "const x = 1" })),
    )
    await expect(client.readFileContent("/repo", "/repo/a.ts")).resolves.toEqual({
      type: "text",
      content: "const x = 1",
    })
  })

  it("二进制图片：保留 type/encoding/mimeType（预览分发依据）", async () => {
    const client = mkClient(() =>
      new Response(
        JSON.stringify({
          type: "binary",
          content: "QUJD",
          encoding: "base64",
          mimeType: "image/png",
        }),
      ),
    )
    await expect(client.readFileContent("/repo", "/repo/a.png")).resolves.toEqual({
      type: "binary",
      content: "QUJD",
      encoding: "base64",
      mimeType: "image/png",
    })
  })

  it("SVG（type:text 无 mimeType）：不臆造 mimeType", async () => {
    const client = mkClient(() =>
      new Response(JSON.stringify({ type: "text", content: "<svg></svg>" })),
    )
    await expect(client.readFileContent("/repo", "/repo/a.svg")).resolves.toEqual({
      type: "text",
      content: "<svg></svg>",
    })
  })

  it("content 非字符串：抛响应格式异常", async () => {
    const client = mkClient(() => new Response(JSON.stringify({ type: "text" })))
    await expect(client.readFileContent("/repo", "/repo/a")).rejects.toBeInstanceOf(ApiError)
  })
})

describe("pty 端点（design-terminal-tab §1）", () => {
  it("createPty：POST /pty + directory query + body", async () => {
    let hit = ""
    const client = mkClient((url, init) => {
      hit = `${init.method} ${url} ${String(init.body)}`
      return new Response(JSON.stringify({ id: "pty_1", command: "bash", cwd: "/repo", status: "running", pid: 1 }))
    })
    const pty = await client.createPty("/repo", { command: "/bin/bash", cwd: "/repo" })
    expect(pty.id).toBe("pty_1")
    expect(hit).toBe('POST http://server/pty?directory=%2Frepo {"command":"/bin/bash","cwd":"/repo"}')
  })

  it("ptyConnectToken：POST + x-opencode-ticket 头（缺头 403；GET 会落 SPA fallback，实测）", async () => {
    let header = ""
    let method = ""
    const client = mkClient((url, init) => {
      header = ((init.headers as Record<string, string>) ?? {})["x-opencode-ticket"] ?? ""
      method = init.method ?? ""
      return new Response(JSON.stringify({ ticket: "tkt", expires_in: 30 }))
    })
    const ticket = await client.ptyConnectToken("pty_1", "/repo")
    expect(ticket.ticket).toBe("tkt")
    expect(header).toBe("1")
    expect(method).toBe("POST")
  })

  it("updatePtySize/deletePty：PUT/DELETE + size body；ws origin 换 scheme", async () => {
    const calls: string[] = []
    const client = mkClient((url, init) => {
      calls.push(`${init.method} ${url}`)
      return new Response()
    })
    await client.updatePtySize("pty 1", "/repo", { rows: 30, cols: 100 })
    await client.deletePty("pty 1", "/repo")
    expect(calls).toEqual([
      "PUT http://server/pty/pty%201?directory=%2Frepo",
      "DELETE http://server/pty/pty%201?directory=%2Frepo",
    ])
    expect(client.ptyWsOrigin()).toBe("ws://server")
    const https = new RestClient({ baseUrl: "https://s/", fetchImpl: (async () => new Response()) as typeof fetch })
    expect(https.ptyWsOrigin()).toBe("wss://s")
  })
})
