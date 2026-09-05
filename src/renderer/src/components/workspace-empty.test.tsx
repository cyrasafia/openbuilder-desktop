/**
 * 中栏无项目空状态测试（design-layout §4 末）：未打开任何项目时中栏只渲染
 * 「打开项目」引导（提示 + 按钮）；无激活 client（有 profile 但连接未建立）
 * 时按钮改为「打开设置」。无 profile（无服务器）时 Shell 不渲染（欢迎屏
 * 语义修订 2026-09-05），不会走到该空状态。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Workspace } from "./workspace"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      noProjectOpenHint: "打开一个项目后即可开始会话",
      openProject: "打开项目…",
      openSettings: "打开设置",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

/** 测试内动态替换的 store 桩（vi.mock 提升导致闭包需经变量间接） */
let storeStub: Record<string, unknown>

function makeStore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openedProjects: [],
    tabs: [],
    activeTab: null,
    activeTabKey: null,
    overlayCount: 0,
    scopeQuery: { directory: "" },
    syncBrowserViewVisibility: vi.fn(),
    getActiveClient: vi.fn(() => ({})),
    openProjectPicker: vi.fn(),
    openSettings: vi.fn(),
    ...overrides,
  }
}

afterEach(cleanup)

describe("Workspace 无项目空状态", () => {
  it("未打开任何项目：渲染提示 + 「打开项目」按钮，点击打开项目选择器", () => {
    storeStub = makeStore()
    render(<Workspace />)
    expect(screen.getByText("打开一个项目后即可开始会话")).toBeTruthy()
    fireEvent.click(screen.getByText("打开项目…"))
    expect(storeStub.openProjectPicker).toHaveBeenCalledTimes(1)
    expect(storeStub.openSettings).not.toHaveBeenCalled()
  })

  it("无激活 client（连接未建立）：按钮改为「打开设置」，点击开设置弹窗", () => {
    storeStub = makeStore({ getActiveClient: vi.fn(() => null) })
    render(<Workspace />)
    fireEvent.click(screen.getByText("打开设置"))
    expect(storeStub.openSettings).toHaveBeenCalledWith("connection")
    expect(storeStub.openProjectPicker).not.toHaveBeenCalled()
  })
})