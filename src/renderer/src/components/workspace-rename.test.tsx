/**
 * Tab 行内重命名测试（design-tab-drag-rename + design-input-selection-restore
 * 2026-09-30 修订）：失焦不提交（blur 只保存选区快照）后，提交收敛于
 * Enter/Escape/换目标三条显式路径——本文件覆盖换目标与守卫两处提交/清理：
 * - 右键菜单换目标重命名：先 commitRename 提交旧目标（镜像双击路径，否则
 *   旧草稿被 setRenaming 静默覆盖丢弃——2026-09-30 review 发现）
 * - 悬挂守卫：目标 Tab 被 SSE 关闭（store.tabs 不再含该 key）时清 renaming
 *   + 选区快照；**切作用域**（目标 Tab 仍在 store.tabs、仅不在当前作用域
 *   过滤数组）不清——草稿保留，切回可续编（守卫判定集合必须用未过滤
 *   store.tabs 的原因）
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
// 重组件 mock 掉（本测试只关心 Tab 条与重命名输入框）
vi.mock("./terminal-view", () => ({ TerminalView: () => null }))
vi.mock("./model-switcher", () => ({ ModelSwitcherBar: () => null }))
// chat Tab 会挂载 ChatView（工作区右侧内容区）——重命名流不涉及，mock 其
// 内部依赖即可让 ChatView 挂载成功
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
const DIR_B = "/repo/b"

function chatTab(key: string, title: string, directory: string) {
  return { key, kind: "chat", title, directory }
}

function makeStore(tabs: ReturnType<typeof chatTab>[], scopeDir = DIR_A) {
  const renameSession = vi.fn(async () => true)
  return {
    store: null as unknown,
    openedProjects: [
      { id: "p1", directory: DIR_A },
      { id: "p2", directory: DIR_B },
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
    pushOverlay: vi.fn(),
    popOverlay: vi.fn(),
    dotStateFor: vi.fn(() => null),
    isBrowserWelcome: vi.fn(() => false),
    renameSession,
    // ChatView 挂载所需（chat Tab 激活时右侧内容区渲染；重命名流不涉及，
    // 给空值桩让挂载成功）
    chatDraftFor: vi.fn(() => ""),
    setChatDraft: vi.fn(),
    chatEntries: vi.fn(() => []),
    statusOf: vi.fn(() => "idle"),
    findSession: vi.fn(() => null),
    chatScrollFor: vi.fn(() => null),
    setChatScroll: vi.fn(),
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

/** 双击 Tab 进入重命名编辑态（Tab div 无 title 属性，按文本找 label 再冒泡到 .tab） */
function startRename(tabTitle: string) {
  const label = screen.getByText(tabTitle)
  const tab = label.closest(".tab") as HTMLElement
  fireEvent.doubleClick(tab)
  return screen.getByRole("textbox", { name: "重命名" }) as HTMLInputElement
}

