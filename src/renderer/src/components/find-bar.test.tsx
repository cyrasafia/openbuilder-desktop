/**
 * 页面内搜索（design-find-in-page）：
 * - FindBar UI：受控输入/计数/Enter 系/Esc 不冒泡/无匹配红边；
 * - useWebContentsFind：findInPage 会话状态机（输入即新 query、findNext 前后跳、
 *   requestId 旧帧守卫、清空 stop、导航清零 reset、卸载 stop 兜底）。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FindBar, useWebContentsFind } from "./find-bar"

const browser = {
  browserFindStart: vi.fn(),
  browserFindStop: vi.fn(),
  browserFocusMain: vi.fn(),
}

/** 帧推送通道订阅收集（beforeEach 重建） */
let findRequestCbs: Array<(payload: unknown) => void> = []
let findStateCbs: Array<(state: unknown) => void> = []

/** 经注册回调唤起（Harness 不渲染 open 钮——store mock 侧收集） */
let openFn: (() => void) | null = null
/** 导航清零回调（useWebContentsFind 返回的 reset；渲染期收集供断言） */
let resetFn: (() => void) | null = null

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
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
    registerFindRequester: (_key: string, fn: () => void) => {
      openFn = fn
    },
    unregisterFindRequester: () => {
      openFn = null
    },
  }),
}))

function Harness(props: { viewId: number | null; tabKey: string }) {
  const find = useWebContentsFind(props.viewId, props.tabKey)
  resetFn = find.reset
  return (
    find.open && (
      <FindBar
        value={find.query}
        onValueChange={find.onValueChange}
        active={find.count?.active ?? null}
        matches={find.count?.matches ?? null}
        focusRequest={find.focusRequest}
        onPrev={find.prev}
        onNext={find.next}
        onClose={find.close}
      />
    )
  )
}

  beforeEach(() => {
  for (const fn of Object.values(browser)) if (vi.isMockFunction(fn)) fn.mockClear()
  findRequestCbs = []
  findStateCbs = []
  openFn = null
  resetFn = null
  ;(window as unknown as { desktop: unknown }).desktop = {
    ...browser,
    onBrowserFindRequest: (cb: (payload: unknown) => void) => {
      findRequestCbs.push(cb)
      return () => {}
    },
    onBrowserFindState: (cb: (state: unknown) => void) => {
      findStateCbs.push(cb)
      return () => {}
    },
  }
})

afterEach(() => {
  cleanup()
  ;(window as unknown as { desktop?: unknown }).desktop = undefined
})

