/**
 * 高用户消息折叠（design-user-message-collapse）：UserBubble 判定与切换。
 * jsdom 无布局：offsetHeight 打桩注入自然高度；行高走回落值 22.4（门槛 472）。
 * ResizeObserver/IntersectionObserver jsdom 缺失，补 stub（后者为 workspace
 * 模块图内 streamdown 所需）。
 */
import { act, fireEvent, render } from "@testing-library/react"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { UserBubble } from "./workspace"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: { bubbleExpand: "点击展开", bubbleCollapse: "点击收起" },
    locale: "zh" as const,
  }),
}))

let naturalHeight = 0

/** RO 桩保留回调引用：测试可手动触发重测（模拟窗口宽度变化后的重排测高） */
class ResizeObserverStub implements ResizeObserver {
  static callbacks: ResizeObserverCallback[] = []
  constructor(cb: ResizeObserverCallback) {
    ResizeObserverStub.callbacks.push(cb)
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  static trigger() {
    for (const cb of ResizeObserverStub.callbacks) cb([], {} as ResizeObserver)
  }
}

beforeAll(() => {
  // jsdom 的 offsetHeight 桩在 HTMLElement.prototype（恒 0 的 getter），替换为注入值
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => naturalHeight,
  })
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  class IntersectionObserverStub implements IntersectionObserver {
    readonly root: Element | null = null
    readonly rootMargin: string = ""
    readonly scrollMargin: string = ""
    readonly thresholds: ReadonlyArray<number> = []
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe("UserBubble", () => {
  it("短消息不挂折叠：无 pointer 类、无提示、点击无反应", () => {
    naturalHeight = 100
    const { container } = render(<UserBubble>短消息</UserBubble>)
    const bubble = container.querySelector(".bubble")!
    expect(bubble.classList.contains("user-collapse")).toBe(false)
    expect(bubble.classList.contains("collapsed")).toBe(false)
    expect(container.querySelector(".bubble-collapse-hint")).toBeNull()
    fireEvent.click(bubble)
    expect(bubble.classList.contains("collapsed")).toBe(false)
  })

  it("高消息默认收起，点击展开，再点收起", () => {
    naturalHeight = 2000
    const { container } = render(<UserBubble>长内容</UserBubble>)
    const bubble = container.querySelector(".bubble")!
    expect(bubble.classList.contains("collapsed")).toBe(true)
    expect(bubble.getAttribute("title")).toBe("点击展开")
    expect(container.querySelector(".bubble-collapse-hint")).not.toBeNull()
    fireEvent.click(bubble)
    expect(bubble.classList.contains("collapsed")).toBe(false)
    expect(bubble.getAttribute("title")).toBe("点击收起")
    expect(container.querySelector(".bubble-expand-hint")).not.toBeNull()
    expect(container.querySelector(".bubble-collapse-hint")).toBeNull()
    fireEvent.click(bubble)
    expect(bubble.classList.contains("collapsed")).toBe(true)
  })

  it("点击链接不触发切换（链接交给系统浏览器）", () => {
    naturalHeight = 2000
    const { container } = render(
      <UserBubble>
        前文 <a href="https://example.com">链接</a>
      </UserBubble>,
    )
    const bubble = container.querySelector(".bubble")!
    // preventDefault 挡掉 jsdom 的锚点导航告警（真实环境走 main 进程 openExternal）
    container.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "A") e.preventDefault()
    })
    fireEvent.click(container.querySelector("a")!)
    expect(bubble.classList.contains("collapsed")).toBe(true)
  })

  it("气泡内存在文本选择时点击不切换（划选收尾的 mouseup 不误触收起）", () => {
    naturalHeight = 2000
    const { container } = render(<UserBubble>长内容</UserBubble>)
    const bubble = container.querySelector(".bubble")!
    const content = container.querySelector(".bubble-content")!
    const selSpy = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ isCollapsed: false, anchorNode: content } as unknown as Selection)
    fireEvent.click(bubble)
    expect(bubble.classList.contains("collapsed")).toBe(true)
    // 气泡外的残留选区不拦截本气泡点击
    selSpy.mockReturnValue({ isCollapsed: false, anchorNode: document.body } as unknown as Selection)
    fireEvent.click(bubble)
    expect(bubble.classList.contains("collapsed")).toBe(false)
    selSpy.mockRestore()
  })

  it("resize 重判定：跌出门槛摘掉折叠壳，跨回门槛恢复默认收起", () => {
    naturalHeight = 2000
    const { container } = render(<UserBubble>长内容</UserBubble>)
    const bubble = container.querySelector(".bubble")!
    expect(bubble.classList.contains("collapsed")).toBe(true)
    naturalHeight = 100
    act(() => ResizeObserverStub.trigger())
    expect(bubble.classList.contains("user-collapse")).toBe(false)
    expect(bubble.classList.contains("collapsed")).toBe(false)
    expect(container.querySelector(".bubble-collapse-hint")).toBeNull()
    naturalHeight = 2000
    act(() => ResizeObserverStub.trigger())
    expect(bubble.classList.contains("collapsed")).toBe(true)
  })
})
