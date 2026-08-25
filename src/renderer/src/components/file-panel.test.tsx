/**
 * 文件栏右键菜单测试（design-file-panel-context-menu）：
 * 对象解析（行 = 节点绝对路径；空白/标题栏 = 作用域根目录）、
 * 「打开方式」可见性（仅文件行 + win32/darwin）、动作走 IPC/clipboard。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { FilePanel } from "./file-panel"
import type { FileNode } from "@shared/api-types"

let platform: "linux" | "win32" | "darwin" | "browser" = "linux"
const shellOpenPath = vi.fn(async () => "")
const shellOpenWith = vi.fn(async () => "")
const writeText = vi.fn(async () => {})

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      noProject: "先打开一个项目",
      filesTitle: "文件",
      loading: "加载中…",
      fileOpen: "打开",
      fileOpenWith: "打开方式…",
      fileCopyPath: "复制路径",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

const ROOT = "/repo"

const fileNode: FileNode = {
  name: "README.md",
  path: "README.md",
  absolute: `${ROOT}/README.md`,
  type: "file",
  ignored: false,
}
const dirNode: FileNode = {
  name: "src",
  path: "src/",
  absolute: `${ROOT}/src`,
  type: "directory",
  ignored: false,
}

/** 测试内动态替换的 store 桩（vi.mock 提升导致闭包需经变量间接） */
let storeStub: Record<string, unknown>

function makeStore(): Record<string, unknown> {
  return {
    currentProject: {
      id: "proj1",
      name: "demo",
      worktree: ROOT,
      time: { created: 0, updated: 0 },
      sandboxes: [],
    },
    currentWorkspace: null,
    scopeQuery: { directory: ROOT },
    fileTreeNodes: new Map([[".", [dirNode, fileNode]]]),
    fileTreeExpanded: new Map(),
    activeTab: null,
    loadFileNodes: vi.fn(async () => {}),
    toggleFileNode: vi.fn(),
    openFileTab: vi.fn(),
  }
}

beforeAll(() => {
  Object.defineProperty(window, "desktop", {
    configurable: true,
    get: () => ({ platform, shellOpenPath, shellOpenWith }),
  })
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value: { writeText },
  })
})

beforeEach(() => {
  platform = "linux"
  storeStub = makeStore()
  shellOpenPath.mockClear()
  shellOpenWith.mockClear()
  writeText.mockClear()
})

afterEach(cleanup)

describe("FilePanel 右键菜单", () => {
  it("文件行右键：打开/复制路径对象 = 节点绝对路径；动作后菜单关闭", () => {
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("README.md"))
    fireEvent.click(screen.getByText("打开"))
    expect(shellOpenPath).toHaveBeenCalledWith("/repo/README.md")
    expect(screen.queryByText("复制路径")).toBeNull()
  })

  it("目录行右键：打开对象 = 目录绝对路径；无「打开方式」（目录无语义）", () => {
    platform = "win32"
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("src"))
    expect(screen.queryByText("打开方式…")).toBeNull()
    fireEvent.click(screen.getByText("打开"))
    expect(shellOpenPath).toHaveBeenCalledWith("/repo/src")
  })

  it("标题栏/空白处右键：打开与复制对象 = 作用域根目录", () => {
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("文件"))
    fireEvent.click(screen.getByText("复制路径"))
    expect(writeText).toHaveBeenCalledWith(ROOT)

    fireEvent.contextMenu(document.querySelector(".tree") as Element)
    fireEvent.click(screen.getByText("打开"))
    expect(shellOpenPath).toHaveBeenCalledWith(ROOT)
  })

  it("「打开方式」仅文件行 + win32/darwin 可见；动作走 shellOpenWith", () => {
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("README.md"))
    expect(screen.queryByText("打开方式…")).toBeNull()
    fireEvent.click(screen.getByText("打开"))
    cleanup()

    platform = "win32"
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("README.md"))
    fireEvent.click(screen.getByText("打开方式…"))
    expect(shellOpenWith).toHaveBeenCalledWith("/repo/README.md")
    cleanup()

    platform = "darwin"
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("README.md"))
    expect(screen.getByText("打开方式…")).toBeTruthy()
  })

  it("打开后初始焦点在首项（键盘导航前提；autoFocus 在隐藏帧落空，rAF 补齐）", async () => {
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("README.md"))
    await new Promise((r) => requestAnimationFrame(r))
    expect(document.activeElement).toBe(screen.getByText("打开"))
  })

  it("焦点不在菜单内时：ArrowUp 落末项、ArrowDown 落首项（Tab 移出后仍对称）", () => {
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("README.md"))
    const menu = document.querySelector(".context-menu") as HTMLElement
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(menu, { key: "ArrowUp" })
    expect(document.activeElement).toBe(screen.getByText("复制路径"))
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    expect(document.activeElement).toBe(screen.getByText("打开"))
  })

  it("无项目时不渲染菜单入口", () => {
    storeStub = { ...makeStore(), currentProject: null }
    const { container } = render(<FilePanel />)
    fireEvent.contextMenu(container.querySelector("aside") as Element)
    expect(screen.queryByText("打开")).toBeNull()
  })
})
