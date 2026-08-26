/**
 * DiffView 渲染测试（design-diff-view §4）：segment 切换、加载/错误/空态、
 * 多 hunk 渲染、二进制空 hunk 兜底、文件块折叠、hunk 级折叠、工具条全部折叠/
 * 展开（含手动开文件的中间态）。store 经 vi.mock 提供
 * diffData + diffTypeFor/switchDiffType/loadDiffTab/visibleSessions。
 * CodeMirror headless 高亮依赖 ResizeObserver（jsdom 缺失），补 stub。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { DiffView } from "./diff-view"
import type { DiffTabType } from "../store/app-store"
import type { Session, FileDiff } from "@shared/api-types"
import { ResizeObserverStub } from "./resize-observer-stub"

const loadDiffTab = vi.fn()
const switchDiffType = vi.fn()

/** 当前选中来源（测试按用例设置，模拟 store.diffSelectedTypes） */
let selType: DiffTabType
let visibleSessions: Session[]

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      loading: "加载中…",
      retry: "重试",
      diffTitle: "改动",
      diffRound: "上一轮",
      diffUncommitted: "未提交",
      diffBranch: "分支",
      diffRoundNoSession: "当前作用域暂无会话",
      diffEmpty: "无改动",
      diffHunkSegment: "第 {n} 段",
      diffNoTextDiff: "无文本差异或二进制文件",
      diffCollapseAll: "全部折叠",
      diffExpandAll: "全部展开",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({
    diffData: dataStub,
    loadDiffTab,
    switchDiffType,
    diffTypeFor: () => selType,
    visibleSessions,
  }),
}))

let dataStub: Map<string, { files: FileDiff[]; error?: string; loading?: boolean }>

beforeAll(() => {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
})

afterAll(() => {
  cleanup()
})

beforeEach(() => {
  cleanup()
  loadDiffTab.mockClear()
  switchDiffType.mockClear()
  dataStub = new Map()
  selType = "uncommitted"
  visibleSessions = []
})

const file = (
  patch: string,
  status: "added" | "deleted" | "modified" = "modified",
  path = "src/a.ts",
) => ({
  file: path,
  patch,
  additions: 1,
  deletions: 1,
  status,
})

const PATCH =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const x = 1\n-const y = 2\n+const y = 3\n+const z = 4\n"

const TAB_KEY = "diff\0/repo"

describe("DiffView", () => {
  it("segment 常驻：三来源按钮，选中态跟随 store", () => {
    dataStub.set("diff\0uncommitted\0/repo", { files: [] })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(screen.getByText("上一轮")).not.toBeNull()
    expect(screen.getByText("未提交")).not.toBeNull()
    expect(screen.getByText("分支")).not.toBeNull()
    expect(screen.getByText("未提交").classList.contains("active")).toBe(true)
    expect(screen.getByText("上一轮").classList.contains("active")).toBe(false)
  })

  it("点击 segment 调用 switchDiffType", () => {
    dataStub.set("diff\0uncommitted\0/repo", { files: [] })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    fireEvent.click(screen.getByText("分支"))
    expect(switchDiffType).toHaveBeenCalledWith(TAB_KEY, "branch")
  })

  it("加载态（loading 且无旧数据）", () => {
    selType = "round"
    dataStub.set("diff\0round\0/repo", { files: [], loading: true })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(screen.getByText("加载中…")).not.toBeNull()
  })

  it("错误态显示错误 + 重试按钮", () => {
    dataStub.set("diff\0uncommitted\0/repo", { files: [], error: "HTTP 500" })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(screen.getByText("HTTP 500")).not.toBeNull()
    fireEvent.click(screen.getByText("重试"))
    expect(loadDiffTab).toHaveBeenCalledWith("uncommitted", "/repo")
  })

  it("空 diff 显示无改动", () => {
    selType = "branch"
    dataStub.set("diff\0branch\0/repo", { files: [] })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(screen.getByText("无改动")).not.toBeNull()
  })

  it("round 空态且无会话：显示无会话文案", () => {
    selType = "round"
    dataStub.set("diff\0round\0/repo", { files: [] })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(screen.getByText("当前作用域暂无会话")).not.toBeNull()
  })

  it("多 hunk 渲染：行号/marker/底色 class/统计", () => {
    selType = "round"
    dataStub.set("diff\0round\0/repo", { files: [file(PATCH)] })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
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
    selType = "round"
    dataStub.set("diff\0round\0/repo", { files: [file("Binary files differ\n")] })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(screen.getByText("无文本差异或二进制文件")).not.toBeNull()
  })

  it("文件块折叠：点击头部收起行", () => {
    selType = "round"
    dataStub.set("diff\0round\0/repo", { files: [file(PATCH)] })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(document.querySelectorAll(".diff-row").length).toBe(4)
    fireEvent.click(screen.getByTitle("src/a.ts"))
    expect(document.querySelectorAll(".diff-row").length).toBe(0)
    // 再次展开
    fireEvent.click(screen.getByTitle("src/a.ts"))
    expect(document.querySelectorAll(".diff-row").length).toBe(4)
  })

  it("hunk 折叠：点击 hunk 头收起本段行，再点展开", () => {
    selType = "round"
    dataStub.set("diff\0round\0/repo", { files: [file(PATCH)] })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(document.querySelectorAll(".diff-row").length).toBe(4)
    fireEvent.click(screen.getByText("第 1 段"))
    // 行收起、hunk 头保留
    expect(document.querySelectorAll(".diff-row").length).toBe(0)
    expect(document.querySelectorAll(".diff-hunk-header").length).toBe(1)
    fireEvent.click(screen.getByText("第 1 段"))
    expect(document.querySelectorAll(".diff-row").length).toBe(4)
  })

  it("全部折叠/展开：文件块与 hunk 一并切换；手动打开的文件内 hunk 仍为收起", () => {
    selType = "round"
    dataStub.set("diff\0round\0/repo", {
      files: [file(PATCH), file(PATCH, "added", "src/b.ts")],
    })
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(document.querySelectorAll(".diff-row").length).toBe(8)
    const foldBtn = screen.getByText("全部折叠")
    // 全部折叠：文件块收起 → 无 hunk 头、无行
    fireEvent.click(foldBtn)
    expect(document.querySelectorAll(".diff-hunk-header").length).toBe(0)
    expect(document.querySelectorAll(".diff-row").length).toBe(0)
    expect(screen.queryByText("全部折叠")).toBeNull()
    expect(screen.getByText("全部展开")).not.toBeNull()
    // 手动打开文件：文件块展开但 hunk 仍是全局收起意图 → 有头无行
    fireEvent.click(screen.getByTitle("src/a.ts"))
    expect(document.querySelectorAll(".diff-hunk-header").length).toBe(1)
    expect(document.querySelectorAll(".diff-row").length).toBe(0)
    // 全部展开：行恢复
    fireEvent.click(screen.getByText("全部展开"))
    expect(document.querySelectorAll(".diff-row").length).toBe(8)
    expect(screen.getByText("全部折叠")).not.toBeNull()
  })

  it("激活即重拉当前选中来源（useEffect 调用 loadDiffTab）", () => {
    selType = "round"
    render(<DiffView tabKey={TAB_KEY} directory="/repo" />)
    expect(loadDiffTab).toHaveBeenCalledWith("round", "/repo")
  })
})
