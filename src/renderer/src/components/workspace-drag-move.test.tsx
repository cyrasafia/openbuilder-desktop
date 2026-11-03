/**
 * 会话 Tab 拖放移动测试（design-session-tab-drag-move）：
 * - dragStart 带外登记（仅 chat Tab）；
 * - dragend 提交分派：有移动目标 → moveSession（不重排）；无目标 → 既有
 *   重排序提交；进行中 → 二次确认（取消不移不停 / 确认走先停后移）；
 * - 悬停回 Tab 条清移动目标（预览切回排序）。
 * 桩体系同 workspace-rename.test.tsx（重组件 mock + 直读 storeStub）。
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
      closeTab: "关闭",
      renameTab: "重命名",
      overflowTabs: "更多 Tab",
      diffTitle: "Diff",
      guideHint: "输入消息开始",
      guidePlaceholder: "问点什么…",
      send: "发送",
      inputPlaceholder: "输入…",
      forkSession: "Fork",
      moveSession: "移动到",
      moveSessionBusy: "会话进行中，完成后可移动",
      mainWorkspace: "主工作区",
      confirm: "确认",
      cancel: "取消",
      confirmMoveActiveSessionTitle: "移动进行中的会话？",
      confirmMoveActiveSession: "会话正在运行。移动前将先停止当前任务。继续？",
      movingSession: "正在停止并移动…",
      commandListLoading: "加载中…",
      attachCmdBlocked: "斜杠命令不支持附件",
      guideTileDiff: "Diff",
      guideTileTerminal: "终端",
      guideTileBrowser: "网页",
      comingSoon: "敬请期待",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))
// 重组件 mock 掉（本测试只关心 Tab 条与确认弹窗；ConfirmDialog 真实渲染）
vi.mock("./terminal-view", () => ({ TerminalView: () => null }))
vi.mock("./model-switcher", () => ({ ModelSwitcherBar: () => null }))
vi.mock("./find-bar", () => ({ FindBar: () => null, useFindRequester: () => ({}) }))
vi.mock("./markdown", () => ({ Markdown: () => null }))
vi.mock("./diff-view", () => ({ DiffView: () => null }))
vi.mock("./browser-tab-view", () => ({ BrowserTabView: () => null }))
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
const DIR_B = "/repo/b"

function chatTab(key: string, title: string, directory: string) {
  return { key, kind: "chat", projectId: "p1", title, directory }
}

function makeStore(tabs: ReturnType<typeof chatTab>[], scopeDir = DIR_A) {
  return {
    store: null as unknown,
    openedProjects: [
      { id: "p1", directory: DIR_A, worktree: DIR_A, sandboxes: [DIR_B] },
      { id: "p2", directory: DIR_B, worktree: DIR_B, sandboxes: [] },
    ],
    tabs,
    activeTab: tabs[0] ?? null,
    activeTabKey: tabs[0]?.key ?? null,
    overlayCount: 0,
    scopeQuery: { directory: scopeDir },
    scopeDisplayName: "a",
    syncBrowserViewVisibility: vi.fn(),
    invalidateBrowserOpenFocusUnless: vi.fn(),
    setActiveTab: vi.fn(),
    applyTabOrder: vi.fn(),
    pushOverlay: vi.fn(),
    popOverlay: vi.fn(),
    dotStateFor: vi.fn(() => null),
    isBrowserWelcome: vi.fn(() => false),
    renameSession: vi.fn(async () => true),
    workspacesOfProject: vi.fn((projectId: string) =>
      projectId === "p1" ? [{ name: "b", directory: DIR_B }] : [],
    ),
    isSessionActive: vi.fn(() => false),
    isSessionMoving: vi.fn(() => false),
    moveSession: vi.fn(async () => true),
    moveSessionConfirmed: vi.fn(async () => true),
    // 拖放移动（design-session-tab-drag-move）：字段供 handleDragEnd 闭包直读，
    // takeSessionDropTarget 镜像真实语义（取走并清空，读模块级 storeStub 保持
    // 与测试内字段突变一致）
    draggingChatTab: null as { sessionID: string; projectId: string; directory: string } | null,
    sessionDropTarget: null as string | null,
    beginChatTabDrag: vi.fn(),
    setSessionDropTarget: vi.fn(),
    cancelChatTabDrag: vi.fn(),
    takeSessionDropTarget: vi.fn(() => {
      const s = storeStub as { sessionDropTarget?: string | null; draggingChatTab?: unknown }
      const v = s.sessionDropTarget ?? null
      s.sessionDropTarget = null
      s.draggingChatTab = null
      return v
    }),
    // ChatView 挂载所需（chat Tab 激活时右侧内容区渲染）
    chatDraftFor: vi.fn(() => ""),
    setChatDraft: vi.fn(),
    chatEntries: vi.fn(() => []),
    statusOf: vi.fn(() => "idle"),
    runningBackgroundTasks: vi.fn(() => []),
    taskDetailVersion: 0,
    consumeTaskDetailRequest: vi.fn(() => null),
    findSession: vi.fn(() => null),
    chatScrollFor: vi.fn(() => null),
    setChatScroll: vi.fn(),
    focusModeFor: vi.fn(() => false),
    setFocusMode: vi.fn(),
    canLoadEarlier: vi.fn(() => false),
    loadEarlierMessages: vi.fn(),
    loadSessionMessages: vi.fn(),
    revertDraftVersion: 0,
    takeRevertDraft: vi.fn(() => null),
    current: null,
    commandsFor: vi.fn(() => []),
    commandsDegraded: false,
    commandsRefreshing: false,
    refreshCommands: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => ({ ok: true })),
    sendCommand: vi.fn(async () => ({ ok: true })),
    fileRefsFor: vi.fn(() => []),
    attachmentsFor: vi.fn(() => []),
    sessionPages: new Map(),
    pendingPermissions: new Map(),
    // file Tab 激活时 FileView 挂载所需（缓存 Map 直读）
    fileContents: new Map(),
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

const DT = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "", types: [] as string[] })

/** 对 chat Tab 的 .tab 节点火 dragStart（登记带外副本） */
function dragStartTab(title: string) {
  const tab = screen.getByText(title).closest(".tab") as HTMLElement
  fireEvent.dragStart(tab, { dataTransfer: DT() })
  return tab
}