describe("FindBar UI", () => {
  function renderBar(over: Partial<Parameters<typeof FindBar>[0]>) {
    render(
      <FindBar
        value={"abc"}
        onValueChange={vi.fn()}
        active={1}
        matches={3}
        focusRequest={0}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
        {...over}
      />,
    )
  }

  it("计数 n/m 展示；下一个/上一个/关闭点击回调（文案钮与 CM 搜索面板同序，2026-09-09 统一）", () => {
    const onPrev = vi.fn()
    const onNext = vi.fn()
    const onClose = vi.fn()
    renderBar({ onPrev, onNext, onClose })
    expect(screen.getByText("1/3")).toBeTruthy()
    // 文案可见即无障碍名（无 title）；next 在 prev 前（CM 同序）
    screen.getByText("下一个").click()
    expect(onNext).toHaveBeenCalledTimes(1)
    screen.getByText("上一个").click()
    expect(onPrev).toHaveBeenCalledTimes(1)
    screen.getByTitle("关闭").click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Enter/Shift+Enter 触发下/上一处；Esc 只关查找条不冒泡（不成全局语义）", () => {
    const onNext = vi.fn()
    const onPrev = vi.fn()
    const onClose = vi.fn()
    renderBar({ onNext, onPrev, onClose })
    const input = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onNext).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(onPrev).toHaveBeenCalledTimes(1)
    // Esc stopPropagation：window 级 keydown 监听（全局分发所在地）不应收到
    const windowKeydown = vi.fn()
    window.addEventListener("keydown", windowKeydown)
    try {
      fireEvent.keyDown(input, { key: "Escape" })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("keydown", windowKeydown)
    }
  })

  it("无匹配（matches=0）输入框描红；有匹配恢复", () => {
    const { rerender } = render(
      <FindBar
        value="zzz"
        onValueChange={vi.fn()}
        active={0}
        matches={0}
        focusRequest={0}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(document.querySelector(".find-input.no-match")).not.toBeNull()
    rerender(
      <FindBar
        value="abc"
        onValueChange={vi.fn()}
        active={1}
        matches={2}
        focusRequest={0}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(document.querySelector(".find-input.no-match")).toBeNull()
    expect(screen.getByText("1/2")).toBeTruthy()
  })
})

describe("useWebContentsFind 状态机", () => {
  it("唤起 → 输入即发起 findInPage（findNext:false）；帧推送落计数", () => {
    render(<Harness viewId={1} tabKey="browser:x" />)
    expect(openFn).toBeTruthy()
    act(() => openFn!())
    const input = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input, { target: { value: "hello" } })
    expect(browser.browserFindStart).toHaveBeenCalledWith(1, "hello", { forward: true, findNext: false })
    // requestId 守卫登记
    act(() => findRequestCbs.forEach((cb) => cb({ viewId: 1, requestId: 7 })))
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 1, requestId: 7, active: 2, matches: 5 })))
    expect(screen.getByText("2/5")).toBeTruthy()
  })

  it("旧请求迟到帧丢弃（requestId 不符）", () => {
    render(<Harness viewId={1} tabKey="browser:x" />)
    act(() => openFn!())
    const input = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input, { target: { value: "a" } })
    act(() => findRequestCbs.forEach((cb) => cb({ viewId: 1, requestId: 2 })))
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 1, requestId: 1, active: 1, matches: 9 })))
    expect(screen.queryByText("1/9")).toBeNull()
    // 相符的帧正常落地
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 1, requestId: 2, active: 1, matches: 3 })))
    expect(screen.getByText("1/3")).toBeTruthy()
  })

  it("Enter/Shift+Enter = findNext 前后跳；其它 viewId 的推送忽略", () => {
    render(<Harness viewId={1} tabKey="browser:x" />)
    act(() => openFn!())
    const input = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input, { target: { value: "q" } })
    browser.browserFindStart.mockClear()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(browser.browserFindStart).toHaveBeenCalledWith(1, "q", { forward: true, findNext: true })
    browser.browserFindStart.mockClear()
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(browser.browserFindStart).toHaveBeenCalledWith(1, "q", { forward: false, findNext: true })
    // 异 viewId 帧
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 99, requestId: 0, active: 1, matches: 1 })))
    expect(screen.queryByText("1/1")).toBeNull()
  })

  it("关闭/清空后（无在途请求）迟到帧一律拒收（review 二轮 #3 严格守卫）", () => {
    render(<Harness viewId={1} tabKey="browser:x" />)
    act(() => openFn!())
    const input = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input, { target: { value: "q" } })
    act(() => findRequestCbs.forEach((cb) => cb({ viewId: 1, requestId: 5 })))
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 1, requestId: 5, active: 1, matches: 2 })))
    expect(screen.getByText("1/2")).toBeTruthy()
    // Esc 关闭（requestIdRef 复位 null）→ 重开重输前的迟到帧不得落入新会话
    fireEvent.keyDown(input, { key: "Escape" })
    act(() => openFn!())
    const input2 = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input2, { target: { value: "new" } })
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 1, requestId: 5, active: 9, matches: 9 })))
    expect(screen.queryByText("9/9")).toBeNull()
    // 新请求的帧正常落地
    act(() => findRequestCbs.forEach((cb) => cb({ viewId: 1, requestId: 6 })))
    act(() => findStateCbs.forEach((cb) => cb({ viewId: 1, requestId: 6, active: 1, matches: 4 })))
    expect(screen.getByText("1/4")).toBeTruthy()
  })

  it("清空输入 stop 清高亮；Esc 关闭条 + stop；卸载兜底 stop", () => {
    const { unmount } = render(<Harness viewId={1} tabKey="browser:x" />)
    act(() => openFn!())
    const input = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input, { target: { value: "q" } })
    browser.browserFindStop.mockClear()
    fireEvent.change(input, { target: { value: "" } })
    expect(browser.browserFindStop).toHaveBeenCalledWith(1)
    // 重新输入后 Esc 关闭
    fireEvent.change(input, { target: { value: "q" } })
    browser.browserFindStop.mockClear()
    fireEvent.keyDown(input, { key: "Escape" })
    expect(browser.browserFindStop).toHaveBeenCalledWith(1)
    expect(screen.queryByRole("textbox")).toBeNull()
    // 重开但未输入（无会话）：卸载不 stop——stopFindInPage 会清页面选区，
    // 用户手动选中的文本不能因切 Tab 被抹掉（review 三轮 #2）
    act(() => openFn!())
    browser.browserFindStop.mockClear()
    unmount()
    expect(browser.browserFindStop).not.toHaveBeenCalled()
    // 有会话（已输入未关闭）卸载：兜底 stop 清原生高亮
    const second = render(<Harness viewId={1} tabKey="browser:x" />)
    act(() => openFn!())
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } })
    browser.browserFindStop.mockClear()
    second.unmount()
    expect(browser.browserFindStop).toHaveBeenCalledWith(1)
  })

  it("无会话不发 stop（选区保护闸门延伸）：未输入即 Esc；导航 reset 后清空", () => {
    render(<Harness viewId={1} tabKey="browser:x" />)
    act(() => openFn!())
    const input = screen.getByRole("textbox") as HTMLInputElement
    browser.browserFindStop.mockClear()
    // 未输入（无会话）Esc 关闭：不发 stop——stopFindInPage 会清页面选区，
    // 不能抹掉用户手动选中的文本（review 三轮 #2 闸门同样约束 close）
    fireEvent.keyDown(input, { key: "Escape" })
    expect(browser.browserFindStop).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).toBeNull()
    // 有会话的关闭路径不受闸门影响
    act(() => openFn!())
    const input2 = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input2, { target: { value: "q" } })
    browser.browserFindStop.mockClear()
    fireEvent.keyDown(input2, { key: "Escape" })
    expect(browser.browserFindStop).toHaveBeenCalledWith(1)
    // 导航 reset 后（Chromium 侧已无会话）清空输入：无高亮可清，不发 stop
    act(() => openFn!())
    const input3 = screen.getByRole("textbox") as HTMLInputElement
    fireEvent.change(input3, { target: { value: "q" } })
    act(() => resetFn!())
    browser.browserFindStop.mockClear()
    fireEvent.change(input3, { target: { value: "" } })
    expect(browser.browserFindStop).not.toHaveBeenCalled()
  })

  it("唤起即收回键盘焦点（browserFocusMain，review 三轮 #1）", () => {
    render(<Harness viewId={1} tabKey="browser:x" />)
    act(() => openFn!())
    expect(browser.browserFocusMain).toHaveBeenCalledTimes(1)
    // 重按 Ctrl+F（已开）同样收回
    act(() => openFn!())
    expect(browser.browserFocusMain).toHaveBeenCalledTimes(2)
  })

  it("空输入 Enter 无动作（不发起 findNext）", () => {
    render(<Harness viewId={1} tabKey="browser:x" />)
    act(() => openFn!())
    const input = screen.getByRole("textbox") as HTMLInputElement
    browser.browserFindStart.mockClear()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(browser.browserFindStart).not.toHaveBeenCalled()
  })
})