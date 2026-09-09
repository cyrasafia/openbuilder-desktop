/**
 * FileView 分发与 markdown 二态测试（design-markdown-preview）：
 * 扩展名分发（.md/.markdown/.MD → 预览；.mdx/点文件/无扩展名/代码 → 源码）
 * + 预览/源码切换 + 加载/错误态工具条常驻 + TOC 大纲（§2.4）
 * + 图片预览（design-image-preview）：扩展名分发、data URL 构建、缩放切换、
 * 解码失败兜底、非图二进制占位。
 * + 操作条（design-file-view-actions，2026-09-08）：所有分支常驻
 * open/open-with 入口；平台分支（linux 自建选择器 / win32·darwin 系统对话框 /
 * browser 隐藏）；浮层计数压制原生视图。
 * jsdom 无 IntersectionObserver（streamdown 依赖），测试前补 stub。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clampImageScale,
  FileView,
  IMAGE_MAX_SCALE,
  IMAGE_MIN_SCALE,
  normalizeWheelDeltaY,
  scanFindMatches,
  wheelScaleFactor,
} from "./workspace"
import { ResizeObserverStub } from "./resize-observer-stub"

const loadFileContent = vi.fn(async () => {})
const ensureFileImage = vi.fn()
const scrollIntoView = vi.fn()

// desktop 桩（design-file-view-actions）：platform 可变（按用例切换），
// shell 动作 mock 供操作条断言
let platform: "linux" | "win32" | "darwin" | "browser" = "linux"
const shellOpenPath = vi.fn(async () => "")
const shellOpenWith = vi.fn(async () => "")
const shellOpenWithApp = vi.fn(async () => "")
const shellListOpenWithApps = vi.fn(async () => [] as { id: string; name: string; icon: string | null; matches: boolean }[])

/** store.subscribe 收集的监听器（md 相对图片 useSyncExternalStore 直订后，测试手动通知） */
let storeListeners: Array<() => void> = []

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
      mdImageFailed: "图片加载失败",
      // 页面内搜索（design-find-in-page）
      findPlaceholder: "查找…",
      findMatchCount: "{active}/{matches}",
      findIdle: "",
      findPrev: "上一处",
      findNext: "下一处",
      findClose: "关闭",
      // 操作条（design-file-view-actions；文案键复用右键菜单）
      fileOpen: "打开",
      fileOpenWith: "打开方式…",
      close: "关闭",
      openWithSearch: "搜索应用…",
      openWithLoading: "正在枚举应用…",
      openWithEmpty: "无匹配的应用",
      openWithMatched: "推荐应用",
      openWithOther: "其他应用",
      openWithLastUsed: "上次使用",
      openWithNoResult: "无匹配结果",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

/** useStore 返回的稳定 stub（真实 store 自 context 引用恒稳；每次渲染新建会使
 *  MarkdownImage 的 [target, store] effect 依赖失效——重复 ensureFileImage） */
let storeStub: Record<string, unknown>

/** OpenWithDialog（design-file-view-actions 内嵌）断言用浮层计数 mock */
const pushOverlay = vi.fn()
const popOverlay = vi.fn()

function buildStoreStub() {
  pushOverlay.mockClear()
  popOverlay.mockClear()
  storeStub = {
    fileContents: fileContentsStub,
    loadFileContent,
    ensureFileImage,
    pushOverlay,
    popOverlay,
    subscribe: (fn: () => void) => {
      storeListeners.push(fn)
      return () => {
        storeListeners = storeListeners.filter((l) => l !== fn)
      }
    },
    // 页面内搜索（design-find-in-page）：注册表桩（真实注册语义，供断言）
    registerFindRequester: (key: string, fn: () => void) => {
      findRequestersStub.set(key, fn)
    },
    unregisterFindRequester: (key: string) => {
      findRequestersStub.delete(key)
    },
    findRequesterFor: (key: string) => findRequestersStub.get(key) ?? null,
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
  }
}

/** 测试内动态替换的内容表（vi.mock 提升导致闭包需经变量间接） */
let fileContentsStub: Map<
  string,
  { content: string; binary?: boolean; mimeType?: string; error?: string }
