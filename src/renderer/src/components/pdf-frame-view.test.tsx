/**
 * PdfFrameView 页面内搜索接线（design-find-in-page §2.2/§2.4）：
 * 挂载注册唤起回调（file Tab key）、唤起渲染查找条、输入发起 findInPage、
 * Esc 关闭 stop；viewId 未落地（shim）时不注册不动作。
 * view-create 走 mock（jsdom 无 main 进程）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PdfFrameView } from "./pdf-frame-view"
import { ResizeObserverStub } from "./resize-observer-stub"

const desktop = {
  browserViewCreate: vi.fn(async () => 5),
  browserViewBounds: vi.fn(),
  browserViewShow: vi.fn(),
  browserViewHide: vi.fn(),
  browserViewDispose: vi.fn(),
  browserNavigate: vi.fn(),
  browserFindStart: vi.fn(),
  browserFindStop: vi.fn(),
  browserFocusMain: vi.fn(),
  onBrowserFindRequest: vi.fn(),
  onBrowserFindState: vi.fn(),
}

/** store 桩：注册表（find requester） + viewId 注册表 */
const registerFileTabView = vi.fn()
const browserViewIdFor = vi.fn((): number | null => null)
const registerFindRequester = vi.fn()
const unregisterFindRequester = vi.fn()

let findRequestCbs: Array<(payload: unknown) => void> = []
let findStateCbs: Array<(state: unknown) => void> = []

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      loading: "加载中…",
      findPlaceholder: "查找…",
      findMatchCount: "{active}/{matches}",
      findIdle: "",
      findPrev: "上一处",
      findNext: "下一处",
      findClose: "关闭",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({
    registerFileTabView,
    browserViewIdFor,
    registerFindRequester,
    unregisterFindRequester,
  }),
}))

beforeEach(() => {
  ResizeObserverStub.reset()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  for (const fn of Object.values(desktop)) if (vi.isMockFunction(fn)) fn.mockClear()
  desktop.onBrowserFindRequest.mockImplementation((cb: (p: unknown) => void) => {
    findRequestCbs.push(cb)
    return () => {}
  })
  desktop.onBrowserFindState.mockImplementation((cb: (s: unknown) => void) => {
    findStateCbs.push(cb)
    return () => {}
  })
  findRequestCbs = []
  findStateCbs = []
  registerFileTabView.mockClear()
  browserViewIdFor.mockClear().mockReturnValue(null)
  registerFindRequester.mockClear()
  unregisterFindRequester.mockClear()
  ;(window as unknown as { desktop: unknown }).desktop = desktop
})

afterEach(() => {
  cleanup()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined
})

describe("PdfFrameView 页面内搜索", () => {
  it("懒建视图 + 导航；唤起查找条输入发起 findInPage（viewId 复用注册表）；Esc 关闭 stop", async () => {
    render(<PdfFrameView tabKey="file:/repo/doc.pdf" absolutePath="/repo/doc.pdf" />)
    await waitFor(() => expect(desktop.browserNavigate).toHaveBeenCalledWith(5, expect.stringContaining("doc.pdf")))
    // 注册表键 = file Tab key
    expect(registerFindRequester).toHaveBeenCalledWith("file:/repo/doc.pdf", expect.any(Function))
    const open = registerFindRequester.mock.calls[0][1] as () => void
    act(() => open())
    const input = document.querySelector(".find-bar input") as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { value: "keyword" } })
    expect(desktop.browserFindStart).toHaveBeenCalledWith(5, "keyword", { forward: true, findNext: false })
    // Enter → findNext；帧推送落计数
    fireEvent.keyDown(input, { key: "Enter" })
    expect(desktop.browserFindStart).toHaveBeenCalledWith(5, "keyword", { forward: true, findNext: true })
    act(() => findRequestCbs.forEach((cb) => cb({ viewId: 5, requestId: 1 })))
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 5, requestId: 1, active: 2, matches: 6 })))
    expect(screen.getByText("2/6")).toBeTruthy()
    // Esc 关闭 → stop 清原生高亮
    fireEvent.keyDown(input, { key: "Escape" })
    expect(desktop.browserFindStop).toHaveBeenCalledWith(5)
    expect(document.querySelector(".find-bar")).toBeNull()
  })

  it("viewId 复用重挂载（切回 Tab）：注册表命中即用既有 viewId；shim（-1）不注册不动作", async () => {
    browserViewIdFor.mockReturnValue(9)
    render(<PdfFrameView tabKey="file:/repo/a.pdf" absolutePath="/repo/a.pdf" />)
    // 不再 view-create（复用）
    expect(desktop.browserViewCreate).not.toHaveBeenCalled()
    expect(registerFindRequester).toHaveBeenCalledWith("file:/repo/a.pdf", expect.any(Function))
    const open = registerFindRequester.mock.calls[0][1] as () => void
    act(() => open())
    const input = document.querySelector(".find-bar input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "x" } })
    expect(desktop.browserFindStart).toHaveBeenCalledWith(9, "x", { forward: true, findNext: false })
    cleanup()

    // shim：view-create 返回 -1 → 停留 loading；viewId 未落地不注册该键
    // （Ctrl+F 无动作，spec 验收口径；review 2026-09-09——前半段 a.pdf 的
    // 注册属于既有 viewId=9 的合法注册，不在此断言）
    browserViewIdFor.mockReturnValue(null)
    desktop.browserViewCreate.mockResolvedValue(-1)
    registerFindRequester.mockClear()
    render(<PdfFrameView tabKey="file:/repo/b.pdf" absolutePath="/repo/b.pdf" />)
    await waitFor(() => expect(desktop.browserViewCreate).toHaveBeenCalled())
    expect(screen.getByText("加载中…")).toBeTruthy()
    expect(document.querySelector(".pdf-host")).not.toBeNull()
    expect(registerFindRequester).not.toHaveBeenCalled()
  })
})