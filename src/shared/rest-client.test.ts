/**
 * RestClient 契约测试（docs/plan/plan-v2-protocol.md M0）：
 * URL 构建（deepObject/flat 双风格并存）、Basic 鉴权头、{data, cursor} envelope、
 * 空体容忍、错误分类（401 auth / 400 透传）。fetch 走构造注入，不依赖网络。
 */
import { describe, expect, it } from "vitest"
import { ApiError, RestClient, isLocationNotFoundError } from "./rest-client"

function mkClient(handler: (url: string, init: RequestInit) => Response | Promise<Response>, opts?: { password?: string }) {
  return new RestClient({
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
  it("prompt：请求体带 id（client-minted 锚，design-optimistic-id-anchor）；回执 {data:{id}} 解析返回；无体防御返回 {id:\"\"}", async () => {
    let seenUrl = ""
    let seenBody = ""
    const client = mkClient((_url, init) => {
      seenUrl = _url
      seenBody = String(init.body)
      return new Response(JSON.stringify({ data: { id: "msg_abc", time: { created: 1 } } }))
    })
    const receipt = await client.prompt("ses_1", { id: "msg_abc", text: "hi" })
    expect(receipt).toEqual({ id: "msg_abc" })
    expect(seenUrl).toBe("http://server/api/session/ses_1/prompt")
    expect(JSON.parse(seenBody)).toEqual({ id: "msg_abc", text: "hi" })
    // 无 id 时请求体省略 id 字段（契约可选）
    const client2 = mkClient((_url, init) => {
      seenBody = String(init.body)
      return new Response(JSON.stringify({ data: { id: "msg_x" } }))
    })
    await client2.prompt("ses_1", { text: "hi" })
    expect(JSON.parse(seenBody)).toEqual({ text: "hi" })
    // skills（skill 激活通道，design-slash-command 2026-10-12 修订）：非空进
    // body（最简 {id} 形态）、空数组省略——与 files 同为可选数组字段
    const clientSkills = mkClient((_url, init) => {
      seenBody = String(init.body)
      return new Response(JSON.stringify({ data: { id: "msg_s" } }))
    })
    await clientSkills.prompt("ses_1", {
      text: "/opencode x",
      files: [{ uri: "data:text/plain;base64,aGk=", name: "t.txt" }],
      skills: [{ id: "opencode" }],
    })
    expect(JSON.parse(seenBody)).toEqual({
      text: "/opencode x",
      files: [{ uri: "data:text/plain;base64,aGk=", name: "t.txt" }],
      skills: [{ id: "opencode" }],
    })
    await clientSkills.prompt("ses_1", { text: "hi", skills: [] })
    expect(JSON.parse(seenBody)).toEqual({ text: "hi" })
    // 无体（防御形态）：{id: ""} 降级，不抛
    const client3 = mkClient(() => new Response(null, { status: 200 }))
    const empty = await client3.prompt("ses_1", { text: "hi" })
    expect(empty).toEqual({ id: "" })
  })

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

  it("updateSession：archived 官方归档字段透传（2.1.3 组合 PATCH，design-archive-official-api §2）", async () => {
    let seenBody = ""
    const client = mkClient((_url, init) => {
      seenBody = String(init.body)
      return new Response(null, { status: 204 })
    })
    await client.updateSession("ses_1", { archived: false, metadata: { keep: 1 } })
    expect(JSON.parse(seenBody)).toEqual({ archived: false, metadata: { keep: 1 } })
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

  it("getSession：GET /api/session/:id，解 {data} envelope（time.idle/viewed 透传）", async () => {
    let seenUrl = ""
    const client = mkClient((url) => {
      seenUrl = url
      return new Response(
        JSON.stringify({
          data: {
            id: "ses_1",
            projectID: "p1",
            time: { created: 1, updated: 2, idle: 100, viewed: 50 },
            location: { directory: "/repo" },
          },
        }),
      )
    })
    const info = await client.getSession("ses_1")
    expect(seenUrl).toBe("http://server/api/session/ses_1")
    expect(info.time).toMatchObject({ idle: 100, viewed: 50 })
  })

  it("markSessionViewed：POST /api/session/:id/view，body {idle}，204 容忍空体", async () => {
    let seenUrl = ""
    let seenMethod = ""
    let seenBody = ""
    const client = mkClient((_url, init) => {
      seenUrl = _url
      seenMethod = init.method ?? ""
      seenBody = String(init.body)
      return new Response(null, { status: 204 })
    })
    await client.markSessionViewed("ses_1", 12345)
    expect(seenUrl).toBe("http://server/api/session/ses_1/view")
    expect(seenMethod).toBe("POST")
    expect(JSON.parse(seenBody)).toEqual({ idle: 12345 })
  })

  it("deleteWorktree：DELETE /api/worktree，payload 含必填 force（缺省 false）", async () => {
    let seenBody = ""
    const client = mkClient((_url, init) => {
      seenBody = String(init.body)
      return new Response(null, { status: 204 })
    })
    await client.deleteWorktree("p1", "/repo/.wt")
    expect(seenBody).toBe(JSON.stringify({ projectID: "p1", directory: "/repo/.wt", force: false }))
    // typed error（脏 worktree 的 WorktreeError 400）透传为 ApiError（body 保留）
    const dirty = mkClient(() => new Response(JSON.stringify({ name: "WorktreeError", data: { forceRequired: true } }), { status: 400 }))
    await expect(dirty.deleteWorktree("p1", "/repo/.wt")).rejects.toMatchObject({ status: 400 })
  })
})

describe("worktree 库存直连（2026-09-29：v2 权威源）", () => {
  it("listWorktrees：GET /api/worktree?projectID=，裸数组（无 envelope），strategy 缺省容忍", async () => {
    let seenUrl = ""
    const client = mkClient((url) => {
      seenUrl = url
      return new Response(
        JSON.stringify([
          { directory: "/repo", strategy: undefined },
          { directory: "/data/worktree/abc123/wt1", strategy: "git" },
        ]),
      )
    })
    const list = await client.listWorktrees("p1")
    expect(seenUrl).toBe("http://server/api/worktree?projectID=p1")
    expect(list).toEqual([
      { directory: "/repo", strategy: undefined },
      { directory: "/data/worktree/abc123/wt1", strategy: "git" },
    ])
  })

  it("createWorktree：POST /api/worktree，响应是裸 {directory}（无 {data} envelope）", async () => {
    let seenBody = ""
    const client = mkClient((_url, init) => {
      seenBody = String(init.body)
      // 2.0.18 活体：裸 Worktree.Info，不包 {data:...}——曾按 envelope 解析致
      // result.directory undefined、createWorkspace 报 TypeError
      return new Response(JSON.stringify({ directory: "/data/worktree/abc123/wt9" }))
    })
    const result = await client.createWorktree("p1")
    expect(seenBody).toBe(JSON.stringify({ projectID: "p1" }))
    expect(result).toEqual({ directory: "/data/worktree/abc123/wt9" })
    // name 可选透传
    await client.createWorktree("p1", { name: "feat-x" })
    expect(seenBody).toBe(JSON.stringify({ projectID: "p1", name: "feat-x" }))
  })

  it("vcsStatus：GET /api/vcs/status?location[directory]=（deepObject query），裸 {location,data} 解包", async () => {
    let seenUrl = ""
    const client = mkClient((url) => {
      seenUrl = url
      // 2.0.18 活体：裸 Location+data，不包 envelope；未跟踪文件报 added +0/+0
      return new Response(
        JSON.stringify({
          location: { directory: "/data/worktree/abc123/wt1" },
          data: [
            { file: "sample/Luna_Cat.png", additions: 0, deletions: 0, status: "added" },
            { file: "src/a.ts", additions: 3, deletions: 1, status: "modified" },
          ],
        }),
      )
    })
    const files = await client.vcsStatus("/data/worktree/abc123/wt1")
    expect(seenUrl).toBe("http://server/api/vcs/status?location%5Bdirectory%5D=%2Fdata%2Fworktree%2Fabc123%2Fwt1")
    expect(files).toEqual([
      { file: "sample/Luna_Cat.png", additions: 0, deletions: 0, status: "added" },
      { file: "src/a.ts", additions: 3, deletions: 1, status: "modified" },
    ])
  })

  it("refreshWorktrees：POST /api/worktree/refresh，payload {projectID}，204 容忍空体", async () => {
    const seen: Array<{ url: string; method: string; body: string }> = []
    const client = mkClient((url, init) => {
      seen.push({ url, method: init.method ?? "", body: String(init.body) })
      return new Response(null, { status: 204 })
    })
    await client.refreshWorktrees("p1")
    expect(seen).toEqual([
      { url: "http://server/api/worktree/refresh", method: "POST", body: JSON.stringify({ projectID: "p1" }) },
    ])
  })

  it("evictLocation：DELETE /api/debug/location?location[directory]=（debug 组端点，pin 含），204 容忍空体", async () => {
    const seen: Array<{ url: string; method: string }> = []
    const client = mkClient((url, init) => {
      seen.push({ url, method: init.method ?? "GET" })
      return new Response(null, { status: 204 })
    })
    await client.evictLocation("/data/worktree/abc123/wt1")
    // directory 必填（签名层面杜绝裸调——requestRef 缺参兜底 process.cwd() 会误
    // evict server cwd 的 location）；deepObject query 同 location 组风格
    expect(seen).toEqual([
      {
        url: "http://server/api/debug/location?location%5Bdirectory%5D=%2Fdata%2Fworktree%2Fabc123%2Fwt1",
        method: "DELETE",
      },
    ])
  })
})

describe("runShell（design-worktree-branch-sync：POST /api/shell 至终态）", () => {
  it("POST 即终态：payload {command,cwd,timeout}，读 output，best-effort DELETE", async () => {
    const seen: Array<{ url: string; method: string }> = []
    let seenBody = ""
    const client = mkClient((url, init) => {
      // GET 无 method（fetchJson 不传 init）——按 URL 分流，method 缺省记 GET
      seen.push({ url, method: init.method ?? "GET" })
      if (url.endsWith("/api/shell") && init.method === "POST") {
        seenBody = String(init.body)
        // 2.0.18 活体：{data} envelope；status 直接终态（快命令常见）
        return new Response(JSON.stringify({ data: { id: "sh_1", status: "exited", exit: 0 } }))
      }
      if (url.endsWith("/api/shell/sh_1/output")) {
        return new Response(JSON.stringify({ data: { output: "切换到一个新分支 'opencode/wt'\n", cursor: 40, size: 40 } }))
      }
      return new Response(null, { status: 204 }) // DELETE 清理
    })
    const r = await client.runShell("git switch -c opencode/wt", { cwd: "/wt", timeoutMs: 15000 })
    expect(r).toEqual({ exit: 0, output: "切换到一个新分支 'opencode/wt'\n" })
    expect(seenBody).toBe(
      JSON.stringify({ command: "git switch -c opencode/wt", cwd: "/wt", timeout: 15000 }),
    )
    expect(seen.map((s) => s.method + " " + s.url.split("http://server")[1])).toEqual([
      "POST /api/shell",
      "GET /api/shell/sh_1/output",
      "DELETE /api/shell/sh_1",
    ])
  })

  it("running → 轮询 GET /api/shell/:id 至 exited，透传 exit code", async () => {
    let polls = 0
    const client = mkClient((url, init) => {
      if (init.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "sh_2", status: "running" } }))
      }
      if (url.endsWith("/api/shell/sh_2/output")) {
        return new Response(JSON.stringify({ data: { output: "fatal: 分支已存在" } }))
      }
      if (init.method === "DELETE") {
        return new Response(null, { status: 204 })
      }
      // GET /api/shell/sh_2（轮询）：首轮即终态
      polls += 1
      return new Response(JSON.stringify({ data: { id: "sh_2", status: "exited", exit: 1 } }))
    })
    const r = await client.runShell("git switch -c x", { timeoutMs: 5000 })
    expect(polls).toBe(1) // 300ms 间隔后首轮即终态
    expect(r).toEqual({ exit: 1, output: "fatal: 分支已存在" })
  })

  it("超时：deadline 内未退出抛 ApiError(timeout)，不再取 output", async () => {
    const client = mkClient((url, init) => {
      if (url.endsWith("/api/shell") && init.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "sh_3", status: "running" } }))
      }
      return new Response(JSON.stringify({ data: { id: "sh_3", status: "running" } }))
    })
    // timeoutMs 1：首轮 300ms 轮询后仍 running → 判超时（ApiError timeout）
    await expect(client.runShell("sleep 100", { timeoutMs: 1 })).rejects.toMatchObject({
      kind: "timeout",
    })
  })
})

