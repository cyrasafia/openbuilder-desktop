/**
 * 引导页快捷键测试（design-keyboard-shortcuts §1，2026-09-06 增）：
 * Ctrl+1/2/3 开 diff/终端/网页 Tab（与磁贴点击同路径同禁用态），监听随引导页
 * 挂载/卸载（仅引导页生效）；Ctrl 按住期间磁贴显示数字角标，禁用磁贴不显示。
 * 角标跟踪是模块级单例（ctrl-held.ts）——Ctrl 按住期间挂载（Ctrl+T 开引导页
 * 场景）初始态照常显示。
 */
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Workspace } from "./workspace"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      newTab: "新建 Tab",
      guideHint: "输入消息开始",
      guidePlaceholder: "问点什么…",
      send: "发送",
      untitled: "未命名",
      archivedSessions: "已归档会话",
      loadMore: "加载更多",
      diffTitle: "Diff",
      openTerminal: "终端",
      openBrowser: "网页",
      comingSoon: "敬请期待",
      closeTab: "关闭",
      renameTab: "重命名",
      forkSession: "Fork",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))
// 引导页 composer 的重组件 mock 掉（本测试只关心磁贴快捷键/角标）
vi.mock("./model-switcher", () => ({ ModelSwitcherBar: () => null }))
vi.mock("./file-ref", () => ({
  FileRefChips: () => null,
  useFileRefInput: () => ({
    chips: null,
    picker: null,
    pickerButton: null,
    dragProps: {},
    onKeyDown: () => false,
    onTextChange: () => {},
  }),
  userFileChipItems: () => [],
}))
vi.mock("./attachments", () => ({
  AttachmentChips: () => null,
  AttachmentThumb: () => null,
  useAttachmentInput: () => ({
    chips: null,
    pickerButton: null,
    pasteProps: {},
    fileDragProps: {},
    notify: () => {},
  }),
  userImageParts: () => [],
}))

/** 测试内动态替换的 store 桩（vi.mock 提升导致闭包需经变量间接） */
let storeStub: Record<string, unknown>

function makeStore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openedProjects: [{ id: "p1", directory: "/repo/a" }],
    tabs: [],
    activeTab: null,
    activeTabKey: null,
    overlayCount: 0,
    scopeQuery: { directory: "/repo/a" },
    syncBrowserViewVisibility: vi.fn(),
    getActiveClient: vi.fn(() => ({})),
    guideDraftFor: vi.fn(() => ""),
    setGuideDraft: vi.fn(),
    archivedSessions: [],
    scopeDisplayName: "a",
    fileRefsFor: vi.fn(() => []),
    attachmentsFor: vi.fn(() => []),
    clearFileRefs: vi.fn(),
    clearAttachments: vi.fn(),
    createSession: vi.fn(),
    sendPrompt: vi.fn(),
    openChatTab: vi.fn(),
    openDiffTab: vi.fn(),
    openTerminalTab: vi.fn(async () => true),
    openBrowserTab: vi.fn(async () => true),
    activeProfile: { name: "local" },
    ...overrides,
  }
}

/** platform 可变（browser shim 用例切 "browser" 验证禁用态） */
let platform = "linux"

/** 原生 window 派发需包 act，角标断言前 React 状态才会 flush */
function press(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { cancelable: true, ...init })
  act(() => {
    window.dispatchEvent(ev)
  })
  return ev
}

function releaseCtrl() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }))
  })
}

function blurWindow() {
  act(() => {
    window.dispatchEvent(new Event("blur"))
  })
}

function badges(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".btn-tile-badge"))
}

beforeEach(() => {
  storeStub = makeStore()
  platform = "linux"
  const cur = (window as unknown as { desktop?: Record<string, unknown> }).desktop
  ;(window as unknown as { desktop: unknown }).desktop = {
    ...(cur ?? {}),
    get platform() {
      return platform
    },
  }
})

// 角标跟踪是模块级单例：用例间残留（如按住未松）会让后续断言角标缺席的用例
// 假失败——afterEach 归零（native 派发需包 act）
afterEach(() => {
  cleanup()
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }))
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }))
    window.dispatchEvent(new Event("blur"))
  })
})

