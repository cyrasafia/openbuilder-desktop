/**
 * Tab 条溢出布局测试（design-tab-overflow）：两段式（挤压 → 溢出菜单）的切片
 * 计算（容量公式 = (barWidth - 常驻钮)/min-w）、激活保位、溢出菜单交互（选中
 * 激活收起 / 行内 × 连续关闭）。jsdom 无布局——barWidth 经 ResizeObserverStub
 * 手动 fire（先覆写 clientWidth）注入；激活 Tab 用 terminal kind（重组件
 * TerminalView mock 掉，ChatView 无涉）。
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Workspace } from "./workspace"
import { ResizeObserverStub } from "./resize-observer-stub"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      newTab: "新建 Tab",
      untitled: "未命名",
      closeTab: "关闭",
      renameTab: "重命名",
      overflowTabs: "更多 Tab",
      diffTitle: "Diff",
      browserWelcomeTitle: "新标签页",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))
vi.mock("./terminal-view", () => ({ TerminalView: () => null }))
vi.mock("./tab-actions", () => ({ closeTabInteractive: vi.fn() }))
import { closeTabInteractive } from "./tab-actions"

/** 测试内动态替换的 store 桩（vi.mock 提升导致闭包需经变量间接） */
let storeStub: Record<string, unknown>

const DIR = "/repo/a"

function makeTabs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    key: `terminal:pty${i + 1}`,
    kind: "terminal",
    title: `Term ${i + 1}`,
    directory: DIR,
  }))
}

function makeStore(activeKey: string | null, tabs: ReturnType<typeof makeTabs>) {
  return {
    openedProjects: [{ id: "p1", directory: DIR }],
    tabs,
    activeTab: activeKey ? tabs.find((t) => t.key === activeKey) : null,
    activeTabKey: activeKey,
    overlayCount: 0,
    scopeQuery: { directory: DIR },
    syncBrowserViewVisibility: vi.fn(),
    invalidateBrowserOpenFocusUnless: vi.fn(),
    setActiveTab: vi.fn(),
    applyTabOrder: vi.fn(),
    pushOverlay: vi.fn(),
    popOverlay: vi.fn(),
  }
}

/** 注入 tabbar 容器宽度（RO 回调读 clientWidth）并触发一次测量 */
function setBarWidth(width: number) {
  const bar = document.querySelector<HTMLElement>(".tabbar")!
  Object.defineProperty(bar, "clientWidth", { value: width, configurable: true })
  const ro = ResizeObserverStub.instances.at(-1)!
  act(() => {
    ro.fire()
  })
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub)
  ResizeObserverStub.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(closeTabInteractive).mockClear()
  cleanup()
})

