/**
 * 文件引用（design-file-reference）：atMentionQuery 纯函数 / fileRefFromSearch /
 * FileRefChips 渲染（增删/目录不可点/点击开文件 Tab）。useFileRefInput 的
 * 键盘与防抖交互在 store mock 下难稳定断言，核心逻辑收敛在纯函数与 store 侧。
 */
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { atMentionQuery, fileRefFromSearch, FileRefChips, useFileRefInput, FILEREF_MIME, setDraggingFileRef } from "./file-ref"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      fileRefRemove: "移除引用",
      fileRefNoMatch: "无匹配文件",
      commandListLoading: "正在获取命令列表…",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

afterEach(cleanup)

/** useFileRefInput 交互测试的 store 桩（vi.mock 提升需经模块级变量间接引用） */
const addFileRef = vi.fn()
const searchFiles = vi.fn(async (q: string) => (q ? [`src/${q}.ts`] : ["readme.md", "a.ts"]))
let storeStub: Record<string, unknown> = {}

describe("atMentionQuery（@词提取）", () => {
  it("光标在 @词 尾部：返回查询词与区间", () => {
    expect(atMentionQuery("看下 @src/ma", 11)).toEqual({ query: "src/ma", start: 3, end: 11 })
  })

  it("光标在词中间：取前半", () => {
    expect(atMentionQuery("@abc", 2)).toEqual({ query: "a", start: 0, end: 2 })
  })

  it("裸 @（空 query）可触发（浏览列表）", () => {
    expect(atMentionQuery("@", 1)).toEqual({ query: "", start: 0, end: 1 })
  })

  it("非 @ 前缀 / 空白分隔 / 转义 \\@ 不触发", () => {
    expect(atMentionQuery("hello", 5)).toBeNull()
    expect(atMentionQuery("a b", 3)).toBeNull()
    expect(atMentionQuery("word@", 5)).toBeNull() // @ 在词首才触发：word@ 的 token 不以 @ 开头
    expect(atMentionQuery("\\@esc", 5)).toBeNull()
  })

  it("多行文本：仅看光标所在行", () => {
    expect(atMentionQuery("line1\n@par", 10)).toEqual({ query: "par", start: 6, end: 10 })
  })
})

describe("fileRefFromSearch（相对路径 → FileRef）", () => {
  it("相对路径拼 absolute；绝对路径直接用（DR-1）", () => {
    expect(fileRefFromSearch("src/a.ts", "/repo")).toEqual({
      path: "src/a.ts",
      absolute: "/repo/src/a.ts",
      filename: "a.ts",
      isDir: false,
    })
    expect(fileRefFromSearch("/abs/a.ts", "/repo").absolute).toBe("/abs/a.ts")
  })

  it("目录尾斜杠归一", () => {
    expect(fileRefFromSearch("a.ts", "/repo/").absolute).toBe("/repo/a.ts")
  })
})

