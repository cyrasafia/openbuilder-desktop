/**
 * FileView 分发与 markdown 二态测试（design-markdown-preview）：
 * 扩展名分发（.md/.markdown/.MD → 预览；.mdx/点文件/无扩展名/代码 → 源码）
 * + 预览/源码切换 + 加载/错误态工具条常驻。
 * jsdom 无 IntersectionObserver（streamdown 依赖），测试前补 stub。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { FileView } from "./workspace"

const loadFileContent = vi.fn(async () => {})

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      loading: "加载中…",
      previewMode: "预览",
      sourceMode: "源码",
      viewModeLabel: "查看方式",
      copy: "复制",
      copied: "已复制",
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
  // CodeMirror 视图测量依赖 ResizeObserver（jsdom 缺失）
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
})

afterAll(() => {
  cleanup()
})

beforeEach(() => {
  // 本仓库 vitest 未开 globals，RTL auto-cleanup 不生效——手动卸载
  cleanup()
  loadFileContent.mockClear()
  fileContentsStub = new Map()
})

describe("FileView markdown 预览", () => {
  it(".md 默认渲染预览 + 工具条二态（分组按钮）；切换源码为代码视图", async () => {
    fileContentsStub.set("/repo/README.md", { content: "# 标题\n\n正文 `code`" })
    render(<FileView absolutePath="/repo/README.md" />)
    // 默认预览：markdown 解析为 h1
    expect((await screen.findByText("标题")).tagName).toBe("H1")
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
    expect((await screen.findByText("A")).tagName).toBe("H1")
    unmount()

    fileContentsStub.set("/repo/BIG.MD", { content: "# B" })
    render(<FileView absolutePath="/repo/BIG.MD" />)
    expect((await screen.findByText("B")).tagName).toBe("H1")
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
    expect((await screen.findByText("标题")).tagName).toBe("H1")
    fireEvent.click(screen.getByRole("button", { name: "源码" }))
    expect(document.querySelector(".cm-content")?.textContent).toContain("# 标题")
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