describe("引导页快捷键（design-keyboard-shortcuts §1，2026-09-06 增）", () => {
  it("Ctrl+1/2/3 分别开 diff/终端/网页 Tab（preventDefault）", () => {
    render(<Workspace />)
    const ev1 = press({ key: "1", code: "Digit1", ctrlKey: true })
    expect(ev1.defaultPrevented).toBe(true)
    expect(storeStub.openDiffTab).toHaveBeenCalledTimes(1)
    const ev2 = press({ key: "2", code: "Digit2", ctrlKey: true })
    expect(ev2.defaultPrevented).toBe(true)
    expect(storeStub.openTerminalTab).toHaveBeenCalledTimes(1)
    const ev3 = press({ key: "3", code: "Digit3", ctrlKey: true })
    expect(ev3.defaultPrevented).toBe(true)
    expect(storeStub.openBrowserTab).toHaveBeenCalledWith("about:blank")
  })

  it("Shift/Alt 组合与按住重复不触发", () => {
    render(<Workspace />)
    const evs = [
      press({ key: "1", code: "Digit1", ctrlKey: true, shiftKey: true }),
      press({ key: "2", code: "Digit2", ctrlKey: true, altKey: true }),
      press({ key: "3", code: "Digit3", ctrlKey: true, repeat: true }),
    ]
    expect(evs.every((ev) => !ev.defaultPrevented)).toBe(true)
    expect(storeStub.openDiffTab).not.toHaveBeenCalled()
    expect(storeStub.openTerminalTab).not.toHaveBeenCalled()
    expect(storeStub.openBrowserTab).not.toHaveBeenCalled()
  })

  it("无激活 profile：Ctrl+2/3 不动作（同磁贴禁用态），Ctrl+1 照常", () => {
    storeStub = makeStore({ activeProfile: null })
    render(<Workspace />)
    press({ key: "1", code: "Digit1", ctrlKey: true })
    press({ key: "2", code: "Digit2", ctrlKey: true })
    press({ key: "3", code: "Digit3", ctrlKey: true })
    expect(storeStub.openDiffTab).toHaveBeenCalledTimes(1)
    expect(storeStub.openTerminalTab).not.toHaveBeenCalled()
    expect(storeStub.openBrowserTab).not.toHaveBeenCalled()
  })

  it("browser 平台（无 Electron）：Ctrl+3 不动作", () => {
    platform = "browser"
    render(<Workspace />)
    press({ key: "3", code: "Digit3", ctrlKey: true })
    expect(storeStub.openBrowserTab).not.toHaveBeenCalled()
  })

  it("Ctrl 按住显示数字角标，松开消失", () => {
    render(<Workspace />)
    press({ key: "Control", ctrlKey: true })
    expect(badges().map((el) => el.textContent)).toEqual(["1", "2", "3"])
    releaseCtrl()
    expect(badges()).toHaveLength(0)
  })

  it("Ctrl 按住期间挂载（Ctrl+T 开引导页场景）角标照常显示（2026-09-06 修复）", () => {
    // Ctrl+T：keydown 先于引导页挂载发生——按住 Ctrl 期间组件才挂载，
    // 组件内监听拿不到初始态（修复前角标不显示，靠 ctrl-held 单例跟踪）
    press({ key: "Control", ctrlKey: true })
    render(<Workspace />)
    expect(badges().map((el) => el.textContent)).toEqual(["1", "2", "3"])
    releaseCtrl()
    expect(badges()).toHaveLength(0)
  })

  it("窗口失焦清角标（失焦后 keyup 不再派发）", () => {
    render(<Workspace />)
    press({ key: "Control", ctrlKey: true })
    expect(badges()).toHaveLength(3)
    blurWindow()
    expect(badges()).toHaveLength(0)
  })

  it("禁用磁贴不显示角标（无 profile 时仅 diff 角标）", () => {
    storeStub = makeStore({ activeProfile: null })
    render(<Workspace />)
    press({ key: "Control", ctrlKey: true })
    expect(badges().map((el) => el.textContent)).toEqual(["1"])
  })

  it("卸载后不再监听（仅引导页生效）", () => {
    const { unmount } = render(<Workspace />)
    unmount()
    press({ key: "1", code: "Digit1", ctrlKey: true })
    expect(storeStub.openDiffTab).not.toHaveBeenCalled()
  })
})
