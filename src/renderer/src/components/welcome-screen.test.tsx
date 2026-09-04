/**
 * 欢迎屏（design-welcome-screen）：入口分支/managed 扫描与启动链/attach 测试与
 * 填入/provider 引导/稍后配置。mock ../app 与 window.desktop（scan/剪贴板桩）。
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
      profileUrl: "服务器地址",
      profileUser: "用户名（可选）",
      profilePassword: "密码（可选）",
      testFailed: "连接失败",
      scanCandidatesTitle: "扫描到的 opencode",
      scanRescan: "重新扫描",
      scanRescanning: "扫描中…",
      welcomeTitle: "欢迎使用 OpenBuilder",
      welcomeSubtitle: "先连接一台 server 开始",
      welcomeManaged: "本机启动（managed）",
      welcomeRecommended: "推荐",
      welcomeManagedDesc: "自动发现本机 opencode 并启动 server",
      welcomeAttach: "连接已有 server（attach）",
      welcomeAttachDesc: "局域网发现或手动填写地址",
      welcomeLater: "稍后配置",
      welcomeManagedTitle: "本机启动",
      welcomeManagedProfileName: "本机 opencode",
      welcomeStartAndConnect: "启动并连接",
      welcomeConnecting: "连接中…",
      welcomeInstallHint: "未发现 opencode 二进制",
      welcomeUseAttach: "改用 attach",
      welcomeShowMore: "展开全部（{count}）",
      welcomeShowLess: "收起",
      welcomeAttachTitle: "连接 server",
      welcomeDiscoveredServers: "发现的服务器",
      welcomeNoServers: "未发现服务器",
      welcomeConnect: "连接",
      welcomeProviderTitle: "配置 Provider",
      welcomeProviderHint: "尚未配置 API key",
      welcomeGoProviders: "去配置 Provider",
      welcomeModelTitle: "设置默认模型",
      welcomeModelHint: "尚未设置默认模型",
      welcomeGoDefaults: "去设置默认模型",
      welcomeSkip: "跳过，进入主界面",
      welcomeConnectServer: "连接服务器",
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
    defaultsFor: () => ({}),
    getActiveClient: () => null,
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

describe("WelcomeScreen", () => {
  it("入口二选一 + 稍后配置关闭欢迎屏", async () => {
    render(<WelcomeScreen />)
    expect(screen.getByText("欢迎使用 OpenBuilder")).toBeTruthy()
    expect(screen.getByText("本机启动（managed）")).toBeTruthy()
    expect(screen.getByText("连接已有 server（attach）")).toBeTruthy()
    fireEvent.click(screen.getByText("稍后配置"))
    expect(storeState.current.closeWelcome).toHaveBeenCalled()
  })

  it("managed 分支：自动扫描显示路径+版本，启动并连接建档（managed profile + binaryPath）", async () => {
    render(<WelcomeScreen />)
    fireEvent.click(screen.getByText("本机启动（managed）"))
    await waitFor(() => expect(screen.getByText("/usr/bin/opencode")).toBeTruthy())
    expect(screen.getByText("1.18.20")).toBeTruthy()
    fireEvent.click(screen.getByText("启动并连接"))
    await waitFor(() =>
      expect(storeState.current.saveProfiles).toHaveBeenCalledWith(
        [
          {
            id: "welcome-managed",
            name: "本机 opencode",
            baseUrl: "",
            mode: "managed",
            binaryPath: "/usr/bin/opencode",
          },
        ],
        "welcome-managed",
      ),
    )
    expect(storeState.current.connect).toHaveBeenCalled()
  })

  it("managed 未发现：安装指引命令 + 复制按钮 + 改用 attach", async () => {
    scanBinaries.mockResolvedValue([])
    render(<WelcomeScreen />)
    fireEvent.click(screen.getByText("本机启动（managed）"))
    await waitFor(() => expect(screen.getByText(/未发现 opencode/)).toBeTruthy())
    expect(screen.getByText(/curl -fsSL https:\/\/opencode\.ai\/install/)).toBeTruthy()
    expect(screen.getAllByTitle("复制").length).toBe(3)
    expect(screen.getByText("重新扫描")).toBeTruthy()
    fireEvent.click(screen.getByText("改用 attach"))
    // 回到入口
    expect(screen.getByText("连接已有 server（attach）")).toBeTruthy()
  })

  it("attach 分支：扫描候选项一键填入 URL，连接前先 health 测试", async () => {
    const health = vi.fn(async () => ({ healthy: true, version: "1.0.0" }))
    storeState.current.getActiveClient = () => null
    render(<WelcomeScreen />)
    fireEvent.click(screen.getByText("连接已有 server（attach）"))
    await waitFor(() => expect(screen.getByText("http://127.0.0.1:4096")).toBeTruthy())
    fireEvent.click(screen.getByText("http://127.0.0.1:4096"))
    const urlInput = screen.getByLabelText("服务器地址") as HTMLInputElement
    expect(urlInput.value).toBe("http://127.0.0.1:4096")
    // health 走真实 RestClient——fetch 桩
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(health()), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    fireEvent.click(screen.getByText("连接"))
    await waitFor(() =>
      expect(storeState.current.saveProfiles).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            id: "welcome-attach",
            baseUrl: "http://127.0.0.1:4096",
            mode: "attach",
          }),
        ],
        "welcome-attach",
      ),
    )
    vi.unstubAllGlobals()
  })

  it("attach health 失败：错误展示、不建档", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }))
    vi.stubGlobal("fetch", fetchMock)
    render(<WelcomeScreen />)
    fireEvent.click(screen.getByText("连接已有 server（attach）"))
    await waitFor(() => expect(screen.getByLabelText("服务器地址")).toBeTruthy())
    fireEvent.change(screen.getByLabelText("服务器地址"), {
      target: { value: "http://127.0.0.1:4096" },
    })
    fireEvent.click(screen.getByText("连接"))
    await waitFor(() => expect(screen.getByText(/连接失败/)).toBeTruthy())
    expect(storeState.current.saveProfiles).not.toHaveBeenCalled()
  })

  it("connectWithProfile 固定 id upsert：重试不堆 profile", async () => {
    render(<WelcomeScreen />)
    fireEvent.click(screen.getByText("本机启动（managed）"))
    await waitFor(() => expect(screen.getByText("/usr/bin/opencode")).toBeTruthy())
    fireEvent.click(screen.getByText("启动并连接"))
    await waitFor(() => expect(storeState.current.saveProfiles).toHaveBeenCalledTimes(1))
    // 二次点击（重试）
    fireEvent.click(screen.getByText("启动并连接"))
    await waitFor(() => expect(storeState.current.saveProfiles).toHaveBeenCalledTimes(2))
    const lastCall = (storeState.current.saveProfiles as ReturnType<typeof vi.fn>).mock.calls.at(-1)
    expect(lastCall![0]).toHaveLength(1)
  })

  it("provider 引导：连接成功且无任何已配置 provider → 引导视图；跳过关闭欢迎屏", async () => {
    storeState.current.connectionState = "streaming"
    storeState.current.getActiveClient = () => ({
      listProviderCatalog: async () => ({ all: [], default: {}, connected: [] }),
    })
    render(<WelcomeScreen />)
    await waitFor(() => expect(screen.getByText("配置 Provider")).toBeTruthy())
    fireEvent.click(screen.getByText("去配置 Provider"))
    expect(storeState.current.openSettings).toHaveBeenCalledWith("providers")
    // 重新渲染引导视图（回跳过）
    fireEvent.click(screen.getByText("跳过，进入主界面"))
    expect(storeState.current.closeWelcome).toHaveBeenCalled()
  })

  it("有 provider 无默认模型 → 默认模型引导（openSettings defaults）", async () => {
    storeState.current.connectionState = "streaming"
    storeState.current.getActiveClient = () => ({
      listProviderCatalog: async () => ({
        all: [],
        default: {},
        connected: ["deepseek"],
      }),
    })
    storeState.current.defaultsFor = () => ({})
    render(<WelcomeScreen />)
    await waitFor(() => expect(screen.getByText("设置默认模型")).toBeTruthy())
    fireEvent.click(screen.getByText("去设置默认模型"))
    expect(storeState.current.openSettings).toHaveBeenCalledWith("defaults")
  })

  it("provider 与默认模型齐备：检查完成直接关闭欢迎屏（组件侧驱动）", async () => {
    storeState.current.connectionState = "streaming"
    storeState.current.getActiveClient = () => ({
      listProviderCatalog: async () => ({
        all: [],
        default: {},
        connected: ["deepseek"],
      }),
    })
    storeState.current.defaultsFor = () => ({ model: { providerID: "deepseek", modelID: "m" } })
    render(<WelcomeScreen />)
    await waitFor(() => expect(storeState.current.closeWelcome).toHaveBeenCalled())
    expect(screen.queryByText("配置 Provider")).toBeNull()
    expect(screen.queryByText("设置默认模型")).toBeNull()
  })

  it("检查失败静默关闭（不阻断进主界面）", async () => {
    storeState.current.connectionState = "streaming"
    storeState.current.getActiveClient = () => ({
      listProviderCatalog: async () => {
        throw new Error("boom")
      },
    })
    render(<WelcomeScreen />)
    await waitFor(() => expect(storeState.current.closeWelcome).toHaveBeenCalled())
  })

  it("无 client（异常态）：直接关闭", async () => {
    storeState.current.connectionState = "streaming"
    storeState.current.getActiveClient = () => null
    render(<WelcomeScreen />)
    await waitFor(() => expect(storeState.current.closeWelcome).toHaveBeenCalled())
  })
})
