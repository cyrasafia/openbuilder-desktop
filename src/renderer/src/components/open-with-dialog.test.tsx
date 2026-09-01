/**
 * 「打开方式」选择器（design-linux-open-with §1.3）：枚举/空态/键盘导航/选择回调。
 * mock desktop.shellListOpenWithApps；onLaunch/onClose 为直接注入的 mock。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OpenWithDialog } from "./open-with-dialog"

const listApps = vi.fn(async () => [
  { id: "a.desktop", name: "Alpha 编辑器", icon: "data:image/png;base64,AAAA" },
  { id: "b.desktop", name: "Beta", icon: null },
  { id: "c.desktop", name: "Gamma", icon: null },
])
const onLaunch = vi.fn()
const onClose = vi.fn()

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      fileOpenWith: "打开方式…",
      openWithLoading: "正在枚举应用…",
      openWithEmpty: "无支持该类型的应用",
    },
    locale: "zh" as const,
  }),
}))

beforeEach(() => {
  listApps.mockClear()
  onLaunch.mockClear()
  onClose.mockClear()
  listApps.mockResolvedValue([
    { id: "a.desktop", name: "Alpha 编辑器", icon: "data:image/png;base64,AAAA" },
    { id: "b.desktop", name: "Beta", icon: null },
    { id: "c.desktop", name: "Gamma", icon: null },
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
    expect(await screen.findByText("无支持该类型的应用")).toBeTruthy()
    // 空态 Enter 不启动
    fireEvent.keyDown(document.querySelector(".open-with-dialog")!, { key: "Enter" })
    expect(onLaunch).not.toHaveBeenCalled()
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
    expect(onLaunch).toHaveBeenCalledWith("c.desktop")
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("打开即聚焦列表容器：键盘事件第一刻可达（评审 M2 回归）", async () => {
    render(<OpenWithDialog path="/repo/a.json" onLaunch={onLaunch} onClose={onClose} />)
    await screen.findByText("Alpha 编辑器")
    const body = document.querySelector(".open-with-dialog .dialog-body") as HTMLElement
    expect(document.activeElement).toBe(body)
    // 焦点在容器上直接 Esc（不点任何行）
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
    await waitFor(() => expect(screen.getByText("无支持该类型的应用")).toBeTruthy())
  })
})
