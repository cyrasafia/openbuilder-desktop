/**
 * 标题栏：面板收起/展开开关（全平台）+ 三个窗口控制按钮（仅 linux）+ 最大化/还原图标切换。
 * mock useI18n/useStore 与 window.desktop（winIsMaximized/onWindowMaximized）。
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TitleBar } from "./title-bar"

const toggleLeft = vi.fn()
const toggleRight = vi.fn()

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    layoutLeftCollapsed: false,
    layoutRightCollapsed: false,
    toggleLeftPanel: toggleLeft,
    toggleRightPanel: toggleRight,
    ...overrides,
  }
}

let store: ReturnType<typeof makeStore>

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      appTitle: "OpenBuilder",
      winMinimize: "最小化",
      winMaximize: "最大化",
      winRestore: "还原",
      winClose: "关闭",
      collapseLeftPanel: "收起左栏",
      expandLeftPanel: "展开左栏",
      collapseRightPanel: "收起右栏",
      expandRightPanel: "展开右栏",
    },
    locale: "zh" as const,
  }),
  useStore: () => store,
}))

const winToggleMaximize = vi.fn()
const unbind = vi.fn()
let stateCb: ((maximized: boolean) => void) | null = null

beforeEach(() => {
  stateCb = null
  winToggleMaximize.mockClear()
  toggleLeft.mockClear()
  toggleRight.mockClear()
  store = makeStore()
  window.desktop = {
    platform: "linux",
    winMinimize: vi.fn(),
    winToggleMaximize,
    winClose: vi.fn(),
    winIsMaximized: vi.fn().mockResolvedValue(false),
    onWindowMaximized: (cb: (maximized: boolean) => void) => {
      stateCb = cb
      return unbind
    },
  } as unknown as typeof window.desktop
})

afterEach(cleanup)

describe("TitleBar 窗口控制", () => {
  it("渲染最小化/最大化/关闭三个控制按钮，点击走 IPC", async () => {
    render(<TitleBar />)
    expect(screen.getByText("OpenBuilder")).toBeTruthy()
    const min = await screen.findByTitle("最小化")
    min.click()
    expect(window.desktop.winMinimize).toHaveBeenCalled()
    screen.getByTitle("最大化").click()
    expect(winToggleMaximize).toHaveBeenCalled()
    screen.getByTitle("关闭").click()
    expect(window.desktop.winClose).toHaveBeenCalled()
  })

  it("最大化状态推送后按钮切换为还原图标", async () => {
    render(<TitleBar />)
    await waitFor(() => expect(stateCb).not.toBeNull())
    stateCb?.(true)
    expect(await screen.findByTitle("还原")).toBeTruthy()
  })

  it("挂载时以快照初始化：已最大化则直接显示还原", async () => {
    vi.mocked(window.desktop.winIsMaximized).mockResolvedValue(true)
    render(<TitleBar />)
    expect(await screen.findByTitle("还原")).toBeTruthy()
  })

  it("非 linux 平台：窗口控制不渲染，面板开关仍在", async () => {
    window.desktop = { platform: "browser" } as unknown as typeof window.desktop
    render(<TitleBar />)
    await waitFor(() => expect(screen.getByTitle("收起左栏")).toBeTruthy())
    expect(screen.queryByTitle("最小化")).toBeNull()
    expect(screen.queryByTitle("关闭")).toBeNull()
    expect(screen.getByTitle("收起右栏")).toBeTruthy()
  })
})

describe("TitleBar 面板开关（design-layout-collapse）", () => {
  it("展开态显示收起 tooltip，点击调 store.toggle*", () => {
    render(<TitleBar />)
    screen.getByTitle("收起左栏").click()
    expect(toggleLeft).toHaveBeenCalledTimes(1)
    screen.getByTitle("收起右栏").click()
    expect(toggleRight).toHaveBeenCalledTimes(1)
  })

  it("折叠态 tooltip 切换为展开", () => {
    store = makeStore({ layoutLeftCollapsed: true, layoutRightCollapsed: true })
    render(<TitleBar />)
    expect(screen.getByTitle("展开左栏")).toBeTruthy()
    expect(screen.getByTitle("展开右栏")).toBeTruthy()
    expect(screen.queryByTitle("收起左栏")).toBeNull()
  })

  it("开关按钮位于最小化按钮左侧（DOM 顺序）", async () => {
    render(<TitleBar />)
    const min = await screen.findByTitle("最小化")
    const controls = min.parentElement!
    const buttons = Array.from(controls.querySelectorAll("button"))
    const leftIdx = buttons.indexOf(screen.getByTitle("收起左栏") as HTMLButtonElement)
    const rightIdx = buttons.indexOf(screen.getByTitle("收起右栏") as HTMLButtonElement)
    const minIdx = buttons.indexOf(min as HTMLButtonElement)
    expect(leftIdx).toBeLessThan(minIdx)
    expect(rightIdx).toBeLessThan(minIdx)
    expect(leftIdx).toBeLessThan(rightIdx)
  })
})
