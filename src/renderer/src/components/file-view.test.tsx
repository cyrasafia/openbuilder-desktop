/**
 * FileView 分发与 markdown 二态测试（design-markdown-preview）：
 * 扩展名分发（.md/.markdown/.MD → 预览；.mdx/点文件/无扩展名/代码 → 源码）
 * + 预览/源码切换 + 加载/错误态工具条常驻 + TOC 大纲（§2.4）。
 * jsdom 无 IntersectionObserver（streamdown 依赖），测试前补 stub。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { FileView } from "./workspace"
import { ResizeObserverStub } from "./resize-observer-stub"

const loadFileContent = vi.fn(async () => {})
const scrollIntoView = vi.fn()

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      loading: "加载中…",
      previewMode: "预览",
      sourceMode: "源码",
      viewModeLabel: "查看方式",
      copy: "复制",
      copied: "已复制",
      tocTitle: "目录",
      tocCollapse: "收起目录",
      tocExpand: "展开目录",
      tocSectionToggle: "折叠/展开章节",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({
    fileContents: fileContentsStub,
    loadFileContent,
  }),
}))

/** 测试内动态替换的内容表（vi.mock 提升导致闭包需经变量间接） */
let fileContentsStub: Map<string, { content: string; error?: string }>

beforeAll(() => {
  class IntersectionObserverStub implements IntersectionObserver {
    readonly root: Element | null = null
    readonly rootMargin: string = ""
    readonly scrollMargin: string = ""
    readonly thresholds: ReadonlyArray<number> = []
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  }
  globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver
  // CodeMirror 视图测量 + FileView TOC 测宽依赖 ResizeObserver（jsdom 缺失）
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  // TOC 点击锚定走 scrollIntoView（jsdom 未实现）
  Element.prototype.scrollIntoView = scrollIntoView
})

afterAll(() => {
  cleanup()
})

beforeEach(() => {
  // 本仓库 vitest 未开 globals，RTL auto-cleanup 不生效——手动卸载
  cleanup()
  ResizeObserverStub.reset()
  loadFileContent.mockClear()
  scrollIntoView.mockClear()
  fileContentsStub = new Map()
})

/** 模拟 .file-view-wrap 宽度变更（jsdom clientWidth 恒 0，需覆写后触发 RO 回调） */
function setPaneWidth(width: number) {
  const wrap = document.querySelector(".file-view-wrap") as HTMLElement
  Object.defineProperty(wrap, "clientWidth", { value: width, configurable: true })
  const ro = ResizeObserverStub.instances.find((r) => r.target === wrap)
  if (ro) act(() => ro.fire())
}

