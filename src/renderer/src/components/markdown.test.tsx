/**
 * 消息流 markdown 渲染：streamdown 解析层 + 本项目覆写组件层。
 * jsdom 无 IntersectionObserver（streamdown 块级懒渲染依赖），测试前补 stub。
 */
import { render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { Markdown } from "./markdown"

vi.mock("../app", () => ({
  useI18n: () => ({ t: { copy: "复制", copied: "已复制" }, locale: "zh" as const }),
}))

// mermaid 懒加载 mock：真实包体积大且 render 依赖布局（jsdom 不可用）。
// 源码含 "BAD" 模拟语法错误（render 抛错 → 组件回落代码块）。
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, source: string) => {
      if (source.includes("BAD")) throw new Error("Parse error")
      return { svg: `<svg>diagram:${source.trim()}</svg>` }
    }),
  },
}))

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
})

describe("Markdown", () => {
  it("行内语法：加粗/行内代码/链接", () => {
    render(
      <Markdown>
        {"**粗体** 与 `code` 及 [链接](https://example.com)"}
      </Markdown>,
    )
    const strong = screen.getByText("粗体")
    expect(strong.tagName).toBe("STRONG")
    const inline = screen.getByText("code")
    expect(inline.classList.contains("md-code-inline")).toBe(true)
    const link = screen.getByText("链接")
    expect(link.tagName).toBe("A")
    expect(link.getAttribute("href")).toBe("https://example.com/")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
  })

  it("代码块：语言标签 + 复制按钮 + 无高亮纯文本", () => {
    render(<Markdown>{"```ts\nconst x = 1\n```"}</Markdown>)
    expect(screen.getByText("ts").classList.contains("md-codeblock-lang")).toBe(true)
    expect(screen.getByText("复制")).not.toBeNull()
    expect(screen.getByText("const x = 1")).not.toBeNull()
  })

  it("GFM 表格与任务列表", () => {
    render(
      <Markdown>{"| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo"}</Markdown>,
    )
    expect(document.querySelector(".md-table-wrap table")).not.toBeNull()
    expect(screen.getByText("done")).not.toBeNull()
    expect(document.querySelectorAll('input[type="checkbox"][disabled]').length).toBe(2)
  })

  it("流式不完整语法：未闭合代码围栏仍渲染为代码块", () => {
    render(<Markdown>{"前文\n\n```python\nprint("}</Markdown>)
    expect(screen.getByText("python").classList.contains("md-codeblock-lang")).toBe(true)
    expect(screen.getByText("print(")).not.toBeNull()
  })

  it("GFM alert：[!NOTE] 引用块渲染为 alert 卡（标记剥离 + 标题 + 多段正文）", () => {
    const { container } = render(<Markdown>{"> [!NOTE]\n> 内容段落\n>\n> 第二段"}</Markdown>)
    const bq = container.querySelector("blockquote.markdown-alert.markdown-alert-note")
    expect(bq).not.toBeNull()
    expect(bq!.querySelector("p.markdown-alert-title")!.textContent).toBe("Note")
    expect(bq!.textContent).not.toContain("[!NOTE]")
    expect(bq!.textContent).toContain("内容段落")
    expect(bq!.textContent).toContain("第二段")
  })

  it("GFM alert 全类型 class + 标记大小写不敏感", () => {
    const { container } = render(
      <Markdown>{"> [!TIP]\n> t\n\n> [!IMPORTANT]\n> i\n\n> [!warning]\n> w\n\n> [!Caution]\n> c"}</Markdown>,
    )
    for (const kind of ["tip", "important", "warning", "caution"]) {
      expect(container.querySelector(`blockquote.markdown-alert-${kind}`)).not.toBeNull()
    }
  })

  it("GFM alert 标记独占段落：仅剩标题行，无空段残留", () => {
    const { container } = render(<Markdown>{"> [!NOTE]"}</Markdown>)
    const bq = container.querySelector("blockquote.markdown-alert-note")!
    expect(bq.querySelectorAll("p").length).toBe(1)
  })

  it("GFM alert 标记后同行内容：剥离标记保留内容", () => {
    const { container } = render(<Markdown>{"> [!IMPORTANT] 同行内容"}</Markdown>)
    const bq = container.querySelector("blockquote.markdown-alert-important")!
    expect(bq.textContent).toContain("同行内容")
    expect(bq.textContent).not.toContain("[!IMPORTANT]")
  })

  it("未知标记 / 标记不在首段：按普通引用块渲染（字面保留）", () => {
    const { container } = render(<Markdown>{"> [!FOO]\n> x\n\n> 段落\n>\n> [!NOTE]"}</Markdown>)
    expect(container.querySelector("blockquote.markdown-alert")).toBeNull()
    const bqs = container.querySelectorAll("blockquote")
    expect(bqs[0].textContent).toContain("[!FOO]")
    expect(bqs[1].textContent).toContain("[!NOTE]")
  })

  it("普通引用块不套 alert class", () => {
    const { container } = render(<Markdown>{"> 普通"}</Markdown>)
    expect(container.querySelector("blockquote")!.classList.contains("markdown-alert")).toBe(false)
  })

  it("mermaid 块：渲染为图容器（防抖后 SVG 落地）", async () => {
    const { container } = render(<Markdown>{"```mermaid\ngraph TD\nA-->B\n```"}</Markdown>)
    // 防抖窗内先呈加载骨架
    expect(container.querySelector(".md-mermaid-pending")).not.toBeNull()
    const host = await waitFor(() => {
      const el = container.querySelector(".md-mermaid:not(.md-mermaid-pending)")
      expect(el).not.toBeNull()
      return el!
    }, { timeout: 2000 })
    expect(host.querySelector("svg")?.textContent).toContain("graph TD")
    // 成功态不再有代码块外壳
    expect(container.querySelector(".md-codeblock")).toBeNull()
  })

  it("mermaid 语法错误：回落代码块外壳（源码可见 + 语言标签）", async () => {
    const { container } = render(<Markdown>{"```mermaid\nBAD graph\n```"}</Markdown>)
    await waitFor(
      () => {
        expect(container.querySelector(".md-codeblock")).not.toBeNull()
      },
      { timeout: 2000 },
    )
    expect(screen.getByText("mermaid").classList.contains("md-codeblock-lang")).toBe(true)
    expect(container.querySelector(".md-pre")?.textContent).toContain("BAD graph")
  })
})
