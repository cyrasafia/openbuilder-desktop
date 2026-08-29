/**
 * 全局快捷键分发表测试（design-keyboard-shortcuts §1）：
 * mock store/i18n，window dispatch KeyboardEvent，断言 store 动作与 preventDefault。
 */
import { render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useShortcuts } from "./shortcuts"

const actions = {
  showGuidePage: vi.fn(),
  cycleTab: vi.fn(),
  cycleScopeEntry: vi.fn(),
  restoreClosedTab: vi.fn(),
  closeTab: vi.fn(),
  closeChatTab: vi.fn(async () => true),
  isSessionActive: vi.fn(() => false),
  activeTab: null as { kind: string; key: string } | null,
}

vi.mock("../app", () => ({
  useI18n: () => ({ t: { confirmCloseStreamingTab: "确认关闭？" }, locale: "zh" as const }),
  useStore: () => actions,
}))

function Harness() {
  useShortcuts()
  return null
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { cancelable: true, ...init })
  window.dispatchEvent(ev)
  return ev
}

let shortcutCb: ((input: { key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean }) => void) | null = null

beforeEach(() => {
  for (const fn of Object.values(actions)) {
    if (vi.isMockFunction(fn)) fn.mockClear()
  }
  actions.activeTab = null
  actions.isSessionActive.mockReturnValue(false)
  vi.spyOn(window, "confirm").mockReturnValue(true)
  const cur = (window as unknown as { desktop?: Record<string, unknown> }).desktop
  ;(window as unknown as { desktop: unknown }).desktop = {
    ...(cur ?? {}),
    onBrowserShortcut: (cb: typeof shortcutCb) => {
      shortcutCb = cb
      return () => {
        shortcutCb = null
      }
    },
  }
})

describe("useShortcuts 分发", () => {
  it("Ctrl+T → 新建 Tab（引导页）", () => {
    render(<Harness />)
    const ev = press({ key: "t", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(actions.showGuidePage).toHaveBeenCalledTimes(1)
  })

  it("Ctrl+Shift+T → 恢复关闭 Tab，不误触新建", () => {
    render(<Harness />)
    const ev = press({ key: "T", ctrlKey: true, shiftKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(actions.restoreClosedTab).toHaveBeenCalledTimes(1)
    expect(actions.showGuidePage).not.toHaveBeenCalled()
  })

  it("Ctrl+W 无激活 Tab → 仅吞不动作（防默认菜单关窗）；有 file 激活 → 关闭并入关闭栈", () => {
    render(<Harness />)
    const ev0 = press({ key: "w", ctrlKey: true })
    expect(ev0.defaultPrevented).toBe(true)
    expect(actions.closeTab).not.toHaveBeenCalled()

    actions.activeTab = { kind: "file", key: "file:/repo/a.md" }
    const ev = press({ key: "w", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(actions.closeTab).toHaveBeenCalledWith("file:/repo/a.md", { pushClosed: true })
  })

  it("Ctrl+W chat 流式中先确认，取消则不关闭", () => {
    render(<Harness />)
    actions.activeTab = { kind: "chat", key: "chat:s1" }
    actions.isSessionActive.mockReturnValue(true)
    vi.spyOn(window, "confirm").mockReturnValue(false)
    press({ key: "w", ctrlKey: true })
    expect(actions.closeChatTab).not.toHaveBeenCalled()

    vi.spyOn(window, "confirm").mockReturnValue(true)
    press({ key: "w", ctrlKey: true })
    expect(actions.closeChatTab).toHaveBeenCalledWith("s1", { streaming: true })
  })

  it("Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PgUp / Ctrl+PgDn → 循环切换", () => {
    render(<Harness />)
    press({ key: "Tab", ctrlKey: true })
    expect(actions.cycleTab).toHaveBeenCalledWith(1)
    press({ key: "Tab", ctrlKey: true, shiftKey: true })
    expect(actions.cycleTab).toHaveBeenCalledWith(-1)
    press({ key: "PageDown", ctrlKey: true })
    expect(actions.cycleTab).toHaveBeenCalledWith(1)
    press({ key: "PageUp", ctrlKey: true })
    expect(actions.cycleTab).toHaveBeenCalledWith(-1)
    expect(actions.cycleTab).toHaveBeenCalledTimes(4)
  })

  it("Ctrl+Alt+↑/↓ → 左栏作用域遍历", () => {
    render(<Harness />)
    press({ key: "ArrowDown", ctrlKey: true, altKey: true })
    expect(actions.cycleScopeEntry).toHaveBeenCalledWith(1)
    press({ key: "ArrowUp", ctrlKey: true, altKey: true })
    expect(actions.cycleScopeEntry).toHaveBeenCalledWith(-1)
  })

  it("浏览器视图快捷键转发（onBrowserShortcut）走同一分发", () => {
    render(<Harness />)
    expect(shortcutCb).not.toBeNull()
    shortcutCb?.({ key: "t", control: true, meta: false, shift: false, alt: false })
    expect(actions.showGuidePage).toHaveBeenCalledTimes(1)
    shortcutCb?.({ key: "ArrowDown", control: true, meta: false, shift: false, alt: true })
    expect(actions.cycleScopeEntry).toHaveBeenCalledWith(1)
    shortcutCb?.({ key: "Tab", control: true, meta: false, shift: true, alt: false })
    expect(actions.cycleTab).toHaveBeenCalledWith(-1)
  })

  it("IME 组合中与其他 Ctrl 组合不触发", () => {
    render(<Harness />)
    const ime = press({ key: "t", ctrlKey: true, isComposing: true })
    expect(ime.defaultPrevented).toBe(false)
    expect(actions.showGuidePage).not.toHaveBeenCalled()
    // Ctrl+S（浏览器保存）等未映射组合不吞
    const other = press({ key: "s", ctrlKey: true })
    expect(other.defaultPrevented).toBe(false)
  })
})