>
/** findRequester 注册表桩（design-find-in-page：FileView 经 useFindRequester 注册） */
let findRequestersStub = new Map<string, () => void>()
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
  // desktop 桩（design-file-view-actions）：FileView 操作条读 platform /
  // 调 shell 动作（真实 app 由 preload 或 browser-shim 恒提供）
  Object.defineProperty(window, "desktop", {
    configurable: true,
    get: () => ({
      platform,
      shellOpenPath,
      shellOpenWith,
      shellOpenWithApp,
      shellListOpenWithApps,
    }),
  })
})

afterAll(() => {
  cleanup()
})

beforeEach(() => {
  // 本仓库 vitest 未开 globals，RTL auto-cleanup 不生效——手动卸载
  cleanup()
  ResizeObserverStub.reset()
  loadFileContent.mockClear()
  ensureFileImage.mockClear()
  scrollIntoView.mockClear()
  platform = "linux"
  shellOpenPath.mockClear()
  shellOpenWith.mockClear()
  shellOpenWithApp.mockClear()
  shellListOpenWithApps.mockClear()
  shellListOpenWithApps.mockResolvedValue([])
  storeListeners = []
  fileContentsStub = new Map()
  fileViewStateStub = new Map()
  tocStateStub = new Map()
  findRequestersStub = new Map()
  buildStoreStub()
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
  it("front matter：预览态元数据卡 + 正文剥离裸 YAML；源码态原文（§2.5）", async () => {
    fileContentsStub.set("/repo/post.md", {
      content: "---\ntitle: 文章标题\ndraft: true\n---\n\n# 正文",
    })
    render(<FileView absolutePath="/repo/post.md" />)
    // 元数据卡：dt/dd 两列
    const card = document.querySelector("dl.md-frontmatter")
    expect(card).not.toBeNull()
    expect(card!.querySelector("dt.md-fm-key")!.textContent).toBe("title")
    expect(card!.querySelector("dd.md-fm-val")!.textContent).toBe("文章标题")
    // 正文剥离：不再渲染裸 YAML/围栏
    const md = document.querySelector(".file-md .markdown-body")!
    expect(md.textContent).not.toContain("title: 文章标题")
    expect(md.textContent).toContain("正文")

    // 源码态：原文完整（front matter 属于源码）
    fireEvent.click(screen.getByRole("button", { name: "源码" }))
    expect(document.querySelector(".cm-content")?.textContent).toContain("title: 文章标题")
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

  it(".mdx / 点文件 .md / 无扩展名：均不识别（纯文本代码视图，无预览/源码分段；操作条常驻）", () => {
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
      // 操作条（design-file-view-actions）：无分段也有 open/open-with 入口
      expect(document.querySelector(".file-toolbar"), path).not.toBeNull()
      expect(screen.getByRole("button", { name: "打开" }), path).toBeTruthy()
    }
  })

  it("非 markdown 文件：代码视图（行号 + 内容）+ 操作条（open/open-with；无预览/源码分段）", () => {
    fileContentsStub.set("/repo/src/main.ts", { content: "const x = 1\nconst y = 2" })
    render(<FileView absolutePath="/repo/src/main.ts" />)
    expect(document.querySelector(".cm-content")?.textContent).toContain("const x = 1")
    expect(document.querySelector(".cm-gutters")).not.toBeNull()
    expect(document.querySelector(".ms-segmented")).toBeNull()
    expect(document.querySelector(".file-toolbar")).not.toBeNull()
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

  it(".html 恒源码态（预览已迁浏览器 Tab，design-browser-tab §1.4）：无 iframe、无预览/源码切换工具条", () => {
    fileContentsStub.set("/repo/page.html", { content: "<html><head><title>t</title></head><body><p>hi</p></body></html>" })
    render(<FileView absolutePath="/repo/page.html" />)
    expect(document.querySelector("iframe.html-preview")).toBeNull()
    // 非 previewable：无工具条（.ms-segmented 不渲染），直接代码视图
    expect(document.querySelector(".ms-segmented")).toBeNull()
    expect(document.querySelector(".cm-content")?.textContent).toContain("<html>")
  })

  it(".htm 与大小写不敏感（.HTML）同样恒源码", () => {
    fileContentsStub.set("/repo/old.htm", { content: "<div>x</div>" })
    const { unmount } = render(<FileView absolutePath="/repo/old.htm" />)
    expect(document.querySelector(".cm-content")?.textContent).toContain("<div>x</div>")
    expect(document.querySelector("iframe.html-preview")).toBeNull()
    unmount()

    fileContentsStub.set("/repo/BIG.HTML", { content: "<div>y</div>" })
    render(<FileView absolutePath="/repo/BIG.HTML" />)
    expect(document.querySelector(".cm-content")?.textContent).toContain("<div>y</div>")
    expect(document.querySelector("iframe.html-preview")).toBeNull()
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

  // 相对路径图片（design-markdown-preview §2.8）
  it("相对图片：占位 chip（alt 文本）→ 拉取（基准 = md 所在目录）→ 缓存落地渲染 data URL", async () => {
    fileContentsStub.set("/repo/docs/README.md", { content: "![截图](./img/shot.png)" })
    render(<FileView absolutePath="/repo/docs/README.md" />)
    // 无缓存：占位 chip 呈 alt 文本；按解析出的绝对路径发起 singleflight 拉取
    expect(screen.getByText("截图").classList.contains("md-img-pending")).toBe(true)
    expect(ensureFileImage).toHaveBeenCalledWith("/repo/docs/img/shot.png")
    // 缓存落地 + 监听通知（useSyncExternalStore 直订，不经父层重渲染）
    fileContentsStub.set("/repo/docs/img/shot.png", {
      content: "QUJD",
      binary: true,
      mimeType: "image/png",
    })
    act(() => storeListeners.forEach((l) => l()))
    const img = document.querySelector(".file-md img") as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute("src")).toBe("data:image/png;base64,QUJD")
    expect(img.getAttribute("alt")).toBe("截图")
  })

  it("相对图片失败：错误占位（title 悬浮详情）；外链图不经拉取直接透传 <img>", async () => {
    fileContentsStub.set("/repo/docs/bad.md", {
      content: "![坏](./gone.png)\n\n![外](https://e.com/a.png)",
    })
    render(<FileView absolutePath="/repo/docs/bad.md" />)
    fileContentsStub.set("/repo/docs/gone.png", { content: "", error: "文件不存在" })
    act(() => storeListeners.forEach((l) => l()))
    const failed = document.querySelector(".md-img-failed")
    expect(failed?.textContent).toContain("图片加载失败")
    expect(failed?.getAttribute("title")).toBe("文件不存在")
    // 只拉相对路径那张；外链字面透传
    expect(ensureFileImage).toHaveBeenCalledTimes(1)
    expect(ensureFileImage).toHaveBeenCalledWith("/repo/docs/gone.png")
    const imgs = document.querySelectorAll(".file-md img")
    expect(imgs.length).toBe(1)
    expect(imgs[0].getAttribute("src")).toBe("https://e.com/a.png")
  })

  it("非图片扩展的相对 src 不解析：不拉取，字面透传（harden 折叠为 /notes.txt）", async () => {
    fileContentsStub.set("/repo/docs/x.md", { content: "![文档](./notes.txt)" })
    render(<FileView absolutePath="/repo/docs/x.md" />)
    expect(ensureFileImage).not.toHaveBeenCalled()
    const img = document.querySelector(".file-md img") as HTMLImageElement
    // 预重写跳过（扩展名闸门）→ streamdown 默认 harden 把 ./ 折叠为根绝对字面
    expect(img.getAttribute("src")).toBe("/notes.txt")
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

describe("FileView markdown 页面内搜索（design-find-in-page §2.3/§2.4）", () => {
  /** 唤起（经注册表桩——真实链路：全局 dispatch Ctrl+F 调 findRequesterFor） */
  function openFindBar(path: string) {
    const fn = findRequestersStub.get(`file:${path}`)
    expect(fn, "预览态应注册唤起回调").toBeTruthy()
    act(() => fn!())
  }

  /** 关闭当前打开的查找条（Esc 路径） */
  function mdFindClose() {
    const bar = document.querySelector(".find-bar input") as HTMLInputElement
    fireEvent.keyDown(bar, { key: "Escape" })
  }

  it("预览态注册唤起回调；源码态回调不动作（active ref 闸门）；非 md 文件不注册（键让给 PDF 子组件）", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# 标题\n\n正文若干" })
    render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findAllByText("标题")
    expect(findRequestersStub.has("file:/repo/doc.md")).toBe(true)
    openFindBar("/repo/doc.md")
    expect(document.querySelector(".find-bar")).not.toBeNull()
    mdFindClose()
    // 切源码：注册回调保留（active ref 闸门设计），但唤起无效——CM 自持搜索
    fireEvent.click(screen.getByRole("button", { name: "源码" }))
    const fn = findRequestersStub.get("file:/repo/doc.md")!
    expect(fn).toBeTruthy()
    act(() => fn())
    expect(document.querySelector(".find-bar")).toBeNull()
    cleanup()

    // 非 md：不注册（PDF 文件 Tab 下 `file:` 键归 PdfFrameView，防父组件覆盖）
    fileContentsStub.set("/repo/main.ts", { content: "const x" })
    render(<FileView absolutePath="/repo/main.ts" />)
    expect(findRequestersStub.has("file:/repo/main.ts")).toBe(false)
  })

  it("唤起 → 输入即扫描计数（大小写不敏感）；Enter 环绕跳转；Esc 关闭清条", async () => {
    fileContentsStub.set("/repo/doc.md", {
      content: "# Alpha\n\nalpha 版本说明\n\n无匹配行\n\nALPHA again",
    })
    render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findAllByText("Alpha")
    openFindBar("/repo/doc.md")
    const input = document.querySelector(".find-bar input") as HTMLInputElement
    // 挂载自动聚焦
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: "alpha" } })
    // 防抖 150ms（真实 timers 等待——fake timers 会卡 RTL 轮询）
    await waitFor(() => expect(screen.getByText("1/3")).toBeTruthy())
    // Enter 下一处 → 2/3 → 3/3 → 环绕回 1/3
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByText("2/3")).toBeTruthy()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByText("3/3")).toBeTruthy()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByText("1/3")).toBeTruthy()
    // Shift+Enter 上一处
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(screen.getByText("3/3")).toBeTruthy()
    // Esc 关闭：查找条移除
    fireEvent.keyDown(input, { key: "Escape" })
    expect(document.querySelector(".find-bar")).toBeNull()
  })

  it("无匹配：计数 0/0 + 输入框描红；有匹配恢复", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# 标题\n\n正文" })
    render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findAllByText("标题")
    openFindBar("/repo/doc.md")
    const input = document.querySelector(".find-bar input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "不存在" } })
    await waitFor(() => expect(screen.getByText("0/0")).toBeTruthy())
    expect(document.querySelector(".find-input.no-match")).not.toBeNull()
    fireEvent.change(input, { target: { value: "正文" } })
    await waitFor(() => expect(screen.getByText("1/1")).toBeTruthy())
    expect(document.querySelector(".find-input.no-match")).toBeNull()
  })

  it("防抖窗口内不闪 0/0（pending 无描红）；首扫落地才显计数（review 2026-09-09）", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# Alpha\n\nalpha" })
    render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findAllByText("Alpha")
    openFindBar("/repo/doc.md")
    const input = document.querySelector(".find-bar input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "alpha" } })
    // 防抖 150ms 内：idle 占位（非 0/0），无描红
    expect(document.querySelector(".find-count")?.textContent).toBe("")
    expect(document.querySelector(".find-input.no-match")).toBeNull()
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy())
  })

  it("首扫落地滚动定位第 1 处匹配（setActive(0) 同值 bail-out 不触发 [active] effect，review 2026-09-09）", async () => {
    fileContentsStub.set("/repo/scroll.md", { content: "# Alpha\n\nalpha" })
    render(<FileView absolutePath="/repo/scroll.md" />)
    await screen.findAllByText("Alpha")
    const layer = document.querySelector(".file-view") as HTMLElement
    layer.scrollTop = 500 // 用户滚在别处（首匹配在视口外）
    // jsdom 无布局：手动供 Range/滚动层 rect，令 scrollMatchIntoView 非 no-op
    const rangeRectOrig = Range.prototype.getBoundingClientRect
    Range.prototype.getBoundingClientRect = () => ({ top: 100, height: 20 }) as DOMRect
    layer.getBoundingClientRect = () => ({ top: 50 }) as DOMRect
    try {
      openFindBar("/repo/scroll.md")
      const input = document.querySelector(".find-bar input") as HTMLInputElement
      fireEvent.change(input, { target: { value: "alpha" } })
      await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy())
      // block:center 对齐：500 + (100 - 50) - (0 - 20)/2 = 560
      expect(layer.scrollTop).toBe(560)
    } finally {
      Range.prototype.getBoundingClientRect = rangeRectOrig
    }
  })

  it("部分命中下迟渲染块仍补扫计数（MutationObserver 不因已有命中断开，2026-09-09 二轮复审 #1）", async () => {
    fileContentsStub.set("/repo/late.md", { content: "# Alpha\n\nalpha" })
    render(<FileView absolutePath="/repo/late.md" />)
    await screen.findAllByText("Alpha")
    openFindBar("/repo/late.md")
    const input = document.querySelector(".find-bar input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "alpha" } })
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy())
    // 迟渲染块（streamdown 延迟）落入：已有 2 处命中也要重扫——原实现仅
    // 零命中时观察，部分命中下计数停留少计
    const mdRoot = document.querySelector(".file-md") as HTMLElement
    const p = document.createElement("p")
    p.textContent = "more alpha"
    act(() => {
      mdRoot.appendChild(p)
    })
    await waitFor(() => expect(screen.getByText("1/3")).toBeTruthy())
  })

  it("切源码自动关查找条；切回预览重新唤起对新 DOM 重扫（防僵尸，review 2026-09-09）", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# Alpha\n\nalpha 文本" })
    const { rerender } = render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findAllByText("Alpha")
    openFindBar("/repo/doc.md")
    const input = document.querySelector(".find-bar input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "alpha" } })
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy())
    // 切源码：查找条关闭（源码态 CM 自持搜索）
    fireEvent.click(screen.getByRole("button", { name: "源码" }))
    expect(document.querySelector(".find-bar")).toBeNull()
    // 切回预览：重新唤起 → 对新 DOM 重扫恢复计数
    fireEvent.click(screen.getByRole("button", { name: "预览" }))
    await screen.findAllByText("Alpha")
    openFindBar("/repo/doc.md")
    const input2 = document.querySelector(".find-bar input") as HTMLInputElement
    expect(input2.value).toBe("") // 关闭时已清词（瞬时任务态）
    fireEvent.change(input2, { target: { value: "alpha" } })
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy())
    // 内容重拉（file watch）同样重扫：改内容为 3 处命中
    fileContentsStub.set("/repo/doc.md", { content: "# Alpha\n\nalpha\n\nmore alpha" })
    rerender(<FileView absolutePath="/repo/doc.md" />)
    await waitFor(() => expect(screen.getByText("1/3")).toBeTruthy())
  })

  it("查找条已开时重按 Ctrl+F：重新聚焦全选（focusRequest，review 2026-09-09）", async () => {
    fileContentsStub.set("/repo/doc.md", { content: "# Alpha\n\nalpha" })
    render(<FileView absolutePath="/repo/doc.md" />)
    await screen.findAllByText("Alpha")
    openFindBar("/repo/doc.md")
    const input = document.querySelector(".find-bar input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "alpha" } })
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy())
    // 模拟焦点被抢走（点到页面）
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).not.toBe(input)
    // 重按 Ctrl+F：重新聚焦并全选
    openFindBar("/repo/doc.md")
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe("alpha".length)
  })

  it("扫描纯函数 scanFindMatches：多节点/同节点多命中/大小写/空查询", () => {
    fileContentsStub.set("/repo/x.md", { content: "x" })
    const root = document.createElement("div")
    root.innerHTML = "<p>Hello hello world</p><p>say HELLO</p><script>hello()</script>"
    const matches = scanFindMatches(root, "hello")
    expect(matches.length).toBe(3)
    expect(matches.map((m) => m.text)).toEqual(["Hello", "hello", "HELLO"])
    expect(scanFindMatches(root, "")).toEqual([])
    expect(scanFindMatches(root, "zzz")).toEqual([])
  })
})

