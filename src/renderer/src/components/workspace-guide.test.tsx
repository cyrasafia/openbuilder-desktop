/**
 * 引导页快捷键测试（design-keyboard-shortcuts §1，2026-09-06 增）：
 * Ctrl+1/2/3 开 diff/终端/网页 Tab（与磁贴点击同路径同禁用态），监听随引导页
 * 挂载/卸载（仅引导页生效）；Ctrl 按住期间磁贴显示数字角标，禁用磁贴不显示。
 * 角标跟踪是模块级单例（ctrl-held.ts）——Ctrl 按住期间挂载（Ctrl+T 开引导页
 * 场景）初始态照常显示。
 * 引导页斜杠命令测试（design-slash-command 2026-09-08 修订）：输入 / 出菜单
 * （按需拉取 + 前缀过滤 + Enter 补全/Esc 关闭），发送命中命令走 sendCommand、
 * 未注册按字面 prompt、发送前强制重拉。
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react"
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
      commandListLoading: "加载中…",
      attachCmdBlocked: "斜杠命令不支持附件",
      inputPlaceholder: "输入…",
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

/** 斜杠用例的命令注册表（makeStore 覆盖 commandsFor 可变） */
let guideCommands: Array<{ name: string; description?: string }>

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
    sendPrompt: vi.fn(async () => ({ ok: true })),
    sendCommand: vi.fn(async () => ({ ok: true })),
    openChatTab: vi.fn(),
    openDiffTab: vi.fn(),
    openTerminalTab: vi.fn(async () => true),
    openBrowserTab: vi.fn(async () => true),
    activeProfile: { name: "local" },
    commandsFor: vi.fn(() => guideCommands),
    refreshCommands: vi.fn(async () => {}),
    commandsDegraded: false,
    commandsRefreshing: false,
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
  guideCommands = []
  platform = "linux"
  // CommandHints 选中行跟随 scrollIntoView（jsdom 未实现，file-view.test 同例）
  Element.prototype.scrollIntoView = vi.fn()
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

