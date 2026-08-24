import { describe, expect, it } from "vitest"
import {
  carriedVariant,
  emptyCatalog,
  findModel,
  getDefaults,
  hasDefaults,
  normalizeModelRef,
  parseAgents,
  parseCatalog,
  parseModels,
  parseVariants,
  setDefaults,
  type ModelDefaults,
} from "./model-catalog"
import type { AgentInfo, ConfigProviders } from "./api-types"

const agent = (name: string, mode: string, hidden = false): AgentInfo => ({
  name,
  mode,
  hidden,
})

describe("parseAgents", () => {
  it("过滤 subagent，保留 primary 与 all（与 server agent.ts:337 一致）", () => {
    const r = parseAgents([
      agent("build", "primary"),
      agent("plan", "primary"),
      agent("explore", "subagent"),
      agent("general", "subagent"),
      agent("my-custom", "all"),
    ])
    expect(r.map((a) => a.name).sort()).toEqual(["build", "my-custom", "plan"])
  })

  it("过滤 hidden", () => {
    const r = parseAgents([
      agent("build", "primary"),
      agent("compaction", "primary", true),
    ])
    expect(r.map((a) => a.name)).toEqual(["build"])
  })

  it("空/缺省返回空数组", () => {
    expect(parseAgents(null)).toEqual([])
    expect(parseAgents(undefined)).toEqual([])
  })
})

describe("parseVariants", () => {
  it("dict 形态取 keys（1.18.20 实测形态）", () => {
    expect(parseVariants({ low: { reasoningEffort: "low" }, high: {}, max: {} }).sort()).toEqual([
      "high",
      "low",
      "max",
    ])
  })

  it("List 形态取每项 id", () => {
    expect(parseVariants([{ id: "high" }, { id: "max" }])).toEqual(["high", "max"])
  })

  it("空数组 / 非对象 / 缺省 → 空", () => {
    expect(parseVariants([])).toEqual([])
    expect(parseVariants(null)).toEqual([])
    expect(parseVariants(undefined)).toEqual([])
    expect(parseVariants("high")).toEqual([])
  })
})

describe("parseModels", () => {
  const providers: ConfigProviders = {
    providers: [
      {
        id: "zai",
        name: "ZAI",
        key: "sk-secret-must-not-leak",
        models: {
          "glm-5.3": { name: "GLM 5.3", status: "active", variants: { high: {}, max: {} } },
          "glm-beta": { name: "GLM beta", status: "beta" },
          "glm-dead": { name: "GLM dead", status: "deprecated" },
          "glm-off": { name: "GLM off", status: "disabled" },
          "no-status": { name: "No status" },
        },
      },
      { id: "deepseek", name: "DeepSeek", models: { "deepseek-v4-flash": { status: "active" } } },
    ],
    default: { zai: "glm-5.3", deepseek: "deepseek-v4-flash" },
  }

  it("拍平 providers.models，黑名单只挡 deprecated/disabled", () => {
    const m = parseModels(providers)
    const ids = m.map((x) => `${x.providerID}/${x.id}`).sort()
    expect(ids).toEqual(
      [
        "zai/glm-5.3",
        "zai/glm-beta",
        "zai/no-status",
        "deepseek/deepseek-v4-flash",
      ].sort(),
    )
    // deprecated/disabled 被排除
    expect(m.find((x) => x.id === "glm-dead" || x.id === "glm-off")).toBeUndefined()
  })

  it("variants 解析为 keys", () => {
    const m = parseModels(providers)
    const glm = m.find((x) => x.id === "glm-5.3")!
    expect(glm.variants.sort()).toEqual(["high", "max"])
    const ds = m.find((x) => x.id === "deepseek-v4-flash")!
    expect(ds.variants).toEqual([])
  })

  it("status 缺省保留（兜底放行）", () => {
    const m = parseModels(providers)
    expect(m.find((x) => x.id === "no-status")).toBeDefined()
  })

  it("name 缺省回退到 id", () => {
    const m = parseModels({ providers: [{ id: "p", models: { "m1": { status: "active" } } }] })
    expect(m[0].name).toBe("m1")
  })

  it("Provider.key 不进结果对象（LR-2）", () => {
    const m = parseModels(providers)
    expect(JSON.stringify(m)).not.toContain("sk-secret-must-not-leak")
  })

  it("空/缺省返回空数组", () => {
    expect(parseModels(null)).toEqual([])
    expect(parseModels(undefined)).toEqual([])
    expect(parseModels({ providers: [] })).toEqual([])
  })
})