describe("FileView 操作条（design-file-view-actions）", () => {
  it("代码视图：操作条常驻；open → shellOpenPath(当前文件路径)", () => {
    fileContentsStub.set("/repo/src/main.ts", { content: "const x = 1" })
    render(<FileView absolutePath="/repo/src/main.ts" />)
    expect(document.querySelector(".file-toolbar")).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "打开" }))
    expect(shellOpenPath).toHaveBeenCalledWith("/repo/src/main.ts")
  })

  it("所有分支常驻入口：markdown（与分段共存）/图片/PDF/二进制占位/加载态", () => {
    // markdown：open/open-with 与预览/源码分段同条
    fileContentsStub.set("/repo/doc.md", { content: "# 甲" })
    render(<FileView absolutePath="/repo/doc.md" />)
    expect(screen.getByRole("button", { name: "预览" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "打开" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "打开方式…" })).toBeTruthy()
    cleanup()

    // 图片
    fileContentsStub.set("/repo/a.png", { content: "QUJD", binary: true, mimeType: "image/png" })
    render(<FileView absolutePath="/repo/a.png" />)
    expect(document.querySelector(".image-zoom")).not.toBeNull()
    expect(screen.getByRole("button", { name: "打开方式…" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "打开" }))
    expect(shellOpenPath).toHaveBeenCalledWith("/repo/a.png")
    cleanup()

    // PDF（宿主 stub 之下操作条仍在）
    fileContentsStub.set("/repo/doc.pdf", { content: btoa("PDF"), binary: true, mimeType: "application/pdf" })
    render(<FileView absolutePath="/repo/doc.pdf" />)
    expect(document.querySelector(".pdf-frame-stub")).not.toBeNull()
    expect(screen.getByRole("button", { name: "打开方式…" })).toBeTruthy()
    cleanup()

    // 二进制占位（应用内不可预览——open 恰是主出口）
    fileContentsStub.set("/repo/a.zip", { content: "UEsDBAo=", binary: true, mimeType: "application/zip" })
    render(<FileView absolutePath="/repo/a.zip" />)
    expect(document.querySelector(".file-binary")).not.toBeNull()
    expect(screen.getByRole("button", { name: "打开方式…" })).toBeTruthy()
    cleanup()

    // 加载态（无缓存）：入口不依赖内容
    render(<FileView absolutePath="/repo/whatever.bin" />)
    expect(screen.getByText("加载中…")).not.toBeNull()
    expect(screen.getByRole("button", { name: "打开" })).toBeTruthy()
  })

  it("linux open-with → 应用内自建选择器：枚举当前文件，选择行 → shellOpenWithApp + 关闭 + 浮层计数", async () => {
    shellListOpenWithApps.mockResolvedValue([
      { id: "editor.desktop", name: "文本编辑器", icon: null, matches: true },
    ])
    fileContentsStub.set("/repo/src/main.ts", { content: "x" })
    render(<FileView absolutePath="/repo/src/main.ts" />)
    fireEvent.click(screen.getByRole("button", { name: "打开方式…" }))
    expect(shellListOpenWithApps).toHaveBeenCalledWith("/repo/src/main.ts")
    // 弹窗存续期间浮层计数（PDF/浏览器原生视图隐藏的 z-order 对策）
    expect(pushOverlay).toHaveBeenCalledTimes(1)
    fireEvent.click(await screen.findByRole("button", { name: "文本编辑器" }))
    expect(shellOpenWithApp).toHaveBeenCalledWith("/repo/src/main.ts", "editor.desktop")
    // 选择即关闭 → 计数平衡
    expect(popOverlay).toHaveBeenCalledTimes(1)
    expect(document.querySelector(".open-with-dialog")).toBeNull()
  })

  it("win32/darwin open-with → 系统对话框 shellOpenWith（不弹自建选择器）；browser 平台不显示该项", () => {
    platform = "win32"
    fileContentsStub.set("/repo/a.ts", { content: "x" })
    render(<FileView absolutePath="/repo/a.ts" />)
    fireEvent.click(screen.getByRole("button", { name: "打开方式…" }))
    expect(shellOpenWith).toHaveBeenCalledWith("/repo/a.ts")
    expect(shellListOpenWithApps).not.toHaveBeenCalled()
    expect(document.querySelector(".open-with-dialog")).toBeNull()
    cleanup()

    // darwin 同系统对话框
    platform = "darwin"
    fileContentsStub.set("/repo/a.ts", { content: "x" })
    render(<FileView absolutePath="/repo/a.ts" />)
    fireEvent.click(screen.getByRole("button", { name: "打开方式…" }))
    expect(shellOpenWith).toHaveBeenCalledTimes(2)
    cleanup()

    // 纯浏览器 shim：open-with 不渲染（无系统通道），open 仍在（同右键菜单恒显）
    platform = "browser"
    fileContentsStub.set("/repo/a.ts", { content: "x" })
    render(<FileView absolutePath="/repo/a.ts" />)
    expect(screen.queryByRole("button", { name: "打开方式…" })).toBeNull()
    expect(screen.getByRole("button", { name: "打开" })).toBeTruthy()
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

// PDF 宿主 mock（main 侧视图在 jsdom 不存在；FileView 层只断言分发与参数）
vi.mock("./pdf-frame-view", () => ({
  PdfFrameView: ({ absolutePath }: { absolutePath: string }) => (
    <div className="pdf-frame-stub" data-path={absolutePath} />
  ),
}))

describe("FileView PDF 预览（design-pdf-preview：专用视图宿主分发）", () => {
  it("binary PDF → PdfFrameView（透传绝对路径）；无工具条切换", () => {
    fileContentsStub.set("/repo/doc.pdf", { content: btoa("PDFBYTES!"), binary: true, mimeType: "application/pdf" })
    render(<FileView absolutePath="/repo/doc.pdf" />)
    const stub = document.querySelector(".pdf-frame-stub") as HTMLElement
    expect(stub).not.toBeNull()
    expect(stub.dataset.path).toBe("/repo/doc.pdf")
    // 仅预览：无预览/源码切换工具条（.ms-segmented）
    expect(document.querySelector(".ms-segmented")).toBeNull()
  })

  it("大小写不敏感（.PDF）；文本型/错误走占位或回退", () => {
    fileContentsStub.set("/repo/BIG.PDF", { content: btoa("%PDF fake"), binary: true })
    const { unmount } = render(<FileView absolutePath="/repo/BIG.PDF" />)
    expect(document.querySelector(".pdf-frame-stub")).not.toBeNull()
    unmount()

    // 服务端按文本返回（罕见）：非 binary → 占位
    fileContentsStub.set("/repo/t.pdf", { content: "not really pdf" })
    render(<FileView absolutePath="/repo/t.pdf" />)
    expect(document.querySelector(".pdf-frame-stub")).toBeNull()
    expect(document.querySelector(".file-binary")).toBeTruthy()
  })

  it("加载错误呈现错误态", () => {
    fileContentsStub.set("/repo/err.pdf", { content: "", binary: true, error: "boom" })
    render(<FileView absolutePath="/repo/err.pdf" />)
    expect(document.querySelector(".file-view.error")?.textContent).toContain("boom")
  })

  it("操作条展示文件名：basename 可见、title 悬浮全路径；加载/占位态常驻不弹入", () => {
    fileContentsStub.set("/repo/src/main.ts", { content: "const x = 1" })
    const { unmount } = render(<FileView absolutePath="/repo/src/main.ts" />)
    const name = document.querySelector<HTMLElement>(".file-toolbar-name")
    expect(name).not.toBeNull()
    expect(name?.textContent).toBe("main.ts")
    expect(name?.getAttribute("title")).toBe("/repo/src/main.ts")
    unmount()
    // 无缓存（占位/加载态）：工具条与文件名同样常驻
    render(<FileView absolutePath="/repo/a/b/c.json" />)
    expect(document.querySelector(".file-toolbar-name")?.textContent).toBe("c.json")
  })
})
