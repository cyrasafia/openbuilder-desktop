/**
 * Linux 自定义头部：三个窗口控制按钮 + 最大化/还原图标切换。
 * mock useI18n 与 window.desktop（winIsMaximized/onWindowMaximized）。
 */
import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TitleBar } from "./title-bar"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      appTitle: "openbuilder desktop",
      winMinimize: "最小化",
      winMaximize: "最大化",
      winRestore: "还原",
      winClose: "关闭",
    },
    locale: "zh" as const,
  }),
}))

const winToggleMaximize = vi.fn()
const unbind = vi.fn()
let stateCb: ((maximized: boolean) => void) | null = null

beforeEach(() => {
  stateCb = null
  winToggleMaximize.mockClear()
  window.desktop = {
    platform: "linux",
    winMinimize: vi.fn(),
    winToggleMaximize,
    winClose: vi.fn(),
    winIsMaximized: vi.fn().mockResolvedValue(false),
    onWindowMaximized: (cb: (maximized: boolean) => void) => {
      stateCb = cb
      return unbind
    },
  } as unknown as typeof window.desktop
})

describe("TitleBar", () => {
  it("渲染最小化/最大化/关闭三个控制按钮，点击走 IPC", async () => {
    render(<TitleBar />)
    const min = await screen.findByTitle("最小化")
    min.click()
    expect(window.desktop.winMinimize).toHaveBeenCalled()
    screen.getByTitle("最大化").click()
    expect(winToggleMaximize).toHaveBeenCalled()
    screen.getByTitle("关闭").click()
    expect(window.desktop.winClose).toHaveBeenCalled()
  })

  it("最大化状态推送后按钮切换为还原图标", async () => {
    render(<TitleBar />)
    await waitFor(() => expect(stateCb).not.toBeNull())
    stateCb?.(true)
    expect(await screen.findByTitle("还原")).toBeTruthy()
  })

  it("挂载时以快照初始化：已最大化则直接显示还原", async () => {
    vi.mocked(window.desktop.winIsMaximized).mockResolvedValue(true)
    render(<TitleBar />)
    expect(await screen.findByTitle("还原")).toBeTruthy()
  })
})