describe("待办人机交互与会话切换（M6a）", () => {
  function recorder(): {
    seen: Array<{ url: string; method: string; body: unknown }>
    client: ReturnType<typeof mkClient>
  } {
    const seen: Array<{ url: string; method: string; body: unknown }> = []
    const client = mkClient((url, init) => {
      seen.push({
        url,
        method: init.method ?? "",
        body: init.body ? (JSON.parse(String(init.body)) as unknown) : null,
      })
      return new Response(null, { status: 204 })
    })
    return { seen, client }
  }

  it("respondPermission：POST /api/session/:id/permission/:requestID/reply，body {decision}", async () => {
    const { seen, client } = recorder()
    await client.respondPermission("ses_1", "per_9", "always")
    expect(seen[0]).toEqual({
      url: "http://server/api/session/ses_1/permission/per_9/reply",
      method: "POST",
      body: { decision: "always" },
    })
  })

  it("replyForm：POST /api/session/:id/form/:formID/reply，body {answer}（键 = field.key）", async () => {
    const { seen, client } = recorder()
    await client.replyForm("ses_1", "frm_1", { branch: "main", tags: ["a"], force: true, n: 2 })
    expect(seen[0]).toEqual({
      url: "http://server/api/session/ses_1/form/frm_1/reply",
      method: "POST",
      body: { answer: { branch: "main", tags: ["a"], force: true, n: 2 } },
    })
  })

  it("cancelForm：DELETE /api/session/:id/form/:formID（无 body）", async () => {
    const { seen, client } = recorder()
    await client.cancelForm("ses_1", "frm_1")
    expect(seen[0]).toEqual({
      url: "http://server/api/session/ses_1/form/frm_1",
      method: "DELETE",
      body: null,
    })
  })

  it("switchAgent / switchModel：POST /api/session/:id/{agent,model}；model variant 条件包含", async () => {
    const { seen, client } = recorder()
    await client.switchAgent("ses_1", "build")
    await client.switchModel("ses_1", { id: "m1", providerID: "prov" })
    await client.switchModel("ses_1", { id: "m1", providerID: "prov", variant: "high" })
    expect(seen[0]).toEqual({
      url: "http://server/api/session/ses_1/agent",
      method: "POST",
      body: { agent: "build" },
    })
    expect(seen[1]).toEqual({
      url: "http://server/api/session/ses_1/model",
      method: "POST",
      body: { model: { id: "m1", providerID: "prov" } },
    })
    expect(seen[2]).toEqual({
      url: "http://server/api/session/ses_1/model",
      method: "POST",
      body: { model: { id: "m1", providerID: "prov", variant: "high" } },
    })
  })
})

