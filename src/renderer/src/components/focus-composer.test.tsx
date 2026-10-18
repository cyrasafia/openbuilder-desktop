/**
 * FocusComposer 测试（design-focus-mode §12）：
 * 1. 初始 doc 渲染 + markdown token class（heading→cm-keyword、inline code→
 *    cm-string，cm-theme classHighlighter 映射）；
 * 2. doc 同步：外部 value 变化整体替换（code-view 同款快路径）；
 * 3. Enter 换行（D4：无发送路径——onChange 只见文本变化），修饰键 Enter 同；
 * 4. Esc → onRequestClose（CM keymap Prec.highest）；
 * 5. 相位回调：opening → onOpened（兜底定时器）、closing → onClosed 携选区；
 * 6. focusSurfaceFadeClass 映射（§6.4 两段式类）。
 *
 * jsdom 无布局（rect 全 0）→ FLIP 分支自动跳过（width>0 守卫），相位回调走
 * 300ms 兜底定时器——waitFor 等待（真实定时器）。
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  FocusComposer,
  focusSurfaceFadeClass,
  type FocusPhase,
} from "./focus-composer"
import { ResizeObserverStub } from "./resize-observer-stub"

beforeAll(() => {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  // jsdom 的 Range 缺几何 API（CM 选区绘制量测调用）——空列表 stub
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () =>
      ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect
  }
})

afterAll(() => cleanup())

type FocusProps = Parameters<typeof FocusComposer>[0]

const baseProps: FocusProps = {
  phase: "opening",
  value: "# 标题\n正文",
  onChange: () => {},
  origin: null,
  getOriginRect: () => null,
  initialSelection: { start: 5, end: 5 },
  onOpened: () => {},
  onClosed: () => {},
  onRequestClose: () => {},
  placeholder: "占位",
  exitTitle: "退回普通模式（Esc）",
  sendLabel: "发送",
  sendDisabled: false,
  onSend: () => {},
  ariaLabel: "专注模式",
}

/** 渲染 + 回调 spy + rerender 辅助（保持其余 base props） */
function renderFocus(props: Partial<FocusProps> = {}) {
  const onChange = vi.fn()
  const onOpened = vi.fn()
  const onClosed = vi.fn()
  const onRequestClose = vi.fn()
  const spies = { onChange, onOpened, onClosed, onRequestClose }
  const utils = render(
    <FocusComposer
      {...baseProps}
      {...spies}
      {...props}
    />,
  )
  return {
    ...utils,
    ...spies,
    rerenderFocus(next: Partial<FocusProps>) {
      utils.rerender(<FocusComposer {...baseProps} {...spies} {...props} {...next} />)
    },
  }
}

function cmContent(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".focus-editor-host .cm-content")
  if (!el) throw new Error("cm-content 未挂载")
  return el
}

describe("FocusComposer（design-focus-mode）", () => {
  it("初始 doc 渲染 + markdown token class", () => {
    const r = renderFocus({ value: "# 标题\n`code`" })
    expect(cmContent(r.container).textContent).toContain("标题")
    expect(cmContent(r.container).textContent).toContain("code")
    // heading1 → cm-keyword、InlineCode/CodeText → cm-string（cm-theme 映射）
    expect(r.container.querySelector(".focus-editor-host .cm-keyword")).not.toBeNull()
    expect(r.container.querySelector(".focus-editor-host .cm-string")).not.toBeNull()
  })

  it("doc 同步：外部 value 变化整体替换", () => {
    const r = renderFocus()
    r.rerenderFocus({ value: "改写后的内容" })
    expect(cmContent(r.container).textContent).toContain("改写后的内容")
  })

  it("Enter 换行（无发送路径，D4）", () => {
    const r = renderFocus({ value: "# 标题\n正文", initialSelection: { start: 5, end: 5 } })
    fireEvent.keyDown(cmContent(r.container), { key: "Enter" })
    expect(r.onChange).toHaveBeenCalledWith("# 标题\n\n正文")
  })

  it("修饰键 Enter 亦换行（一律换行）", () => {
    const r = renderFocus({ value: "# 标题\n正文", initialSelection: { start: 5, end: 5 } })
    fireEvent.keyDown(cmContent(r.container), { key: "Enter", ctrlKey: true })
    expect(r.onChange).toHaveBeenCalledWith("# 标题\n\n正文")
  })

  it("Esc → onRequestClose（Prec.highest 压过选区折叠）", () => {
    const r = renderFocus()
    fireEvent.keyDown(cmContent(r.container), { key: "Escape" })
    expect(r.onRequestClose).toHaveBeenCalledTimes(1)
  })

  it("相位回调：opening → onOpened；closing → onClosed 携选区", async () => {
    const r = renderFocus({ value: "abc", initialSelection: { start: 1, end: 2 } })
    await waitFor(() => expect(r.onOpened).toHaveBeenCalledTimes(1))
    r.rerenderFocus({ phase: "closing" as FocusPhase })
    await waitFor(() => expect(r.onClosed).toHaveBeenCalledTimes(1))
    // jsdom 无布局走兜底定时器；选区来自 CM 主选区（初始 range 1..2）
    expect(r.onClosed).toHaveBeenCalledWith({ start: 1, end: 2 })
  })

  it("focusSurfaceFadeClass：两段式渐变类映射（§6.4）", () => {
    expect(focusSurfaceFadeClass("off")).toBe("")
    expect(focusSurfaceFadeClass("opening")).toBe("focus-fade-out")
    expect(focusSurfaceFadeClass("closing")).toBe("focus-fade-in")
    expect(focusSurfaceFadeClass("on")).toBe("")
  })
})
