import { describe, expect, it } from "vitest"
import {
  carriedVariant,
  effectiveDefaultModel,
  emptyCatalog,
  enabledModels,
  findModel,
  getDefaults,
  hasDefaults,
  isModelDisabled,
  normalizeModelRef,
  parseAgents,
  parseModelsV2,
  parseVariants,
  sanitizeDisabledModels,
  setDefaults,
  setDisabledModels,
  type DisabledModels,
  type ModelDefaults,
} from "./model-catalog"
import type { AgentInfo } from "./api-types"
import type { V2ModelInfo } from "./api-v2-types"

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

describe("parseModelsV2（v2 /api/model 平铺列表，M6b）", () => {
  const raw: V2ModelInfo[] = [
    {
      id: "glm-5.3",
      providerID: "zhipuai-coding-plan",
      name: "GLM 5.3",
      status: "active",
      enabled: true,
      variants: [{ id: "high" }, { id: "max" }],
    },
    { id: "glm-beta", providerID: "zai", name: "GLM beta", status: "beta" },
    { id: "glm-dead", providerID: "zai", status: "deprecated" },
    { id: "glm-off", providerID: "zai", status: "disabled" },
    { id: "unconfigured", providerID: "zai", enabled: false },
    { id: "no-name", providerID: "zai", status: "active" },
    // wire 畸形条目（缺 id）：防御式丢弃——类型断言模拟越界输入
    { name: "缺 id/providerID 丢弃", providerID: "zai" } as unknown as V2ModelInfo,
  ]

  it("黑名单（deprecated/disabled）+ enabled:false 过滤；name 缺省回退 id", () => {
    const m = parseModelsV2(raw)
    expect(m.map((x) => `${x.providerID}/${x.id}`).sort()).toEqual(
      ["zhipuai-coding-plan/glm-5.3", "zai/glm-beta", "zai/no-name"].sort(),
    )
    expect(m.find((x) => x.id === "no-name")!.name).toBe("no-name")
  })

  it("variants 数组形态解析为 id 列表（活体形状 [{id:\"high\"}]）", () => {
    const m = parseModelsV2(raw)
    expect(m.find((x) => x.id === "glm-5.3")!.variants.sort()).toEqual(["high", "max"])
    expect(m.find((x) => x.id === "glm-beta")!.variants).toEqual([])
  })

  it("enabled 缺省视为启用（对齐移动端：未配置层不算禁用）", () => {
    const m = parseModelsV2([{ id: "m1", providerID: "p" }])
    expect(m).toHaveLength(1)
  })

  it("空/缺省返回空数组", () => {
    expect(parseModelsV2(null)).toEqual([])
    expect(parseModelsV2(undefined)).toEqual([])
    expect(parseModelsV2([])).toEqual([])
  })
})