describe("agent / model 目录（M6b 补换绑）", () => {
  it("listAgents：wire id/name 错位映射——id 是标识符（切换键）落 name，wire name 落 label（活体形状）", async () => {
    const client = mkClient(
      () =>
        new Response(
          JSON.stringify({
            location: { directory: "/r" },
            data: [
              { id: "build", name: "Build", mode: "primary", hidden: false },
              { id: "general", name: "General", mode: "subagent", hidden: false },
            ],
          }),
        ),
    )
    const agents = await client.listAgents("/r")
    expect(agents).toEqual([
      { name: "build", label: "Build", description: undefined, mode: "primary", hidden: false },
      { name: "general", label: "General", description: undefined, mode: "subagent", hidden: false },
    ])
  })

  it("listModels：deepObject location + envelope 解包", async () => {
    const seen: string[] = []
    const client = mkClient((url) => {
      seen.push(url)
      return new Response(
        JSON.stringify({ location: { directory: "/r" }, data: [{ id: "x", providerID: "p", enabled: true }] }),
      )
    })
    await client.listModels("/r")
    expect(seen).toEqual(["http://server/api/model?location%5Bdirectory%5D=%2Fr"])
  })
})

describe("Provider 凭据（design-provider-config v2 恢复，A1）", () => {
  it("listIntegrations：deepObject location + envelope 解包", async () => {
    const seen: string[] = []
    const client = mkClient((url) => {
      seen.push(url)
      return new Response(
        JSON.stringify({
          location: { directory: "/r" },
          data: [
            {
              id: "deepseek",
              name: "DeepSeek",
              methods: [{ type: "key" }],
              connections: [
                { type: "credential", id: "cred_1", label: "API key", method: "key" },
              ],
            },
          ],
        }),
      )
    })
    const items = await client.listIntegrations("/r")
    expect(seen).toEqual(["http://server/api/integration?location%5Bdirectory%5D=%2Fr"])
    expect(items[0]?.connections[0]).toMatchObject({ type: "credential", id: "cred_1", method: "key" })
  })

  it("connectIntegrationKey：POST connect/key，body {key} + location query，204 容忍空体", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const client = mkClient((url, init) => {
      seen.push({ url, init })
      return new Response(null, { status: 204 })
    })
    await client.connectIntegrationKey("deep seek", "sk-x", "/r")
    expect(seen[0]?.url).toBe(
      "http://server/api/integration/deep%20seek/connect/key?location%5Bdirectory%5D=%2Fr",
    )
    expect(seen[0]?.init.method).toBe("POST")
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ key: "sk-x" })
  })

  it("removeCredential：DELETE /api/credential/:id（无 location query），204", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const client = mkClient((url, init) => {
      seen.push({ url, init })
      return new Response(null, { status: 204 })
    })
    await client.removeCredential("cred_1")
    expect(seen[0]?.url).toBe("http://server/api/credential/cred_1")
    expect(seen[0]?.init.method).toBe("DELETE")
  })

  it("removeCredential：404（2.0.18–22 无路由）按 not-found 分类抛 ApiError", async () => {
    const client = mkClient(
      () => new Response(JSON.stringify({ _tag: "NotFoundError", message: "not found" }), { status: 404 }),
    )
    await expect(client.removeCredential("cred_1")).rejects.toMatchObject({
      status: 404,
      kind: "not-found",
    })
  })
})