describe("Tab 行内重命名（失焦不提交的语义收敛）", () => {
  it("右键菜单换目标重命名：先提交旧目标草稿（镜像双击路径），再进入新目标编辑", async () => {
    const tabs = [chatTab("chat:s1", "标题A", DIR_A), chatTab("chat:s2", "标题B", DIR_A)]
    storeStub = makeStore(tabs)
    const { rerender } = render(<Workspace />)
    const input = startRename("标题A")
    fireEvent.change(input, { target: { value: "草稿新名" } })

    // 右键 Tab B → 重命名（右键菜单渲染于 portal，走 ContextMenu 组件内部按钮）
    const tabB = screen.getByText("标题B")
    fireEvent.contextMenu(tabB.closest(".tab") as HTMLElement)
    const renameItem = await screen.findByText("重命名")
    fireEvent.click(renameItem)
    await act(() => {})

    // 旧目标草稿经 commitRename 提交（未被静默丢弃），新目标进入编辑态
    const store = storeStub as unknown as { renameSession: ReturnType<typeof vi.fn> }
    expect(store.renameSession).toHaveBeenCalledWith("s1", "草稿新名")
    const input2 = screen.getByRole("textbox", { name: "重命名" }) as HTMLInputElement
    expect(input2.value).toBe("标题B")
    // 新目标全选（新会话默认）
    expect(input2.selectionStart).toBe(0)
    expect(input2.selectionEnd).toBe("标题B".length)
  })

  it("双击换目标重命名（镜像对照）：同样先提交旧目标", async () => {
    const tabs = [chatTab("chat:s1", "标题A", DIR_A), chatTab("chat:s2", "标题B", DIR_A)]
    storeStub = makeStore(tabs)
    render(<Workspace />)
    const input = startRename("标题A")
    fireEvent.change(input, { target: { value: "草稿新名" } })

    // 双击 Tab B（对另一 Tab 双击）——切换激活 + 换目标重命名
    fireEvent.doubleClick((screen.getByText("标题B").closest(".tab") as HTMLElement))
    await act(() => {})

    const store = storeStub as unknown as { renameSession: ReturnType<typeof vi.fn> }
    expect(store.renameSession).toHaveBeenCalledWith("s1", "草稿新名")
    const input2 = screen.getByRole("textbox", { name: "重命名" }) as HTMLInputElement
    expect(input2.value).toBe("标题B")
  })

  it("悬挂守卫：目标 Tab 被外部关闭（store.tabs 移除）→ 清 renaming 与选区快照", async () => {
    const tabs = [chatTab("chat:s1", "标题A", DIR_A)]
    storeStub = makeStore(tabs)
    const { rerender } = render(<Workspace />)
    const input = startRename("标题A")
    fireEvent.change(input, { target: { value: "草稿新名" } })
    fireEvent.blur(input) // 保存快照（未提交——新语义）

    // SSE 删会话：store.tabs 移除目标（桩测试经 rerender 模拟 emit 后重渲染；
    // 真实数据流 = SSE emit → useSyncExternalStore… 此桩体系为 Context 直读）
    storeStub = { ...storeStub, tabs: [] }
    rerender(<Workspace />)
    await act(async () => {})

    expect(screen.queryByRole("textbox", { name: "重命名" })).toBeNull()
    const store = storeStub as unknown as { renameSession: ReturnType<typeof vi.fn> }
    expect(store.renameSession).not.toHaveBeenCalled()
  })

  it("切作用域不清 renaming（守卫判定集合 = 未过滤 store.tabs）：草稿保留", async () => {
    const tabs = [chatTab("chat:s1", "标题A", DIR_A), chatTab("chat:s2", "标题B", DIR_B)]
    storeStub = makeStore(tabs, DIR_A)
    const { rerender } = render(<Workspace />)
    const input = startRename("标题A")
    fireEvent.change(input, { target: { value: "草稿新名" } })

    // 切换作用域到 B：scopeQuery.directory 变化 → 过滤后的 tabs 不含目标，
    // 但未过滤 store.tabs 仍含——守卫不得触发
    storeStub = { ...storeStub, scopeQuery: { directory: DIR_B } }
    rerender(<Workspace />)
    await act(async () => {})

    const store = storeStub as unknown as { renameSession: ReturnType<typeof vi.fn> }
    expect(store.renameSession).not.toHaveBeenCalled()
    // 作用域 B 的 Tab 条不渲染 A 的输入框（A 的 Tab 不在 B 作用域），
    // renaming 状态保留待切回续编——此处仅断言未提交未清除
  })

  it("切回原作用域恢复编辑状态（草稿+光标，selection-restore 跨作用域往返）", async () => {
    const tabs = [chatTab("chat:s1", "标题A", DIR_A)]
    storeStub = makeStore(tabs, DIR_A)
    const { rerender } = render(<Workspace />)
    const input = startRename("标题A")
    fireEvent.change(input, { target: { value: "草稿新名" } })
    input.setSelectionRange(2, 2)
    fireEvent.blur(input)

    // 切走（B 作用域）再切回（A）：重挂载编辑输入框，草稿与光标恢复
    storeStub = { ...storeStub, scopeQuery: { directory: DIR_B } }
    rerender(<Workspace />)
    await act(async () => {})
    storeStub = { ...storeStub, scopeQuery: { directory: DIR_A } }
    rerender(<Workspace />)
    await act(async () => {})

    const input2 = screen.getByRole("textbox", { name: "重命名" }) as HTMLInputElement
    expect(input2.value).toBe("草稿新名")
    expect(input2.selectionStart).toBe(2)
    expect(input2.selectionEnd).toBe(2)
  })
})