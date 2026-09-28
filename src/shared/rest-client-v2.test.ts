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
  it("GET /api/info 与 /api/project：路径正确、null 容忍为数组", async () => {
    const seen: string[] = []
    const client = mkClient((url) => {
      seen.push(url)
      if (url.endsWith("/api/info")) {
        return new Response(JSON.stringify({ version: "2.0.18", pid: 1, urls: [], paths: { tmp: "/tmp" } }))
      }
      return new Response("")
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

  it("空响应体：data 空、cursor 空对象，不抛解析错", async () => {
    const client = mkClient(() => new Response(""))
    const page = await client.listSessions()
    expect(page).toEqual({ data: [], cursor: {} })
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

  it("401 → auth 分类；400 → 状态码透传（ApiError）", async () => {
    const client = mkClient(() => new Response("{}", { status: 401 }))
    await expect(client.serverInfo()).rejects.toMatchObject({ kind: "auth", status: 401 })
    const c400 = mkClient(() => new Response("{}", { status: 400 }))
    await expect(c400.listSessions({ cursor: "bad" })).rejects.toBeInstanceOf(ApiError)
    await expect(c400.listSessions({ cursor: "bad" })).rejects.toMatchObject({ status: 400 })
  })
})