describe("文件系统（M6b）", () => {
  it("listFiles：Entry 相对 path + 响应 location 为基址拼 absolute；目录尾 / 剥离进 name；ignored 恒 false", async () => {
    // 活体形状（2.0.18）：location 回显**请求** location（不含 path 前缀），
    // Entry.path 含请求 path 前缀（相对请求 location）
    const client = mkClient(() =>
      new Response(
        JSON.stringify({
          location: { directory: "/repo" },
          data: [
            { path: "src/shared/", type: "directory" },
            { path: "src/main/index.ts", type: "file" },
          ],
        }),
      ),
    )
    const nodes = await client.listFiles("/repo", "src")
    expect(nodes).toEqual([
      { name: "shared", path: "src/shared/", absolute: "/repo/src/shared", type: "directory", ignored: false },
      { name: "index.ts", path: "src/main/index.ts", absolute: "/repo/src/main/index.ts", type: "file", ignored: false },
    ])
  })

  it("findFiles：query 透传，返回 Entry.path 数组", async () => {
    let seenUrl = ""
    const client = mkClient((url) => {
      seenUrl = url
      return new Response(JSON.stringify({ data: [{ path: "a.ts", type: "file" }, { path: "d/", type: "directory" }] }))
    })
    const out = await client.findFiles("adapter", "/repo", 20)
    expect(out).toEqual(["a.ts", "d/"])
    expect(seenUrl).toBe("http://server/api/fs/find?location%5Bdirectory%5D=%2Frepo&query=adapter&limit=20")
  })

  it("readFileContent：文本（无 NUL）→ text + UTF-8 解码；路径逐段编码 + deepObject location", async () => {
    let seenUrl = ""
    const client = mkClient((url) => {
      seenUrl = url
      return new Response(new TextEncoder().encode("héllo 你好"), { headers: { "content-type": "text/plain; charset=utf-8" } })
    })
    const fc = await client.readFileContent("/repo", "src/a b?.ts")
    expect(fc).toEqual({ type: "text", content: "héllo 你好" })
    expect(seenUrl).toBe("http://server/api/fs/read/src/a%20b%3F.ts?location%5Bdirectory%5D=%2Frepo")
  })

  it("readFileContent：NUL 嗅探判二进制（.ts 误判 video/mp2t 也能救回文本；真二进制走 base64）", async () => {
    // 真 NUL 字节 → binary（mime 非图片也判二进制）
    const bin = mkClient(() => new Response(new Uint8Array([0x89, 0x50, 0x00, 0x0d]), { headers: { "content-type": "application/octet-stream" } }))
    const fc1 = await bin.readFileContent("/r", "a.png")
    expect(fc1.type).toBe("binary")
    expect(fc1.encoding).toBe("base64")
    expect(fc1.mimeType).toBe("application/octet-stream")
    // .ts 文本被 server 误标 video/mp2t：无 NUL → text（M6b 活体发现的坑）
    const ts = mkClient(() => new Response(new TextEncoder().encode("export {}"), { headers: { "content-type": "video/mp2t" } }))
    expect((await ts.readFileContent("/r", "a.ts")).type).toBe("text")
    // image/* 直判二进制（svg 例外：文本源码）
    const svg = mkClient(() => new Response(new TextEncoder().encode("<svg/>"), { headers: { "content-type": "image/svg+xml" } }))
    expect((await svg.readFileContent("/r", "a.svg")).type).toBe("text")
  })

  // 流式消费（design-file-load-streaming，2026-10-12）：chunk 化 body 的嗅探/增量转换/取消
  it("readFileContent：流式——非图片二进制头 8K 含 NUL 即 cancel，余量不读、不产 base64", async () => {
    let cancelled = false
    const body = new Uint8Array(64 * 1024 + 100)
    body.set([0x28, 0xb5, 0x2f, 0xfd, 0x00], 0) // zstd 魔数 + NUL（嗅探窗口内）
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(body.subarray(0, 30000))
        c.enqueue(body.subarray(30000))
      },
      cancel() {
        cancelled = true
      },
    })
    const client = mkClient(
      () => new Response(stream, { headers: { "content-type": "application/zstd" } }),
    )
    const fc = await client.readFileContent("/r", "a.pkg.tar.zst")
    expect(fc).toEqual({ type: "binary", content: "", encoding: "base64", mimeType: "application/zstd" })
    expect(cancelled).toBe(true)
  })

  it("readFileContent：流式——image/* 分 chunk 增量拼 binary string，完结 btoa + 进度上报", async () => {
    const progress: Array<[number, number | undefined]> = []
    const enc = new TextEncoder()
    const client = mkClient(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode("AB"))
              c.enqueue(enc.encode("C"))
              c.close()
            },
          }),
          { headers: { "content-type": "image/png" } },
        ),
    )
    const fc = await client.readFileContent("/r", "a.png", {
      onProgress: (received, total) => progress.push([received, total]),
    })
    expect(fc).toEqual({ type: "binary", content: "QUJD", encoding: "base64", mimeType: "image/png" })
    expect(progress.map((p) => p[0])).toEqual([2, 3])
  })

  it("readFileContent：流式——文本超 8K 早判 text，多字节序列跨 chunk 增量解码不碎", async () => {
    const enc = new TextEncoder()
    const head = new Uint8Array(8192).fill(0x61) // 无 NUL → 首 chunk 攒满嗅探窗口即判 text
    const tail = enc.encode("a你b")
    const client = mkClient(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(head)
              c.enqueue(tail.subarray(0, 2)) // "你" 的 UTF-8 序列从中间切开
              c.enqueue(tail.subarray(2))
              c.close()
            },
          }),
          { headers: { "content-type": "application/octet-stream" } },
        ),
    )
    const fc = await client.readFileContent("/r", "big.txt")
    expect(fc).toEqual({ type: "text", content: "a".repeat(8192) + "a你b" })
  })

  it("listVcsDiff：mode 映射 git→working、branch 直传；context 恒显式", async () => {
    const seen: string[] = []
    const client = mkClient((url) => {
      seen.push(url)
      return new Response(JSON.stringify({ data: [] }))
    })
    await client.listVcsDiff("/r", "git")
    await client.listVcsDiff("/r", "branch", { context: 5 })
    expect(seen[0]).toBe("http://server/api/vcs/diff?location%5Bdirectory%5D=%2Fr&mode=working&context=3")
    expect(seen[1]).toBe("http://server/api/vcs/diff?location%5Bdirectory%5D=%2Fr&mode=branch&context=5")
  })

  it("listSessionDiff：from 透传（缺省省略）+ context；无 directory 参数", async () => {
    const seen: string[] = []
    const client = mkClient((url) => {
      seen.push(url)
      return new Response(JSON.stringify({ data: [] }))
    })
    await client.listSessionDiff("ses_1", "msg_u1")
    await client.listSessionDiff("ses_1", undefined)
    expect(seen[0]).toBe("http://server/api/session/ses_1/diff?from=msg_u1&context=3")
    expect(seen[1]).toBe("http://server/api/session/ses_1/diff?context=3")
  })
})

