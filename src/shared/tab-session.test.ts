/**
 * Tab 会话持久层纯函数测试（design-tab-session-restore §2/§3/§5）。
 */
import { describe, expect, it } from "vitest"
import {
  deriveTabSession,
  orderTabsByTemplate,
  sanitizeTabSession,
  sanitizeTabSessionMap,
  type SessionTabSource,
} from "./tab-session"

function tab(kind: string, key: string, directory = "/repo"): SessionTabSource {
  return { kind, key, projectId: "proj1", directory, title: key }
}

describe("deriveTabSession", () => {
  it("投影全 kind 有序条目；browser 当前页与初始 URL 相同省略 url、不同携带", () => {
    const out = deriveTabSession(
      [
        tab("chat", "chat:s1"),
        tab("file", "file:/repo/a.md"),
        tab("browser", "browser:https://a.dev/"),
        tab("browser", "browser:https://b.dev/"),
        tab("diff", "diff\0/repo"),
      ],
      new Map([
        ["/repo", "file:/repo/a.md"],
        ["/wt", null],
      ]),
      (key) => (key === "browser:https://b.dev/" ? "https://b.dev/x/y" : "https://a.dev/"),
    )
    expect(out.tabs.map((t) => t.kind)).toEqual(["chat", "file", "browser", "browser", "diff"])
    expect(out.tabs[2]).not.toHaveProperty("url")
    expect(out.tabs[3]?.url).toBe("https://b.dev/x/y")
    expect(out.scopeActive).toEqual({ "/repo": "file:/repo/a.md", "/wt": null })
  })

  it("browser 无解析结果（view 已亡）时省略 url，回退初始 URL 语义", () => {
    const out = deriveTabSession([tab("browser", "browser:https://a.dev/")], new Map(), () => undefined)
    expect(out.tabs[0]).not.toHaveProperty("url")
  })
})

describe("orderTabsByTemplate", () => {
  const live = ["a", "b", "c", "d"].map((k) => ({ key: k }))

  it("模板序在前、模板外按原相对序追加尾部", () => {
    expect(orderTabsByTemplate(live, ["c", "a"]).map((t) => t.key)).toEqual(["c", "a", "b", "d"])
  })

  it("模板含死键（未恢复实体）忽略；模板键去重", () => {
    expect(orderTabsByTemplate(live, ["x", "d", "d", "a"]).map((t) => t.key)).toEqual(["d", "a", "b", "c"])
  })

  it("空模板原序返回", () => {
    expect(orderTabsByTemplate(live, []).map((t) => t.key)).toEqual(["a", "b", "c", "d"])
  })
})

describe("sanitizeTabSession / sanitizeTabSessionMap", () => {
  const valid = {
    tabs: [
      { kind: "chat", key: "chat:s1", projectId: "p", directory: "/repo", title: "t" },
      { kind: "file", key: "file:/repo/a.md", projectId: "p", directory: "/repo", title: "a" },
      { kind: "diff", key: "diff\0/repo", projectId: "p", directory: "/repo", title: "diff" },
      {
        kind: "terminal",
        key: "terminal:pty1",
        projectId: "p",
        directory: "/repo",
        title: "zsh",
      },
      { kind: "browser", key: "browser:https://a.dev/", projectId: "p", directory: "/repo", title: "A", url: "https://a.dev/x" },
    ],
    scopeActive: { "/repo": "file:/repo/a.md", "/wt": null },
  }

  it("合法切片原样通过（字段级）", () => {
    const out = sanitizeTabSession(valid)
    expect(out?.tabs).toHaveLength(5)
    expect(out?.scopeActive).toEqual({ "/repo": "file:/repo/a.md", "/wt": null })
  })

  it("逐条剔除非法条目：kind 未知 / 前缀不符 / 空 ident / diff 双 \\0 / 缺字段 / 重复键 / url 非法", () => {
    const out = sanitizeTabSession({
      ...valid,
      tabs: [
        ...valid.tabs,
        { kind: "other", key: "chat:x", projectId: "p", directory: "/r", title: "" }, // kind 未知
        { kind: "chat", key: "bad-prefix", projectId: "p", directory: "/r", title: "" }, // 前缀不符
        { kind: "chat", key: "chat:", projectId: "p", directory: "/r", title: "" }, // 空 ident
        { kind: "diff", key: "diff\0x\0y", projectId: "p", directory: "/r", title: "" }, // 双 \0
        { kind: "file", key: "file:/r/x", directory: "/r", title: "" }, // 缺 projectId
        { kind: "file", key: "file:/r/y", projectId: "p", title: "" }, // 缺 directory
        { kind: "chat", key: "chat:s1", projectId: "p", directory: "/r", title: "" }, // 重复键
        { kind: "browser", key: "browser:https://a.dev/", projectId: "p", directory: "/r", title: "", url: 1 },
      ],
    })
    expect(out?.tabs.map((t) => t.key)).toEqual(valid.tabs.map((t) => t.key))
  })

  it("scopeActive 只收 string|null；非对象回退空", () => {
    const out = sanitizeTabSession({ tabs: [], scopeActive: { "/a": "k", "/b": 3, "": "x", "/c": null } })
    expect(out?.scopeActive).toEqual({ "/a": "k", "/c": null })
    expect(sanitizeTabSession({ tabs: [] })?.scopeActive).toEqual({})
  })

  it("结构非法 → null；map 整体坏切片丢弃", () => {
    expect(sanitizeTabSession(null)).toBeNull()
    expect(sanitizeTabSession({ scopeActive: {} })).toBeNull() // 缺 tabs 数组
    expect(sanitizeTabSession("x")).toBeNull()
    const map = sanitizeTabSessionMap({ good: valid, bad: "nope", "": valid })
    expect(Object.keys(map)).toEqual(["good"])
    expect(sanitizeTabSessionMap(42)).toEqual({})
  })
})