describe("引导页斜杠命令（design-slash-command 2026-09-08 修订）", () => {
  /** 引导页输入框（autoFocus 的 textarea） */
  function guideTextarea(): HTMLTextAreaElement {
    const el = document.querySelector<HTMLTextAreaElement>(".guide-composer textarea")
    if (!el) throw new Error("guide textarea not found")
    return el
  }

  /** 键入文本（change 事件走 React 受控更新） */
  function type(text: string) {
    const el = guideTextarea()
    act(() => {
      fireEvent.change(el, { target: { value: text } })
    })
  }

  /** 菜单行文本（/name + description 拼接，无菜单返回 []） */
  function menuRows(): string[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(".command-row")).map(
      (el) => el.textContent ?? "",
    )
  }

  /** 按下引导页输入框键（keydown 派发） */
  function key(k: string, init: KeyboardEventInit = {}) {
    const el = guideTextarea()
    const ev = new KeyboardEvent("keydown", { key: k, cancelable: true, bubbles: true, ...init })
    act(() => {
      el.dispatchEvent(ev)
    })
    return ev
  }

  /** 建会话桩（发送路径依赖） */
  function sessionStub() {
    return { id: "s1", directory: "/repo/a", title: "", time: { created: "", updated: "" } }
  }

  it("输入 / 触发按需拉取并展示菜单（前缀过滤）", () => {
    guideCommands = [
      { name: "review", description: "评审" },
      { name: "init", description: "初始化" },
    ]
    render(<Workspace />)
    type("/")
    expect(storeStub.refreshCommands).toHaveBeenCalledWith("/repo/a")
    expect(menuRows()).toEqual(["/review评审", "/init初始化"])
    type("/rev")
    expect(menuRows()).toEqual(["/review评审"])
  })

  it("Enter 补全选中命令（菜单开时不发送），补全后菜单关闭", () => {
    guideCommands = [{ name: "review" }]
    render(<Workspace />)
    type("/rev")
    const ev = key("Enter")
    expect(ev.defaultPrevented).toBe(true)
    expect(guideTextarea().value).toBe("/review ")
    expect(menuRows()).toHaveLength(0)
    expect(storeStub.createSession).not.toHaveBeenCalled()
  })

  it("↑/↓ 循环移动选中，Tab 同补全，Esc 关闭菜单（改草稿重开）", () => {
    guideCommands = [{ name: "review" }, { name: "init" }]
    render(<Workspace />)
    type("/")
    key("ArrowDown")
    key("ArrowDown")
    // 两项循环：↓ → 第二项，↓ → 回第一项
    expect(
      document.querySelectorAll(".command-row")[0].classList.contains("selected"),
    ).toBe(true)
    key("ArrowUp")
    expect(
      document.querySelectorAll(".command-row")[1].classList.contains("selected"),
    ).toBe(true)
    key("Tab")
    expect(guideTextarea().value).toBe("/init ")
    expect(menuRows()).toHaveLength(0)
    // Esc 关闭后改草稿重开
    type("/")
    key("Escape")
    expect(menuRows()).toHaveLength(0)
    type("/i")
    expect(menuRows()).toHaveLength(1)
  })

  it("发送命中命令：建会话 → 发送前强制重拉 → sendCommand（含参数）", async () => {
    guideCommands = [{ name: "review" }]
    const session = sessionStub()
    ;(storeStub.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)
    ;(storeStub.sendCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    render(<Workspace />)
    type("/review --help")
    // 菜单模式外（含空白）直接 Enter 发送
    key("Enter")
    await act(async () => {
      await vi.waitFor(() => expect(storeStub.sendCommand).toHaveBeenCalled())
    })
    expect(storeStub.createSession).toHaveBeenCalledWith({ openTab: false })
    // 发送前强制重拉（决策 3）：直接键入完整命令（未经菜单模式）时发送路径
    // 拉取是唯一一次；先经菜单再补参数发送则是第二次（store 侧 in-flight 共享
    // 语义此处不重复断言，app-store 已覆盖）
    expect(storeStub.refreshCommands).toHaveBeenCalledWith("/repo/a")
    expect(storeStub.sendCommand).toHaveBeenCalledWith("s1", "review", "--help", [], [])
    expect(storeStub.sendPrompt).not.toHaveBeenCalled()
  })

  it("先经菜单（按需拉取过）再发送：发送前仍强制重拉（in-flight 等待语义入口）", async () => {
    guideCommands = [{ name: "review" }]
    const session = sessionStub()
    ;(storeStub.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)
    ;(storeStub.sendCommand as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    render(<Workspace />)
    type("/rev")
    expect(storeStub.refreshCommands).toHaveBeenCalledTimes(1) // 菜单按需拉取
    key("Enter") // 补全为 /review （菜单开时 Enter = 补全不发送）
    expect(guideTextarea().value).toBe("/review ")
    type("/review --help")
    key("Enter") // 菜单关（含空白）后 Enter = 发送
    await act(async () => {
      await vi.waitFor(() => expect(storeStub.sendCommand).toHaveBeenCalled())
    })
    // 发送前强制重拉：菜单拉取之外发送路径再拉一次
    expect((storeStub.refreshCommands as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(storeStub.sendCommand).toHaveBeenCalledWith("s1", "review", "--help", [], [])
  })

  it("发送未注册 /xxx：按字面 prompt 发送（决策 4 降级）", async () => {
    guideCommands = [{ name: "review" }]
    const session = sessionStub()
    ;(storeStub.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)
    render(<Workspace />)
    type("/不存在")
    key("Enter")
    await act(async () => {
      await vi.waitFor(() => expect(storeStub.sendPrompt).toHaveBeenCalled())
    })
    expect(storeStub.sendCommand).not.toHaveBeenCalled()
    expect(storeStub.sendPrompt).toHaveBeenCalledWith("s1", "/不存在", [], [])
  })

  it("附件守卫在途连按 Enter 不再入：只建一个会话、只发一次（review 修复回归）", async () => {
    const session = sessionStub()
    ;(storeStub.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)
    ;(storeStub.sendPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    ;(storeStub.attachmentsFor as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "a1", mime: "image/png", filename: "x.png", dataUrl: "data:image/png;base64,AAAA" },
    ])
    // 守卫的 refreshCommands 悬挂一个宏任务：两次同步 Enter 都落在 await 窗口内
    //（修复前 sending 仍是 state false，第二次会并发走到 createSession）
    ;(storeStub.refreshCommands as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((r) => setTimeout(r, 0)),
    )
    render(<Workspace />)
    type("/不存在")
    key("Enter")
    key("Enter")
    await act(async () => {
      await vi.waitFor(() => expect(storeStub.sendPrompt).toHaveBeenCalled())
    })
    expect(storeStub.createSession).toHaveBeenCalledTimes(1)
    expect(storeStub.sendPrompt).toHaveBeenCalledTimes(1)
    expect(storeStub.openChatTab).toHaveBeenCalledTimes(1)
  })

  it("纯附件 + 非命令 /xxx 不拦，字面发送合法（守卫只在命中时拦）", async () => {
    guideCommands = [{ name: "review" }]
    const session = sessionStub()
    ;(storeStub.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)
    ;(storeStub.sendPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    ;(storeStub.attachmentsFor as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "a1", mime: "image/png", filename: "x.png", dataUrl: "data:image/png;base64,AAAA" },
    ])
    render(<Workspace />)
    type("/不存在")
    key("Enter")
    await act(async () => {
      await vi.waitFor(() => expect(storeStub.sendPrompt).toHaveBeenCalled())
    })
    // 命中命令 + 附件的阻断路径（attachCmdBlocked 提示）在 ChatView 同构，
    // 此处只验非命令字面发送不拦
    expect(storeStub.sendCommand).not.toHaveBeenCalled()
  })
})
