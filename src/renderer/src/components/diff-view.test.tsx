/**
 * DiffView 渲染测试（design-diff-view §4）：加载/错误/空态/多 hunk 渲染/
 * 二进制空 hunk 兜底/文件块折叠。store 经 vi.mock 提供 diffData + loadDiffTab。
 * CodeMirror headless 高亮依赖 ResizeObserver（jsdom 缺失），补 stub。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DiffView } from "./diff-view"
import type { FileDiff } from "@shared/api-types"

const loadDiffTab = vi.fn()

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      loading: "加载中…",
      retry: "重试",
      diffEmpty: "无改动",
      diffHunkSegment: "第 {n} 段",
      diffNoTextDiff: "无文本差异或二进制文件",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({ diffData: dataStub, loadDiffTab }),
}))

let dataStub: Map<string, { files: FileDiff[]; error?: string; loading?: boolean }>

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

beforeEach(() => {
  cleanup()
  loadDiffTab.mockClear()
  dataStub = new Map()
})

const file = (patch: string, status: "added" | "deleted" | "modified" = "modified") => ({
  file: "src/a.ts",
  patch,
  additions: 1,
  deletions: 1,
  status,
})

const PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const x = 1\n-const y = 2\n+const y = 3\n+const z = 4\n"

describe("DiffView", () => {
  it("加载态（loading 且无旧数据）", () => {
    dataStub.set("diff\0round\0/repo", { files: [], loading: true })
    render(<DiffView tabKey={"diff\0round\0/repo"} type="round" directory="/repo" />)
    expect(screen.getByText("加载中…")).not.toBeNull()
  })

  it("错误态显示错误 + 重试按钮", () => {
    dataStub.set("diff\0uncommitted\0/repo", { files: [], error: "HTTP 500" })
    render(<DiffView tabKey={"diff\0uncommitted\0/repo"} type="uncommitted" directory="/repo" />)
    expect(screen.getByText("HTTP 500")).not.toBeNull()
    fireEvent.click(screen.getByText("重试"))
    expect(loadDiffTab).toHaveBeenCalledWith("uncommitted", "/repo")
  })

  it("空 diff 显示无改动", () => {
    dataStub.set("diff\0branch\0/repo", { files: [] })
    render(<DiffView tabKey={"diff\0branch\0/repo"} type="branch" directory="/repo" />)
    expect(screen.getByText("无改动")).not.toBeNull()
  })

  it("多 hunk 渲染：行号/marker/底色 class/统计", () => {
    dataStub.set("diff\0round\0/repo", { files: [file(PATCH)] })
    render(<DiffView tabKey={"diff\0round\0/repo"} type="round" directory="/repo" />)
    // 文件路径
    expect(screen.getByTitle("src/a.ts")).not.toBeNull()
    // 行：context(1/1)、removed(2/无)、added(无/2)、added(无/3)
    const rows = document.querySelectorAll(".diff-row")
    expect(rows.length).toBe(4)
    expect(rows[0].classList.contains("ctx")).toBe(true)
    expect(rows[1].classList.contains("del")).toBe(true)
    expect(rows[2].classList.contains("add")).toBe(true)
    expect(rows[3].classList.contains("add")).toBe(true)
    // 行号
    expect(rows[1].querySelector(".diff-no.old")?.textContent).toBe("2")
    expect(rows[2].querySelector(".diff-no.new")?.textContent).toBe("2")
    expect(rows[3].querySelector(".diff-no.new")?.textContent).toBe("3")
    // marker
    expect(rows[1].querySelector(".diff-marker")?.textContent).toBe("-")
    expect(rows[2].querySelector(".diff-marker")?.textContent).toBe("+")
    expect(rows[0].querySelector(".diff-marker")?.textContent).toBe("")
  })

  it("无 hunk（二进制）显示兜底文案", () => {
    dataStub.set("diff\0round\0/repo", { files: [file("Binary files differ\n")] })
    render(<DiffView tabKey={"diff\0round\0/repo"} type="round" directory="/repo" />)
    expect(screen.getByText("无文本差异或二进制文件")).not.toBeNull()
  })

  it("文件块折叠：点击头部收起行", () => {
    dataStub.set("diff\0round\0/repo", { files: [file(PATCH)] })
    render(<DiffView tabKey={"diff\0round\0/repo"} type="round" directory="/repo" />)
    expect(document.querySelectorAll(".diff-row").length).toBe(4)
    fireEvent.click(screen.getByTitle("src/a.ts"))
    expect(document.querySelectorAll(".diff-row").length).toBe(0)
    // 再次展开
    fireEvent.click(screen.getByTitle("src/a.ts"))
    expect(document.querySelectorAll(".diff-row").length).toBe(4)
  })

  it("激活即重拉（useEffect 调用 loadDiffTab）", () => {
    render(<DiffView tabKey={"diff\0round\0/repo"} type="round" directory="/repo" />)
    expect(loadDiffTab).toHaveBeenCalledWith("round", "/repo")
  })
})