describe("pty（M6b，契约活体核对 V2D-2）", () => {
  it("createPty/updatePtySize/deletePty：deepObject location；envelope 解包", async () => {
    const seen: Array<{ url: string; method: string }> = []
    const client = mkClient((url, init) => {
      seen.push({ url, method: init.method ?? "" })
      return new Response(JSON.stringify({ data: { id: "pty_1", command: "", cwd: "/r", status: "running", pid: 1 } }))
    })
    await client.createPty("/r", { cwd: "/r" })
    await client.updatePtySize("pty_1", "/r", { rows: 24, cols: 80 })
    expect(seen).toEqual([
      { url: "http://server/api/pty?location%5Bdirectory%5D=%2Fr", method: "POST" },
      { url: "http://server/api/pty/pty_1?location%5Bdirectory%5D=%2Fr", method: "PUT" },
    ])
    const seenDel: string[] = []
    const del = mkClient((url, init) => {
      seenDel.push(`${init.method} ${url}`)
      return new Response(null, { status: 204 })
    })
    await del.deletePty("pty_1", "/r")
    expect(seenDel).toEqual(["DELETE http://server/api/pty/pty_1?location%5Bdirectory%5D=%2Fr"])
  })

  it("ptyConnectToken：POST + x-opencode-ticket 头（无头 server 403，活体核对）+ envelope 解包", async () => {
    let header = ""
    let method = ""
    const client = mkClient((_url, init) => {
      method = init.method ?? ""
      header = (init.headers as Record<string, string>)["x-opencode-ticket"] ?? ""
      return new Response(JSON.stringify({ data: { ticket: "tkt", expires_in: 60 } }))
    })
    const t = await client.ptyConnectToken("pty_1", "/r")
    expect(t).toEqual({ ticket: "tkt", expires_in: 60 })
    expect(method).toBe("POST")
    expect(header).toBe("1")
  })
})

