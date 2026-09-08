/**
 * CodeView 测试（design-code-view / design-code-folding）：
 * 1. languageForPath 纯函数映射（扩展名/特殊文件名/未命中）；
 * 2. CodeView 渲染冒烟（jsdom + ResizeObserver stub）：行号 gutter、内容、只读、
 *    doc 同步（content 变化不重建视图）；
 * 3. 折叠装配：JSON gutter 折叠标记、折叠→占位符、展开还原、无折叠范围纯文本无标记。
 */
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CodeView } from "./code-view"
import { languageForPath } from "./cm-lang"
import { EditorView } from "@codemirror/view"
import { foldable, foldEffect, unfoldEffect } from "@codemirror/language"
import { ResizeObserverStub } from "./resize-observer-stub"

beforeAll(() => {
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

describe("代码折叠（design-code-folding）", () => {
  const jsonDoc = `{\n  "a": {\n    "b": 1\n  },\n  "c": [1, 2]\n}\n`

  /** CM 视口外行不渲染折叠标记；jsdom 无布局，viewport 停在 doc 开头，
   * 前几行必在视口内（Object/ObjectProperty 起始行）。
   * foldGutter 恒渲染一个 initialSpacer 兜底元素（spacer 的 .cm-gutterElement
   * 内联 visibility:hidden），真实标记断言须按此过滤 */
  function viewFrom(container: HTMLElement): EditorView {
    const host = container.querySelector(".code-view-host") as HTMLElement
    const view = EditorView.findFromDOM(host)
    expect(view).not.toBeNull()
    return view as EditorView
  }

  /** 可见折叠标记（排除 spacer：其外层 .cm-gutterElement 内联 visibility:hidden） */
  function visibleFoldMarkers(container: HTMLElement): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(".cm-foldGutter .cm-gutterElement:not([style*='hidden']) span"),
    )
  }

  it("JSON 文件 gutter 出现折叠标记；折叠后行内占位符出现、展开还原", () => {
    const { container } = render(<CodeView path="/repo/pkg.json" content={jsonDoc} />)
    // 折叠标记挂 cm-gutters（与行号同容器）：Object 起始行可折叠 → 标记存在
    expect(visibleFoldMarkers(container).length).toBeGreaterThan(0)
    const view = viewFrom(container)
    // 顶层 Object 整体折叠（foldable(0) = doc 首行可折叠范围）
    const range = foldable(view.state, 0, view.state.doc.line(1).to)
    expect(range).not.toBeNull()
    view.dispatch({ effects: foldEffect.of(range!) })
    expect(container.querySelector(".cm-foldPlaceholder")).not.toBeNull()
    // 展开还原：占位符消失、内容全文可读
    view.dispatch({ effects: unfoldEffect.of(range!) })
    expect(container.querySelector(".cm-foldPlaceholder")).toBeNull()
    expect(container.querySelector(".cm-content")?.textContent).toContain('"b": 1')
  })

  it("无折叠范围（纯文本）无标记，折叠指令无动作", () => {
    const { container } = render(<CodeView path="/repo/notes.xyz" content={"line1\nline2\n"} />)
    // 纯文本无 foldable 范围 → 无折叠标记（仅剩 spacer 兜底，被可见性过滤掉）
    expect(visibleFoldMarkers(container)).toEqual([])
    const view = viewFrom(container)
    expect(foldable(view.state, 0, view.state.doc.line(1).to)).toBeNull()
  })
})