describe("FileView markdown 预览", () => {
  it(".md 默认渲染预览 + 工具条二态（分组按钮）；切换源码为代码视图", async () => {
    fileContentsStub.set("/repo/README.md", { content: "# 标题\n\n正文 `code`" })
    render(<FileView absolutePath="/repo/README.md" />)
    // 默认预览：markdown 解析为 h1（TOC 条目同文案，按标签筛）
    const matches = await screen.findAllByText("标题")
    expect(matches.some((el) => el.tagName === "H1")).toBe(true)
    const preview = screen.getByRole("button", { name: "预览" })
    expect(preview.getAttribute("aria-pressed")).toBe("true")

    // 切源码：CodeMirror 视图显示原文
    fireEvent.click(screen.getByRole("button", { name: "源码" }))
    expect(document.querySelector(".cm-content")?.textContent).toContain("# 标题")
    expect(screen.getByRole("button", { name: "源码" }).getAttribute("aria-pressed")).toBe("true")
  })

  it(".markdown 扩展名与大小写不敏感（.MD）均走预览", async () => {
    fileContentsStub.set("/repo/notes.markdown", { content: "# A" })
    const { unmount } = render(<FileView absolutePath="/repo/notes.markdown" />)
    expect((await screen.findAllByText("A")).some((el) => el.tagName === "H1")).toBe(true)
    unmount()

    fileContentsStub.set("/repo/BIG.MD", { content: "# B" })
    render(<FileView absolutePath="/repo/BIG.MD" />)
    expect((await screen.findAllByText("B")).some((el) => el.tagName === "H1")).toBe(true)
  })

  it(".mdx / 点文件 .md / 无扩展名：均不识别（纯文本代码视图、无工具条）", () => {
    for (const [path, text] of [
      ["/repo/page.mdx", "# not md"],
      ["/repo/.md", "dotfile named .md"],
      ["/repo/Makefile", "no extension"],
    ] as const) {
      cleanup()
      fileContentsStub.set(path, { content: text })
      render(<FileView absolutePath={path} />)
      expect(document.querySelector(".cm-content")?.textContent, path).toContain(text)
      expect(document.querySelector(".ms-segmented"), path).toBeNull()
    }
  })

  it("非 markdown 文件行为不变：代码视图（行号 + 内容）、无工具条", () => {
    fileContentsStub.set("/repo/src/main.ts", { content: "const x = 1\nconst y = 2" })
    render(<FileView absolutePath="/repo/src/main.ts" />)
    expect(document.querySelector(".cm-content")?.textContent).toContain("const x = 1")
    expect(document.querySelector(".cm-gutters")).not.toBeNull()
    expect(document.querySelector(".ms-segmented")).toBeNull()
  })

  it("markdown 源码态：代码视图渲染原文", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# 标题\n\n正文" })
    render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findAllByText("标题")
    fireEvent.click(screen.getByRole("button", { name: "源码" }))
    expect(document.querySelector(".cm-content")?.textContent).toContain("# 标题")
  })

  it(".html 默认 sandboxed iframe 预览（CSP 注入）；切源码为高亮代码", () => {
    fileContentsStub.set("/repo/page.html", { content: "<html><head><title>t</title></head><body><p>hi</p></body></html>" })
    render(<FileView absolutePath="/repo/page.html" />)
    const iframe = document.querySelector("iframe.html-preview") as HTMLIFrameElement
    expect(iframe).not.toBeNull()
    expect(iframe.getAttribute("sandbox")).toBe("")
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(iframe.getAttribute("srcdoc")).toContain("Content-Security-Policy")

    fireEvent.click(screen.getByRole("button", { name: "源码" }))
    expect(document.querySelector(".cm-content")?.textContent).toContain("<html>")
    expect(document.querySelector("iframe.html-preview")).toBeNull()
  })

  it(".htm 与大小写不敏感（.HTML）均走预览", () => {
    fileContentsStub.set("/repo/old.htm", { content: "<div>x</div>" })
    const { unmount } = render(<FileView absolutePath="/repo/old.htm" />)
    expect(document.querySelector("iframe.html-preview")).not.toBeNull()
    unmount()

    fileContentsStub.set("/repo/BIG.HTML", { content: "<div>y</div>" })
    render(<FileView absolutePath="/repo/BIG.HTML" />)
    expect(document.querySelector("iframe.html-preview")).not.toBeNull()
  })

  it(".xhtml 不识别（走代码视图）", () => {
    fileContentsStub.set("/repo/page.xhtml", { content: "<div>xml</div>" })
    render(<FileView absolutePath="/repo/page.xhtml" />)
    expect(document.querySelector("iframe.html-preview")).toBeNull()
    expect(document.querySelector(".ms-segmented")).toBeNull()
    expect(document.querySelector(".cm-content")?.textContent).toContain("<div>xml</div>")
  })

  it("错误/加载态：markdown 工具条常驻（防内容落地时布局跳动）", () => {
    fileContentsStub.set("/repo/broken.md", { content: "", error: "HTTP 500" })
    render(<FileView absolutePath="/repo/broken.md" />)
    expect(document.querySelector(".file-error")?.textContent).toBe("HTTP 500")
    expect(document.querySelector(".ms-segmented")).not.toBeNull()
    expect(document.querySelector(".file-md")).toBeNull()

    cleanup()
    render(<FileView absolutePath="/repo/loading.md" />)
    expect(screen.getByText("加载中…")).not.toBeNull()
    expect(document.querySelector(".ms-segmented")).not.toBeNull()
  })
})

