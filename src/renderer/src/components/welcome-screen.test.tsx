/**
 * 欢迎屏（design-welcome-screen，2026-09-06 二次修订）：入口视图只呈现「添加
 * 服务器」；点击后复用设置弹窗引导式流程（DiscoverView 双扫描混排 + 手动配置
 * ProfileFormView），动作语义 = 建档 + 激活 + 连接；streaming 直接关闭（无
 * provider 引导）。mock ../app 与 window.desktop。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WelcomeScreen } from "./welcome-screen"

const scanBinaries = vi.fn(async () => [
  { path: "/usr/bin/opencode", version: "1.18.20" },
])
const scanServers = vi.fn(async () => [
  { url: "http://127.0.0.1:4096", version: "1.0.0", source: "loopback" as const },
])

/** 可变 store 桩（连接动作断言） */
const storeState: { current: Record<string, unknown> } = { current: {} }

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      back: "返回",
      cancel: "取消",
      save: "保存",
      copy: "复制",
      openSettings: "打开设置",
      profileMode: "模式",
      modeAttach: "连接现有服务",
      modeManaged: "本机启动",
      modeAttachDesc: "连接一个已在运行的 opencode server。",
      modeManagedDesc: "用本机的 opencode 自动启动一个 server。",
      profileName: "名称",
      profileUrl: "服务器地址",
      profileUser: "用户名（可选）",
      profilePassword: "密码（可选）",
      testConnection: "测试连接",
      testOk: "连接成功（{version}）",
      testFailed: "连接失败",
      profileBinaryPath: "二进制路径",
      profileBinaryPathHint: "留空 = 自动发现",
      browseBinary: "浏览…",
      managedCredsHint: "随机端口 + 自动凭据",
      scanCandidatesTitle: "扫描到的 opencode",
      scanRescan: "重新扫描",
      scanRescanning: "扫描中…",
      scanNone: "未发现候选",
      welcomeTitle: "欢迎使用 OpenBuilder",
      welcomeSubtitle: "先连接一台 server 开始",
      welcomeStartAndConnect: "启动并连接",
      welcomeConnecting: "连接中…",
      welcomeInstallHint: "未发现 server 与本机 opencode",
      welcomeConnect: "连接",
      addProfileTitle: "添加服务器",
      addProfileManualTitle: "手动配置服务器",
      discoverServersTitle: "发现的服务器",
      discoverBinariesTitle: "本机 opencode",
      discoverScanning: "正在搜索…",
      discoverNoResult: "未发现可连接目标",
      discoverSourceLoopback: "本机",
      discoverSourceMdns: "局域网",
      discoverRescan: "重新搜索",
      discoverManualEntry: "手动配置…",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeState.current,
}))

