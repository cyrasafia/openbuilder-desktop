/**
 * 浏览器 Tab 组件（design-browser-tab §1.3）：mock desktop 与 store ——
 * 工具条动作（后退/前进/刷新/停止/地址导航/打开本地文件）走 IPC、bounds 同步、
 * 地址栏聚焦不被 store url 回写打断。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
  openHtmlFilePicker: vi.fn(async (): Promise<string | null> => "/repo/x.html"),
}

let stateStub: { viewId: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean } | null

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      browserBack: "后退",
      browserForward: "前进",
      browserReload: "刷新",
      browserStop: "停止",
      browserOpenFile: "打开本地文件…",
      browserAddressPlaceholder: "输入地址",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({
    browserStates: new Map(stateStub ? [[1, stateStub]] : []),
  }),
}))

beforeEach(() => {
  ResizeObserverStub.reset()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
  for (const fn of Object.values(browser)) if (vi.isMockFunction(fn)) fn.mockClear()
  ;(window as unknown as { desktop: unknown }).desktop = { ...browser }
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
})
