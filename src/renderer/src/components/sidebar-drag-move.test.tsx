/**
 * 左栏行 = 会话 Tab 拖放移动目标（design-session-tab-drag-move §2.3）测试：
 * - 合法性判定：同项目 + 非会话当前目录 + 移动 POST 不在途；合法行
 *   preventDefault + 设目标，当前目录行 = 清目标（"放回原处"手势）；
 * - 他项目行/在途：不受理也不清（目标粘滞——任意位置放手都移动）；
 * - 目标行高亮类（.drop-target）随 store.sessionDropTarget 渲染。
 * sidebar 主体历来不单测（AppStore 全量驱动），本文件为其首个聚焦用例：
 * 行级 dragover 合法性是移动安全网（错误移动 = 数据动作），值得桩测。
 */
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Sidebar } from "./sidebar"
import type { Project } from "@shared/api-types"

/** 测试内动态替换的 store 桩（vi.mock 提升导致闭包需经变量间接） */
let storeStub: Record<string, unknown>

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      projectsTitle: "项目",
      openProject: "打开项目",
      newWorkspace: "新建工作区",
      deleteWorkspace: "删除工作树",
      closeProject: "关闭项目",
      deletingWorkspace: "正在清理…",
      sessionIndicatorTitle: "会话 {count}，进行中 {busy}，重试 {error}，失败 {failed}，待输入 {waiting}，未读 {unread}",
      settings: "设置",
      statusStreaming: "已连接",
      statusDegraded: "重连中",
      statusOffline: "未连接",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

const ROOT = "/repo"
const WT1 = "/repo/.git/opencode-worktrees/wt1"
const OTHER = "/other"

const proj1: Project = {
  id: "p1",
  worktree: ROOT,
  vcs: "git",
  time: { created: 0, updated: 0 },
  sandboxes: [WT1],
}
const proj2: Project = { id: "p2", worktree: OTHER, vcs: "git", time: { created: 0, updated: 0 }, sandboxes: [] }

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    layoutLeftCollapsed: false,
    // ServerStatus
    connectionState: "streaming",
    activeProfile: null,
    baseUrl: "",
    connectionError: "",
    serverVersionWarning: null,
    managedNotice: null,
    openSettings: vi.fn(),
    // ProjectTree
    openedEntries: [
      { key: "p1", name: "repo", directory: ROOT, project: proj1 },
      { key: "p2", name: "other", directory: OTHER, project: proj2 },
    ],
    currentProject: proj1,
    scopePreview: null,
    applyEntryOrder: vi.fn(),
    isEntryActive: vi.fn(() => false),
    workspacesOfProject: vi.fn((projectId: string) =>
      projectId === "p1" ? [{ name: "wt1", directory: WT1 }] : [],
    ),
    sessionsInDirectory: vi.fn(() => []),
    isWorkspaceDeleting: vi.fn(() => false),
    currentWorkspace: null,
    createWorkspace: vi.fn(),
    closeEntry: vi.fn(),
    requestWorktreeDelete: vi.fn(),
    openEntry: vi.fn(),
    setCurrentProject: vi.fn(),
    setCurrentWorkspace: vi.fn(),
    openProjectPicker: vi.fn(),
    branchNotice: null,
    pickerOpen: false,
    pendingWorktreeDelete: null,
    dirtyCheckFor: vi.fn(() => undefined),
    cancelWorktreeDelete: vi.fn(),
    // 拖放移动（design-session-tab-drag-move）：findSession 缺省 null =
    // 僵尸 Tab 回退快照（dragScopeOf 语义）
    draggingChatTab: null as { sessionID: string; projectId: string; directory: string } | null,
    sessionDropTarget: null as string | null,
    isSessionMoving: vi.fn(() => false),
    setSessionDropTarget: vi.fn(),
    findSession: vi.fn(() => null),
    ...overrides,
  }
}

/** 拖拽中的会话（目录缺省 = 主工作区 ROOT） */
const dragging = (directory = ROOT) => ({ sessionID: "s1", projectId: "p1", directory })

const DT = () => ({ dropEffect: "", types: [] as string[] })

beforeEach(() => {
  storeStub = makeStore()
})

afterEach(() => {
  cleanup()
})

/** worktree 行（title 属性在内层 .tree-label 上——行 div 无 title） */
function wsRow(directory: string) {
  const label = document.querySelector<HTMLElement>(`.ws-row .tree-label[title="${directory}"]`)
  const row = label?.closest<HTMLElement>(".ws-row")
  if (!row) throw new Error(`ws-row not found: ${directory}`)
  return row
}

