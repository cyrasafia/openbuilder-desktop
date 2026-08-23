/**
 * 消息流 markdown 渲染：streamdown 解析层 + 本项目覆写组件层。
 * jsdom 无 IntersectionObserver（streamdown 块级懒渲染依赖），测试前补 stub。
 */
import { render, screen } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { Markdown } from "./markdown"

vi.mock("../app", () => ({
  useI18n: () => ({ t: { copy: "复制", copied: "已复制" }, locale: "zh" as const }),
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
})
