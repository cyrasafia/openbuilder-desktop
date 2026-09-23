/**
 * 模型开关过滤（design-model-list）：picker 只列开启的模型（分组计数收缩），
 * 被关闭的当前会话模型不受影响（pill/thinking 照常，D-ML-3），生效默认解析
 * 在过滤后列表上进行（被关默认/首项回退首个开启模型，D-ML-4）。
 * store/i18n 均 mock（同 settings-dialog.test 模式）；popover 经 portal 渲染到
 * document.body，jsdom 零几何下定位为 0 坐标但仍可查询。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ModelSwitcherBar } from "./model-switcher"
import { ResizeObserverStub } from "./resize-observer-stub"
import type { ModelCatalog } from "@shared/model-catalog"
import type { Session } from "@shared/api-types"

/** store mock：目录缓存 + 开关集可按用例覆写（emit 联动免真实订阅） */
const storeState: { current: Record<string, unknown> } = { current: {} }

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      model: "模型",
      modelSearchPlaceholder: "搜索模型…",
      loading: "加载中…",
      loadFailed: "加载失败",
      modelLoadFailed: "加载失败，点击重试",
      noModelMatch: "无匹配模型",
      thinkingLabel: "思考强度",
      thinkingDefault: "默认",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeState.current,
}))

const catalog: ModelCatalog = {
  agents: [
    { name: "build", mode: "primary", hidden: false },
    { name: "plan", mode: "primary", hidden: false },
  ],
  models: [
    { id: "glm-air", providerID: "zai", name: "GLM Air", variants: ["low"] },
    { id: "glm-5.3", providerID: "zai", name: "GLM 5.3", variants: ["low", "high"] },
    { id: "glm-4", providerID: "zai", name: "GLM 4", variants: [] },
    { id: "deepseek-v4-flash", providerID: "deepseek", name: "DeepSeek V4 Flash", variants: [] },
  ],
}

const DIR = "/repo"

function mkSession(model?: Session["model"]): Session {
  return {
    id: "s1",
    projectID: "proj1",
    directory: DIR,
    title: "s1",
    time: { created: 1, updated: 1 },
    ...(model ? { model } : {}),
    agent: "build",
  }
}

/** 模型 pill（含 provider/id 文案的那个 button） */
function modelPill() {
  const el = document.querySelector(".ms-bar > .ms-pill")
  expect(el).toBeTruthy()
  return el as HTMLElement
}

beforeEach(() => {
  // popover 定位跟踪用 RO（jsdom 缺失，同 workspace-guide 惯例；不 fire——
  // 零几何下定位为 0 坐标，不影响行可查询性）；焦点行滚入视野 jsdom 同缺
  vi.stubGlobal("ResizeObserver", ResizeObserverStub)
  ResizeObserverStub.reset()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  storeState.current = {
    modelCatalogs: new Map([[DIR, catalog]]),
    modelCatalogFor: (dir: string) =>
      (storeState.current.modelCatalogs as Map<string, ModelCatalog>).get(dir) ?? {
        agents: [],
        models: [],
      },
    modelCatalogFailedFor: () => false,
    ensureModelCatalog: vi.fn(async () => {}),
    refreshModelCatalog: vi.fn(async () => {}),
    disabledModelsFor: () => ({}),
    defaultsFor: () => ({}),
    setModelDefaults: vi.fn(async () => {}),
    switchSessionAgent: vi.fn(async () => true),
    switchSessionModel: vi.fn(async () => true),
    switchSessionVariant: vi.fn(async () => true),
  }
})

afterEach(cleanup)

describe("模型开关过滤（design-model-list）", () => {
  it("picker 不列关闭模型，分组计数随过滤收缩；搜索命中被关模型无行", async () => {
    ;(
      storeState.current.disabledModelsFor as () => Record<string, string[]>
    ) = () => ({ zai: ["glm-air"] })

    render(<ModelSwitcherBar directory={DIR} mode="defaults" />)
    // 无显式默认 → 生效默认 = 首个开启模型（首项 glm-air 被关 → glm-5.3，D-ML-4）
    expect(screen.getByText("zai/glm-5.3")).toBeTruthy()

    fireEvent.click(modelPill())
    expect(screen.getByText("GLM 5.3")).toBeTruthy()
    expect(screen.queryByText("GLM Air")).toBeNull()
    // zai 组剩 2（glm-5.3/glm-4）、deepseek 组 1
    expect(screen.getByText("2")).toBeTruthy()
    expect(screen.getByText("1")).toBeTruthy()

    // 搜索被关模型名：无行（无匹配文案）
    fireEvent.change(screen.getByPlaceholderText("搜索模型…"), { target: { value: "air" } })
    expect(screen.queryByText("GLM 5.3")).toBeNull()
    expect(screen.getByText("无匹配模型")).toBeTruthy()
  })

  it("被关模型是当前会话模型：pill 照显、thinking 照常（D-ML-3），picker 内无勾选行", () => {
    ;(
      storeState.current.disabledModelsFor as () => Record<string, string[]>
    ) = () => ({ zai: ["glm-air"] })

    render(
      <ModelSwitcherBar directory={DIR} mode="session" session={mkSession({ id: "glm-air", providerID: "zai", variant: "low" })} />,
    )
    expect(screen.getByText("zai/glm-air")).toBeTruthy()
    // thinking 控件可见且值为 low（variants 来自全目录，非过滤集）
    expect(screen.getByText("思考强度")).toBeTruthy()
    expect(screen.getByText("low")).toBeTruthy()

    fireEvent.click(modelPill())
    expect(screen.queryByText("GLM Air")).toBeNull() // picker 内无该行（无勾选）；pill 本体照显（上方断言）
  })

  it("defaults 模式显式默认被关 → 展示首个开启模型（同失效默认路径）", () => {
    ;(
      storeState.current.disabledModelsFor as () => Record<string, string[]>
    ) = () => ({ zai: ["glm-air"] })
    ;(storeState.current.defaultsFor as () => unknown) = () => ({
      model: { id: "glm-air", providerID: "zai" },
    })

    render(<ModelSwitcherBar directory={DIR} mode="defaults" />)
    expect(screen.getByText("zai/glm-5.3")).toBeTruthy()
    expect(screen.queryByText("zai/glm-air")).toBeNull()
  })

  it("开关集空 → 全量列出（跨 provider 同名不误滤）", () => {
    render(<ModelSwitcherBar directory={DIR} mode="defaults" />)
    fireEvent.click(modelPill())
    expect(screen.getByText("GLM Air")).toBeTruthy()
    expect(screen.getByText("DeepSeek V4 Flash")).toBeTruthy()
    // zai 组 3、deepseek 组 1
    expect(screen.getByText("3")).toBeTruthy()
  })
})
