/**
 * FileView 分发与 markdown 二态测试（design-markdown-preview）：
 * 扩展名分发（.md/.markdown/.MD → 预览；.mdx/点文件/无扩展名/代码 → 源码）
 * + 预览/源码切换 + 加载/错误态工具条常驻 + TOC 大纲（§2.4）
 * + 图片预览（design-image-preview）：扩展名分发、data URL 构建、缩放切换、
 * 解码失败兜底、非图二进制占位。
 * jsdom 无 IntersectionObserver（streamdown 依赖），测试前补 stub。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clampImageScale,
  FileView,
  IMAGE_MAX_SCALE,
  IMAGE_MIN_SCALE,
  normalizeWheelDeltaY,
  wheelScaleFactor,
} from "./workspace"
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
      binaryUnsupported: "二进制文件，暂不支持预览",
      imageZoomToggle: "切换缩放",
      imageDecodeFailed: "图片解码失败",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({
    fileContents: fileContentsStub,
    loadFileContent,
    fileViewStateFor: (path: string) => fileViewStateStub.get(path) ?? null,
    setFileViewState: (path: string, state: { mode: "preview" | "source"; top: number }) => {
      fileViewStateStub.set(path, state)
    },
    tocStateFor: (path: string) => tocStateStub.get(path) ?? null,
    setTocVisible: (path: string, visible: boolean) => {
      const cur = tocStateStub.get(path)
      tocStateStub.set(path, { visible, folded: cur?.folded ?? [] })
    },
    setTocFolded: (path: string, folded: string[]) => {
      const cur = tocStateStub.get(path)
      tocStateStub.set(path, { visible: cur?.visible, folded })
    },
  }),
}))

/** 测试内动态替换的内容表（vi.mock 提升导致闭包需经变量间接） */
let fileContentsStub: Map<
  string,
  { content: string; binary?: boolean; mimeType?: string; error?: string }
