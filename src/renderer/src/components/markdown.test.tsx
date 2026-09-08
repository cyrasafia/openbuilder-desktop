/**
 * 消息流 markdown 渲染：streamdown 解析层 + 本项目覆写组件层。
 * jsdom 无 IntersectionObserver（streamdown 块级懒渲染依赖），测试前补 stub。
 */
import { render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { Markdown } from "./markdown"
import { defaultRemarkPlugins, type StreamdownProps } from "streamdown"
import { relativeImageRewrite } from "./markdown-image"

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

  // design-markdown-preview §2.9：CommonMark 侧向规则 CJK 缺陷——micromark 严格
  // 遵循规范，闭合 ** 前是全角标点、后紧跟汉字时无法闭合，加粗退化为字面文本
  it("CJK 标点侧向修复：闭合 ** 前是全角逗号仍渲染加粗（用户实测样例）", () => {
    render(
      <Markdown>
        {
          "职责：你的首要职责是激发用户的旅行灵感。**每一张订单都是双赢的结果，**只有在用户满意的基础上，才能实现商业价值。"
        }
      </Markdown>,
    )
    const strong = screen.getByText("每一张订单都是双赢的结果，")
    expect(strong.tagName).toBe("STRONG")
  })

  it("CJK 标点侧向修复：开侧 ** 后是全角标点补救；纯 ASCII 维持严格语义（与 GitHub 一致）", () => {
    const { container } = render(<Markdown>{"字**，加粗**尾 **foo,**bar"}</Markdown>)
    expect(screen.getByText("，加粗").tagName).toBe("STRONG")
    expect(container.textContent).toContain("**foo,**bar")
  })

  it("CJK 标点侧向修复：remarkPlugins 传入（文件预览管线）同样自动注入", () => {
    const { container } = render(
      <Markdown remarkPlugins={[...Object.values(defaultRemarkPlugins)]}>{"**加粗，**尾"}</Markdown>,
    )
    const strong = container.querySelector("strong")!
    expect(strong.textContent).toBe("加粗，")
  })

  it("CJK 标点侧向修复：softLineBreak（用户回显）管线同样生效", () => {
    const { container } = render(<Markdown softLineBreak>{"**加粗，**尾\n第二行"}</Markdown>)
    const strong = container.querySelector("strong")!
    expect(strong.textContent).toBe("加粗，")
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

  // 放末尾：softLineBreak 用例渲染含复制按钮的代码块，DOM 累积会污染
  // 前面用例的 screen.getByText("复制") 全局查询（vitest 无全局 cleanup）
  it("softLineBreak：单个换行渲染为 <br>（用户回显保真），代码块内换行不受影响", () => {
    const { container } = render(
      <Markdown softLineBreak>{"第一行\n第二行\n\n```py\nx=1\ny=2\n```"}</Markdown>,
    )
    const p = container.querySelector("p")!
    expect(p.querySelectorAll("br").length).toBe(1)
    expect(p.textContent).toContain("第一行")
    expect(p.textContent).toContain("第二行")
    // 代码块内容在 code 节点（非 text），不受软换行插件触及，原样换行
    const code = container.querySelector(".md-pre code")!
    expect(code.querySelectorAll("br").length).toBe(0)
    expect(code.textContent).toBe("x=1\ny=2\n")
  })

  it("默认（无 softLineBreak）：单个换行按 CommonMark 折叠为空格，不产生 <br>", () => {
    const { container } = render(<Markdown>{"第一行\n第二行"}</Markdown>)
    expect(container.querySelector("p")!.querySelectorAll("br").length).toBe(0)
  })

  // img 覆写（design-markdown-preview §2.8 相对路径图片注入点）
  it("img 覆写：传入时替换默认 img 组件（src/alt 透传）", () => {
    const { container } = render(
      <Markdown img={({ node: _node, ...rest }) => <img data-ov="1" {...rest} />}>
        {"![替代](/abs/img/a.png)"}
      </Markdown>,
    )
    const el = container.querySelector("img[data-ov]") as HTMLImageElement
    expect(el).not.toBeNull()
    expect(el.getAttribute("src")).toBe("/abs/img/a.png")
    expect(el.getAttribute("alt")).toBe("替代")
  })

  it("默认 img：无覆写时原样渲染（外链不拦截）", () => {
    const { container } = render(<Markdown>{"![a](https://e.com/x.png)"}</Markdown>)
    const el = container.querySelector("img") as HTMLImageElement
    expect(el).not.toBeNull()
    expect(el.getAttribute("src")).toBe("https://e.com/x.png")
  })

  it("§2.8 预重写管线：remarkPlugins 重写相对 src 为 / 绝对路径（默认 rehype 管线前）", () => {
    const seen: string[] = []
    const plugins = [
      ...Object.values(defaultRemarkPlugins),
      [relativeImageRewrite, { baseDir: "/repo/docs" }],
    ] as unknown as StreamdownProps["remarkPlugins"]
    render(
      <Markdown
        remarkPlugins={plugins}
        img={({ node: _node, src, ...rest }) => {
          if (typeof src === "string") seen.push(src)
          return <img {...rest} src={src} />
        }}
      >
        {"![a](./img/x.png) ![b](https://e.com/y.png) ![c](./doc.pdf)"}
      </Markdown>,
    )
    // 相对图片 → / 绝对路径；外链/非图扩展不改写（harden 对其维持原语义：
    // 外链透传，./doc.pdf 被折叠为 /doc.pdf 的字面 pathname）
    expect(seen).toContain("/repo/docs/img/x.png")
    expect(seen).toContain("https://e.com/y.png")
    expect(seen).not.toContain("./img/x.png")
  })
})