describe("FileRefChips", () => {
  const items = [
    { key: "/repo/a.ts", path: "src/a.ts", absolute: "/repo/a.ts", isDir: false },
    { key: "/repo/src", path: "src/", absolute: "/repo/src", isDir: true },
  ]

  it("渲染文件/目录 chip，× 可删，目录不可点", () => {
    const onRemove = vi.fn()
    const onOpen = vi.fn()
    const { container } = render(<FileRefChips items={items} onRemove={onRemove} onOpen={onOpen} />)
    expect(screen.getAllByText("src/a.ts").length).toBeGreaterThan(0)
    const chips = container.querySelectorAll(".ref-chip")
    expect(chips.length).toBe(2)
    expect(chips[0]!.classList.contains("clickable")).toBe(true)
    expect(chips[1]!.classList.contains("clickable")).toBe(false)
    chips[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(onOpen).toHaveBeenCalledWith(items[0])
    const x = container.querySelectorAll(".ref-chip-x")[0]! as HTMLElement
    x.click()
    expect(onRemove).toHaveBeenCalledWith("/repo/a.ts")
  })

  it("空列表不渲染", () => {
    const { container } = render(<FileRefChips items={[]} />)
    expect(container.querySelector(".ref-chips")).toBeNull()
  })

  it("pending 占位 chip：预览样式类、无 × 按钮、不可点", () => {
    const onRemove = vi.fn()
    const onOpen = vi.fn()
    const { container } = render(
      <FileRefChips
        items={[{ key: "/repo/a.ts", path: "src/a.ts", absolute: "/repo/a.ts", isDir: false, pending: true }]}
        onRemove={onRemove}
        onOpen={onOpen}
      />,
    )
    const chip = container.querySelector(".ref-chip")!
    expect(chip.className).toContain("pending")
    expect(chip.className).not.toContain("clickable")
    expect(container.querySelector(".ref-chip-x")).toBeNull()
  })

  it("FILEREF_MIME 自定义类型（非 text/plain）", () => {
    expect(FILEREF_MIME).toBe("application/x-openbuilder-fileref")
  })
})

describe("useFileRefInput 交互（@ 触发 → 防抖搜索 → 键盘选中 → 文本删除）", () => {
  function Harness() {
    const [text, setText] = useState("")
    const refInput = useFileRefInput({
      refKey: "s1",
      directory: "/repo",
      onRemoveAtToken: (start, end) => {
        setText((d) => d.slice(0, start) + d.slice(end))
      },
    })
    return (
      <div>
        <div data-testid="picker-slot">{refInput.picker}</div>
        <div data-testid="chips-slot">{refInput.chips}</div>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            refInput.onTextChange(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            if (refInput.onKeyDown(e)) e.preventDefault()
          }}
        />
        <span data-testid="text">{text}</span>
      </div>
    )
  }

  beforeEach(() => {
    vi.useFakeTimers()
    addFileRef.mockClear()
    searchFiles.mockClear()
    storeStub = {
      addFileRef,
      removeFileRef: vi.fn(),
      fileRefsFor: vi.fn(() => []),
      searchFiles,
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function typeAt(ta: HTMLTextAreaElement, value: string, caret?: number) {
    fireEvent.change(ta, { target: { value, selectionStart: caret ?? value.length } })
  }

  it("输入 @ 触发防抖搜索，Enter 选中：加引用 + 删 @词 文本", async () => {
    render(<Harness />)
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement
    // 防抖窗口内不出现结果
    typeAt(ta, "看下 @ma")
    expect(screen.queryByText("src/ma.ts")).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(screen.getByText("src/ma.ts")).toBeTruthy()
    // Enter 选中 → addFileRef + @ma 从文本移除
    fireEvent.keyDown(ta, { key: "Enter" })
    expect(addFileRef).toHaveBeenCalledWith("s1", {
      path: "src/ma.ts",
      absolute: "/repo/src/ma.ts",
      filename: "ma.ts",
      isDir: false,
    })
    expect(screen.getByTestId("text").textContent).toBe("看下 ")
    expect(screen.queryByText("src/ma.ts")).toBeNull()
  })

  it("非 @ 输入不触发浮层；Esc 关闭", async () => {
    render(<Harness />)
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement
    typeAt(ta, "普通文本")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(screen.queryByTestId("file-ref-picker")).toBeNull()
    expect(searchFiles).not.toHaveBeenCalled()

    typeAt(ta, "@que")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(screen.getByText("src/que.ts")).toBeTruthy()
    fireEvent.keyDown(ta, { key: "Escape" })
    expect(screen.queryByText("src/que.ts")).toBeNull()
  })

  it("浮层打开（加载中/空结果）Enter 被消费：不冒泡为发送", async () => {
    render(<Harness />)
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement
    typeAt(ta, "@x")
    // 尚在防抖窗口（浮层开、加载中）：Enter 消费且不选中
    const enterEv = createEvent.keyDown(ta, { key: "Enter" })
    fireEvent(ta, enterEv)
    expect(enterEv.defaultPrevented).toBe(true)
    expect(addFileRef).not.toHaveBeenCalled()
    // 空结果同理（搜索返回空）
    searchFiles.mockResolvedValueOnce([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(screen.getByText("无匹配文件")).toBeTruthy()
    const enter2 = createEvent.keyDown(ta, { key: "Enter" })
    fireEvent(ta, enter2)
    expect(enter2.defaultPrevented).toBe(true)
    expect(addFileRef).not.toHaveBeenCalled()
  })

  it("↑/↓ 循环移动选中项，Enter 选中当前项", async () => {
    searchFiles.mockResolvedValue(["a.ts", "b.ts", "c.ts"])
    render(<Harness />)
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement
    typeAt(ta, "@")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    const rows = screen.getAllByRole("button")
    expect(rows.length).toBe(3)
    expect(rows[0]!.className).toContain("selected")
    fireEvent.keyDown(ta, { key: "ArrowDown" })
    fireEvent.keyDown(ta, { key: "ArrowDown" })
    expect(rows[2]!.className).toContain("selected")
    fireEvent.keyDown(ta, { key: "Enter" })
    expect(addFileRef).toHaveBeenCalledWith("s1", expect.objectContaining({ path: "c.ts" }))
  })
})

describe("文件拖拽引用实时预览（design-file-reference §3.3 修订）", () => {
  const ref = { path: "src/a.ts", absolute: "/repo/src/a.ts", filename: "a.ts", isDir: false }
  const addFileRef = vi.fn()

  function Harness() {
    const refInput = useFileRefInput({ refKey: "s1", directory: "/repo", onRemoveAtToken: () => {} })
    return (
      <div data-testid="zone" {...refInput.dragProps}>
        <div data-testid="chips-slot">{refInput.chips}</div>
      </div>
    )
  }

  beforeEach(() => {
    addFileRef.mockClear()
    storeStub = { addFileRef, removeFileRef: vi.fn(), fileRefsFor: vi.fn(() => []) }
    setDraggingFileRef(ref)
  })
  afterEach(() => setDraggingFileRef(null))

  const dt = () => ({ types: [FILEREF_MIME], getData: () => JSON.stringify(ref) })

  it("dragover 即渲染末位占位 chip（所见即所得），drop 落位与预览一致", () => {
    render(<Harness />)
    const zone = screen.getByTestId("zone")
    fireEvent.dragOver(zone, { dataTransfer: dt() })
    const chip = screen.getByTestId("chips-slot").querySelector(".ref-chip")
    expect(chip?.className).toContain("pending")
    expect(chip?.textContent).toContain("src/a.ts")
    fireEvent.drop(zone, { dataTransfer: dt() })
    expect(addFileRef).toHaveBeenCalledWith("s1", ref)
    expect(screen.getByTestId("chips-slot").querySelector(".ref-chip")).toBeNull()
  })

  it("dragleave 清占位；已引用的 absolute 不出占位（提交将是 no-op）", () => {
    render(<Harness />)
    const zone = screen.getByTestId("zone")
    fireEvent.dragOver(zone, { dataTransfer: dt() })
    fireEvent.dragLeave(zone, { dataTransfer: dt() })
    expect(screen.getByTestId("chips-slot").querySelector(".ref-chip")).toBeNull()
    ;(storeStub.fileRefsFor as ReturnType<typeof vi.fn>).mockReturnValue([ref])
    fireEvent.dragOver(zone, { dataTransfer: dt() })
    // 不出"占位"chip（真实 chip 出现 = 引用已在条内，提交将是 no-op）
    expect(screen.getByTestId("chips-slot").querySelector(".ref-chip.pending")).toBeNull()
  })

  it("非自定义 MIME 的 dragover 不出占位", () => {
    render(<Harness />)
    const zone = screen.getByTestId("zone")
    fireEvent.dragOver(zone, { dataTransfer: { types: ["text/plain"], getData: () => "" } })
    expect(screen.getByTestId("chips-slot").querySelector(".ref-chip")).toBeNull()
  })
})
