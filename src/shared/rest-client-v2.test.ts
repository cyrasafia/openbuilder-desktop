/**
 * RestClientV2 契约测试（docs/plan-v2-protocol.md M0）：
 * URL 构建（deepObject/flat 双风格并存）、Basic 鉴权头、{data, cursor} envelope、
 * 空体容忍、错误分类（401 auth / 400 透传）。fetch 走构造注入，不依赖网络。
 */
import { describe, expect, it } from "vitest"
import { ApiError, RestClientV2 } from "./rest-client-v2"

function mkClient(handler: (url: string, init: RequestInit) => Response, opts?: { password?: string }) {
  return new RestClientV2({
    baseUrl: "http://server/",
    password: opts?.password,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
      handler(String(url), init ?? {})) as typeof fetch,
  })
}

describe("serverInfo / listProjects", () => {
  it("GET /api/info 与 /api/project：路径正确", async () => {
    const seen: string[] = []
    const client = mkClient((url) => {
      seen.push(url)
      if (url.endsWith("/api/info")) {
        return new Response(JSON.stringify({ version: "2.0.18", pid: 1, urls: [], paths: { tmp: "/tmp" } }))
      }
      return new Response(JSON.stringify([]))
    })
    await expect(client.serverInfo()).resolves.toMatchObject({ version: "2.0.18" })
    await expect(client.listProjects()).resolves.toEqual([])
    expect(seen).toEqual(["http://server/api/info", "http://server/api/project"])
  })
})

describe("resolveLocation（deepObject query）", () => {
  it("directory 编码为 location[directory]（[] 转义）；省略 = 无 query", async () => {
    let called = ""
    const client = mkClient((url) => {
      called = url
      return new Response(JSON.stringify({ directory: "/repo", project: { id: "p1", directory: "/repo", canonical: "/repo" } }))
    })
    await client.resolveLocation("/repo")
    expect(called).toBe("http://server/api/location?location%5Bdirectory%5D=%2Frepo")
    await client.resolveLocation()
    expect(called).toBe("http://server/api/location")
  })
})

describe("listSessions（flat query + envelope）", () => {
  it("query 全量透传：directory/limit/order/search；parentID null → 字符串 \"null\"", async () => {
    let called = ""
    const client = mkClient((url) => {
      called = url
      return new Response(JSON.stringify({ data: [], cursor: {} }))
    })
    await client.listSessions({ directory: "/repo", limit: 50, order: "desc", search: "x", parentID: null })
    expect(called).toBe(
      "http://server/api/session?directory=%2Frepo&limit=50&order=desc&search=x&parentID=null",
    )
  })

  it("parentID 具体值原样透传；cursor 透传；无输入 = 裸路径", async () => {
    let called = ""
    const client = mkClient((url) => {
      called = url
      return new Response(JSON.stringify({ data: [], cursor: {} }))
    })
    await client.listSessions({ parentID: "ses_1", cursor: "CUR" })
    expect(called).toBe("http://server/api/session?parentID=ses_1&cursor=CUR")
    await client.listSessions()
    expect(called).toBe("http://server/api/session")
  })

  it("{data, cursor} envelope 解析（双向游标）", async () => {
    const client = mkClient(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "ses_1", projectID: "p1", time: { created: 1, updated: 2 }, location: { directory: "/r" } },
            ],
            cursor: { previous: "P", next: "N" },
          }),
        ),
    )
    const page = await client.listSessions({ directory: "/r" })
    expect(page.data).toHaveLength(1)
    expect(page.data[0].location.directory).toBe("/r")
    expect(page.cursor).toEqual({ previous: "P", next: "N" })
  })

  it("空响应体：ApiError（unknown/空响应），v2 读端点必有 JSON 体", async () => {
    const client = mkClient(() => new Response(""))
    await expect(client.listSessions()).rejects.toMatchObject({ kind: "unknown" })
    await expect(client.serverInfo()).rejects.toMatchObject({ kind: "unknown" })
  })

  it("200 + HTML（v1 server SPA fallback 形态）：ApiError unsupported，不裸抛 SyntaxError", async () => {
    const client = mkClient(() => new Response("<!doctype html><html>…</html>", { headers: { "content-type": "text/html" } }))
    const err = await client.serverInfo().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ kind: "unsupported", status: 200 })
  })
})