>
/** 文件视图状态记忆表（design-tab-state-memory §2.2；测试内可预置恢复态） */
let fileViewStateStub: Map<string, { mode: "preview" | "source"; top: number }>
/** TOC 状态记忆表（design-tab-state-memory §2.4；测试内可预置恢复态） */
let tocStateStub: Map<string, { visible?: boolean; folded: string[] }>

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
  fileViewStateStub = new Map()
  tocStateStub = new Map()
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

  it("状态记忆（§2.2）：挂载恢复源码模式；模式切换写归零条目；预览滚动上报", async () => {
    fileContentsStub.set("/repo/doc2.md", { content: "# 标题\n\n正文" })
    fileViewStateStub.set("/repo/doc2.md", { mode: "source", top: 0 })
    render(<FileView absolutePath="/repo/doc2.md" />)
    // 恢复源码模式：CodeMirror 渲染原文（无 markdown h1）
    expect(document.querySelector(".cm-content")?.textContent).toContain("# 标题")
    expect(document.querySelector(".file-md h1")).toBeNull()

    // 切预览：写归零条目（非激活模式偏移不保留）
    fireEvent.click(screen.getByRole("button", { name: "预览" }))
    expect(fileViewStateStub.get("/repo/doc2.md")).toEqual({ mode: "preview", top: 0 })
    const matches = await screen.findAllByText("标题")
    expect(matches.some((el) => el.tagName === "H1")).toBe(true)

    // 预览滚动上报（容器 scrollTop 采集，写入不触发渲染）
    const layer = document.querySelector(".file-view") as HTMLElement
    layer.scrollTop = 120
    fireEvent.scroll(layer)
    expect(fileViewStateStub.get("/repo/doc2.md")).toEqual({ mode: "preview", top: 120 })
  })

  it("状态记忆（§2.2）：挂载恢复预览态滚动偏移（内容落地后一次性应用）", () => {
    fileContentsStub.set("/repo/long.md", { content: "# 标题\n\n正文" })
    fileViewStateStub.set("/repo/long.md", { mode: "preview", top: 240 })
    render(<FileView absolutePath="/repo/long.md" />)
    const layer = document.querySelector(".file-view") as HTMLElement
    expect(layer.scrollTop).toBe(240)
  })

  it("状态记忆（§2.2）：加载窗口内切模式弃待恢复偏移（旧偏移不错灌新模式）", async () => {
    fileViewStateStub.set("/repo/race.md", { mode: "source", top: 240 })
    const { rerender } = render(<FileView absolutePath="/repo/race.md" />)
    expect(screen.getByText("加载中…")).not.toBeNull()
    // 内容未落地即切预览：待恢复偏移应随切换弃掉
    fireEvent.click(screen.getByRole("button", { name: "预览" }))
    fileContentsStub.set("/repo/race.md", { content: "# 标题" })
    rerender(<FileView absolutePath="/repo/race.md" />)
    await screen.findAllByText("标题")
    const layer = document.querySelector(".file-view") as HTMLElement
    expect(layer.scrollTop).toBe(0)
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

  it("状态记忆（§2.4）：显隐选择与章节折叠随操作落 store（合并互不覆盖）", async () => {
    fileContentsStub.set("/repo/toc.md", { content: "# 甲章\n\n## 乙节\n\n正文" })
    render(<FileView absolutePath="/repo/toc.md" />)
    await screen.findByRole("navigation")

    fireEvent.click(document.querySelector(".md-toc-fold:not(.md-toc-fold-empty)") as HTMLElement)
    expect(tocStateStub.get("/repo/toc.md")).toEqual({ folded: ["甲章"] })
    fireEvent.click(screen.getByRole("button", { name: "收起目录" }))
    expect(tocStateStub.get("/repo/toc.md")).toEqual({ visible: false, folded: ["甲章"] })
  })

  it("状态记忆（§2.4）：挂载恢复——默认显示态仍收起、折叠章节保持", async () => {
    fileContentsStub.set("/repo/toc2.md", { content: "# 甲章\n\n## 乙节\n\n正文" })
    tocStateStub.set("/repo/toc2.md", { visible: false, folded: ["甲章"] })
    render(<FileView absolutePath="/repo/toc2.md" />)
    // visible:false 恢复覆盖默认显示态（悬浮窗不渲染、展开钮在）
    await screen.findByRole("button", { name: "展开目录" })
    expect(document.querySelector(".md-toc")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "展开目录" }))
    expect(await screen.findByRole("navigation")).not.toBeNull()
    // 甲章仍折叠：子条目「乙节」不出现
    expect(screen.queryByRole("button", { name: "乙节" })).toBeNull()
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

describe("FileView 图片预览（design-image-preview）", () => {
  it(".png 二进制 → img data URL（mimeType 来自服务端）；点击切换缩放二态", () => {
    fileContentsStub.set("/repo/a.png", { content: "QUJD", binary: true, mimeType: "image/png" })
    render(<FileView absolutePath="/repo/a.png" />)
    const btn = document.querySelector("button.image-zoom") as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.getAttribute("aria-pressed")).toBe("false")
    const img = btn.querySelector("img") as HTMLImageElement
    expect(img.getAttribute("src")).toBe("data:image/png;base64,QUJD")
    expect(img.getAttribute("alt")).toBe("a.png")
    expect(document.querySelector(".ms-segmented")).toBeNull()
    // zoomed class 以 nat 落地为前提（防 load 前 1:1 闪现）——先注入原始尺寸
    mockNaturalSize(img, 800, 600)
    fireEvent.click(btn)
    expect(document.querySelector(".image-zoom.zoomed")).not.toBeNull()
    fireEvent.click(btn)
    expect(document.querySelector(".image-zoom.zoomed")).toBeNull()
  })

  it(".svg 文本源码 → encodeURIComponent data URL（不执行脚本）", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    fileContentsStub.set("/repo/logo.svg", { content: svg })
    render(<FileView absolutePath="/repo/logo.svg" />)
    const img = document.querySelector(".image-zoom img") as HTMLImageElement
    expect(img.getAttribute("src")).toBe(
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg),
    )
  })

  it(".jpg 缺省 mimeType：按扩展名兜底；扩展名大小写不敏感", () => {
    fileContentsStub.set("/repo/p.JPG", { content: "xx", binary: true })
    render(<FileView absolutePath="/repo/p.JPG" />)
    const img = document.querySelector(".image-zoom img") as HTMLImageElement
    expect(img.getAttribute("src")).toBe("data:image/jpeg;base64,xx")
  })

  it("解码失败（img error 事件）→ 错误文案，不静默 broken icon", () => {
    fileContentsStub.set("/repo/bad.png", { content: "xx", binary: true, mimeType: "image/png" })
    render(<FileView absolutePath="/repo/bad.png" />)
    const img = document.querySelector(".image-zoom img") as HTMLImageElement
    fireEvent.error(img)
    expect(document.querySelector(".file-state.file-error")?.textContent).toBe("图片解码失败")
    expect(document.querySelector(".image-zoom")).toBeNull()
  })

  it("解码失败后内容重拉（src 变化）：失败态重置，重新渲染图片", () => {
    fileContentsStub.set("/repo/bad.png", { content: "xx", binary: true, mimeType: "image/png" })
    const { rerender } = render(<FileView absolutePath="/repo/bad.png" />)
    fireEvent.error(document.querySelector(".image-zoom img") as HTMLImageElement)
    expect(document.querySelector(".image-zoom")).toBeNull()
    fileContentsStub.set("/repo/bad.png", { content: "yy", binary: true, mimeType: "image/png" })
    rerender(<FileView absolutePath="/repo/bad.png" />)
    const img = document.querySelector(".image-zoom img") as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute("src")).toBe("data:image/png;base64,yy")
  })

  it("图片扩展名但内容为文本（名不符实）：回落代码视图，不硬渲染", () => {
    fileContentsStub.set("/repo/fake.png", { content: "not really an image" })
    render(<FileView absolutePath="/repo/fake.png" />)
    expect(document.querySelector(".image-zoom")).toBeNull()
    expect(document.querySelector(".cm-content")?.textContent).toContain("not really an image")
  })

  it("非图片二进制（.zip）：占位提示，无 base64 文本、无代码视图", () => {
    fileContentsStub.set("/repo/a.zip", {
      content: "UEsDBAo=",
      binary: true,
      mimeType: "application/zip",
    })
    render(<FileView absolutePath="/repo/a.zip" />)
    expect(document.querySelector(".file-state.file-binary")?.textContent).toBe(
      "二进制文件，暂不支持预览",
    )
    expect(document.querySelector(".cm-content")).toBeNull()
    expect(document.querySelector(".image-zoom")).toBeNull()
  })

  it("加载态（无缓存）：显示加载文案，不渲染图片", () => {
    render(<FileView absolutePath="/repo/x.png" />)
    expect(screen.getByText("加载中…")).not.toBeNull()
    expect(document.querySelector(".image-zoom")).toBeNull()
  })

  it("错误态：显示错误文案", () => {
    fileContentsStub.set("/repo/err.png", { content: "", error: "HTTP 500" })
    render(<FileView absolutePath="/repo/err.png" />)
    expect(document.querySelector(".file-view.error")?.textContent).toContain("HTTP 500")
    expect(document.querySelector(".image-zoom")).toBeNull()
  })

  /** jsdom 无布局/不解码图片：以 defineProperty 注入原始尺寸 + 触发 load 事件 */
  function mockNaturalSize(img: HTMLImageElement, w: number, h: number) {
    Object.defineProperty(img, "naturalWidth", { value: w, configurable: true })
    Object.defineProperty(img, "naturalHeight", { value: h, configurable: true })
    fireEvent.load(img)
  }

  it("滚轮连续缩放：适应窗口态起步，渲染显式尺寸（原始宽 × scale）", () => {
    fileContentsStub.set("/repo/a.png", { content: "QUJD", binary: true, mimeType: "image/png" })
    render(<FileView absolutePath="/repo/a.png" />)
    const img = document.querySelector(".image-zoom img") as HTMLImageElement
    mockNaturalSize(img, 800, 600)
    const container = document.querySelector(".file-view.image-view") as HTMLDivElement

    // 适应窗口态起点：渲染宽 0（jsdom 无布局）→ 兜底 scale 1；单刻步进 e^0.2
    fireEvent.wheel(container, { deltaY: -100 })
    const btn = document.querySelector(".image-zoom") as HTMLButtonElement
    expect(btn.className).toContain("zoomed")
    expect(img.style.width).toBe(`${800 * Math.exp(0.2)}px`)
    expect(img.style.height).toBe(`${600 * Math.exp(0.2)}px`)
    expect(img.style.maxWidth).toBe("none")

    // 连续放大触顶 16×
    for (let i = 0; i < 40; i++) fireEvent.wheel(container, { deltaY: -100 })
    expect(img.style.width).toBe(`${800 * IMAGE_MAX_SCALE}px`)

    // 连续缩小触底 0.05×
    for (let i = 0; i < 80; i++) fireEvent.wheel(container, { deltaY: 100 })
    expect(img.style.width).toBe(`${800 * IMAGE_MIN_SCALE}px`)
  })

  it("load 事件绕过 React onLoad 的竞态：img 已 complete 而 nat 未落，滚轮仍缩放", () => {
    // 启动后首个图片 Tab 实测故障：load 先于/绕过 React onLoad 落地，nat 永不落 →
    // 缩放渲染门槛（sized）永不满足，滚轮 preventDefault 生效却无视觉变化。
    // 兜底 = 每次渲染检查 img.complete 补登记 nat（不依赖 onLoad 事件）
    fileContentsStub.set("/repo/a.png", { content: "QUJD", binary: true, mimeType: "image/png" })
    render(<FileView absolutePath="/repo/a.png" />)
    const img = document.querySelector(".image-zoom img") as HTMLImageElement
    // 只注入已解码事实，不触发 load 事件（模拟 React 错过 load）
    Object.defineProperty(img, "naturalWidth", { value: 800, configurable: true })
    Object.defineProperty(img, "naturalHeight", { value: 600, configurable: true })
    Object.defineProperty(img, "complete", { value: true, configurable: true })
    const container = document.querySelector(".file-view.image-view") as HTMLDivElement
    fireEvent.wheel(container, { deltaY: -100 })
    const btn = document.querySelector(".image-zoom") as HTMLButtonElement
    expect(btn.className).toContain("zoomed")
    expect(img.style.width).toBe(`${800 * Math.exp(0.2)}px`)
  })

  it("初次打开（加载态 → 内容落地分支切换）：预览体挂载后滚轮即可缩放", () => {
    // 首开无缓存先渲染加载态，内容落地后才挂 ImagePreview——
    // 滚轮监听须随容器节点挂载（回调 ref），不落在加载态节点上
    const { rerender } = render(<FileView absolutePath="/repo/a.png" />)
    expect(document.querySelector(".image-zoom")).toBeNull()
    fileContentsStub.set("/repo/a.png", { content: "QUJD", binary: true, mimeType: "image/png" })
    rerender(<FileView absolutePath="/repo/a.png" />)
    const img = document.querySelector(".image-zoom img") as HTMLImageElement
    mockNaturalSize(img, 800, 600)
    const container = document.querySelector(".file-view.image-view") as HTMLDivElement
    fireEvent.wheel(container, { deltaY: -100 })
    expect((document.querySelector(".image-zoom") as HTMLButtonElement).className).toContain(
      "zoomed",
    )
    expect(img.style.width).toBe(`${800 * Math.exp(0.2)}px`)
  })

  it("点击落在容器上（真实浏览器指针捕获重定向）也触发切换", () => {
    // setPointerCapture 把 pointerup 派生的 click 重定向到捕获元素（容器），
    // button 自身收不到——切换监听在容器上，键盘 click 经冒泡同路
    fileContentsStub.set("/repo/a.png", { content: "QUJD", binary: true, mimeType: "image/png" })
    render(<FileView absolutePath="/repo/a.png" />)
    mockNaturalSize(document.querySelector(".image-zoom img") as HTMLImageElement, 800, 600)
    const container = document.querySelector(".file-view.image-view") as HTMLDivElement
    fireEvent.click(container)
    expect((document.querySelector(".image-zoom") as HTMLButtonElement).className).toContain(
      "zoomed",
    )
    fireEvent.click(container)
    expect((document.querySelector(".image-zoom") as HTMLButtonElement).className).not.toContain(
      "zoomed",
    )
  })

  it("滚轮缩放后点击回落适应窗口（显式尺寸移除）", () => {
    fileContentsStub.set("/repo/a.png", { content: "QUJD", binary: true, mimeType: "image/png" })
    render(<FileView absolutePath="/repo/a.png" />)
    const img = document.querySelector(".image-zoom img") as HTMLImageElement
    mockNaturalSize(img, 800, 600)
    const container = document.querySelector(".file-view.image-view") as HTMLDivElement
    fireEvent.wheel(container, { deltaY: -100 })
    const btn = document.querySelector(".image-zoom") as HTMLButtonElement
    expect(btn.className).toContain("zoomed")
    fireEvent.click(btn)
    expect(btn.className).not.toContain("zoomed")
    expect(img.style.width).toBe("")
  })

  it("拖动平移：位移超阈值进入拖动态；拖动后的点击不触发缩放切换", () => {
    fileContentsStub.set("/repo/a.png", { content: "QUJD", binary: true, mimeType: "image/png" })
    render(<FileView absolutePath="/repo/a.png" />)
    const img = document.querySelector(".image-zoom img") as HTMLImageElement
    mockNaturalSize(img, 800, 600)
    const btn = document.querySelector(".image-zoom") as HTMLButtonElement
    fireEvent.click(btn) // 1:1 放大态
    expect(btn.getAttribute("aria-pressed")).toBe("true")

    const container = document.querySelector(".file-view.image-view") as HTMLDivElement
    fireEvent.pointerDown(container, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    // 阈值内移动不算拖动
    fireEvent.pointerMove(container, { pointerId: 1, clientX: 101, clientY: 101 })
    expect(btn.className).not.toContain("dragging")
    fireEvent.pointerMove(container, { pointerId: 1, clientX: 60, clientY: 70 })
    expect(btn.className).toContain("dragging")
    fireEvent.pointerUp(container, { pointerId: 1 })
    expect(btn.className).not.toContain("dragging")

    // 拖动余波的第一次点击被抑制，其后正常切换
    fireEvent.click(btn)
    expect(btn.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(btn)
    expect(btn.getAttribute("aria-pressed")).toBe("false")
  })
})

describe("图片缩放纯函数（design-image-preview §2.4）", () => {
  it("deltaMode 行模式折算像素量级", () => {
    expect(normalizeWheelDeltaY(3, 1)).toBe(48)
    expect(normalizeWheelDeltaY(100, 0)).toBe(100)
  })

  it("步进指数对称：放大后等量缩小回原位", () => {
    const up = wheelScaleFactor(-100)
    expect(up).toBeCloseTo(Math.exp(0.2))
    expect(up * wheelScaleFactor(100)).toBeCloseTo(1)
  })

  it("缩放区间钳制 [0.05, 16]", () => {
    expect(clampImageScale(1)).toBe(1)
    expect(clampImageScale(0.001)).toBe(IMAGE_MIN_SCALE)
    expect(clampImageScale(1000)).toBe(IMAGE_MAX_SCALE)
  })
})
