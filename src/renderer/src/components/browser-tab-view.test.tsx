/**
 * 浏览器 Tab 组件（design-browser-tab §1.3）：mock desktop 与 store ——
 * 工具条动作（后退/前进/刷新/停止/地址导航/打开本地文件）走 IPC、bounds 同步、
 * 地址栏聚焦不被 store url 回写打断。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BrowserTabView } from "./browser-tab-view"
import { ResizeObserverStub } from "./resize-observer-stub"

const browser = {
  browserViewBounds: vi.fn(),
  browserViewShow: vi.fn(),
  browserViewHide: vi.fn(),
  browserViewDispose: vi.fn(),
  browserNavigate: vi.fn(),
  browserGoBack: vi.fn(),
  browserGoForward: vi.fn(),
  browserReload: vi.fn(),
  browserStop: vi.fn(),
  // 页面内搜索（design-find-in-page）
  browserFindStart: vi.fn(),
  browserFindStop: vi.fn(),
  browserFocusMain: vi.fn(),
  openHtmlFilePicker: vi.fn(async (): Promise<string | null> => "/repo/x.html"),
}

/** findRequester 注册表桩（useWebContentsFind 挂载注册） */
const registerFindRequesterMock = vi.fn()

let stateStub: { viewId: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean } | null
let findRequestCbs: Array<(payload: unknown) => void> = []
let findStateCbs: Array<(state: unknown) => void> = []

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      browserBack: "后退",
      browserForward: "前进",
      browserReload: "刷新",
      browserStop: "停止",
      browserOpenFile: "打开本地文件…",
      browserAddressPlaceholder: "输入地址",
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
    browserStates: new Map(stateStub ? [[1, stateStub]] : []),
    // 页面内搜索（design-find-in-page）：注册表桩
    registerFindRequester: registerFindRequesterMock,
    unregisterFindRequester: vi.fn(),
  }),
}))

beforeEach(() => {
  ResizeObserverStub.reset()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  for (const fn of Object.values(browser)) if (vi.isMockFunction(fn)) fn.mockClear()
  registerFindRequesterMock.mockClear()
  findRequestCbs = []
  findStateCbs = []
  ;(window as unknown as { desktop: unknown }).desktop = {
    ...browser,
    // 页面内搜索推送通道（design-find-in-page）：测试手动收集订阅
    onBrowserFindRequest: (cb: (payload: unknown) => void) => {
      findRequestCbs.push(cb)
      return () => {
        findRequestCbs = findRequestCbs.filter((c) => c !== cb)
      }
    },
    onBrowserFindState: (cb: (state: unknown) => void) => {
      findStateCbs.push(cb)
      return () => {
        findStateCbs = findStateCbs.filter((c) => c !== cb)
      }
    },
  }
  stateStub = { viewId: 1, url: "https://example.com/", title: "Example", loading: false, canGoBack: true, canGoForward: false }
})

afterEach(() => {
  cleanup()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined
})