describe("parseCatalog", () => {
  it("组合 agent + model 解析", () => {
    const c = parseCatalog(
      [agent("build", "primary"), agent("explore", "subagent")],
      { providers: [{ id: "p", models: { m: { status: "active" } } }] },
    )
    expect(c.agents.map((a) => a.name)).toEqual(["build"])
    expect(c.models.map((m) => m.id)).toEqual(["m"])
  })

  it("空入参 = emptyCatalog 值相等（非同引用但内容空）", () => {
    expect(parseCatalog(null, null)).toEqual(emptyCatalog)
  })
})

describe("findModel", () => {
  const models = parseModels({
    providers: [
      { id: "deepseek", models: { "deepseek-v4-flash": { status: "active" } } },
      { id: "ollama-cloud", models: { "deepseek-v4-flash": { status: "active" } } },
    ],
  })

  it("(providerID, id) 双字段匹配——跨 provider 重名不误选", () => {
    const m = findModel(models, "ollama-cloud", "deepseek-v4-flash")!
    expect(m.providerID).toBe("ollama-cloud")
    expect(findModel(models, "deepseek", "deepseek-v4-flash")!.providerID).toBe("deepseek")
  })

  it("无匹配返回 undefined", () => {
    expect(findModel(models, "zai", "glm-5.3")).toBeUndefined()
  })
})

describe("carriedVariant", () => {
  const model = (variants: string[]) => ({ id: "m", providerID: "p", name: "m", variants })

  it("新模型有同名 variant → 沿用", () => {
    expect(carriedVariant("high", model(["low", "high", "max"]))).toBe("high")
  })

  it("新模型无同名 variant → undefined（省略字段 = 重置默认）", () => {
    expect(carriedVariant("high", model(["low", "max"]))).toBeUndefined()
  })

  it("当前无 variant → undefined", () => {
    expect(carriedVariant(undefined, model(["high"]))).toBeUndefined()
  })
})

describe("normalizeModelRef", () => {
  it('字面 variant "default" 归一化为未设（服务器既有会话实测大量此值）', () => {
    expect(
      normalizeModelRef({ id: "m", providerID: "p", variant: "default" }),
    ).toEqual({ id: "m", providerID: "p" })
  })

  it("真实 variant 保留、无 variant 原样、缺省返回 undefined", () => {
    expect(normalizeModelRef({ id: "m", providerID: "p", variant: "high" })).toEqual({
      id: "m",
      providerID: "p",
      variant: "high",
    })
    expect(normalizeModelRef({ id: "m", providerID: "p" })).toEqual({ id: "m", providerID: "p" })
    expect(normalizeModelRef(undefined)).toBeUndefined()
  })
})

describe("defaults 读写", () => {
  it("getDefaults 缺省返回空对象", () => {
    expect(getDefaults(null, "default")).toEqual({})
    expect(getDefaults({}, "default")).toEqual({})
    expect(getDefaults({ a: { agent: "plan" } }, "a")).toEqual({ agent: "plan" })
  })

  it("setDefaults 覆盖单字段、不 mutate 入参、空条目删除", () => {
    const r1 = setDefaults(null, "p1", { agent: "plan" })
    expect(r1).toEqual({ p1: { agent: "plan" } })

    const r2 = setDefaults(r1, "p1", { model: { id: "glm-5.3", providerID: "zai" } })
    expect(r2).toEqual({
      p1: {
        agent: "plan",
        model: { id: "glm-5.3", providerID: "zai" },
      },
    })
    // 不 mutate
    expect(r1).toEqual({ p1: { agent: "plan" } })

    // 删除字段
    const r3 = setDefaults(r2, "p1", { agent: undefined })
    expect(r3).toEqual({ p1: { model: { id: "glm-5.3", providerID: "zai" } } })

    // 全空 → 删条目
    const r4 = setDefaults(r3, "p1", { model: undefined })
    expect(r4).toEqual({})
  })

  it("setDefaults 值相同时返回原引用（防无谓重渲染）", () => {
    const r = setDefaults(null, "p", { agent: "plan" })
    expect(setDefaults(r, "p", { agent: "plan" })).toBe(r)
    // 另一 profile 不变
    expect(setDefaults(r, "p2", { agent: "plan" })).not.toBe(r)
  })

  it("hasDefaults", () => {
    expect(hasDefaults({})).toBe(false)
    expect(hasDefaults({ agent: "plan" })).toBe(true)
    expect(hasDefaults({ model: { id: "glm-5.3", providerID: "zai" } })).toBe(true)
    expect(hasDefaults({ model: { id: "", providerID: "zai" } })).toBe(false)
    expect(hasDefaults({ model: { id: "x", providerID: "" } })).toBe(false)
  })

  it("defaults model 含 variant 时往返不变", () => {
    const d: ModelDefaults = { model: { id: "glm-5.3", providerID: "zai", variant: "high" } }
    const r = setDefaults(null, "p", d)
    expect(getDefaults(r, "p")).toEqual(d)
  })
})