describe("命令面板与 pending 回填（M6c）", () => {
  it("listCommands：/api/command ∪ /api/skill 合并（skill 带 source 标记）；单源失败保留另一源", async () => {
    const urls: string[] = []
    const both = mkClient((url) => {
      urls.push(url)
      if (url.includes("/api/skill")) {
        return new Response(
          JSON.stringify({ data: [{ id: "report", name: "Report", description: "报告问题" }] }),
        )
      }
      return new Response(JSON.stringify({ data: [{ name: "init", description: "setup" }] }))
    })
    const commands = await both.listCommands("/r")
    expect(commands).toEqual([
      { name: "init", description: "setup" },
      { name: "report", description: "报告问题", source: "skill" },
    ])
    expect(urls).toEqual([
      expect.stringContaining("/api/command?"),
      expect.stringContaining("/api/skill?"),
    ])
    // skill 源 404 → 只剩 command 源（不拖垮）
    const skillDead = mkClient((url) =>
      url.includes("/api/skill")
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify({ data: [{ name: "init" }] })),
    )
    expect(await skillDead.listCommands("/r")).toEqual([{ name: "init" }])
  })

  it("sendCommand：POST /api/session/:id/command，text 恒携带（v2 必填）、files 空则省略", async () => {
    const seen: Array<{ url: string; body: unknown }> = []
    const client = mkClient((url, init) => {
      seen.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(null, { status: 204 })
    })
    await client.sendCommand("ses_1", "review", "--help")
    // 无参命令：text 必须是 ""（省略整个键 = server 400 Missing key ["text"]，
    // 2026-09-29 实测）；undefined（旧签名）同归一为 ""
    await client.sendCommand("ses_1", "init", "", [{ uri: "file:///a.ts", name: "a.ts" }])
    await client.sendCommand("ses_1", "init", undefined)
    expect(seen[0]).toEqual({ url: "http://server/api/session/ses_1/command", body: { name: "review", text: "--help" } })
    expect(seen[1]).toEqual({
      url: "http://server/api/session/ses_1/command",
      body: { name: "init", text: "", files: [{ uri: "file:///a.ts", name: "a.ts" }] },
    })
    expect(seen[2]).toEqual({ url: "http://server/api/session/ses_1/command", body: { name: "init", text: "" } })
  })

  it("listPendingPermissionRequests / listPendingForms：deepObject location + envelope 解包（form 归一化）", async () => {
    const urls: string[] = []
    const client = mkClient((url) => {
      urls.push(url)
      if (url.includes("/api/form")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "frm_1",
                sessionID: "ses_1",
                title: "t",
                fields: [{ key: "k", type: "boolean" }],
              },
            ],
          }),
        )
      }
      return new Response(JSON.stringify({ data: [{ id: "per_1", sessionID: "ses_1", action: "bash", resources: [] }] }))
    })
    const perms = await client.listPendingPermissionRequests("/r")
    expect(perms).toEqual([{ id: "per_1", sessionID: "ses_1", action: "bash", resources: [] }])
    const forms = await client.listPendingForms("/r")
    expect(forms).toHaveLength(1)
    expect(forms[0]).toMatchObject({ id: "frm_1", sessionID: "ses_1", directory: "/r" })
    expect(urls).toEqual([
      "http://server/api/permission/request?location%5Bdirectory%5D=%2Fr",
      "http://server/api/form?location%5Bdirectory%5D=%2Fr",
    ])
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

