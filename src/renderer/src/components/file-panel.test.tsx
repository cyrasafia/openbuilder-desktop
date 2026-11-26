/**
 * 文件栏右键菜单测试（design-file-panel-context-menu）：
 * 对象解析（行 = 节点绝对路径；空白/标题栏 = 作用域根目录）、
 * 「打开方式」可见性（win32/darwin/linux，目录/空白处根目录同文件行）、动作走 IPC/clipboard、
 * 刷新入口（标题栏钮/菜单项）走 store.refreshFileTree（2026-11-25 增补）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
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
      fileRefresh: "刷新",
      filePreviewInBrowser: "在浏览器 Tab 中预览",
      filePreview: "预览",
      defaultAction: "默认",
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
    fileTreeExpanded: new Set<string>(),
    activeTab: null,
    loadFileNodes: vi.fn(async () => {}),
    refreshFileTree: vi.fn(),
    refreshingFileTree: false,
    pushOverlay: vi.fn(),
    popOverlay: vi.fn(),
    toggleFileNode: vi.fn(),
    openFileTab: vi.fn(),
    setFileViewState: vi.fn(),
    isLocalServer: true,
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
    // 末项 = 分隔线后的「刷新」（2026-11-25 增补）
    expect(document.activeElement).toBe(screen.getByText("刷新"))
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(menu, { key: "ArrowDown" })
    expect(document.activeElement).toBe(screen.getByText("打开"))
  })

  it("刷新（标题栏钮 + 菜单项，2026-11-25 增补）：走 store.refreshFileTree；动作后菜单关闭", () => {
    render(<FilePanel />)
    // 标题栏图标钮（左栏 Plus 钮同模式 .icon-btn）
    fireEvent.click(document.querySelector(".sidebar-heading .icon-btn") as Element)
    expect(storeStub.refreshFileTree).toHaveBeenCalledTimes(1)
    // 菜单项：任意对象（文件/目录/空白处根目录）都刷新整树，与对象路径无关
    fireEvent.contextMenu(screen.getByText("README.md"))
    fireEvent.click(screen.getByText("刷新"))
    expect(storeStub.refreshFileTree).toHaveBeenCalledTimes(2)
    expect(screen.queryByText("复制路径")).toBeNull()
    fireEvent.contextMenu(screen.getByText("src"))
    fireEvent.click(screen.getByText("刷新"))
    expect(storeStub.refreshFileTree).toHaveBeenCalledTimes(3)
  })

  it("刷新在途转圈（2026-11-26）：refreshingFileTree 驱动 .spinning 类；静止无类", () => {
    storeStub = { ...makeStore(), refreshingFileTree: true }
    const { container } = render(<FilePanel />)
    const btn = container.querySelector(".sidebar-heading .icon-btn") as Element
    expect(btn.classList.contains("spinning")).toBe(true)
    cleanup()
    storeStub = makeStore()
    render(<FilePanel />)
    const idle = document.querySelector(".sidebar-heading .icon-btn") as Element
    expect(idle.classList.contains("spinning")).toBe(false)
  })

  it("根目录未加载（首载失败后常驻「加载中…」）：两刷新入口仍在——刷新兼首载重试（review 一轮 #1）", () => {
    storeStub = { ...makeStore(), fileTreeNodes: new Map() }
    const { container } = render(<FilePanel />)
    expect(screen.getByText("加载中…")).toBeTruthy()
    fireEvent.click(container.querySelector(".sidebar-heading .icon-btn") as Element)
    expect(storeStub.refreshFileTree).toHaveBeenCalledTimes(1)
    // 树区空白处右键（面板级兜底，对象 = 作用域根目录）→ 菜单「刷新」
    fireEvent.contextMenu(container.querySelector(".tree") as Element)
    fireEvent.click(screen.getByText("刷新"))
    expect(storeStub.refreshFileTree).toHaveBeenCalledTimes(2)
  })

  it("根未加载且刷新在途：挂载效应不抢跑根首载；标记收（同作用域 reset）后效应重跑补拉根", () => {
    // 在途闸：空白窗口内不抢跑（重列集合根恒在，抢跑吞清空帧）
    const load = vi.fn(async () => {})
    storeStub = {
      ...makeStore(),
      fileTreeNodes: new Map(),
      refreshingFileTree: true,
      loadFileNodes: load,
    }
    const { rerender } = render(<FilePanel />)
    expect(screen.getByText("加载中…")).toBeTruthy()
    expect(load).not.toHaveBeenCalled()
    // m1（2026-11-26 review）：同作用域 resetFileTree 收标记作废本轮后 hasLoaded
    // 仍是 false 且不变——依赖须含 refreshingFileTree，效应才重跑，否则卡「加载中…」
    storeStub = { ...storeStub, refreshingFileTree: false }
    rerender(<FilePanel />)
    expect(load).toHaveBeenCalledWith(".")
    cleanup()
    // 刷新不在途直接挂载：效应照常首载根
    storeStub = {
      ...makeStore(),
      fileTreeNodes: new Map(),
      refreshingFileTree: false,
      loadFileNodes: vi.fn(async () => {}),
    }
    render(<FilePanel />)
    expect(storeStub.loadFileNodes).toHaveBeenCalledWith(".")
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

  it("无项目时：保留「文件」标题行（2026-09-06 修订，与左栏空态对称），不渲染菜单入口与刷新钮", () => {
    storeStub = { ...makeStore(), currentProject: null }
    const { container } = render(<FilePanel />)
    expect(screen.getByText("文件").closest(".sidebar-heading")).toBeTruthy()
    expect(container.querySelector(".tree")).toBeNull()
    // 空态无树：标题栏不提供刷新钮（2026-11-25 增补的空态例外）
    expect(container.querySelector(".sidebar-heading .icon-btn")).toBeNull()
    fireEvent.contextMenu(container.querySelector("aside") as Element)
    expect(screen.queryByText("打开")).toBeNull()
  })
})

// 刷新滚动还原（R6-1 方案 B）：jsdom 无布局，scrollTop 用钳制语义模型——
// 写 = 钳到 [0, maxScroll]，读 = 当前值；内容塌缩/长高引发的浏览器钳制由用例
// 手工改 value/maxScroll 模拟。每帧独立 rerender（RTL 自带 act，帧不合并）
describe("FilePanel 刷新滚动还原（R6-1 方案 B，scrollTop 钳制模型）", () => {
  const scrollModel = { value: 0, maxScroll: 400 }
  let restoreScroll: (() => void) | null = null

  function installScrollModel() {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get: () => scrollModel.value,
      set: (v: number) => {
        scrollModel.value = Math.max(0, Math.min(v, scrollModel.maxScroll))
      },
    })
    restoreScroll = () => {
      if (desc) Object.defineProperty(Element.prototype, "scrollTop", desc)
      restoreScroll = null
    }
  }

  afterEach(() => {
    restoreScroll?.()
    restoreScroll = null
  })

  /** 触发帧：真实流程置位与清空同帧 emit（hasLoaded 即 false），浏览器在塌缩帧
   *  把 scrollTop 钳 0——节点清空、标记置位、钳 0 三件事一批，独立 rerender */
  function triggerFrame(
    rerender: (ui: ReactNode) => void,
    nodes: Map<string, FileNode[]>,
  ) {
    nodes.clear()
    storeStub.refreshingFileTree = true
    scrollModel.value = 0
    rerender(<FilePanel />)
  }

  function renderPanel(nodes: Map<string, FileNode[]>) {
    storeStub = { ...makeStore(), fileTreeNodes: nodes }
    return render(<FilePanel />)
  }

  function clickTitleRefresh() {
    fireEvent.click(document.querySelector(".sidebar-heading .icon-btn") as Element)
    expect(storeStub.refreshFileTree).toHaveBeenCalledTimes(1)
  }

  it("标题栏钮：点击时存滚动位（清空前），落地帧还原 400 而非钳后的 0", () => {
    installScrollModel()
    scrollModel.value = 400
    const nodes = new Map([[".", [dirNode, fileNode]]])
    const { rerender } = renderPanel(nodes)
    clickTitleRefresh()
    triggerFrame(rerender, nodes)
    // 根落地帧：内容回来 → layout 提交前还原
    nodes.set(".", [dirNode, fileNode])
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(400)
  })

  it("右键菜单：同一 refreshTree 入口，落地帧同样还原（探针 2）", () => {
    installScrollModel()
    scrollModel.value = 400
    const nodes = new Map([[".", [fileNode]]])
    const { rerender } = renderPanel(nodes)
    fireEvent.contextMenu(screen.getByText("README.md"))
    fireEvent.click(screen.getByText("刷新"))
    expect(storeStub.refreshFileTree).toHaveBeenCalledTimes(1)
    triggerFrame(rerender, nodes)
    nodes.set(".", [fileNode])
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(400)
  })

  it("子目录晚于根落地：根帧高度不足被钳制，size 变化重试至还原（未探测风险 5）", () => {
    installScrollModel()
    scrollModel.value = 400
    const nodes = new Map([[".", [fileNode]], ["src/", []]])
    const { rerender } = renderPanel(nodes)
    clickTitleRefresh()
    // 根落地帧：内容矮（maxScroll=50）——写入被钳到 50 ≠ 400，pending 留待重试
    triggerFrame(rerender, nodes)
    scrollModel.maxScroll = 50
    nodes.set(".", [fileNode])
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(50)
    // src/ 落地帧：高度够 → 重试成功
    scrollModel.maxScroll = 400
    nodes.set("src/", [dirNode])
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(400)
  })

  it("补足尾段用户滚动不被收标帧回写（探针 5；91e7652 的重置缺陷）", () => {
    installScrollModel()
    scrollModel.value = 400
    const nodes = new Map([[".", [fileNode]]])
    const { rerender } = renderPanel(nodes)
    clickTitleRefresh()
    triggerFrame(rerender, nodes)
    nodes.set(".", [fileNode])
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(400)
    // 尾段用户滚到 250 → 收标帧不得回写
    scrollModel.value = 250
    storeStub.refreshingFileTree = false
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(250)
  })

  it("落地前切作用域：轮作废清 pending 不写入，新作用域不带旧值（探针 4）", () => {
    installScrollModel()
    scrollModel.value = 400
    const nodes = new Map([[".", [fileNode]]])
    const { rerender } = renderPanel(nodes)
    clickTitleRefresh()
    // 触发帧 + 作废（resetFileTree 收标记，标记 false）：pending 清、无写入
    nodes.clear()
    storeStub.refreshingFileTree = false
    scrollModel.value = 0
    rerender(<FilePanel />)
    // 新作用域落地帧：不得写入旧值 400
    nodes.set(".", [fileNode])
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(0)
  })

  it("失败回填帧还原（探针 6）：回填 emit 时标记仍真，内容帧归位", () => {
    installScrollModel()
    scrollModel.value = 400
    const nodes = new Map([[".", [fileNode]], ["src/", []]])
    const { rerender } = renderPanel(nodes)
    clickTitleRefresh()
    triggerFrame(rerender, nodes)
    // settle 回填（标记仍真）→ 内容帧还原
    nodes.set(".", [fileNode])
    nodes.set("src/", [])
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(400)
  })

  it("落地后切作用域：已还原即清 pending，新作用域无残留写入（探针 3）", () => {
    installScrollModel()
    scrollModel.value = 400
    const nodes = new Map([[".", [fileNode]]])
    const { rerender } = renderPanel(nodes)
    clickTitleRefresh()
    triggerFrame(rerender, nodes)
    nodes.set(".", [fileNode])
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(400) // 已还原、pending 清
    // 切新作用域：滚动归零（浏览器行为），不得被旧值回写
    scrollModel.value = 0
    storeStub.refreshingFileTree = false
    nodes.clear()
    nodes.set(".", [fileNode])
    rerender(<FilePanel />)
    expect(scrollModel.value).toBe(0)
  })
})

