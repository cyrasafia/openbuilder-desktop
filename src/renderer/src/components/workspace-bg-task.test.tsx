/**
 * 后台任务卡交互测试（design-subagent-background D2 2026-10-08 修订）：
 * 走真实 Workspace → ChatView 渲染，覆盖用户实测回归路径——
 * 展开列表 → 点行开详情（互斥替代）→ 关详情：列表**保持展开**（展开态
 * 受控挂 ChatView，卡卸载不丢状态）。
 * 附带：行键盘 Enter 开详情；行内「停止」键盘激活不被行级 keydown 劫持
 * （review：target 守卫，Enter 停止不得变开详情）；全部结束复位展开态
 * （含详情开着任务清零的窗口——复位归 ChatView）。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Workspace } from "./workspace"
import { ResizeObserverStub } from "./resize-observer-stub"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      newTab: "新建 Tab",
      untitled: "未命名",
      closeTab: "关闭 Tab",
      close: "关闭",
      renameTab: "重命名",
      overflowTabs: "更多 Tab",
      diffTitle: "Diff",
      guideHint: "输入消息开始",
      guidePlaceholder: "问点什么…",
      send: "发送",
      inputPlaceholder: "输入…",
      forkSession: "Fork",
      commandListLoading: "加载中…",
      attachCmdBlocked: "斜杠命令不支持附件",
      guideTileDiff: "Diff",
      guideTileTerminal: "终端",
      guideTileBrowser: "网页",
      comingSoon: "敬请期待",
      bgTaskTitle: "后台任务",
      bgTaskRunning: "{count} 个运行中",
      bgTaskStop: "停止",
      subagentLoading: "加载中…",
      subagentNoSession: "无会话",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

// 重组件 mock（同 workspace-rename.test.tsx——ChatView 挂载所需，本测试只关心
// 任务卡槽位；SubagentMessageList 留真，详情窗走空态文案）
vi.mock("./terminal-view", () => ({ TerminalView: () => null }))
vi.mock("./model-switcher", () => ({ ModelSwitcherBar: () => null }))
vi.mock("./find-bar", () => ({ FindBar: () => null, useFindRequester: () => ({}) }))
vi.mock("./markdown", () => ({ Markdown: () => null }))
vi.mock("./diff-view", () => ({ DiffView: () => null }))
vi.mock("./browser-tab-view", () => ({ BrowserTabView: () => null }))
vi.mock("./confirm-dialog", () => ({ ConfirmDialog: () => null }))
vi.mock("./code-view", () => ({ CodeView: () => null }))
vi.mock("./pdf-frame-view", () => ({ PdfFrameView: () => null }))
vi.mock("./open-with-dialog", () => ({ OpenWithDialog: () => null }))
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
    picker: null,
    pickerButton: null,
    pasteProps: {},
    fileDragProps: {},
    notify: () => {},
  }),
  userImageParts: () => [],
}))

let storeStub: Record<string, unknown>

// jsdom 无滚动布局 API（ChatView 挂载即 scrollTo）——stub 最小实现
Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {})
Object.defineProperty(Element.prototype, "scrollHeight", {
  configurable: true,
  get() {
    return 0
  },
})
Object.defineProperty(Element.prototype, "scrollTop", {
  configurable: true,
  get() {
    return 0
  },
  set() {},
})

const DIR_A = "/repo/a"

function makeStore(taskIds: string[]) {
  return {
    openedProjects: [{ id: "p1", directory: DIR_A }],
    tabs: [{ key: "chat:s1", kind: "chat", title: "标题A", directory: DIR_A }],
    activeTab: { key: "chat:s1", kind: "chat", title: "标题A", directory: DIR_A },
    activeTabKey: "chat:s1",
    overlayCount: 0,
    scopeQuery: { directory: DIR_A },
    scopeDisplayName: "a",
    syncBrowserViewVisibility: vi.fn(),
    invalidateBrowserOpenFocusUnless: vi.fn(),
    setActiveTab: vi.fn(),
    pushOverlay: vi.fn(),
    popOverlay: vi.fn(),
    dotStateFor: vi.fn(() => null),
    isBrowserWelcome: vi.fn(() => false),
    chatDraftFor: vi.fn(() => ""),
    setChatDraft: vi.fn(),
    chatEntries: vi.fn(() => []),
    statusOf: vi.fn(() => "idle"),
    runningBackgroundTasks: vi.fn(() =>
      taskIds.map((id) => ({
        id,
        title: "评审任务",
        agent: "review",
        time: { created: Date.now() },
      })),
    ),
    taskDetailVersion: 0,
    consumeTaskDetailRequest: vi.fn(() => null),
    findSession: vi.fn((id: string) =>
      taskIds.includes(id) ? { id, title: "评审任务", directory: DIR_A } : null,
    ),
    chatScrollFor: vi.fn(() => null),
    setChatScroll: vi.fn(),
    canLoadEarlier: vi.fn(() => false),
    loadEarlierMessages: vi.fn(),
    loadSessionMessages: vi.fn(),
    revertDraftVersion: 0,
    takeRevertDraft: vi.fn(() => null),
    commandsFor: vi.fn(() => []),
    commandsDegraded: false,
    commandsRefreshing: false,
    refreshCommands: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => ({ ok: true })),
    sendCommand: vi.fn(async () => ({ ok: true })),
    abortSession: vi.fn(async () => {}),
    fileRefsFor: vi.fn(() => []),
    attachmentsFor: vi.fn(() => []),
    sessionPages: new Map(),
    pendingPermissions: new Map(),
    childPermissionFor: vi.fn(() => null),
    questionsForSession: vi.fn(() => []),
    childQuestionsFor: vi.fn(() => []),
  }
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub)
  ResizeObserverStub.reset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("后台任务卡（展开态跨详情保留 + 键盘路径）", () => {
  it("展开 → 点行开详情 → 关详情：列表保持展开（用户实测回归路径）", () => {
    storeStub = makeStore(["child-1"])
    render(<Workspace />)

    // 默认收起：卡头可见、任务行不可见
    expect(screen.getByText("后台任务")).toBeTruthy()
    expect(screen.queryByText("评审任务")).toBeNull()

    // 展开列表
    fireEvent.click(screen.getByText("后台任务"))
    expect(screen.getByText("评审任务")).toBeTruthy()

    // 点行：详情窗替代任务卡
    fireEvent.click(screen.getByText("评审任务"))
    expect(screen.getByRole("region", { name: "评审任务" })).toBeTruthy()
    expect(screen.queryByText("后台任务")).toBeNull()

    // 关闭详情（×）
    fireEvent.click(screen.getByRole("button", { name: "关闭" }))

    // 列表保持展开：卡头与任务行同屏（回归断言——关闭不得回收起态）
    expect(screen.getByText("后台任务")).toBeTruthy()
    expect(screen.getByText("评审任务")).toBeTruthy()
  })

  it("行键盘 Enter 开详情（删「查看」钮后键盘路径保留）", () => {
    storeStub = makeStore(["child-1"])
    render(<Workspace />)
    fireEvent.click(screen.getByText("后台任务"))
    const row = screen.getByText("评审任务").closest("[role='button']") as HTMLElement
    fireEvent.keyDown(row, { key: "Enter" })
    expect(screen.getByRole("region", { name: "评审任务" })).toBeTruthy()
  })

  it("行内「停止」：键盘 Enter 不被行劫持开详情（target 守卫），点击中断子会话", async () => {
    storeStub = makeStore(["child-1"])
    render(<Workspace />)
    fireEvent.click(screen.getByText("后台任务"))
    const stop = screen.getByRole("button", { name: "停止" })
    // 修复前：行级 keydown 对 Enter preventDefault + 开详情——键盘停止变开详情。
    // jsdom 不派发按钮激活 click，这里直接断言 keydown 不开详情（守卫生效）
    fireEvent.keyDown(stop, { key: "Enter" })
    expect(screen.queryByRole("region", { name: "评审任务" })).toBeNull()
    // 点击路径：中断该子会话、详情不开（click stopPropagation）
    fireEvent.click(stop)
    await act(() => {})
    const store = storeStub as unknown as { abortSession: ReturnType<typeof vi.fn> }
    expect(store.abortSession).toHaveBeenCalledWith("child-1")
    expect(screen.queryByRole("region", { name: "评审任务" })).toBeNull()
  })

  it("详情开着任务清零：复位展开态，关详情后新任务卡以收起态出现", () => {
    storeStub = makeStore(["child-1"])
    const { rerender } = render(<Workspace />)
    fireEvent.click(screen.getByText("后台任务"))
    fireEvent.click(screen.getByText("评审任务"))
    expect(screen.getByRole("region", { name: "评审任务" })).toBeTruthy()

    // 详情开着时任务全部完成（卡已卸载，卡内复位 effect 够不着）
    const store = storeStub as unknown as {
      runningBackgroundTasks: ReturnType<typeof vi.fn>
    }
    store.runningBackgroundTasks.mockReturnValue([])
    rerender(<Workspace />)

    // 关详情（任务数 0，槽位随详情关闭整体消失）
    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    expect(screen.queryByRole("region", { name: "评审任务" })).toBeNull()

    // 同会话再启新任务：新卡必须收起（残留展开态已复位）
    store.runningBackgroundTasks.mockReturnValue([
      { id: "child-2", title: "新任务", agent: "review", time: { created: Date.now() } },
    ])
    rerender(<Workspace />)
    expect(screen.getByText("后台任务")).toBeTruthy()
    expect(screen.queryByText("新任务")).toBeNull()
  })
})