describe("findModel", () => {
  const models = parseModelsV2([
    { id: "deepseek-v4-flash", providerID: "deepseek" },
    { id: "deepseek-v4-flash", providerID: "ollama-cloud" },
  ])

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

describe("effectiveDefaultModel（隐式默认：显式优先，未设/失效回退首项）", () => {
  const models = parseModelsV2([
    { id: "glm-5.3", providerID: "zai", name: "GLM 5.3", variants: [{ id: "high" }, { id: "max" }] },
    { id: "glm-4", providerID: "zai", name: "GLM 4", variants: [{ id: "low" }, { id: "high" }] },
    { id: "glm-air", providerID: "zai", name: "GLM Air", variants: [] },
    { id: "deepseek-v4-flash", providerID: "deepseek", name: "DS Flash", variants: [] },
  ])

  it("显式默认有效 → 原样返回（含合法 variant）", () => {
    expect(effectiveDefaultModel({ id: "glm-5.3", providerID: "zai", variant: "high" }, models)).toEqual(
      { id: "glm-5.3", providerID: "zai", variant: "high" },
    )
  })

  it("显式默认 variant 失效 → 只丢 variant 保模型（AM-IMPL4-1）", () => {
    expect(effectiveDefaultModel({ id: "glm-5.3", providerID: "zai", variant: "gone" }, models)).toEqual(
      { id: "glm-5.3", providerID: "zai" },
    )
  })

  it("显式默认模型失效（provider 下线/改名）→ 回退列表首项", () => {
    expect(effectiveDefaultModel({ id: "gone", providerID: "zai" }, models)).toEqual({
      id: "glm-5.3",
      providerID: "zai",
    })
  })

  it("未设置 → 列表首项（不含 variant）", () => {
    expect(effectiveDefaultModel(undefined, models)).toEqual({ id: "glm-5.3", providerID: "zai" })
  })

  it("空列表 → undefined（回退服务器默认）", () => {
    expect(effectiveDefaultModel(undefined, [])).toBeUndefined()
    expect(effectiveDefaultModel({ id: "gone", providerID: "zai" }, [])).toBeUndefined()
  })
})

// ---- 模型开关（design-model-list）----

describe("模型开关读写（isModelDisabled / setDisabledModels）", () => {
  it("例外集缺省 = 开；命中 (providerID, id) 才关", () => {
    const rec: DisabledModels = { zai: ["glm-air"] }
    expect(isModelDisabled(rec, "zai", "glm-air")).toBe(true)
    expect(isModelDisabled(rec, "zai", "glm-5.3")).toBe(false)
    expect(isModelDisabled(rec, "deepseek", "glm-air")).toBe(false) // 跨 provider 同名不误伤
    expect(isModelDisabled(undefined, "zai", "glm-air")).toBe(false)
  })

  it("关闭：新 provider 键 / 既有键追加（单模型 = 单元素 ids）", () => {
    expect(setDisabledModels(undefined, "p1", "zai", ["glm-air"], true)).toEqual({
      p1: { zai: ["glm-air"] },
    })
    expect(
      setDisabledModels({ p1: { zai: ["glm-air"] } }, "p1", "zai", ["glm-5.3"], true),
    ).toEqual({ p1: { zai: ["glm-air", "glm-5.3"] } })
    // 不同 profile 互不影响
    expect(setDisabledModels({ p1: { zai: ["glm-air"] } }, "p2", "zai", ["glm-air"], true)).toEqual({
      p1: { zai: ["glm-air"] },
      p2: { zai: ["glm-air"] },
    })
  })

  it("开启：移除；列表空删 provider 键；切片空删 profile 条目", () => {
    expect(
      setDisabledModels({ p1: { zai: ["glm-air", "glm-5.3"] } }, "p1", "zai", ["glm-air"], false),
    ).toEqual({ p1: { zai: ["glm-5.3"] } })
    expect(setDisabledModels({ p1: { zai: ["glm-air"] } }, "p1", "zai", ["glm-air"], false)).toEqual({})
    expect(
      setDisabledModels({ p1: { zai: ["glm-air"] }, p2: { zai: ["x"] } }, "p1", "zai", ["glm-air"], false),
    ).toEqual({ p2: { zai: ["x"] } })
  })

  it("值无变化返回原引用（免无谓重渲染/落盘）；ids 空 no-op", () => {
    const rec = { p1: { zai: ["glm-air"] } }
    expect(setDisabledModels(rec, "p1", "zai", ["glm-air"], true)).toBe(rec)
    expect(setDisabledModels(rec, "p1", "zai", ["glm-5.3"], false)).toBe(rec)
    expect(setDisabledModels(rec, "p2", "zai", ["x"], false)).toBe(rec)
    expect(setDisabledModels(rec, "p1", "zai", [], true)).toBe(rec)
  })

  it("批量关闭（组级全部关闭）：并集去重追加", () => {
    expect(
      setDisabledModels({ p1: { zai: ["glm-air"], deepseek: ["x"] } }, "p1", "zai", [
        "glm-air",
        "glm-5.3",
        "glm-4",
      ], true),
    ).toEqual({ p1: { zai: ["glm-air", "glm-5.3", "glm-4"], deepseek: ["x"] } })
  })

  it("批量开启（组级全部开启）：只移除传入 id——其他目录/陈旧条目保留；移空删键", () => {
    // stale 不在传入 ids 内 → 保留（惰性无效，不属本次操作范围）
    expect(
      setDisabledModels({ p1: { zai: ["glm-air", "stale"] } }, "p1", "zai", ["glm-air"], false),
    ).toEqual({ p1: { zai: ["stale"] } })
    expect(
      setDisabledModels({ p1: { zai: ["glm-air", "glm-5.3"], deepseek: ["x"] } }, "p1", "zai", [
        "glm-air",
        "glm-5.3",
      ], false),
    ).toEqual({ p1: { deepseek: ["x"] } })
    // 全在目标态 → 原引用
    const rec = { p1: { zai: ["glm-air"] } }
    expect(setDisabledModels(rec, "p1", "zai", ["glm-5.3"], false)).toBe(rec)
    expect(setDisabledModels(rec, "p1", "zai", ["glm-air"], true)).toBe(rec)
  })
})

describe("enabledModels 过滤", () => {
  const models = parseModelsV2([
    { id: "glm-5.3", providerID: "zai" },
    { id: "glm-air", providerID: "zai" },
    { id: "deepseek-v4-flash", providerID: "deepseek" },
  ])

  it("关闭集空（null/{}/空对象）返回原引用；关闭项被滤除", () => {
    expect(enabledModels(models, null)).toBe(models)
    expect(enabledModels(models, {})).toBe(models)
    const out = enabledModels(models, { zai: ["glm-air"] })
    expect(out.map((m) => `${m.providerID}/${m.id}`)).toEqual([
      "zai/glm-5.3",
      "deepseek/deepseek-v4-flash",
    ])
  })

  it("跨 provider 同名 id 不误滤", () => {
    const out = enabledModels(models, { deepseek: ["glm-air"] })
    expect(out).toHaveLength(models.length)
  })
})

describe("sanitizeDisabledModels 读入校验", () => {
  it("非对象/数组 → 空记录", () => {
    expect(sanitizeDisabledModels(null)).toEqual({})
    expect(sanitizeDisabledModels("x")).toEqual({})
    expect(sanitizeDisabledModels([1])).toEqual({})
  })

  it("坏切片/坏键丢弃；非字符串项滤除；空数组键丢弃（等效无记录）", () => {
    expect(
      sanitizeDisabledModels({
        p1: { zai: ["glm-air", 1, null], deepseek: "bad", anthropic: [] },
        p2: "bad",
        p3: null,
      }),
    ).toEqual({ p1: { zai: ["glm-air"] } })
    // 全空切片 → 条目整体丢弃
    expect(sanitizeDisabledModels({ p1: { anthropic: [] } })).toEqual({})
  })
})
