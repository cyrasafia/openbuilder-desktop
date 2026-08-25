/**
 * CodeView 测试（design-code-view）：
 * 1. languageForPath 纯函数映射（扩展名/特殊文件名/未命中）；
 * 2. CodeView 渲染冒烟（jsdom + ResizeObserver stub）：行号 gutter、内容、只读、
 *    doc 同步（content 变化不重建视图）。
 */
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CodeView } from "./code-view"
import { languageForPath } from "./cm-lang"
import { EditorView } from "@codemirror/view"

beforeAll(() => {
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

describe("languageForPath（静态映射）", () => {
  const cases: Array<[string, boolean]> = [
    ["/repo/src/main.ts", true],
    ["/repo/src/app.tsx", true],
    ["/repo/index.js", true],
    ["/repo/pkg.json", true],
    ["/repo/tsconfig.jsonc", true],
    ["/repo/data.jsonl", true],
    ["/repo/main.py", true],
    ["/repo/main.go", true],
    ["/repo/lib.rs", true],
    ["/repo/ci.yaml", true],
    ["/repo/ci.YML", true],
    ["/repo/README.md", true],
    ["/repo/index.html", true],
    ["/repo/style.css", true],
    ["/repo/style.scss", true],
    ["/repo/query.sql", true],
    ["/repo/main.cpp", true],
    ["/repo/icon.svg", true],
    ["/repo/run.sh", true],
    ["/repo/Cargo.toml", true],
    ["/repo/app.ini", true],
    ["/repo/Makefile", true],
    ["/repo/Dockerfile", true],
    ["/repo/unknown.xyz", false],
    ["/repo/noext", false],
    ["/repo/.gitignore", false],
  ]
  for (const [path, hit] of cases) {
    it(`${path} → ${hit ? "语言命中" : "纯文本"}`, () => {
      expect(languageForPath(path) != null).toBe(hit)
    })
  }
})

describe("CodeView 渲染", () => {
  it("行号 gutter + 内容渲染 + 只读", () => {
    const { container } = render(<CodeView path="/repo/a.ts" content={"const x = 1\nconst y = 2\n"} />)
    expect(container.querySelector(".cm-gutters")).not.toBeNull()
    expect(container.querySelector(".cm-content")?.textContent).toContain("const x = 1")
    // 行号块数量 = 逻辑行数（3 行内容 + 末空行计法取 CM 自身，断言 ≥3）
    expect(container.querySelectorAll(".cm-gutterElement").length).toBeGreaterThanOrEqual(3)
    // readonly：state 层
    const host = container.querySelector(".code-view-host") as HTMLElement
    const view = EditorView.findFromDOM(host)
    expect(view?.state.readOnly).toBe(true)
  })

  it("content 变化 → 原视图整体替换（不重建，含收缩路径）", () => {
    const { container, rerender } = render(<CodeView path="/repo/a.ts" content={"line1\n"} />)
    const host = container.querySelector(".code-view-host") as HTMLElement
    const view1 = EditorView.findFromDOM(host)
    rerender(<CodeView path="/repo/a.ts" content={"line1\nline2\n"} />)
    const view2 = EditorView.findFromDOM(host)
    expect(view2).toBe(view1)
    expect(view2?.state.doc.toString()).toBe("line1\nline2\n")
    rerender(<CodeView path="/repo/a.ts" content={"short\n"} />)
    expect(EditorView.findFromDOM(host)?.state.doc.toString()).toBe("short\n")
  })

  it("Ctrl+F 打开搜索面板（zh 短语），readonly 无 replace 输入", () => {
    const { container } = render(
      <CodeView path="/repo/a.ts" content={"const x = 1\n"} locale="zh" />,
    )
    const content = container.querySelector(".cm-content") as HTMLElement
    content.focus()
    fireEvent.keyDown(content, { key: "f", ctrlKey: true })
    const panel = container.querySelector(".cm-panels")
    expect(panel).not.toBeNull()
    const input = panel?.querySelector("input.cm-textfield") as HTMLInputElement
    expect(input.placeholder).toBe("查找")
    // readonly：replace 输入与按钮自动隐藏（CM 内建）
    expect(panel?.querySelector("input[name=replace]")).toBeNull()
  })
})
