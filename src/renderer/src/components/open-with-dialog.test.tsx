/**
 * 「打开方式」选择器（design-linux-open-with §1.3）：枚举/空态/键盘导航/选择回调。
 * mock desktop.shellListOpenWithApps；onLaunch/onClose 为直接注入的 mock。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OpenWithDialog } from "./open-with-dialog"

const listApps = vi.fn(async () => [
  { id: "a.desktop", name: "Alpha 编辑器", icon: "data:image/png;base64,AAAA", matches: true },
  { id: "b.desktop", name: "Beta", icon: null, matches: true },
  { id: "d.desktop", name: "Delta 查看器", icon: null, matches: false },
  { id: "c.desktop", name: "Gamma", icon: null, matches: false },
])
const onLaunch = vi.fn()
const onClose = vi.fn()

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      fileOpenWith: "打开方式…",
      openWithLoading: "正在枚举应用…",
      openWithEmpty: "无匹配的应用",
      openWithSearch: "搜索应用…",
      openWithMatched: "推荐应用",
      openWithOther: "其他应用",
      openWithNoResult: "无匹配结果",
    },
    locale: "zh" as const,
  }),
}))

beforeEach(() => {
  listApps.mockClear()
  onLaunch.mockClear()
  onClose.mockClear()
  listApps.mockResolvedValue([
    { id: "a.desktop", name: "Alpha 编辑器", icon: "data:image/png;base64,AAAA", matches: true },
    { id: "b.desktop", name: "Beta", icon: null, matches: true },
    { id: "d.desktop", name: "Delta 查看器", icon: null, matches: false },
    { id: "c.desktop", name: "Gamma", icon: null, matches: false },
  ])
  Object.defineProperty(window, "desktop", {
    configurable: true,
    get: () => ({ shellListOpenWithApps: listApps }),
  })
})

afterEach(cleanup)

describe("OpenWithDialog", () => {
  it("枚举落地列出应用；点击行 → onLaunch + 关闭", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    expect(await screen.findByText("Alpha 编辑器")).toBeTruthy()
    fireEvent.click(screen.getByText("Beta"))
    expect(onLaunch).toHaveBeenCalledWith("b.desktop")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("加载中/空态呈现", async () => {
    listApps.mockResolvedValue([])
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    expect(screen.getByText("正在枚举应用…")).toBeTruthy()
    expect(await screen.findByText("无匹配的应用")).toBeTruthy()
    // 空态 Enter 不启动
    fireEvent.keyDown(document.querySelector(".open-with-dialog")!, { key: "Enter" })
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it("全量列表分段：匹配组在前（推荐应用）、其他组在后，组标题正确", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Alpha 编辑器")
    const groups = () => Array.from(document.querySelectorAll(".open-with-group")).map((g) => g.textContent)
    expect(groups()).toEqual(["推荐应用", "其他应用"])
    // 行序：匹配组（Alpha/Beta）→ 其他组（Delta/Gamma；main 侧已按字母序排）
    const names = () =>
      Array.from(document.querySelectorAll(".open-with-row .open-with-name")).map((n) => n.textContent)
    expect(names()).toEqual(["Alpha 编辑器", "Beta", "Delta 查看器", "Gamma"])
  })

  it("搜索：名称大小写不敏感子串过滤，跨段保留分组次序；清空恢复全量", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Alpha 编辑器")
    const input = screen.getByPlaceholderText("搜索应用…") as HTMLInputElement
    // 大写查询命中小写名（大小写不敏感）；只匹配其他组的 Delta
    fireEvent.change(input, { target: { value: "DELTA" } })
    expect(screen.queryByText("Alpha 编辑器")).toBeNull()
    expect(screen.getByText("Delta 查看器")).toBeTruthy()
    // 无结果态
    fireEvent.change(input, { target: { value: "zzz" } })
    expect(screen.getByText("无匹配结果")).toBeTruthy()
    // 清空恢复
    fireEvent.change(input, { target: { value: "" } })
    expect(screen.getByText("Alpha 编辑器")).toBeTruthy()
  })

  it("搜索后键盘导航在过滤列表内循环；Esc 有内容先清空", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Alpha 编辑器")
    const input = screen.getByPlaceholderText("搜索应用…") as HTMLInputElement
    fireEvent.change(input, { target: { value: "ta" } }) // Beta/Delta 含 ta
    const dialog = document.querySelector(".open-with-dialog") as HTMLElement
    const rows = () => Array.from(dialog.querySelectorAll<HTMLButtonElement>(".open-with-row"))
    expect(rows().length).toBe(2)
    fireEvent.keyDown(dialog, { key: "ArrowDown" })
    fireEvent.keyDown(dialog, { key: "ArrowDown" })
    expect(rows()[0]!.className).toContain("selected") // 循环回首
    fireEvent.keyDown(dialog, { key: "Enter" })
    expect(onLaunch).toHaveBeenCalledWith("b.desktop") // 过滤列表内 Enter 启动当前项
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Esc 有内容先清空（不关闭），再按关闭", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Alpha 编辑器")
    const input = screen.getByPlaceholderText("搜索应用…") as HTMLInputElement
    fireEvent.change(input, { target: { value: "x" } })
    const dialog = document.querySelector(".open-with-dialog") as HTMLElement
    fireEvent.keyDown(dialog, { key: "Escape" }) // 有内容 → 清空不关闭
    await waitFor(() => expect(input.value).toBe(""))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog, { key: "Escape" }) // 再 Esc → 关闭
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("键盘 ↑↓ 循环 + Enter 启动当前项；Esc 关闭", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Alpha 编辑器")
    const dialog = document.querySelector(".open-with-dialog") as HTMLElement
    const rows = () => Array.from(dialog.querySelectorAll<HTMLButtonElement>(".open-with-row"))
    expect(rows()[0]!.className).toContain("selected")
    fireEvent.keyDown(dialog, { key: "ArrowDown" })
    fireEvent.keyDown(dialog, { key: "ArrowDown" })
    expect(rows()[2]!.className).toContain("selected")
    fireEvent.keyDown(dialog, { key: "Enter" })
    expect(onLaunch).toHaveBeenCalledWith("d.desktop")
    expect(onClose).toHaveBeenCalledTimes(1)
    // 越界循环：末项 ↓ 回首项
    expect(rows()[0]!.className).not.toContain("selected")
  })

  it("打开即聚焦搜索框：输入即过滤、键盘事件第一刻可达", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Alpha 编辑器")
    const input = screen.getByPlaceholderText("搜索应用…") as HTMLInputElement
    expect(document.activeElement).toBe(input)
    // 焦点在搜索框上直接 Esc（无内容）→ 关闭
    fireEvent.keyDown(document.querySelector(".open-with-dialog")!, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("点击遮罩关闭（不启动）", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Beta")
    fireEvent.click(document.querySelector(".dialog-mask")!)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it("标题行关闭按钮（对齐打开项目弹窗）点击关闭（不启动）", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Alpha 编辑器")
    fireEvent.click(document.querySelector(".dialog-title-row .icon-btn")!)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it("应用图标：有 icon 渲染 img，无 icon 回退首字母瓷片（2026-08-31）", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Alpha 编辑器")
    const img = document.querySelector<HTMLImageElement>(".open-with-icon")
    expect(img?.src).toBe("data:image/png;base64,AAAA")
    // Beta 无 icon → 首字母瓷片（B）
    const rowB = screen.getByText("Beta").closest(".open-with-row") as HTMLElement
    expect(rowB.querySelector(".open-with-icon")).toBeNull()
    expect(rowB.querySelector(".open-with-avatar")?.textContent).toBe("B")
  })

  it("枚举失败容错（reject → 空列表按空态呈现）", async () => {
    listApps.mockRejectedValue(new Error("boom"))
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText("无匹配的应用")).toBeTruthy())
  })
})