beforeEach(() => {
  scanBinaries.mockClear()
  scanServers.mockClear()
  scanBinaries.mockResolvedValue([{ path: "/usr/bin/opencode", version: "1.18.20" }])
  scanServers.mockResolvedValue([
    { url: "http://127.0.0.1:4096", version: "1.0.0", source: "loopback" },
  ])
  storeState.current = {
    connectionState: "disconnected",
    connectionError: null,
    profiles: [],
    closeWelcome: vi.fn(),
    openSettings: vi.fn(),
    saveProfiles: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
  }
  Object.defineProperty(window, "desktop", {
    configurable: true,
    get: () => ({ scanBinaries, scanServers }),
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** 入口 → 发现视图（返回发现视图渲染完成的 waitFor） */
async function enterDiscover() {
  render(<WelcomeScreen />)
  fireEvent.click(screen.getByRole("button", { name: "添加服务器" }))
  await waitFor(() => expect(screen.getByText("发现的服务器")).toBeTruthy())
}

describe("WelcomeScreen", () => {
  it("入口视图：标题/副标题 + 唯一「添加服务器」入口 + 打开设置；未进入流程不扫描", () => {
    render(<WelcomeScreen />)
    expect(screen.getByText("欢迎使用 OpenBuilder")).toBeTruthy()
    expect(screen.getByRole("button", { name: "添加服务器" })).toBeTruthy()
    expect(screen.queryByText("手动配置…")).toBeNull()
    expect(scanServers).not.toHaveBeenCalled()
    expect(scanBinaries).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("打开设置"))
    expect(storeState.current.openSettings).toHaveBeenCalledWith()
  })

  it("点击「添加服务器」进发现视图：双扫描并行启动，server 与 binary 候选混排", async () => {
    await enterDiscover()
    expect(scanServers).toHaveBeenCalledTimes(1)
    expect(scanBinaries).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByText("http://127.0.0.1:4096")).toBeTruthy())
    expect(screen.getByText("本机")).toBeTruthy() // 来源徽标
    expect(screen.getByText("/usr/bin/opencode")).toBeTruthy()
    expect(screen.getByText("1.18.20")).toBeTruthy()
  })

  it("发现视图返回：回入口页", async () => {
    await enterDiscover()
    fireEvent.click(screen.getByTitle("返回"))
    expect(screen.getByText("欢迎使用 OpenBuilder")).toBeTruthy()
    expect(screen.queryByText("发现的服务器")).toBeNull()
  })

  it("点击 server 候选：先 health 验证（带草稿凭据），通过后建 attach profile（固定 id）并连接", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ healthy: true, version: "1.0.0" }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await enterDiscover()
    await waitFor(() => expect(screen.getByText("http://127.0.0.1:4096")).toBeTruthy())
    fireEvent.click(screen.getByText("http://127.0.0.1:4096"))
    await waitFor(() =>
      expect(storeState.current.saveProfiles).toHaveBeenCalledWith(
        [
          {
            id: "welcome-attach",
            name: "http://127.0.0.1:4096",
            baseUrl: "http://127.0.0.1:4096",
            mode: "attach",
          },
        ],
        "welcome-attach",
      ),
    )
    expect(storeState.current.connect).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("attach health 失败：错误展示、不建档不连接", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }))
    vi.stubGlobal("fetch", fetchMock)
    await enterDiscover()
    await waitFor(() => expect(screen.getByText("http://127.0.0.1:4096")).toBeTruthy())
    fireEvent.click(screen.getByText("http://127.0.0.1:4096"))
    await waitFor(() => expect(screen.getByText(/连接失败/)).toBeTruthy())
    expect(storeState.current.saveProfiles).not.toHaveBeenCalled()
    expect(storeState.current.connect).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("点击 binary 候选：建 managed profile（binaryPath，空名）并连接；固定 id 重试不堆 profile", async () => {
    await enterDiscover()
    await waitFor(() => expect(screen.getByText("/usr/bin/opencode")).toBeTruthy())
    fireEvent.click(screen.getByText("/usr/bin/opencode"))
    await waitFor(() =>
      expect(storeState.current.saveProfiles).toHaveBeenCalledWith(
        [
          {
            id: "welcome-managed",
            name: "",
            baseUrl: "",
            mode: "managed",
            binaryPath: "/usr/bin/opencode",
          },
        ],
        "welcome-managed",
      ),
    )
    expect(storeState.current.connect).toHaveBeenCalled()
    fireEvent.click(screen.getByText("/usr/bin/opencode"))
    await waitFor(() => expect(storeState.current.saveProfiles).toHaveBeenCalledTimes(2))
    const lastCall = (storeState.current.saveProfiles as ReturnType<typeof vi.fn>).mock.calls.at(-1)
    expect(lastCall![0]).toHaveLength(1)
  })

  it("双路皆空：安装指引命令 + 复制按钮；手动配置入口常驻", async () => {
    scanBinaries.mockResolvedValue([])
    scanServers.mockResolvedValue([])
    await enterDiscover()
    await waitFor(() => expect(screen.getByText(/未发现 server 与本机 opencode/)).toBeTruthy())
    expect(screen.queryByText("未发现可连接目标")).toBeNull() // emptyContent 覆盖默认空态
    expect(screen.getByText(/curl -fsSL https:\/\/opencode\.ai\/install/)).toBeTruthy()
    expect(screen.getAllByTitle("复制").length).toBe(3)
    expect(screen.getByText("手动配置…")).toBeTruthy()
    expect(screen.getByText("重新搜索")).toBeTruthy()
  })

  it("重新搜索：双扫描再次触发", async () => {
    await enterDiscover()
    await waitFor(() => expect(screen.getByText("/usr/bin/opencode")).toBeTruthy())
    fireEvent.click(screen.getByText("重新搜索"))
    await waitFor(() => expect(scanServers).toHaveBeenCalledTimes(2))
    expect(scanBinaries).toHaveBeenCalledTimes(2)
  })

  it("手动配置页：URL 草稿默认值 + 「连接」主按钮先 health 再建档（固定 id）+ 连接；返回发现视图", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ healthy: true, version: "1.0.0" }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await enterDiscover()
    fireEvent.click(screen.getByText("手动配置…"))
    expect(screen.getByText("手动配置服务器")).toBeTruthy()
    const urlInput = screen.getByLabelText("服务器地址") as HTMLInputElement
    expect(urlInput.value).toBe("http://127.0.0.1:4096") // 草稿默认值
    fireEvent.change(urlInput, { target: { value: "http://10.0.0.5:4096" } })
    fireEvent.click(screen.getByText("连接"))
    await waitFor(() =>
      expect(storeState.current.saveProfiles).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            id: "welcome-attach",
            baseUrl: "http://10.0.0.5:4096",
            mode: "attach",
          }),
        ],
        "welcome-attach",
      ),
    )
    expect(storeState.current.connect).toHaveBeenCalled()
    fireEvent.click(screen.getByTitle("返回"))
    await waitFor(() => expect(screen.getByText("发现的服务器")).toBeTruthy())
    vi.unstubAllGlobals()
  })

  it("手动配置切 managed 段：URL/凭据隐藏、主按钮文案切换", async () => {
    await enterDiscover()
    fireEvent.click(screen.getByText("手动配置…"))
    fireEvent.click(screen.getByText("本机启动"))
    expect(screen.queryByLabelText("服务器地址")).toBeNull()
    expect(screen.getByText("二进制路径")).toBeTruthy()
    expect(screen.getByText("启动并连接")).toBeTruthy()
  })

  it("连接成功（streaming）：组件侧直接 closeWelcome（无 provider 引导）", async () => {
    storeState.current.connectionState = "streaming"
    render(<WelcomeScreen />)
    await waitFor(() => expect(storeState.current.closeWelcome).toHaveBeenCalled())
    expect(screen.queryByText("配置 Provider")).toBeNull()
    expect(screen.queryByText("设置默认模型")).toBeNull()
  })

  it("connecting 态：候选与手动入口禁用 + 连接中提示（防重复触发）", async () => {
    storeState.current.connectionState = "connecting"
    await enterDiscover()
    await waitFor(() => expect(screen.getByText("连接中…")).toBeTruthy())
    const binaryBtn = screen.getByText("/usr/bin/opencode").closest("button")
    expect(binaryBtn?.disabled).toBe(true)
    expect((screen.getByText("手动配置…") as HTMLButtonElement).disabled).toBe(true)
  })

  it("连接失败：connectionError 展示在卡片内，候选可再点（重试）", async () => {
    storeState.current.connectionError = "managed 启动失败"
    await enterDiscover()
    await waitFor(() => expect(screen.getByText("managed 启动失败")).toBeTruthy())
    const binaryBtn = screen.getByText("/usr/bin/opencode").closest("button")
    expect(binaryBtn?.disabled).toBe(false)
  })
})