describe("会话域（M2）", () => {
  it("createSession：POST /api/session，payload 为 location 对象 + 透传字段；响应取 data", async () => {
    let seenUrl = ""
    let seenBody = ""
    const client = mkClient((_url, init) => {
      seenUrl = _url
      seenBody = String(init.body)
      return new Response(
        JSON.stringify({
          data: { id: "ses_1", projectID: "p1", time: { created: 1, updated: 1 }, location: { directory: "/r" } },
        }),
      )
    })
    const s = await client.createSession({
      directory: "/r",
      title: "t",
      agent: "agent",
      model: { id: "m1", providerID: "prov" },
    })
    expect(s.id).toBe("ses_1")
    expect(seenUrl).toBe("http://server/api/session")
    expect(JSON.parse(seenBody)).toEqual({
      location: { directory: "/r" },
      title: "t",
      agent: "agent",
      model: { id: "m1", providerID: "prov" },
    })
  })

  it("updateSession：PATCH /api/session/:id，body 透传；204 走 fetchResponse（无 JSON 解析）", async () => {
    let seenUrl = ""
    let seenBody = ""
    let seenMethod = ""
    const client = mkClient((_url, init) => {
      seenUrl = _url
      seenBody = String(init.body)
      seenMethod = init.method ?? ""
      return new Response(null, { status: 204 })
    })
    await client.updateSession("ses_1", { title: "x", metadata: { archivedAt: 9 } })
    expect(seenUrl).toBe("http://server/api/session/ses_1")
    expect(seenMethod).toBe("PATCH")
    expect(JSON.parse(seenBody)).toEqual({ title: "x", metadata: { archivedAt: 9 } })
  })

  it("deleteSession：DELETE /api/session/:id（无 directory query），204 容忍空体", async () => {
    let seenUrl = ""
    let seenMethod = ""
    const client = mkClient((_url, init) => {
      seenUrl = _url
      seenMethod = init.method ?? ""
      return new Response(null, { status: 204 })
    })
    await client.deleteSession("ses_1")
    expect(seenUrl).toBe("http://server/api/session/ses_1")
    expect(seenMethod).toBe("DELETE")
  })

  it("deleteWorktree：DELETE /api/worktree，payload 含必填 force（缺省 false）", async () => {
    let seenBody = ""
    const client = mkClient((_url, init) => {
      seenBody = String(init.body)
      return new Response(null, { status: 204 })
    })
    await client.deleteWorktree("p1", "/repo/.wt")
    expect(seenBody).toBe(JSON.stringify({ projectID: "p1", directory: "/repo/.wt", force: false }))
    // forceRequired 错误（脏 worktree）透传为 ApiError
    const dirty = mkClient(() => new Response(JSON.stringify({ name: "WorktreeError", data: { forceRequired: true } }), { status: 400 }))
    await expect(dirty.deleteWorktree("p1", "/repo/.wt")).rejects.toMatchObject({ status: 400 })
  })
})

describe("鉴权与错误分类", () => {
  it("Basic 头注入（用户名缺省 opencode）", async () => {
    let auth = ""
    const client = mkClient((_url, init) => {
      auth = (init.headers as Record<string, string>)["Authorization"]
      return new Response("[]")
    }, { password: "pw" })
    await client.listProjects()
    expect(auth).toBe("Basic " + btoa("opencode:pw"))
  })

  it("非 Latin1 密码（中文）：UTF-8 字节 base64，构造不抛、值可独立复算", async () => {
    let auth = ""
    const client = mkClient((_url, init) => {
      auth = (init.headers as Record<string, string>)["Authorization"]
      return new Response("[]")
    }, { password: "密码123" })
    await client.listProjects()
    const expected =
      "Basic " +
      btoa(String.fromCharCode(...new TextEncoder().encode("opencode:密码123")))
    expect(auth).toBe(expected)
  })

  it("401 → auth 分类；400 → 状态码透传（ApiError）", async () => {
    const client = mkClient(() => new Response("{}", { status: 401 }))
    await expect(client.serverInfo()).rejects.toMatchObject({ kind: "auth", status: 401 })
    const c400 = mkClient(() => new Response("{}", { status: 400 }))
    await expect(c400.listSessions({ cursor: "bad" })).rejects.toBeInstanceOf(ApiError)
    await expect(c400.listSessions({ cursor: "bad" })).rejects.toMatchObject({ status: 400 })
  })
})