describe("FileView markdown TOC（design-markdown-preview §2.4）", () => {
  it("有标题内容渲染 TOC 悬浮窗 + 工具条收起钮；点击条目锚定到内容区对应标题", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# 甲章\n\n正文\n\n## 乙节\n\n内容" })
    render(<FileView absolutePath="/repo/doc.md" />)
    const toc = await screen.findByRole("navigation")
    expect(toc.className).toBe("md-toc-tree")
    // 悬浮窗挂内容区左侧（滚动层之外，.file-view-wrap 直接子）；显隐钮在工具条
    expect(document.querySelector(".file-view-wrap > .md-toc")).not.toBeNull()
    expect(document.querySelector(".file-md")).not.toBeNull()
    expect(screen.getByRole("button", { name: "收起目录" })).not.toBeNull()

    // 条目为按钮（内容区标题是 h1/h2，role 不冲突）
    const entry = screen.getByRole("button", { name: "乙节" })
    fireEvent.click(entry)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.instances[0]).toBe(document.querySelector(".file-md h2"))
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })
  })

  it("章节折叠：有子标题的条目可收起其子条目", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# 甲章\n\n## 乙节\n\n正文" })
    render(<FileView absolutePath="/repo/doc.md" />)
    const fold = (await screen.findByRole("navigation")).querySelector(
      ".md-toc-fold:not(.md-toc-fold-empty)",
    ) as HTMLButtonElement
    expect(screen.getByRole("button", { name: "乙节" })).not.toBeNull()
    fireEvent.click(fold)
    expect(screen.queryByRole("button", { name: "乙节" })).toBeNull()
    fireEvent.click(fold)
    expect(screen.getByRole("button", { name: "乙节" })).not.toBeNull()
  })

  it("工具条按钮收起/展开 TOC 悬浮窗（收起即整体移除，无窄轨）", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# 甲章" })
    render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findByRole("navigation")
    fireEvent.click(screen.getByRole("button", { name: "收起目录" }))
    expect(document.querySelector(".md-toc")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "展开目录" }))
    expect(await screen.findByRole("navigation")).not.toBeNull()
    expect(document.querySelector(".file-view-wrap > .md-toc")).not.toBeNull()
  })

  it("章节折叠态：跨悬浮窗显隐保留（MdToc 卸载不丢），内容更换重置", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# 甲章\n\n## 乙节\n\n正文" })
    const { rerender } = render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findByRole("navigation")
    // 折叠章节
    fireEvent.click(document.querySelector(".md-toc-fold:not(.md-toc-fold-empty)") as HTMLElement)
    expect(screen.queryByRole("button", { name: "乙节" })).toBeNull()
    // 收起/展开悬浮窗 → 折叠态保留（状态由 FileView 持有）
    fireEvent.click(screen.getByRole("button", { name: "收起目录" }))
    fireEvent.click(screen.getByRole("button", { name: "展开目录" }))
    expect(await screen.findByRole("navigation")).not.toBeNull()
    expect(screen.queryByRole("button", { name: "乙节" })).toBeNull()
    // 内容更换 → 标题元素更新，折叠态重置
    fileContentsStub.set("/repo/doc.md", { content: "# 甲章\n\n## 乙节\n\n新正文" })
    rerender(<FileView absolutePath="/repo/doc.md" />)
    expect(await screen.findByRole("button", { name: "乙节" })).not.toBeNull()
  })

  it("悬浮窗会遮挡内容区 → 默认收起；侧缘够宽 → 默认显示；钮可显式展开", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# 甲章" })
    render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findByRole("navigation")
    // 侧缘够宽（内容区左缘 300 ≥ 12 + 窗宽 240）→ 默认显示
    setPaneWidth(1400)
    expect(document.querySelector(".md-toc")).not.toBeNull()
    // 收窄到会遮挡（内容区左缘 200 < 窗右缘 252）→ 默认收起（按钮仍在，供显式展开）
    setPaneWidth(1200)
    expect(document.querySelector(".md-toc")).toBeNull()
    expect(screen.getByRole("button", { name: "展开目录" })).not.toBeNull()
    // 显式展开（悬浮覆盖内容区左缘）；再加宽不因默认态回摆
    fireEvent.click(screen.getByRole("button", { name: "展开目录" }))
    expect(document.querySelector(".md-toc")).not.toBeNull()
    setPaneWidth(1400)
    expect(document.querySelector(".md-toc")).not.toBeNull()
  })

  it("无标题内容不渲染 TOC、无收起钮（布局回落单列）", async () => {
    fileContentsStub.set("/repo/plain.md", { content: "只有段落，没有标题。" })
    render(<FileView absolutePath="/repo/plain.md" />)
    await screen.findByText("只有段落，没有标题。")
    expect(document.querySelector(".md-toc")).toBeNull()
    expect(screen.queryByRole("button", { name: "收起目录" })).toBeNull()
    expect(screen.queryByRole("button", { name: "展开目录" })).toBeNull()
  })

  it("源码态不渲染 TOC、无收起钮；切回预览恢复", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# 甲章" })
    render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findByRole("navigation")
    fireEvent.click(screen.getByRole("button", { name: "源码" }))
    expect(document.querySelector(".md-toc")).toBeNull()
    expect(screen.queryByRole("button", { name: "收起目录" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "预览" }))
    expect(await screen.findByRole("navigation")).not.toBeNull()
  })
})
