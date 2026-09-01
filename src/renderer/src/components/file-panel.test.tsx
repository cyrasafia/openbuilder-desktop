/**
 * 文件栏右键菜单测试（design-file-panel-context-menu）：
 * 对象解析（行 = 节点绝对路径；空白/标题栏 = 作用域根目录）、
 * 「打开方式」可见性（win32/darwin/linux，目录/空白处根目录同文件行）、动作走 IPC/clipboard。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { FilePanel } from "./file-panel"
import type { FileNode } from "@shared/api-types"

let platform: "linux" | "win32" | "darwin" | "browser" = "linux"
const shellOpenPath = vi.fn(async () => "")
const shellOpenWith = vi.fn(async () => "")
const openWithApp = vi.fn(async () => "")
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
      fileViewSource: "查看源码",
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
const ignoredFileNode: FileNode = {
  name: "dist.zip",
  path: "dist.zip",
  absolute: `${ROOT}/dist.zip`,
  type: "file",
  ignored: true,
}
const ignoredDirNode: FileNode = {
  name: "node_modules",
  path: "node_modules/",
  absolute: `${ROOT}/node_modules`,
  type: "directory",
  ignored: true,
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
    fileTreeNodes: new Map([[".", [dirNode, fileNode, ignoredFileNode, ignoredDirNode]]]),
    fileTreeExpanded: new Map(),
    activeTab: null,
    loadFileNodes: vi.fn(async () => {}),
    pushOverlay: vi.fn(),
    popOverlay: vi.fn(),
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

  it("目录行右键：打开对象 = 目录绝对路径；「打开方式」同样提供（2026-08-31 修订）", () => {
    platform = "win32"
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("src"))
    expect(screen.getByText("打开方式…")).toBeTruthy()
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

  it("「打开方式」linux 可见且开自建选择器（design-linux-open-with）；目录/空白处同提供", async () => {
    const listApps = vi.fn(async () => [{ id: "editor.desktop", name: "文本编辑器" }])
    Object.defineProperty(window, "desktop", {
      configurable: true,
      get: () => ({
        platform,
        shellOpenPath,
        shellOpenWith,
        shellListOpenWithApps: listApps,
        shellOpenWithApp: openWithApp,
      }),
    })
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("README.md"))
    fireEvent.click(screen.getByText("打开方式…"))
    expect(listApps).toHaveBeenCalledWith("/repo/README.md")
    // 枚举落地 → 弹窗列出应用（弹窗交互细节见 open-with-dialog.test）
    expect(await screen.findByText("文本编辑器")).toBeTruthy()
    cleanup()
    // 目录行：同显示并走选择器（inode/directory 命中文件管理器）
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("src"))
    fireEvent.click(screen.getByText("打开方式…"))
    expect(listApps).toHaveBeenCalledWith("/repo/src")
    expect(await screen.findByText("文本编辑器")).toBeTruthy()
    cleanup()
    // 空白处（作用域根目录）：同显示并走选择器
    render(<FilePanel />)
    fireEvent.contextMenu(document.querySelector(".tree") as Element)
    fireEvent.click(screen.getByText("打开方式…"))
    expect(listApps).toHaveBeenCalledWith(ROOT)
    expect(await screen.findByText("文本编辑器")).toBeTruthy()
  })

  it("「打开方式」win32/darwin 走系统对话框 shellOpenWith", () => {
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("README.md"))
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
    // 目录行 win32/darwin 同提供（系统对话框接受目录）
    cleanup()
    shellOpenWith.mockClear()
    platform = "darwin"
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("src"))
    expect(screen.getByText("打开方式…")).toBeTruthy()
    expect(shellOpenWith).not.toHaveBeenCalled()
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

  it("ignored 节点展示且带弱化类（design-layout §5：不再过滤）", () => {
    render(<FilePanel />)
    // 文件行与目录行都覆盖
    expect(screen.getByText("dist.zip").closest(".tree-row")?.classList.contains("ignored")).toBe(
      true,
    )
    expect(
      screen.getByText("node_modules").closest(".tree-row")?.classList.contains("ignored"),
    ).toBe(true)
    // 非 ignored 行不带弱化类
    expect(screen.getByText("README.md").closest(".tree-row")?.classList.contains("ignored")).toBe(
      false,
    )
  })

  it("无项目时不渲染菜单入口", () => {
    storeStub = { ...makeStore(), currentProject: null }
    const { container } = render(<FilePanel />)
    fireEvent.contextMenu(container.querySelector("aside") as Element)
    expect(screen.queryByText("打开")).toBeNull()
  })
})

describe("FilePanel .html 路由（design-browser-tab §1.4）", () => {
  it("点击 .html 默认开浏览器 Tab（file URL 编码）；shim 失败回退文件 Tab", async () => {
    const htmlNode: FileNode = { name: "页 面.html", path: "页 面.html", absolute: `${ROOT}/页 面.html`, type: "file", ignored: false }
    storeStub = {
      ...makeStore(),
      fileTreeNodes: new Map([[".", [dirNode, fileNode, htmlNode]]]),
      openBrowserTab: vi.fn(async () => true),
    }
    render(<FilePanel />)
    ;(screen.getAllByText("页 面.html")[0] as HTMLElement).click()
    await waitFor(() => {
      expect(storeStub.openBrowserTab).toHaveBeenCalledWith("file:///repo/%E9%A1%B5%20%E9%9D%A2.html")
    })
    expect(storeStub.openFileTab).not.toHaveBeenCalledWith(`${ROOT}/页 面.html`)

    // 回退：openBrowserTab false → 文件 Tab
    cleanup()
    ;(storeStub.openBrowserTab as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    render(<FilePanel />)
    ;(screen.getAllByText("页 面.html")[0] as HTMLElement).click()
    await waitFor(() => expect(storeStub.openFileTab).toHaveBeenCalledWith(`${ROOT}/页 面.html`))
  })

  it("右键 .html 显示「查看源码」，点击开文件 Tab", async () => {
    const htmlNode: FileNode = { name: "a.html", path: "a.html", absolute: `${ROOT}/a.html`, type: "file", ignored: false }
    storeStub = {
      ...makeStore(),
      fileTreeNodes: new Map([[".", [htmlNode]]]),
      openBrowserTab: vi.fn(async () => true),
      pushOverlay: vi.fn(),
      popOverlay: vi.fn(),
    }
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("a.html"))
    const item = await screen.findByText("查看源码")
    item.click()
    await waitFor(() => expect(storeStub.openFileTab).toHaveBeenCalledWith(`${ROOT}/a.html`))
    cleanup()
  })
})
