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
/** 监听重拉序号桩（design-file-watcher §7.5）：undefined = 无监听重拉 */
const fileReloadSeqFor = vi.fn((): number | undefined => undefined)

let findRequestCbs: Array<(payload: unknown) => void> = []
let findStateCbs: Array<(state: unknown) => void> = []

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      loading: "加载中…",
      findPlaceholder: "查找…",
      findMatchCount: "{active}/{matches}",
      findIdle: "",
      findPrev: "上一个",
      findNext: "下一个",
      findClose: "关闭",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({
    registerFileTabView,
    browserViewIdFor,
    registerFindRequester,
    unregisterFindRequester,
    fileReloadSeqFor,
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
  fileReloadSeqFor.mockClear().mockReturnValue(undefined)
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
    // 注册表键 = file Tab key（注册在 setViewId 重渲染后的 find effect 里，
    // 落后 navigate 一次 commit——须 waitFor，同步断言并发负载下偶发抢跑）
    await waitFor(() =>
      expect(registerFindRequester).toHaveBeenCalledWith("file:/repo/doc.pdf", expect.any(Function)),
    )
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

describe("PdfFrameView 监听重载（design-file-watcher §7.5）", () => {
  // 上一组用例结尾把 browserViewCreate 改成了 -1（shim 分支），mockClear 不恢复
  // 实现——本组依赖懒建成功，显式恢复
  beforeEach(() => {
    desktop.browserViewCreate.mockResolvedValue(5)
  })

  // 模块级 navigatedSeq 跨用例保留：各用例用不同 Tab key 互不干扰。
  // ui 是工厂：rerender 须传新元素——同一元素引用 React 会跳过渲染
  it("重拉序号前进 → 重新导航；序号不变不重复导航", async () => {
    const ui = () => (<PdfFrameView tabKey="file:/repo/r1.pdf" absolutePath="/repo/r1.pdf" />)
    const { rerender } = render(ui())
    await waitFor(() => expect(desktop.browserNavigate).toHaveBeenCalledTimes(1))
    const url = expect.stringContaining("r1.pdf")

    fileReloadSeqFor.mockReturnValue(4)
    rerender(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(2)
    expect(desktop.browserNavigate).toHaveBeenLastCalledWith(5, url)

    // 序号未变（其他 SSE emit 驱动的重渲染）不重导航
    rerender(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(2)

    fileReloadSeqFor.mockReturnValue(6)
    rerender(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(3)
  })

  it("后台期间的重拉：切回重挂载时补导航一次", async () => {
    browserViewIdFor.mockReturnValue(9)
    const ui = () => (<PdfFrameView tabKey="file:/repo/r2.pdf" absolutePath="/repo/r2.pdf" />)
    const first = render(ui())
    expect(desktop.browserNavigate).not.toHaveBeenCalled()
    first.unmount()

    // 视图存续期间（后台）发生了两次监听重拉
    fileReloadSeqFor.mockReturnValue(7)
    const { rerender } = render(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(1)
    expect(desktop.browserNavigate).toHaveBeenCalledWith(9, expect.stringContaining("r2.pdf"))
    rerender(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(1)
  })

  it("首次导航呈现的就是当前磁盘内容：不因既有序号重复导航", async () => {
    fileReloadSeqFor.mockReturnValue(3)
    const ui = () => (<PdfFrameView tabKey="file:/repo/r3.pdf" absolutePath="/repo/r3.pdf" />)
    const { rerender } = render(ui())
    await waitFor(() => expect(desktop.browserNavigate).toHaveBeenCalledTimes(1))
    rerender(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(1)
    fileReloadSeqFor.mockReturnValue(4)
    rerender(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(2)
  })

  it("序号随连接拆除清空（undefined）：不导航，已导航值作废", async () => {
    browserViewIdFor.mockReturnValue(9)
    const ui = () => (<PdfFrameView tabKey="file:/repo/r4.pdf" absolutePath="/repo/r4.pdf" />)
    fileReloadSeqFor.mockReturnValue(5)
    const { rerender } = render(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(1) // 后台期间的重拉：补导航

    fileReloadSeqFor.mockReturnValue(undefined) // 连接拆除，store 清空序号表
    rerender(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(1) // 不导航

    // 重连后序号表重建：即使值更小也能导航（已导航值已作废，不再可比）
    fileReloadSeqFor.mockReturnValue(1)
    rerender(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(2)
  })

  it("关 Tab 卸载时清理已导航序号：同路径重开后较小的新代序号仍可导航", () => {
    browserViewIdFor.mockReturnValue(9)
    fileReloadSeqFor.mockReturnValue(5)
    const ui = () => (<PdfFrameView tabKey="file:/repo/r5.pdf" absolutePath="/repo/r5.pdf" />)
    const first = render(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(1)

    browserViewIdFor.mockReturnValue(null) // closeTab 已 dispose 并清注册表
    first.unmount()
    browserViewIdFor.mockReturnValue(9)
    fileReloadSeqFor.mockReturnValue(1) // 新连接的序号表从较小值重建
    render(ui())
    expect(desktop.browserNavigate).toHaveBeenCalledTimes(2)
  })
})
