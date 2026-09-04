/**
 * profile 表单按模式分化（design-managed-config §1）：managed 隐藏 URL/凭据、
 * 显示二进制路径与扫描候选；attach 字段齐全。mock desktop.scanBinaries。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SettingsDialog } from "./settings-dialog"

const scanBinaries = vi.fn(async () => [
  { path: "/usr/bin/opencode", version: "1.18.20" },
  { path: "/home/t/.opencode/bin/opencode", version: null },
])
const openBinaryPicker = vi.fn(async (): Promise<string | null> => null)

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      settings: "设置",
      connectionTitle: "服务器连接",
      appearanceTitle: "外观",
      defaultsTitle: "默认",
      close: "关闭",
      back: "返回",
      cancel: "取消",
      save: "保存",
      addProfile: "添加",
      addProfileTitle: "添加服务器",
      editProfileTitle: "编辑服务器",
      editProfile: "编辑",
      removeProfile: "删除",
      activateProfile: "启用",
      activeProfile: "当前使用",
      profileName: "名称",
      profileUrl: "服务器地址",
      profileUser: "用户名（可选）",
      profilePassword: "密码（可选）",
      profileMode: "模式",
      modeAttach: "attach（连接现有服务）",
      modeManaged: "managed（本机启动）",
      testConnection: "测试连接",
      testOk: "连接正常（版本 {version}）",
      testFailed: "连接失败",
      profileBinaryPath: "二进制路径",
      profileBinaryPathHint: "留空 = 自动发现",
      browseBinary: "浏览…",
      scanCandidatesTitle: "扫描到的 opencode",
      scanRescan: "重新扫描",
      scanRescanning: "扫描中…",
      scanNone: "未发现 opencode",
      managedCredsHint: "随机端口 + 自动凭据",
      serverLogTitle: "服务器日志",
      serverLogEmpty: "暂无日志",
      serverLogCopy: "复制日志",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({
    profiles: [],
    activeProfileId: null,
    activeProfile: null,
    closeSettings: vi.fn(),
    saveProfiles: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
    serverVersionWarning: null,
    managedNotice: null,
    managedLogLines: [],
  }),
}))

beforeEach(() => {
  scanBinaries.mockClear()
  openBinaryPicker.mockClear()
  Object.defineProperty(window, "desktop", {
    configurable: true,
    get: () => ({ scanBinaries, openBinaryPicker }),
  })
})

afterEach(cleanup)

describe("ProfileFormView 模式分化", () => {
  it("managed 模式：隐藏 URL/凭据，显示二进制路径 + 扫描候选，点击候选填入", async () => {
    render(
      <SettingsDialog />,
    )
    // 打开"添加服务器"表单
    fireEvent.click(screen.getByText("添加"))
    // 切到 managed
    fireEvent.change(screen.getByDisplayValue("attach（连接现有服务）"), {
      target: { value: "managed" },
    })
    // URL/凭据字段消失
    expect(screen.queryByLabelText("服务器地址")).toBeNull()
    expect(screen.queryByLabelText("用户名（可选）")).toBeNull()
    expect(screen.queryByLabelText("密码（可选）")).toBeNull()
    // 二进制路径 + 候选出现
    expect(screen.getByLabelText("二进制路径")).toBeTruthy()
    expect(await screen.findByText("/usr/bin/opencode")).toBeTruthy()
    // 点击候选填入
    fireEvent.click(screen.getByText("/usr/bin/opencode"))
    const input = screen.getByLabelText("二进制路径") as HTMLInputElement
    expect(input.value).toBe("/usr/bin/opencode")
  })

  it("attach 模式：URL/凭据字段齐全，无二进制路径，不触发扫描", async () => {
    render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    expect(screen.getByLabelText("服务器地址")).toBeTruthy()
    expect(screen.getByLabelText("用户名（可选）")).toBeTruthy()
    expect(screen.getByLabelText("密码（可选）")).toBeTruthy()
    expect(screen.queryByLabelText("二进制路径")).toBeNull()
    expect(scanBinaries).not.toHaveBeenCalled()
  })

  it("浏览按钮选择路径填入", async () => {
    openBinaryPicker.mockResolvedValue("/picked/opencode")
    render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    fireEvent.change(screen.getByDisplayValue("attach（连接现有服务）"), {
      target: { value: "managed" },
    })
    fireEvent.click(screen.getByText("浏览…"))
    await waitFor(() => {
      expect((screen.getByLabelText("二进制路径") as HTMLInputElement).value).toBe("/picked/opencode")
    })
  })
})