describe("location 请求屏障（design-worktree-sync §3.5，ref §3.4 三订）", () => {
  it("gate：挂起目录的 location 请求立即拒绝且不发出；resume 后恢复", async () => {
    let fetched = 0
    const client = mkClient(() => {
      fetched++
      return new Response(JSON.stringify({ location: { directory: "/wt" }, data: [] }))
    })
    client.suspendLocationRequests("/wt")
    await expect(client.listFiles("/wt", ".")).rejects.toThrow(/挂起/)
    await expect(client.vcsStatus("/wt")).rejects.toThrow(/挂起/)
    await expect(client.listVcsDiff("/wt", "git")).rejects.toThrow(/挂起/)
    await expect(client.findFiles("q", "/wt")).rejects.toThrow(/挂起/)
    expect(fetched).toBe(0)
    client.resumeLocationRequests("/wt")
    await expect(client.listFiles("/wt", ".")).resolves.toEqual([])
    expect(fetched).toBe(1)
  })

  it("gate 豁免 evictLocation（删除链路自身要用，且其请求只 invalidate 不 boot）", async () => {
    const client = mkClient(() => new Response(null, { status: 204 }))
    client.suspendLocationRequests("/wt")
    await expect(client.evictLocation("/wt")).resolves.toBeUndefined()
  })

  it("gate 不影响其他目录（按目录精确挂起）", async () => {
    const client = mkClient(() =>
      new Response(JSON.stringify({ location: { directory: "/other" }, data: [] })),
    )
    client.suspendLocationRequests("/wt")
    await expect(client.listFiles("/other", ".")).resolves.toEqual([])
  })

  it("barrier：在途未清零时等满超时放行；清零后立即返回", async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let fetched = 0
    const client = mkClient(async () => {
      fetched++
      await held
      return new Response(JSON.stringify({ location: { directory: "/wt" }, data: [] }))
    })
    const pending = client.listFiles("/wt", ".")
    const t0 = Date.now()
    await client.awaitLocationIdle("/wt", 120)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100) // 超时放行（在途未清零）
    release()
    await pending
    const t1 = Date.now()
    await client.awaitLocationIdle("/wt", 5000)
    expect(Date.now() - t1).toBeLessThan(200) // 已清零：立即返回
    expect(fetched).toBe(1)
  })

  it("计数在请求失败后归零（barrier 不悬挂）", async () => {
    const client = mkClient(() => new Response("nope", { status: 500 }))
    await expect(client.vcsStatus("/wt")).rejects.toBeInstanceOf(ApiError)
    const t0 = Date.now()
    await client.awaitLocationIdle("/wt", 5000)
    expect(Date.now() - t0).toBeLessThan(200)
  })
})

