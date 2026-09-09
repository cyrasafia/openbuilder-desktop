/**
 * 全局快捷键分发表测试（design-keyboard-shortcuts §1）：
 * mock store/i18n，window dispatch KeyboardEvent，断言 store 动作与 preventDefault。
 */
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useShortcuts } from "./shortcuts"

// 卸载 Harness（本项目无 RTL 自动清理惯例——原文件靠 dispatch 的
// defaultPrevented 守卫掩盖监听累积；keyup/blur 监听无该守卫，须真实卸载）
afterEach(cleanup)

const actions = {
  showGuidePage: vi.fn(),
  openProjectPicker: vi.fn(),
  closeActiveEntry: vi.fn(),
  createWorkspace: vi.fn(),
  requestWorktreeDelete: vi.fn(),
  cycleTab: vi.fn(),
  moveScopePreview: vi.fn(),
  beginScopePreview: vi.fn(),
  commitScopePreview: vi.fn(),
  cancelScopePreview: vi.fn(),
  restoreClosedTab: vi.fn(),
  toggleLeftPanel: vi.fn(),
  toggleRightPanel: vi.fn(),
  closeTab: vi.fn(),
  closeChatTab: vi.fn(async () => true),
  isSessionActive: vi.fn(() => false),
  activeTab: null as { kind: string; key: string } | null,
  overlayCount: 0,
  currentWorkspace: null as { directory: string } | null,
  // 页面内搜索（design-find-in-page）：注册表桩
  findRequesterFor: vi.fn(() => null),
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

function release(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keyup", { cancelable: true, ...init })
  window.dispatchEvent(ev)
  return ev
}

type ShortcutInput = {
  key: string
  code: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
  up?: boolean
  isAutoRepeat?: boolean
}
let shortcutCb: ((input: ShortcutInput) => void) | null = null
let windowBlurCb: (() => void) | null = null

/** platform 可变（macOS 专属切 Tab 键用例切 darwin 验证） */
let platform: "linux" | "darwin" = "linux"

beforeEach(() => {
  for (const fn of Object.values(actions)) {
    if (vi.isMockFunction(fn)) fn.mockClear()
  }
  actions.activeTab = null
  actions.overlayCount = 0
  actions.currentWorkspace = null
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
    onBrowserWindowBlur: (cb: typeof windowBlurCb) => {
      windowBlurCb = cb
      return () => {
        windowBlurCb = null
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

  it("Alt+O → 打开项目选择器（§1.2，2026-09-06 自 Ctrl+O 迁移）", () => {
    render(<Harness />)
    const ev = press({ key: "o", code: "KeyO", altKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(actions.openProjectPicker).toHaveBeenCalledTimes(1)
  })

  it("Alt 域四键（非 mac 裸左 Alt，按 code 匹配）：C 关激活 entry、N 新建 worktree、⌫ 删当前 worktree（无目标不动作仍吞）；Ctrl+O 迁移后放行", () => {
    render(<Harness />)
    press({ key: "c", code: "KeyC", altKey: true })
    expect(actions.closeActiveEntry).toHaveBeenCalledTimes(1)
    press({ key: "n", code: "KeyN", altKey: true })
    expect(actions.createWorkspace).toHaveBeenCalledTimes(1)
    // 项目根作用域（currentWorkspace=null）→ Alt+⌫ 无目标：吞而不动作
    const bs = press({ key: "Backspace", code: "Backspace", altKey: true })
    expect(bs.defaultPrevented).toBe(true)
    expect(actions.requestWorktreeDelete).not.toHaveBeenCalled()
    actions.currentWorkspace = { directory: "/repo/wt1" }
    press({ key: "Backspace", code: "Backspace", altKey: true })
    expect(actions.requestWorktreeDelete).toHaveBeenCalledWith("/repo/wt1")
    // Ctrl+O 已迁移：放行（Electron 默认菜单无该加速键，§0.2 核查）
    const old = press({ key: "o", ctrlKey: true })
    expect(old.defaultPrevented).toBe(false)
    expect(actions.openProjectPicker).not.toHaveBeenCalled()
  })

  it("mac ⌘⌥O（Option 产特殊字符 key ø，按 code 匹配）命中；裸 ⌥ 系与 ⌥⌫ 放行（打字键不劫持）；AltGr（ctrl+alt 同按）排除", () => {
    render(<Harness />)
    // 非 mac：AltGr+字母上报 ctrl+alt（东欧/欧陆布局打字）→ 放行不动作
    const altgr = press({ key: "ô", code: "KeyO", ctrlKey: true, altKey: true })
    expect(altgr.defaultPrevented).toBe(false)
    expect(actions.openProjectPicker).not.toHaveBeenCalled()
    platform = "darwin"
    press({ key: "ø", code: "KeyO", metaKey: true, altKey: true })
    expect(actions.openProjectPicker).toHaveBeenCalledTimes(1)
    // mac 裸 ⌥O（打字产字符）与 ⌥⌫（删词）不劫持
    const bareO = press({ key: "ø", code: "KeyO", altKey: true })
    expect(bareO.defaultPrevented).toBe(false)
    const bareBs = press({ key: "Backspace", code: "Backspace", altKey: true })
    expect(bareBs.defaultPrevented).toBe(false)
    expect(actions.closeActiveEntry).not.toHaveBeenCalled()
  })

  it("overlay 闸门（§1.2）：弹窗遮挡时 Alt 域四键仅消费不动作；Alt+↑/↓ 不闸（非破坏性，维持现状）", () => {
    render(<Harness />)
    actions.overlayCount = 1
    const o = press({ key: "o", code: "KeyO", altKey: true })
    expect(o.defaultPrevented).toBe(true)
    expect(actions.openProjectPicker).not.toHaveBeenCalled()
    press({ key: "Backspace", code: "Backspace", altKey: true })
    expect(actions.requestWorktreeDelete).not.toHaveBeenCalled()
    press({ key: "ArrowDown", altKey: true })
    expect(actions.moveScopePreview).toHaveBeenCalledWith(1)
  })

  it("repeat 不触发 Alt 域（按住 Alt+N 不得连建 worktree）；裸 Alt+B 不误触右栏开关（KeyB 分支 ctrl 守卫）", () => {
    render(<Harness />)
    const rep = press({ key: "n", code: "KeyN", altKey: true, repeat: true })
    expect(rep.defaultPrevented).toBe(false)
    expect(actions.createWorkspace).not.toHaveBeenCalled()
    // 其余 Alt+字母仍页面/输入框自用（§0.1）——Alt+B 不再触发右栏（原 KeyB 分支无 ctrl 守卫会误触）
    const altB = press({ key: "b", code: "KeyB", altKey: true })
    expect(altB.defaultPrevented).toBe(false)
    expect(actions.toggleRightPanel).not.toHaveBeenCalled()
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

  it("Ctrl+F：激活 Tab 有注册回调 → 消费并唤起（design-find-in-page）；无回调/无激活 Tab → 放行", () => {
    render(<Harness />)
    const requester = vi.fn()
    ;(actions.findRequesterFor as ReturnType<typeof vi.fn>).mockReturnValue(requester)

    // 无激活 Tab：放行（无调用）
    const ev0 = press({ key: "f", ctrlKey: true })
    expect(ev0.defaultPrevented).toBe(false)
    expect(requester).not.toHaveBeenCalled()

    // 有激活 Tab 且已注册：消费 + 唤起
    actions.activeTab = { kind: "browser", key: "browser:https://x/" }
    const ev = press({ key: "f", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(requester).toHaveBeenCalledTimes(1)

    // 有激活 Tab 但未注册（代码视图/消息流）：放行
    ;(actions.findRequesterFor as ReturnType<typeof vi.fn>).mockReturnValue(null)
    const ev2 = press({ key: "f", ctrlKey: true })
    expect(ev2.defaultPrevented).toBe(false)

    // 浏览器视图转发路径（onBrowserShortcut）同分发：Ctrl+F 亦唤起
    ;(actions.findRequesterFor as ReturnType<typeof vi.fn>).mockReturnValue(requester)
    shortcutCb!({ key: "f", code: "KeyF", control: true, meta: false, shift: false, alt: false, up: false, isAutoRepeat: false })
    expect(requester).toHaveBeenCalledTimes(2)

    // overlay 闸门（review 二轮 #5）：弹窗遮挡时仅消费不动作
    actions.overlayCount = 1
    const ev3 = press({ key: "f", ctrlKey: true })
    expect(ev3.defaultPrevented).toBe(true)
    expect(requester).toHaveBeenCalledTimes(2)
    actions.overlayCount = 0
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

  it("Alt+↑/↓ → 移动作用域预览光标（非 mac）；原 Ctrl+Alt+↑/↓ 废弃不吞", () => {
    render(<Harness />)
    press({ key: "ArrowDown", altKey: true })
    expect(actions.moveScopePreview).toHaveBeenCalledWith(1)
    press({ key: "ArrowUp", altKey: true })
    expect(actions.moveScopePreview).toHaveBeenCalledWith(-1)
    // 原 Ctrl+Alt+↑/↓ 是 GNOME/KDE 合成器工作区切换（应用收不到），废弃不消费
    const old = press({ key: "ArrowDown", ctrlKey: true, altKey: true })
    expect(old.defaultPrevented).toBe(false)
    expect(actions.moveScopePreview).toHaveBeenCalledTimes(2)
  })

  it("Alt 预览-提交（§3 修订）：裸 Alt 按下 begin，Alt 松开 commit，窗口失焦 cancel；Ctrl 在位时 Alt 不 begin", () => {
    render(<Harness />)
    // Ctrl+Alt+B 组合路径：Alt 按下时 Ctrl 已在位——不显光标（commit 入口恒开，
    // store 侧无预览时 no-op）
    press({ key: "Control", ctrlKey: true })
    press({ key: "Alt", ctrlKey: true, altKey: true })
    expect(actions.beginScopePreview).not.toHaveBeenCalled()
    release({ key: "Alt", ctrlKey: true, altKey: true })
    expect(actions.commitScopePreview).toHaveBeenCalledTimes(1)
    // 裸 Alt：按下 begin、松开 commit
    press({ key: "Alt", altKey: true })
    expect(actions.beginScopePreview).toHaveBeenCalledTimes(1)
    press({ key: "ArrowDown", altKey: true })
    expect(actions.moveScopePreview).toHaveBeenCalledWith(1)
    release({ key: "Alt", altKey: true })
    expect(actions.commitScopePreview).toHaveBeenCalledTimes(2)
    // 窗口失焦（Alt+Tab 被合成器抢走后 keyup 不再来）：作废预览
    window.dispatchEvent(new Event("blur"))
    expect(actions.cancelScopePreview).toHaveBeenCalledTimes(1)
    // 非 mac：Meta 键松开不提交（非遍历修饰）
    release({ key: "Meta", metaKey: true })
    expect(actions.commitScopePreview).toHaveBeenCalledTimes(2)
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
    // mac 下 ⌘B 仍是左栏收起/展开；⌘⌥↑/↓ 仍是作用域遍历（与 ←/→ 轴不冲突）——
    // 预览-提交（§3 修订）：⌘⌥ 弦凑齐 begin（⌥ 先 ⌘ 后），↑/↓ 只移光标，
    // 任一修饰松开 commit
    press({ key: "b", code: "KeyB", metaKey: true })
    expect(actions.toggleLeftPanel).toHaveBeenCalledTimes(1)
    press({ key: "Alt", altKey: true })
    expect(actions.beginScopePreview).not.toHaveBeenCalled()
    press({ key: "Meta", metaKey: true, altKey: true })
    expect(actions.beginScopePreview).toHaveBeenCalledTimes(1)
    press({ key: "ArrowDown", metaKey: true, altKey: true })
    expect(actions.moveScopePreview).toHaveBeenCalledWith(1)
    release({ key: "Meta", metaKey: true, altKey: true })
    expect(actions.commitScopePreview).toHaveBeenCalledTimes(1)
    // mac 裸 ⌥↑/↓ 不劫持（NSText 段落首/尾移动惯例，输入框打字要用）
    const bareAlt = press({ key: "ArrowDown", altKey: true })
    expect(bareAlt.defaultPrevented).toBe(false)
    // 浏览器视图转发路径同分发（code 随载荷）
    shortcutCb?.({ key: "{", code: "BracketLeft", control: false, meta: true, shift: true, alt: false, isAutoRepeat: false })
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
    shortcutCb?.({ key: "t", code: "", control: true, meta: false, shift: false, alt: false, up: false, isAutoRepeat: false })
    expect(actions.showGuidePage).toHaveBeenCalledTimes(1)
    // 裸 Alt+↓（非 mac 作用域遍历）经转发路径同分发（browser-views 过滤已扩）；
    // 裸 Alt keydown 附带 begin、Alt keyup 驱动 commit（§3 修订，up 标记）
    shortcutCb?.({ key: "Alt", code: "AltLeft", control: false, meta: false, shift: false, alt: true, up: false, isAutoRepeat: false })
    expect(actions.beginScopePreview).toHaveBeenCalledTimes(1)
    shortcutCb?.({ key: "ArrowDown", code: "", control: false, meta: false, shift: false, alt: true, up: false, isAutoRepeat: false })
    expect(actions.moveScopePreview).toHaveBeenCalledWith(1)
    shortcutCb?.({ key: "Alt", code: "AltLeft", control: false, meta: false, shift: false, alt: false, up: true, isAutoRepeat: false })
    expect(actions.commitScopePreview).toHaveBeenCalledTimes(1)
    shortcutCb?.({ key: "Tab", code: "", control: true, meta: false, shift: true, alt: false, up: false, isAutoRepeat: false })
    expect(actions.cycleTab).toHaveBeenCalledWith(-1)
    shortcutCb?.({ key: "b", code: "KeyB", control: true, meta: false, shift: false, alt: true, up: false, isAutoRepeat: false })
    expect(actions.toggleRightPanel).toHaveBeenCalledTimes(1)
    // 非修饰键 keyup 不经转发（browser-views 过滤），即便到达也不动作
    shortcutCb?.({ key: "b", code: "KeyB", control: true, meta: false, shift: false, alt: false, up: true, isAutoRepeat: false })
    expect(actions.toggleLeftPanel).not.toHaveBeenCalled()
    // 裸 Alt 域四键（2026-09-06 browser-views 过滤扩展）：Alt+O 同分发；
    // isAutoRepeat 转发（repeat 不触发）
    shortcutCb?.({ key: "o", code: "KeyO", control: false, meta: false, shift: false, alt: true, up: false, isAutoRepeat: false })
    expect(actions.openProjectPicker).toHaveBeenCalledTimes(1)
    shortcutCb?.({ key: "n", code: "KeyN", control: false, meta: false, shift: false, alt: true, up: false, isAutoRepeat: true })
    expect(actions.createWorkspace).not.toHaveBeenCalled()
    // 顶层窗口失焦（视图持焦时应用失活，renderer 无 DOM blur）：main 补发 cancel
    windowBlurCb?.()
    expect(actions.cancelScopePreview).toHaveBeenCalledTimes(1)
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