/** 项目行（data-entry-key 在 .project-group 容器上） */
function projectRow(entryKey: string) {
  const row = document.querySelector<HTMLElement>(
    `.project-group[data-entry-key="${entryKey}"] > .tree-row.project-row`,
  )
  if (!row) throw new Error(`project-row not found: ${entryKey}`)
  return row
}

describe("左栏行 = 拖放移动目标（合法性判定）", () => {
  it("同项目 worktree 行合法：preventDefault + 设目标", () => {
    storeStub = makeStore({ draggingChatTab: dragging() })
    render(<Sidebar />)
    const row = wsRow(WT1)

    // fireEvent 返回 false = 事件被 preventDefault（行成合法落区）
    expect(fireEvent.dragOver(row, { dataTransfer: DT() })).toBe(false)
    expect(storeStub.setSessionDropTarget).toHaveBeenCalledWith(WT1)
  })

  it("项目行（主工作区）合法：会话在 worktree 中时可移回", () => {
    storeStub = makeStore({ draggingChatTab: dragging(WT1) })
    render(<Sidebar />)
    const row = projectRow("p1")

    expect(fireEvent.dragOver(row, { dataTransfer: DT() })).toBe(false)
    expect(storeStub.setSessionDropTarget).toHaveBeenCalledWith(ROOT)
  })

  it("悬停会话当前目录行 = 放回原处手势：清目标、不受理", () => {
    storeStub = makeStore({ draggingChatTab: dragging() })
    render(<Sidebar />)
    const row = projectRow("p1")

    expect(fireEvent.dragOver(row, { dataTransfer: DT() })).toBe(true)
    expect(storeStub.setSessionDropTarget).toHaveBeenCalledWith(null)
    expect(storeStub.setSessionDropTarget).toHaveBeenCalledTimes(1)
  })

  it("他项目行不受理也不清（目标粘滞，任意位置放手都移动）", () => {
    storeStub = makeStore({ draggingChatTab: dragging() })
    render(<Sidebar />)
    const row = projectRow("p2")

    expect(fireEvent.dragOver(row, { dataTransfer: DT() })).toBe(true)
    expect(storeStub.setSessionDropTarget).not.toHaveBeenCalled()
  })

  it("移动 POST 在途不受理；无拖拽登记（项目行自身拖拽排序等）互不干扰", () => {
    storeStub = makeStore({ draggingChatTab: dragging(), isSessionMoving: vi.fn(() => true) })
    render(<Sidebar />)
    expect(fireEvent.dragOver(wsRow(WT1), { dataTransfer: DT() })).toBe(true)
    expect(storeStub.setSessionDropTarget).not.toHaveBeenCalled()

    // 项目行拖拽排序进行中（无 chat 拖拽登记）：行级 dragover 早退
    storeStub = makeStore({ draggingChatTab: null })
    cleanup()
    render(<Sidebar />)
    expect(fireEvent.dragOver(wsRow(WT1), { dataTransfer: DT() })).toBe(true)
    expect(storeStub.setSessionDropTarget).not.toHaveBeenCalled()
  })

  it("目标行高亮：.drop-target 随 sessionDropTarget 渲染，其余行不高亮", () => {
    storeStub = makeStore({ draggingChatTab: dragging(), sessionDropTarget: WT1 })
    render(<Sidebar />)

    expect(wsRow(WT1).classList.contains("drop-target")).toBe(true)
    expect(projectRow("p1").classList.contains("drop-target")).toBe(false)
  })

  it("远端移动竞态：判定按会话实时目录——快照里的旧目录行不再误判为当前目录", () => {
    // 拖拽中他端把会话从 ROOT 移到 WT1：快照 directory 仍是 ROOT，实时目录 WT1。
    // 此时 ROOT 行（主工作区）是合法目标，不得按快照误清目标
    storeStub = makeStore({
      draggingChatTab: dragging(), // 快照 directory = ROOT
      findSession: vi.fn(() => ({ projectID: "p1", directory: WT1 })),
    })
    render(<Sidebar />)

    expect(fireEvent.dragOver(projectRow("p1"), { dataTransfer: DT() })).toBe(false)
    expect(storeStub.setSessionDropTarget).toHaveBeenCalledWith(ROOT)
    // 实时当前目录行（WT1）才走"放回原处"清目标
    expect(fireEvent.dragOver(wsRow(WT1), { dataTransfer: DT() })).toBe(true)
    expect(storeStub.setSessionDropTarget).toHaveBeenLastCalledWith(null)
  })
})
