/**
 * 全局快捷键分发表测试（design-keyboard-shortcuts §1）：
 * mock store/i18n，window dispatch KeyboardEvent，断言 store 动作与 preventDefault。
 */
import { render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useShortcuts } from "./shortcuts"

const actions = {
  showGuidePage: vi.fn(),
  openProjectPicker: vi.fn(),
  cycleTab: vi.fn(),
  cycleScopeEntry: vi.fn(),
  restoreClosedTab: vi.fn(),
  toggleLeftPanel: vi.fn(),
  toggleRightPanel: vi.fn(),
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

let shortcutCb: ((input: { key: string; code: string; control: boolean; meta: boolean; shift: boolean; alt: boolean }) => void) | null = null

/** platform 可变（macOS 专属切 Tab 键用例切 darwin 验证） */
let platform: "linux" | "darwin" = "linux"

beforeEach(() => {
  for (const fn of Object.values(actions)) {
    if (vi.isMockFunction(fn)) fn.mockClear()
  }
  actions.activeTab = null
  actions.isSessionActive.mockReturnValue(false)
  vi.spyOn(window, "confirm").mockReturnValue(true)
  platform = "linux"
  const cur = (window as unknown as { desktop?: Record<string, unknown> }).desktop
  ;(window as unknown as { desktop: unknown }).desktop = {
    ...(cur ?? {}),
    get platform() {
      return platform
    },
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

  it("Ctrl+O → 打开项目选择器", () => {
    render(<Harness />)
    const ev = press({ key: "o", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(actions.openProjectPicker).toHaveBeenCalledTimes(1)
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

  it("Alt+↑/↓ → 左栏作用域遍历（非 mac）；原 Ctrl+Alt+↑/↓ 废弃不吞", () => {
    render(<Harness />)
    press({ key: "ArrowDown", altKey: true })
    expect(actions.cycleScopeEntry).toHaveBeenCalledWith(1)
    press({ key: "ArrowUp", altKey: true })
    expect(actions.cycleScopeEntry).toHaveBeenCalledWith(-1)
    // 原 Ctrl+Alt+↑/↓ 是 GNOME/KDE 合成器工作区切换（应用收不到），废弃不消费
    const old = press({ key: "ArrowDown", ctrlKey: true, altKey: true })
    expect(old.defaultPrevented).toBe(false)
    expect(actions.cycleScopeEntry).toHaveBeenCalledTimes(2)
  })

  it("macOS 切 Tab 惯例键：⌘⌥←/→ 与 ⌘⇧[/]（按 code 匹配）；linux 不绑这两组", () => {
    render(<Harness />)
    // linux：Ctrl+Alt+←/→ 是 GNOME/KDE 工作区切换、Ctrl+Shift+[/] 维持放行——不吞
    const arrow = press({ key: "ArrowLeft", ctrlKey: true, altKey: true })
    expect(arrow.defaultPrevented).toBe(false)
    const bracket = press({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true })
    expect(bracket.defaultPrevented).toBe(false)
    expect(actions.cycleTab).not.toHaveBeenCalled()

    platform = "darwin"
    // mac 下 Ctrl+Tab / ⌘PgDn 不绑定（切 Tab 仅惯例键，用户决策 2026-09-04）
    const tab = press({ key: "Tab", ctrlKey: true })
    expect(tab.defaultPrevented).toBe(false)
    const pgdn = press({ key: "PageDown", metaKey: true })
    expect(pgdn.defaultPrevented).toBe(false)
    const right = press({ key: "ArrowRight", metaKey: true, altKey: true })
    expect(right.defaultPrevented).toBe(true)
    expect(actions.cycleTab).toHaveBeenCalledWith(1)
    press({ key: "ArrowLeft", metaKey: true, altKey: true })
    expect(actions.cycleTab).toHaveBeenCalledWith(-1)
    // ⌘⇧[ / ⌘⇧]：US 布局 shift+[ 的 key 是 "{"，按 code 匹配
    press({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true })
    expect(actions.cycleTab).toHaveBeenCalledWith(-1)
    press({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true })
    expect(actions.cycleTab).toHaveBeenCalledWith(1)
    // mac 下 ⌘B 仍是左栏收起/展开；⌘⌥↑/↓ 仍是作用域遍历（与 ←/→ 轴不冲突）
    press({ key: "b", code: "KeyB", metaKey: true })
    expect(actions.toggleLeftPanel).toHaveBeenCalledTimes(1)
    press({ key: "ArrowDown", metaKey: true, altKey: true })
    expect(actions.cycleScopeEntry).toHaveBeenCalledWith(1)
    // mac 裸 ⌥↑/↓ 不劫持（NSText 段落首/尾移动惯例，输入框打字要用）
    const bareAlt = press({ key: "ArrowDown", altKey: true })
    expect(bareAlt.defaultPrevented).toBe(false)
    // 浏览器视图转发路径同分发（code 随载荷）
    shortcutCb?.({ key: "{", code: "BracketLeft", control: false, meta: true, shift: true, alt: false })
    expect(actions.cycleTab).toHaveBeenCalledWith(-1)
  })

  it("Ctrl+B / Ctrl+Alt+B → 左/右栏收起/展开（VS Code 系）；Shift 组合放行；⌥⌘B 按 code 匹配", () => {
    render(<Harness />)
    const left = press({ key: "b", code: "KeyB", ctrlKey: true })
    expect(left.defaultPrevented).toBe(true)
    expect(actions.toggleLeftPanel).toHaveBeenCalledTimes(1)
    expect(actions.toggleRightPanel).not.toHaveBeenCalled()
    const right = press({ key: "b", code: "KeyB", ctrlKey: true, altKey: true })
    expect(right.defaultPrevented).toBe(true)
    expect(actions.toggleRightPanel).toHaveBeenCalledTimes(1)
    // Ctrl+Shift+B 未映射不吞
    const shifted = press({ key: "B", code: "KeyB", ctrlKey: true, shiftKey: true })
    expect(shifted.defaultPrevented).toBe(false)
    // mac ⌥⌘B：Option 产特殊字符（key "∫"），按 code 匹配走右栏
    const macRight = press({ key: "∫", code: "KeyB", metaKey: true, altKey: true })
    expect(macRight.defaultPrevented).toBe(true)
    expect(actions.toggleRightPanel).toHaveBeenCalledTimes(2)
  })

  it("浏览器视图快捷键转发（onBrowserShortcut）走同一分发", () => {
    render(<Harness />)
    expect(shortcutCb).not.toBeNull()
    shortcutCb?.({ key: "t", code: "", control: true, meta: false, shift: false, alt: false })
    expect(actions.showGuidePage).toHaveBeenCalledTimes(1)
    // 裸 Alt+↓（非 mac 作用域遍历）经转发路径同分发（browser-views 过滤已扩）
    shortcutCb?.({ key: "ArrowDown", code: "", control: false, meta: false, shift: false, alt: true })
    expect(actions.cycleScopeEntry).toHaveBeenCalledWith(1)
    shortcutCb?.({ key: "Tab", code: "", control: true, meta: false, shift: true, alt: false })
    expect(actions.cycleTab).toHaveBeenCalledWith(-1)
    shortcutCb?.({ key: "b", code: "KeyB", control: true, meta: false, shift: false, alt: true })
    expect(actions.toggleRightPanel).toHaveBeenCalledTimes(1)
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