describe("Tab 条溢出布局（挤压 + overflow 菜单）", () => {
  it("容量充足：全部 Tab 渲染、无溢出入口", () => {
    storeStub = makeStore("terminal:pty1", makeTabs(8))
    const { container } = render(<Workspace />)
    setBarWidth(72 + 96 * 8) // 恰容全部

    expect(container.querySelectorAll(".tab")).toHaveLength(8)
    expect(container.querySelector(".tabbar-overflow")).toBeNull()
  })

  it("容量不足：前缀可见 + 溢出入口出现（容量公式）", () => {
    storeStub = makeStore("terminal:pty1", makeTabs(8))
    const { container } = render(<Workspace />)
    setBarWidth(72 + 96 * 3) // 容量 3

    expect(container.querySelectorAll(".tab")).toHaveLength(3)
    expect(container.querySelector(".tabbar-overflow")).not.toBeNull()
  })

  it("激活保位：激活在溢出区时占末位可见槽，前缀少一位（DOM 序保持）", () => {
    const tabs = makeTabs(8)
    storeStub = makeStore("terminal:pty6", tabs) // 索引 5 ≥ 容量 3
    const { container } = render(<Workspace />)
    setBarWidth(72 + 96 * 3)

    const keys = [...container.querySelectorAll<HTMLElement>(".tab")].map((el) => el.dataset.tabKey)
    expect(keys).toEqual(["terminal:pty1", "terminal:pty2", "terminal:pty6"])
    // 前缀外非激活项（pty3）不可见
    expect(container.querySelector('.tab[data-tab-key="terminal:pty3"]')).toBeNull()
  })

  it("溢出菜单：列出溢出 Tab，选中即激活并收起", () => {
    const tabs = makeTabs(8)
    storeStub = makeStore("terminal:pty1", tabs)
    const { container } = render(<Workspace />)
    setBarWidth(72 + 96 * 3)

    fireEvent.click(container.querySelector<HTMLElement>(".tabbar-overflow")!)
    const items = document.querySelectorAll<HTMLButtonElement>(".tab-overflow-item")
    expect(items).toHaveLength(5) // 可见 = pty1..3（激活在前缀内），溢出 = pty4..8

    fireEvent.click(items[1]!) // pty5
    expect(storeStub.setActiveTab).toHaveBeenCalledWith("terminal:pty5")
    expect(document.querySelector(".tab-overflow-menu")).toBeNull() // 收起
  })

  it("溢出菜单：行内 × 走统一关闭路径且菜单保持开放（可连续关闭）", () => {
    const tabs = makeTabs(8)
    storeStub = makeStore("terminal:pty1", tabs)
    const { container } = render(<Workspace />)
    setBarWidth(72 + 96 * 3)

    fireEvent.click(container.querySelector<HTMLElement>(".tabbar-overflow")!)
    const closeBtns = document.querySelectorAll<HTMLButtonElement>(".tab-overflow-close")
    expect(closeBtns).toHaveLength(5)

    fireEvent.click(closeBtns[0]!)
    expect(closeTabInteractive).toHaveBeenCalledTimes(1)
    expect(closeTabInteractive).toHaveBeenCalledWith(storeStub, expect.objectContaining({ key: "terminal:pty4" }))
    expect(document.querySelector(".tab-overflow-menu")).not.toBeNull()
  })

  it("再点 overflow 钮（ChevronsRight）= 关闭菜单（mousedown 先于 click 的 capture 竞争不重开，2026-09-22 review Bug3）", () => {
    const tabs = makeTabs(8)
    storeStub = makeStore("terminal:pty1", tabs)
    const { container } = render(<Workspace />)
    setBarWidth(72 + 96 * 3)
    const btn = container.querySelector<HTMLElement>(".tabbar-overflow")!

    fireEvent.click(btn)
    expect(document.querySelector(".tab-overflow-menu")).not.toBeNull()

    // 真实序列：capture 级 window mousedown（外部关闭判定）→ click（toggle）。
    // 锚点豁免后 mousedown 放行、click 的 toggle 关闭；无豁免则先关后开恒在
    fireEvent.mouseDown(btn)
    fireEvent.click(btn)
    expect(document.querySelector(".tab-overflow-menu")).toBeNull()
  })

  it("溢出清空时复位菜单态：复现后不自发重挂、toggle 方向不反转（2026-09-22 review 二轮）", () => {
    const many = makeTabs(8)
    storeStub = makeStore("terminal:pty1", many)
    const { container, rerender } = render(<Workspace />)
    setBarWidth(72 + 96 * 3)
    const btn = () => container.querySelector<HTMLElement>(".tabbar-overflow")!

    fireEvent.click(btn())
    expect(document.querySelector(".tab-overflow-menu")).not.toBeNull()

    // 溢出清空（行内 × 关掉全部 / SSE 关闭 / 窗口放宽的同一守卫路径）：菜单
    // 卸载且开合态复位（overflow 钮随溢出清空一并卸载，aria 断言移至复现后）
    storeStub = makeStore("terminal:pty1", makeTabs(2))
    act(() => {
      rerender(<Workspace />)
    })
    expect(document.querySelector(".tab-overflow-menu")).toBeNull()

    // 溢出复现（新开 Tab / 窗口收窄）：残留态不得自发重挂菜单；钮已重挂，
    // aria-expanded 反映复位后的关闭态（残留则报 true）
    storeStub = makeStore("terminal:pty1", many)
    act(() => {
      rerender(<Workspace />)
    })
    expect(document.querySelector(".tab-overflow-menu")).toBeNull()
    expect(btn().getAttribute("aria-expanded")).toBe("false")

    // toggle 方向正确：首点 = 开
    fireEvent.click(btn())
    expect(document.querySelector(".tab-overflow-menu")).not.toBeNull()
  })

  it("拖拽 × 溢出：拖拽项推过保位前缀不卸载（dragend 可达）且槽位按 key 映射（2026-09-22 review Bug1+2）", () => {
    const tabs = makeTabs(8)
    storeStub = makeStore("terminal:pty6", tabs) // 激活保位（preview idx 5 ≥ 容量 3）
    const { container } = render(<Workspace />)
    setBarWidth(72 + 96 * 3)
    const bar = container.querySelector<HTMLElement>(".tabbar")!

    // 可见集 = [pty1, pty2, pty6]（前缀 2 + 激活保位）；覆写矩形几何：
    // pty1 0-100 / pty2 100-200 / pty6 200-300
    const visible = [...container.querySelectorAll<HTMLElement>(".tab")]
    visible.forEach((el, i) => {
      const left = i * 100
      el.getBoundingClientRect = () =>
        ({ left, right: left + 100, width: 100, top: 0, bottom: 36, height: 36, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
    })

    // 拖 pty1 悬停 pty6 右边缘带（x=290）：key 反查 pty6 在 base 的下标 4 →
    // 插其右 = slot 5 → 预览序 [pty2..pty6, pty1, pty7, pty8]。旧代码两缺陷：
    // 位置算术算出 slot 2（pty1 落 preview idx 2），且保位阈值 >= capacity 漏保
    // idx 2（≥ 前缀 2 但 < 容量 3）→ pty1 被切片卸载、dragend 失派发
    const dragged = container.querySelector<HTMLElement>('.tab[data-tab-key="terminal:pty1"]')!
    fireEvent.dragStart(dragged, { dataTransfer: { setData: vi.fn(), effectAllowed: "" } })
    fireEvent.dragOver(bar, { clientX: 290, dataTransfer: {} })

    const keys = [...container.querySelectorAll<HTMLElement>(".tab")].map((el) => el.dataset.tabKey)
    expect(keys).toEqual(["terminal:pty2", "terminal:pty6", "terminal:pty1"])

    // 源节点仍在 DOM → dragend 恒派发 → 按松手 DOM 序提交（子集槽位回填）
    const draggedAfter = container.querySelector<HTMLElement>('.tab[data-tab-key="terminal:pty1"]')!
    fireEvent.dragEnd(draggedAfter)
    expect(storeStub.applyTabOrder).toHaveBeenCalledWith([
      "terminal:pty2",
      "terminal:pty6",
      "terminal:pty1",
    ])
  })
})