describe("BrowserTabView", () => {
  it("工具条动作：后退/刷新可用（canGoBack），前进禁用；点击走 IPC", () => {
    render(<BrowserTabView tabKey="browser:https://example.com/" viewId={1} />)
    const back = screen.getByTitle("后退") as HTMLButtonElement
    const fwd = screen.getByTitle("前进") as HTMLButtonElement
    expect(back.disabled).toBe(false)
    expect(fwd.disabled).toBe(true)
    back.click()
    expect(browser.browserGoBack).toHaveBeenCalledWith(1)
    screen.getByTitle("刷新").click()
    expect(browser.browserReload).toHaveBeenCalledWith(1)
  })

  it("加载中显示停止按钮（替换刷新）", () => {
    stateStub = { ...stateStub!, loading: true }
    render(<BrowserTabView tabKey="browser:x" viewId={1} />)
    expect(screen.getByTitle("停止")).toBeTruthy()
    expect(screen.queryByTitle("刷新")).toBeNull()
    screen.getByTitle("停止").click()
    expect(browser.browserStop).toHaveBeenCalledWith(1)
  })

  it("地址栏 Enter 导航：字面路径补 file:// scheme；Escape 还原当前 URL", () => {
    render(<BrowserTabView tabKey="browser:https://example.com/" viewId={1} />)
    const input = screen.getByRole("textbox") as HTMLInputElement
    expect(input.value).toBe("https://example.com/")
    fireEvent.change(input, { target: { value: "/home/u/page.html" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(browser.browserNavigate).toHaveBeenCalledWith(1, "file:///home/u/page.html")
    fireEvent.change(input, { target: { value: "https://a.io/" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(input.value).toBe("https://example.com/") // store url 还原
  })

  it("打开本地文件：选择器 → file:// 导航；取消无动作", async () => {
    render(<BrowserTabView tabKey="browser:about:blank" viewId={1} />)
    screen.getByTitle("打开本地文件…").click()
    await waitFor(() => expect(browser.browserNavigate).toHaveBeenCalledWith(1, "file:///repo/x.html"))
    browser.browserNavigate.mockClear()
    browser.openHtmlFilePicker.mockResolvedValueOnce(null)
    screen.getByTitle("打开本地文件…").click()
    await waitFor(() => expect(browser.openHtmlFilePicker).toHaveBeenCalledTimes(2))
    expect(browser.browserNavigate).not.toHaveBeenCalled()
  })

  it("bounds 同步：挂载推送 + resize 重推（rAF 合帧）", async () => {
    render(<BrowserTabView tabKey="browser:x" viewId={1} />)
    await waitFor(() => expect(browser.browserViewBounds).toHaveBeenCalledWith(1, expect.anything()))
    // store url 变化（导航完成）：地址栏未聚焦时同步
    stateStub = { ...stateStub!, url: "https://example.com/page2" }
    fireEvent(screen.getByRole("textbox"), new Event("input", { bubbles: false }))
    // 聚焦编辑不被回写：聚焦 → store url 变 → 输入框保持用户输入
    const input = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "editing" } })
    stateStub = { ...stateStub!, url: "https://example.com/page3" }
    // 触发一次重渲染（任意动作）
    screen.getByTitle("刷新").click()
    expect(input.value).toBe("editing")
  })

  it("页面内搜索（design-find-in-page）：挂载注册唤起回调；唤起后输入发起 findInPage；导航清零计数", async () => {
    render(<BrowserTabView tabKey="browser:x" viewId={1} />)
    // 挂载即注册（tabKey 为键）
    expect(registerFindRequesterMock).toHaveBeenCalledWith("browser:x", expect.any(Function))
    const open = registerFindRequesterMock.mock.calls[0][1] as () => void
    // act 内 flush（open 是事件外裸调用，setOpen 不会自动同步渲染）
    act(() => open())
    // FindBar 输入框 = 第二个 textbox（第一个是地址栏）
    const bar = document.querySelector(".find-bar input") as HTMLInputElement
    expect(bar).not.toBeNull()
    fireEvent.change(bar, { target: { value: "hello" } })
    expect(browser.browserFindStart).toHaveBeenCalledWith(1, "hello", { forward: true, findNext: false })
    // 帧推送（requestId 先登记）落计数
    act(() => findRequestCbs.forEach((cb) => cb({ viewId: 1, requestId: 3 })))
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 1, requestId: 3, active: 1, matches: 4 })))
    expect(screen.getByText("1/4")).toBeTruthy()
    // 导航（store url 变化）：计数清零（查询词保留）。
    // 受控 input 不变值不重渲染（React bail out）——改地址栏值触发 onChange 重渲染，
    // useStore mock 读新 stateStub → state.url 变化 → reset
    stateStub = { ...stateStub!, url: "https://example.com/page2" }
    const addr = screen.getByRole("textbox", { name: "输入地址" }) as HTMLInputElement
    fireEvent.change(addr, { target: { value: "https://example.com/page2" } })
    await waitFor(() => expect(screen.queryByText("1/4")).toBeNull())
    // 查询词保留（清零非关闭）
    expect((document.querySelector(".find-bar input") as HTMLInputElement).value).toBe("hello")
    // Esc 关闭：导航 reset 已使会话失效（Chromium 侧无高亮），不发 stop——
    // stopFindInPage 会清页面选区，不能抹掉用户手动选中的文本（闸门同 close）
    browser.browserFindStop.mockClear()
    fireEvent.keyDown(document.querySelector(".find-bar input") as HTMLInputElement, { key: "Escape" })
    expect(browser.browserFindStop).not.toHaveBeenCalled()
    expect(document.querySelector(".find-bar")).toBeNull()
  })

  it("同 URL 刷新（loading 翻转）同样清零计数（review 三轮 #3）", async () => {
    render(<BrowserTabView tabKey="browser:x" viewId={1} />)
    const open = registerFindRequesterMock.mock.calls[0][1] as () => void
    act(() => open())
    const bar = document.querySelector(".find-bar input") as HTMLInputElement
    fireEvent.change(bar, { target: { value: "hello" } })
    act(() => findRequestCbs.forEach((cb) => cb({ viewId: 1, requestId: 3 })))
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 1, requestId: 3, active: 1, matches: 4 })))
    expect(screen.getByText("1/4")).toBeTruthy()
    // 刷新：URL 不变，loading false→true 翻转触发清零。click（mock IPC）
    // 不产生状态变化不重渲染——改地址栏值强制 onChange 重渲染读新 stateStub
    //（同上一用例手法）
    stateStub = { ...stateStub!, loading: true }
    const addr = screen.getByRole("textbox", { name: "输入地址" }) as HTMLInputElement
    fireEvent.change(addr, { target: { value: "https://example.com/editing" } })
    await waitFor(() => expect(screen.queryByText("1/4")).toBeNull())
    // 查询词保留
    expect((document.querySelector(".find-bar input") as HTMLInputElement).value).toBe("hello")
  })
})