describe("FilePanel .html 路由（design-html-preview §3.3 按连接分派）", () => {
  const htmlNode: FileNode = { name: "页 面.html", path: "页 面.html", absolute: `${ROOT}/页 面.html`, type: "file", ignored: false }

  function htmlStore(isLocal: boolean) {
    return {
      ...makeStore(),
      fileTreeNodes: new Map([[".", [dirNode, fileNode, htmlNode]]]),
      openBrowserTab: vi.fn(async () => true),
      isLocalServer: isLocal,
    }
  }

  it("本地 server：点击 .html 默认开浏览器 Tab（file URL 编码）；shim 失败回退文件 Tab", async () => {
    storeStub = htmlStore(true)
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

  it("远程 server：点击 .html 默认文件 Tab（预览态），不开浏览器 Tab", async () => {
    storeStub = htmlStore(false)
    render(<FilePanel />)
    ;(screen.getAllByText("页 面.html")[0] as HTMLElement).click()
    await waitFor(() => expect(storeStub.openFileTab).toHaveBeenCalledWith(`${ROOT}/页 面.html`))
    expect(storeStub.openBrowserTab).not.toHaveBeenCalled()
  })

  it("右键 .html 双入口置首：本地默认标在「在浏览器 Tab 中预览」；远程标在「预览」；预览入口强制 preview 模式", async () => {
    // 本地：默认标记在浏览器项
    storeStub = htmlStore(true)
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("页 面.html"))
    const browserBtn = (await screen.findByText("在浏览器 Tab 中预览")).closest("button") as HTMLButtonElement
    const previewBtn = (screen.getByText("预览")).closest("button") as HTMLButtonElement
    expect(browserBtn.textContent).toContain("默认")
    expect(previewBtn.textContent).not.toContain("默认")
    previewBtn.click()
    await waitFor(() => expect(storeStub.setFileViewState).toHaveBeenCalledWith(`${ROOT}/页 面.html`, { mode: "preview", top: 0 }))
    await waitFor(() => expect(storeStub.openFileTab).toHaveBeenCalledWith(`${ROOT}/页 面.html`, undefined, { remountView: true }))
    cleanup()

    // 远程：默认标记在预览项；浏览器入口仍可用
    storeStub = htmlStore(false)
    render(<FilePanel />)
    fireEvent.contextMenu(screen.getByText("页 面.html"))
    const browserBtn2 = (await screen.findByText("在浏览器 Tab 中预览")).closest("button") as HTMLButtonElement
    const previewBtn2 = (screen.getByText("预览")).closest("button") as HTMLButtonElement
    expect(previewBtn2.textContent).toContain("默认")
    expect(browserBtn2.textContent).not.toContain("默认")
    browserBtn2.click()
    await waitFor(() => expect(storeStub.openBrowserTab).toHaveBeenCalledWith("file:///repo/%E9%A1%B5%20%E9%9D%A2.html"))
    cleanup()
  })
})
