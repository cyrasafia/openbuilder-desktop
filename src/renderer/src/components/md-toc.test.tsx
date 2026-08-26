/**
 * markdown 预览 TOC 大纲测试（design-markdown-preview §2.4）：
 * 章节树构建（嵌套/跳级/平级）+ DOM 扫描 + 组件行为
 * （按章节收起/展开、点击锚定）。整窗收起/展开由 FileView 工具条控制，
 * 相应测试在 file-view.test.tsx。
 */
import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { buildTocTree, collectHeadings, MdToc, type TocHeading } from "./md-toc"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      tocTitle: "目录",
      tocCollapse: "收起目录",
      tocExpand: "展开目录",
      tocSectionToggle: "折叠/展开章节",
    },
    locale: "zh" as const,
  }),
}))

const scrollIntoView = vi.fn()

beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})

afterEach(() => {
  cleanup()
  scrollIntoView.mockClear()
})

function heading(level: number, text: string): TocHeading {
  const el = document.createElement(`h${level}`)
  el.textContent = text
  return { level, text, el }
}

describe("buildTocTree", () => {
  it("嵌套：h1 > h2 > h3", () => {
    const tree = buildTocTree([heading(1, "a"), heading(2, "b"), heading(3, "c")])
    expect(tree).toHaveLength(1)
    expect(tree[0].heading.text).toBe("a")
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].heading.text).toBe("b")
    expect(tree[0].children[0].children[0].heading.text).toBe("c")
  })

  it("平级并列 + 回退层级", () => {
    const tree = buildTocTree([heading(1, "a"), heading(2, "b"), heading(2, "c"), heading(1, "d")])
    expect(tree.map((n) => n.heading.text)).toEqual(["a", "d"])
    expect(tree[0].children.map((n) => n.heading.text)).toEqual(["b", "c"])
    expect(tree[1].children).toHaveLength(0)
  })

  it("跳级：h1 后直接 h3 挂入 h1 之下；h3 起头为根", () => {
    const tree = buildTocTree([heading(1, "a"), heading(3, "b")])
    expect(tree).toHaveLength(1)
    expect(tree[0].children[0].heading.text).toBe("b")

    const tree2 = buildTocTree([heading(3, "x"), heading(1, "y")])
    expect(tree2.map((n) => n.heading.text)).toEqual(["x", "y"])
  })

  it("空输入 → 空树", () => {
    expect(buildTocTree([])).toEqual([])
  })
})

describe("collectHeadings", () => {
  it("按 DOM 顺序收集 h1–h6，忽略非标题元素", () => {
    const root = document.createElement("div")
    root.innerHTML =
      "<h2>二</h2><p>正文</p><h1>一</h1><pre><code># 代码内假标题</code></pre><h6>六</h6>"
    const got = collectHeadings(root)
    expect(got.map((h) => [h.level, h.text])).toEqual([
      [2, "二"],
      [1, "一"],
      [6, "六"],
    ])
  })
})

describe("MdToc 组件", () => {
  const sample = () => [heading(1, "章节一"), heading(2, "小节 A"), heading(2, "小节 B"), heading(1, "章节二")]

  /** 章节折叠态由父级（FileView）持有，测试以带 state 的包装模拟父级；
   * 折叠态跨显隐保留与内容更换重置在 file-view.test.tsx 覆盖 */
  function TocHarness({ headings }: { headings: TocHeading[] }) {
    const [folded, setFolded] = useState<ReadonlySet<HTMLElement>>(new Set())
    return (
      <MdToc
        headings={headings}
        folded={folded}
        onFold={(el) =>
          setFolded((prev) => {
            const next = new Set(prev)
            if (next.has(el)) next.delete(el)
            else next.add(el)
            return next
          })
        }
      />
    )
  }

  it("无标题不渲染", () => {
    const { container } = render(<TocHarness headings={[]} />)
    expect(container.innerHTML).toBe("")
  })

  it("渲染全部条目；有子节点的带折叠钮，叶子无", () => {
    render(<TocHarness headings={sample()} />)
    expect(screen.getByText("章节一")).not.toBeNull()
    expect(screen.getByText("小节 B")).not.toBeNull()
    const folds = document.querySelectorAll(".md-toc-fold:not(.md-toc-fold-empty)")
    expect(folds.length).toBe(1)
    expect(document.querySelectorAll(".md-toc-fold-empty").length).toBe(3)
  })

  it("按章节收起/展开：子条目隐藏/恢复，aria-expanded 同步", () => {
    render(<TocHarness headings={sample()} />)
    const fold = document.querySelectorAll(".md-toc-fold:not(.md-toc-fold-empty)")[0]
    expect(fold.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("小节 A")).not.toBeNull()

    fireEvent.click(fold)
    expect(screen.queryByText("小节 A")).toBeNull()
    expect(screen.queryByText("小节 B")).toBeNull()
    expect(fold.getAttribute("aria-expanded")).toBe("false")
    // 兄弟章节不受影响
    expect(screen.getByText("章节二")).not.toBeNull()

    fireEvent.click(fold)
    expect(screen.getByText("小节 A")).not.toBeNull()
  })

  it("点击条目对目标元素 scrollIntoView（smooth/start）", () => {
    const headings = sample()
    render(<TocHarness headings={headings} />)
    fireEvent.click(screen.getByText("小节 B"))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.instances[0]).toBe(headings[2].el)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })
  })
})