describe("会话 Tab 拖放移动（dragend 提交分派）", () => {
  it("dragStart 登记 chat 拖拽带外副本", () => {
    storeStub = makeStore([chatTab("chat:s1", "标题A", DIR_A)])
    render(<Workspace />)
    dragStartTab("标题A")
    expect(storeStub.beginChatTabDrag).toHaveBeenCalledWith({
      sessionID: "s1",
      projectId: "p1",
      directory: DIR_A,
    })
  })

  it("非 chat Tab 拖拽不登记（无移动语义）", () => {
    // file Tab 置于非激活位——FileView 挂载链与本测无关
    const fileTab = { key: `file:${DIR_A}/a.md`, kind: "file", projectId: "p1", title: "a.md", directory: DIR_A }
    storeStub = makeStore([
      chatTab("chat:s0", "标题0", DIR_A),
      fileTab as unknown as ReturnType<typeof chatTab>,
    ])
    render(<Workspace />)
    fireEvent.dragStart(screen.getByText("a.md").closest(".tab") as HTMLElement, { dataTransfer: DT() })
    expect(storeStub.beginChatTabDrag).not.toHaveBeenCalled()
  })

  it("dragend 有移动目标 → 提交移动、不重排（任意位置放手语义）", () => {
    storeStub = makeStore([chatTab("chat:s1", "标题A", DIR_A), chatTab("chat:s2", "标题B", DIR_A)])
    render(<Workspace />)
    const tab = dragStartTab("标题A")
    // 模拟悬停合法 worktree 行（左栏行 dragover 已置目标）
    storeStub.draggingChatTab = { sessionID: "s1", projectId: "p1", directory: DIR_A }
    storeStub.sessionDropTarget = DIR_B
    fireEvent.dragEnd(tab)

    expect(storeStub.moveSession).toHaveBeenCalledWith("s1", DIR_B)
    expect(storeStub.applyTabOrder).not.toHaveBeenCalled()
  })

  it("dragend 无移动目标 → 回退既有重排序提交", () => {
    storeStub = makeStore([chatTab("chat:s1", "标题A", DIR_A), chatTab("chat:s2", "标题B", DIR_A)])
    render(<Workspace />)
    const tab = dragStartTab("标题A")
    storeStub.draggingChatTab = { sessionID: "s1", projectId: "p1", directory: DIR_A }
    fireEvent.dragEnd(tab)

    expect(storeStub.moveSession).not.toHaveBeenCalled()
    expect(storeStub.applyTabOrder).toHaveBeenCalledTimes(1)
  })

  it("目标目录 = 会话当前目录（拖拽期间被移动等竞态）→ 不移动，回退重排", () => {
    storeStub = makeStore([chatTab("chat:s1", "标题A", DIR_A)])
    render(<Workspace />)
    const tab = dragStartTab("标题A")
    storeStub.draggingChatTab = { sessionID: "s1", projectId: "p1", directory: DIR_A }
    storeStub.sessionDropTarget = DIR_A
    fireEvent.dragEnd(tab)

    expect(storeStub.moveSession).not.toHaveBeenCalled()
    expect(storeStub.applyTabOrder).toHaveBeenCalledTimes(1)
  })

  it("进行中会话拖放 → 二次确认：取消 = 不停不移", async () => {
    storeStub = makeStore([chatTab("chat:s1", "标题A", DIR_A)])
    ;(storeStub.isSessionActive as ReturnType<typeof vi.fn>).mockReturnValue(true)
    render(<Workspace />)
    const tab = dragStartTab("标题A")
    storeStub.draggingChatTab = { sessionID: "s1", projectId: "p1", directory: DIR_A }
    storeStub.sessionDropTarget = DIR_B
    fireEvent.dragEnd(tab)

    // 弹窗挂载（overlay 计数同步）
    expect(await screen.findByText("移动进行中的会话？")).not.toBeNull()
    expect(storeStub.pushOverlay).toHaveBeenCalled()

    // 取消（打开即聚焦取消钮——danger 弹窗安全默认）
    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    await act(async () => {})
    expect(storeStub.moveSessionConfirmed).not.toHaveBeenCalled()
    expect(storeStub.moveSession).not.toHaveBeenCalled()
    expect(screen.queryByText("移动进行中的会话？")).toBeNull()
  })

  it("进行中会话拖放 → 确认走先停后移（moveSessionConfirmed）", async () => {
    storeStub = makeStore([chatTab("chat:s1", "标题A", DIR_A)])
    ;(storeStub.isSessionActive as ReturnType<typeof vi.fn>).mockReturnValue(true)
    render(<Workspace />)
    const tab = dragStartTab("标题A")
    storeStub.draggingChatTab = { sessionID: "s1", projectId: "p1", directory: DIR_A }
    storeStub.sessionDropTarget = DIR_B
    fireEvent.dragEnd(tab)

    fireEvent.click(await screen.findByRole("button", { name: "确认" }))
    await act(async () => {})

    expect(storeStub.moveSessionConfirmed).toHaveBeenCalledWith("s1", DIR_B)
    // onConfirm Promise 完成后弹窗自关
    expect(screen.queryByText("移动进行中的会话？")).toBeNull()
  })

  it("悬停回 Tab 条 → 清移动目标，此后 dragend 走重排序（端到端互斥）", () => {
    storeStub = makeStore([chatTab("chat:s1", "标题A", DIR_A), chatTab("chat:s2", "标题B", DIR_A)])
    const { container } = render(<Workspace />)
    const tab = dragStartTab("标题A")
    storeStub.draggingChatTab = { sessionID: "s1", projectId: "p1", directory: DIR_A }
    storeStub.sessionDropTarget = DIR_B
    fireEvent.dragOver(container.querySelector(".tabbar") as HTMLElement, {
      clientX: 10,
      dataTransfer: DT(),
    })
    expect(storeStub.setSessionDropTarget).toHaveBeenCalledWith(null)
    // store 已清目标（桩模拟 emit 后状态）→ dragend 回退重排序提交，不移动
    storeStub.sessionDropTarget = null
    fireEvent.dragEnd(tab)

    expect(storeStub.moveSession).not.toHaveBeenCalled()
    expect(storeStub.applyTabOrder).toHaveBeenCalledTimes(1)
  })
})