describe("结构化错误体（_tag 判别，todo-error-body-tag #1；三形状 2026-10-25 活体）", () => {
  it("扁平 _tag 体（SessionBusyError 409）：tag 提取 + 顶层 message 进错误消息", async () => {
    const client = mkClient(
      () =>
        new Response(JSON.stringify({ _tag: "SessionBusyError", sessionID: "ses_1", message: "session is busy" }), {
          status: 409,
        }),
    )
    const err = (await client.revertStage("ses_1", "msg_1").catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.tag).toBe("SessionBusyError")
    expect(err.message).toContain("session is busy")
    expect(err.locationDirectory).toBeUndefined()
  })

  it("包装体（旧 {name, data} WorktreeError 400）：tag 从 name、message 从 data.message（兼容保留）", async () => {
    const client = mkClient(
      () =>
        new Response(
          JSON.stringify({ name: "WorktreeError", data: { message: "worktree has modifications", forceRequired: true } }),
          { status: 400 },
        ),
    )
    const err = (await client.deleteWorktree("p1", "/wt").catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.tag).toBe("WorktreeError")
    expect(err.message).toContain("worktree has modifications")
  })

  it("_tag+name+data 并存（2.1.3 WorktreeError）：tag 双读取 _tag；顶层 message 优先 data.message", async () => {
    const client = mkClient(
      () =>
        new Response(
          JSON.stringify({ _tag: "WorktreeError", name: "WorktreeError", data: { message: "in-data" }, message: "top" }),
          { status: 400 },
        ),
    )
    const err = (await client.deleteWorktree("p1", "/wt").catch((e: unknown) => e)) as ApiError
    expect(err.tag).toBe("WorktreeError")
    expect(err.message).toContain("top")
    expect(err.message).not.toContain("in-data")
  })

  it("LocationNotFoundError 404：tag + locationDirectory + isLocationNotFoundError 判别", async () => {
    const client = mkClient(
      () =>
        new Response(
          JSON.stringify({
            _tag: "LocationNotFoundError",
            location: { directory: "/wt" },
            message: "Location not found: /wt",
          }),
          { status: 404 },
        ),
    )
    const err = (await client.vcsStatus("/wt").catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.tag).toBe("LocationNotFoundError")
    expect(err.locationDirectory).toBe("/wt")
    expect(isLocationNotFoundError(err)).toBe(true)
    expect(err.message).toContain("Location not found: /wt")
  })

  it("onDeadLocation（todo-error-body-tag #3）：LocationNotFoundError 回执触发（directory = 请求目录）且错误照抛；其他错误与 gate 拒绝不触发", async () => {
    const dead: string[] = []
    const client = mkClient((url) => {
      if (url.includes("/api/vcs/status")) {
        return new Response(
          JSON.stringify({
            _tag: "LocationNotFoundError",
            location: { directory: "/wt" },
            message: "Location not found: /wt",
          }),
          { status: 404 },
        )
      }
      return new Response("boom", { status: 500 })
    })
    client.onDeadLocation = (d) => dead.push(d)
    // 确证回执：错误照抛（消费方判别吸收），回调以请求目录触发
    await expect(client.vcsStatus("/wt")).rejects.toBeInstanceOf(ApiError)
    expect(dead).toEqual(["/wt"])
    // 非 LocationNotFound（500）：不触发
    await expect(client.listFiles("/wt", ".")).rejects.toBeInstanceOf(ApiError)
    expect(dead).toEqual(["/wt"])
    // gate 本地拒绝（删除窗口）：无 server 回执，不构成确证
    client.suspendLocationRequests("/wt")
    await expect(client.findFiles("q", "/wt")).rejects.toThrow(/挂起/)
    client.resumeLocationRequests("/wt")
    expect(dead).toEqual(["/wt"])
  })
})
