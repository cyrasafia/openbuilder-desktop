/**
 * 添加服务器引导式（design-guided-add-server）：点「添加」先搜索（servers +
 * binaries 并行、先到先列），候选一键建档；手动入口进 manual 表单。
 * manual 表单按模式分化（design-managed-config §1）：模式段置顶（segment），
 * managed 隐藏 URL/凭据、显示二进制路径与扫描候选；attach 字段齐全。
 * Provider 页签（design-provider-config）：已连接组/搜索/设删 key（ops 注入）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderKeyForm, ProviderSettings, SettingsDialog, type ProviderOps } from "./settings-dialog"
import type { ProviderCatalog, ProviderInfo } from "@shared/api-types"

const scanBinaries = vi.fn(async () => [
  { path: "/usr/bin/opencode", version: "1.18.20" },
  { path: "/home/t/.opencode/bin/opencode", version: null },
])
const scanServers = vi.fn(async () => [
  { url: "http://127.0.0.1:4096", version: "1.0.0", source: "loopback" as const },
])
const openBinaryPicker = vi.fn(async (): Promise<string | null> => null)

/** 可切换的 store mock（Provider 用例换已连接态） */
const storeState: { current: Record<string, unknown> } = { current: {} }

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      settings: "设置",
      connectionTitle: "服务器连接",
      providerTitle: "Provider",
      appearanceTitle: "外观",
      defaultsTitle: "默认",
      close: "关闭",
      back: "返回",
      cancel: "取消",
      save: "保存",
      addProfile: "添加",
      addProfileTitle: "添加服务器",
      addProfileManualTitle: "手动配置服务器",
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
      modeAttach: "连接现有服务",
      modeManaged: "本机启动",
      modeAttachDesc: "attach 说明",
      modeManagedDesc: "managed 说明",
      discoverServersTitle: "发现的服务器",
      discoverBinariesTitle: "本机 opencode",
      discoverScanning: "正在搜索…",
      discoverSourceLoopback: "本机",
      discoverSourceMdns: "局域网",
      discoverNoResult: "未发现",
      discoverRescan: "重新搜索",
      discoverManualEntry: "手动配置…",
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
      providerSearch: "搜索 provider（全部目录）…",
      providerRefresh: "刷新",
      providerKeyHint: "API key 存于 server 侧",
      providerNoneConnected: "尚无已配置的 provider",
      providerModels: "模型 {count}",
      providerKeySet: "设置 key",
      providerKeyReplace: "更换 key",
      providerKeyDelete: "删除",
      providerKeyOn: "已配置 key",
      providerKeyOff: "未配置",
      providerKeyFor: "{name} 的 API key",
      providerKeyDeleteConfirmTitle: "删除 {name} 的凭据",
      providerKeyDeleteConfirmBody: "删除后该 provider 的模型将不可用。",
      connectFirst: "请先连接服务器",
      providerNoProject: "打开项目后可在此配置 provider（列表按项目作用域查询）",
      noProjectMatch: "无匹配",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeState.current,
}))

beforeEach(() => {
  scanBinaries.mockClear()
  scanServers.mockClear()
  openBinaryPicker.mockClear()
  // mockReturnValue 会跨 mockClear 存留：逐用例覆写（如悬挂 Promise）后须在此复位
  scanBinaries.mockImplementation(async () => [
    { path: "/usr/bin/opencode", version: "1.18.20" },
    { path: "/home/t/.opencode/bin/opencode", version: null },
  ])
  scanServers.mockImplementation(async () => [
    { url: "http://127.0.0.1:4096", version: "1.0.0", source: "loopback" },
  ])
  openBinaryPicker.mockImplementation(async () => null)
  storeState.current = {
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
    getActiveClient: () => null,
    scopeQuery: { directory: null },
    pushOverlay: () => {},
    popOverlay: () => {},
    settingsInitialTab: "connection",
  }
  Object.defineProperty(window, "desktop", {
    configurable: true,
    get: () => ({ scanBinaries, scanServers, openBinaryPicker }),
  })
})

afterEach(cleanup)

describe("添加服务器引导式（design-guided-add-server）", () => {
  it("点「添加」进发现视图：双扫描并行启动，server 与 binary 候选混排列出", async () => {
    render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    expect(scanServers).toHaveBeenCalled()
    expect(scanBinaries).toHaveBeenCalled()
    // 两类候选都出现（attach 候选带来源徽标「本机」）
    await waitFor(() => expect(screen.getByText("http://127.0.0.1:4096")).toBeTruthy())
    expect(screen.getByText("/usr/bin/opencode")).toBeTruthy()
    expect(screen.getByText("本机")).toBeTruthy()
    // 手动入口常驻
    expect(screen.getByText("手动配置…")).toBeTruthy()
  })

  it("一路先回一路未回：先回的立即列出，保持搜索中提示", async () => {
    // servers 悬挂不回；binaries 立即回
    scanServers.mockReturnValue(new Promise(() => []))
    render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    await waitFor(() => expect(screen.getByText("/usr/bin/opencode")).toBeTruthy())
    expect(screen.getByText("正在搜索…")).toBeTruthy()
    expect(screen.queryByText("未发现")).toBeNull()
  })

  it("全部完成且无候选：空态文案 + 手动入口", async () => {
    scanServers.mockResolvedValue([])
    scanBinaries.mockResolvedValue([])
    render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    await waitFor(() => expect(screen.getByText("未发现")).toBeTruthy())
    expect(screen.getByText("手动配置…")).toBeTruthy()
  })

  it("点击 server 候选：一键建档并启用（attach profile + baseUrl），关弹窗 + 直达连接", async () => {
    render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    await waitFor(() => expect(screen.getByText("http://127.0.0.1:4096")).toBeTruthy())
    fireEvent.click(screen.getByText("http://127.0.0.1:4096"))
    // 建档即启用：saveProfiles 第二参 = 新 profile id（非 null）
    await waitFor(() => {
      const calls = (storeState.current.saveProfiles as ReturnType<typeof vi.fn>).mock.calls
      const last = calls.at(-1)
      expect(last?.[0]).toEqual([expect.objectContaining({ baseUrl: "http://127.0.0.1:4096", mode: "attach" })])
      expect(last?.[1]).toEqual(expect.any(String))
    })
    // 关闭设置弹窗 + 拆旧连接 + 带 openPickerAfter 标记连接
    await waitFor(() => expect(storeState.current.closeSettings).toHaveBeenCalled())
    await waitFor(() => expect(storeState.current.disconnect).toHaveBeenCalled())
    await waitFor(() =>
      expect(storeState.current.connect).toHaveBeenCalledWith({ openPickerAfter: true }),
    )
  })

  it("点击 binary 候选：一键建档并启用（managed profile + binaryPath）", async () => {
    scanServers.mockResolvedValue([])
    render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    await waitFor(() => expect(screen.getByText("/usr/bin/opencode")).toBeTruthy())
    fireEvent.click(screen.getByText("/usr/bin/opencode"))
    await waitFor(() => {
      const calls = (storeState.current.saveProfiles as ReturnType<typeof vi.fn>).mock.calls
      const last = calls.at(-1)
      expect(last?.[0]).toEqual([expect.objectContaining({ mode: "managed", binaryPath: "/usr/bin/opencode" })])
      expect(last?.[1]).toEqual(expect.any(String))
    })
    await waitFor(() => expect(storeState.current.closeSettings).toHaveBeenCalled())
    await waitFor(() =>
      expect(storeState.current.connect).toHaveBeenCalledWith({ openPickerAfter: true }),
    )
  })

  it("「手动配置…」进 manual 表单：模式段置顶默认 attach，字段齐全，不再触发扫描", async () => {
    render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    await waitFor(() => expect(screen.getByText("手动配置…")).toBeTruthy())
    fireEvent.click(screen.getByText("手动配置…"))
    // 标题切手动配置；模式段置顶 + 一句话说明
    expect(screen.getByText("手动配置服务器")).toBeTruthy()
    expect(screen.getByText("连接现有服务")).toBeTruthy()
    expect(screen.getByText("本机启动")).toBeTruthy()
    expect(screen.getByText("attach 说明")).toBeTruthy()
    expect(screen.getByLabelText("服务器地址")).toBeTruthy()
    expect(screen.getByLabelText("用户名（可选）")).toBeTruthy()
    expect(screen.getByLabelText("密码（可选）")).toBeTruthy()
    expect(screen.queryByLabelText("二进制路径")).toBeNull()
    // manual（attach）不触发二进制扫描（仅发现视图那次）
    expect(scanBinaries).toHaveBeenCalledTimes(1)
  })

  it("重新搜索按钮：再次触发双扫描，重搜期间按钮禁用 + 搜索中提示回归", async () => {
    // servers 慢回（悬挂），验证 rescan 反馈（guided review 修订：rescan 时
    // 两路已非 null，null 判据给不出反馈——须显式 scanning 态）
    scanServers.mockImplementation(
      () => new Promise((r) => setTimeout(() => r([{ url: "http://127.0.0.1:4096", version: "1.0.0", source: "loopback" }]), 50)),
    )
    render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    const rescanBtn = () => screen.getByText("重新搜索").closest("button") as HTMLButtonElement
    // 首扫完成（快路 binaries 已列、慢路 servers 50ms 后回）→ 可重搜
    await waitFor(() => expect(rescanBtn().disabled).toBe(false))
    fireEvent.click(screen.getByText("重新搜索"))
    await waitFor(() => expect(scanServers).toHaveBeenCalledTimes(2))
    expect(scanBinaries).toHaveBeenCalledTimes(2)
    // 重搜期间：按钮禁用 + 搜索中提示（不闪空态文案）
    expect(screen.getByText("正在搜索…")).toBeTruthy()
    expect(rescanBtn().disabled).toBe(true)
    expect(screen.queryByText("未发现")).toBeNull()
    await waitFor(() => expect(rescanBtn().disabled).toBe(false))
  })

  it("发现视图焦点落弹窗容器（真 focus 语义：Esc 分层第一跳不失效）", async () => {
    // guided review 修复回归：fireEvent.keyDown 直派 dialog 元素会绕过真实
    // focus 语义——此处用真 focus 位置断言（进入发现视图时「添加」按钮卸载，
    // 焦点须由 effect 拉回 dialog 容器，否则 Esc 冒泡到 body 静默失效）
    const { container } = render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    await waitFor(() => expect(screen.getByText("手动配置…")).toBeTruthy())
    expect(document.activeElement).toBe(container.querySelector(".dialog"))
    // manual（无 autoFocus 落焦时同理）返回发现视图后焦点回容器
    fireEvent.click(screen.getByText("手动配置…"))
    await waitFor(() => expect(screen.getByText("手动配置服务器")).toBeTruthy())
    fireEvent.click(screen.getByTitle("返回"))
    await waitFor(() => expect(screen.getByText("手动配置…")).toBeTruthy())
    expect(document.activeElement).toBe(container.querySelector(".dialog"))
  })

  it("新增路径 Esc 分层：manual 表单先退回发现视图，再退关弹窗", async () => {
    const { container } = render(<SettingsDialog />)
    fireEvent.click(screen.getByText("添加"))
    await waitFor(() => expect(screen.getByText("手动配置…")).toBeTruthy())
    fireEvent.click(screen.getByText("手动配置…"))
    expect(screen.getByText("手动配置服务器")).toBeTruthy()
    // Esc 1：退回发现视图
    fireEvent.keyDown(container.querySelector(".dialog")!, { key: "Escape" })
    await waitFor(() => expect(screen.getByText("手动配置…")).toBeTruthy())
    // Esc 2：退回列表
    fireEvent.keyDown(container.querySelector(".dialog")!, { key: "Escape" })
    await waitFor(() => expect(screen.getByText("添加")).toBeTruthy())
    // Esc 3：关闭弹窗
    fireEvent.keyDown(container.querySelector(".dialog")!, { key: "Escape" })
    expect(storeState.current.closeSettings).toHaveBeenCalled()
  })
})

describe("ProfileFormView 模式分化", () => {
  /** 进 manual 表单（经发现视图——引导路径已在上组覆盖） */
  const goManual = async () => {
    fireEvent.click(screen.getByText("添加"))
    await waitFor(() => expect(screen.getByText("手动配置…")).toBeTruthy())
    fireEvent.click(screen.getByText("手动配置…"))
    await waitFor(() => expect(screen.getByText("手动配置服务器")).toBeTruthy())
  }

  it("managed 模式：模式段切换后隐藏 URL/凭据，显示二进制路径 + 扫描候选，点击候选填入", async () => {
    render(<SettingsDialog />)
    await goManual()
    // 切到 managed（模式段按钮）
    fireEvent.click(screen.getByText("本机启动"))
    // 说明切换 + URL/凭据字段消失
    expect(screen.getByText("managed 说明")).toBeTruthy()
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

  it("attach 模式：URL/凭据字段齐全，无二进制路径", async () => {
    render(<SettingsDialog />)
    await goManual()
    expect(screen.getByLabelText("服务器地址")).toBeTruthy()
    expect(screen.getByLabelText("用户名（可选）")).toBeTruthy()
    expect(screen.getByLabelText("密码（可选）")).toBeTruthy()
    expect(screen.queryByLabelText("二进制路径")).toBeNull()
  })

  it("浏览按钮选择路径填入", async () => {
    openBinaryPicker.mockResolvedValue("/picked/opencode")
    render(<SettingsDialog />)
    await goManual()
    fireEvent.click(screen.getByText("本机启动"))
    fireEvent.click(screen.getByText("浏览…"))
    await waitFor(() => {
      expect((screen.getByLabelText("二进制路径") as HTMLInputElement).value).toBe("/picked/opencode")
    })
  })

  it("编辑既有 profile 直落 manual 表单（跳过发现视图），保存 upsert", async () => {
    storeState.current.profiles = [{ id: "p1", name: "srv", baseUrl: "http://x:1", mode: "attach" }]
    render(<SettingsDialog />)
    // 编辑钮是 icon-btn（Pencil 图标，无文字），按 title 取
    fireEvent.click(screen.getByTitle("编辑"))
    // 编辑标题（非手动配置标题），发现视图未出现
    expect(screen.getByText("编辑服务器")).toBeTruthy()
    expect(screen.queryByText("手动配置…")).toBeNull()
    expect((screen.getByLabelText("服务器地址") as HTMLInputElement).value).toBe("http://x:1")
    fireEvent.click(screen.getByText("保存"))
    await waitFor(() =>
      expect(storeState.current.saveProfiles).toHaveBeenCalledWith(
        [expect.objectContaining({ id: "p1", baseUrl: "http://x:1" })],
        null,
      ),
    )
    // 保存后退回列表（编辑按钮回到视野）
    await waitFor(() => expect(screen.getByTitle("编辑")).toBeTruthy())
  })

  it("手动新增保存 = 启用流：关弹窗 + disconnect + connect({openPickerAfter})", async () => {
    render(<SettingsDialog />)
    await goManual()
    fireEvent.change(screen.getByLabelText("服务器地址"), { target: { value: "http://127.0.0.1:9999" } })
    fireEvent.click(screen.getByText("保存"))
    await waitFor(() => {
      const calls = (storeState.current.saveProfiles as ReturnType<typeof vi.fn>).mock.calls
      const last = calls.at(-1)
      expect(last?.[0]).toEqual([expect.objectContaining({ baseUrl: "http://127.0.0.1:9999", mode: "attach" })])
      expect(last?.[1]).toEqual(expect.any(String))
    })
    await waitFor(() => expect(storeState.current.closeSettings).toHaveBeenCalled())
    await waitFor(() => expect(storeState.current.disconnect).toHaveBeenCalled())
    await waitFor(() =>
      expect(storeState.current.connect).toHaveBeenCalledWith({ openPickerAfter: true }),
    )
    // 顺序：disconnect 先于 saveProfiles——saveProfiles 先行会把 activeProfileId 切到
    // 新 profile，disconnect 按新 profile 的 mode 判定（attach）跳过 managedStop，
    // managed→attach 切换泄漏旧 server 进程（review P2）
    const disIdx = (storeState.current.disconnect as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    const saveIdx = (storeState.current.saveProfiles as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)
    expect(disIdx).toBeLessThan(saveIdx!)
  })
})

// ============ Provider 页签（design-provider-config） ============

import { filterProviders } from "./settings-dialog"

describe("filterProviders 纯函数", () => {
  const all: ProviderInfo[] = [
    { id: "anthropic", name: "Anthropic", source: "env", env: [], models: { m1: {} } },
    { id: "deepseek", name: "DeepSeek", source: "api", env: [], key: "k", models: {} },
    { id: "openrouter", name: "OpenRouter", source: "env", env: [], models: {} },
  ]
  it("空查询 = 空结果；id/名称子串不区分大小写", () => {
    expect(filterProviders(all, "")).toEqual([])
    expect(filterProviders(all, "  ")).toEqual([])
    expect(filterProviders(all, "deep").map((p) => p.id)).toEqual(["deepseek"])
    expect(filterProviders(all, "SEEK").map((p) => p.id)).toEqual(["deepseek"])
    expect(filterProviders(all, "Anthropic").map((p) => p.id)).toEqual(["anthropic"])
  })
  it("上限 20", () => {
    const many: ProviderInfo[] = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      source: "env",
      env: [],
      models: {},
    }))
    expect(filterProviders(many, "p")).toHaveLength(20)
  })
})


describe("ProviderSettings 组件", () => {
  const onEditKey = vi.fn()
  const cat: ProviderCatalog = {
    all: [
      { id: "deepseek", name: "DeepSeek", source: "api", env: [], key: "k1", models: { a: {}, b: {} } },
      { id: "anthropic", name: "Anthropic", source: "env", env: [], models: { c: {} } },
      { id: "opencode", name: "OpenCode", source: "custom", env: [], key: null, models: {} },
    ],
    default: { deepseek: "a" },
    connected: ["deepseek"],
  }
  const mkOps = () => {
    const list = vi.fn(async (): Promise<ProviderCatalog> => cat)
    const setKey = vi.fn(async (): Promise<boolean> => true)
    const removeKey = vi.fn(async (): Promise<boolean> => true)
    return { ops: { list, setKey, removeKey } satisfies ProviderOps, list, setKey, removeKey }
  }
  const connectStore = () => {
    storeState.current = {
      ...storeState.current,
      activeProfileId: "p1",
      activeProfile: { id: "p1", name: "a", baseUrl: "http://x", mode: "attach" },
      getActiveClient: () => ({}),
      scopeQuery: { directory: "/repo" },
    }
  }

  it("默认视图只显示已配置 key 的 provider（名称/source/模型数）；搜索切全目录", async () => {
    connectStore()
    const { ops, list } = mkOps()
    render(<ProviderSettings ops={ops} onEditKey={onEditKey} />)
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeTruthy())
    expect(screen.queryByText("Anthropic")).toBeNull()
    expect(list).toHaveBeenCalledWith("/repo")
    expect(screen.getByText("模型 2")).toBeTruthy()
    expect(screen.getByText("更换 key")).toBeTruthy()
    // 搜索 anthropic → 全目录命中，未配置项出现
    fireEvent.change(screen.getByPlaceholderText(/搜索 provider/), {
      target: { value: "anthropic" },
    })
    await waitFor(() => expect(screen.getByText("Anthropic")).toBeTruthy())
    expect(screen.getByText("设置 key")).toBeTruthy()
  })

  it("设置 key：onEditKey 提升到弹窗层（ProviderSettings 不再自持编辑态）", async () => {
    connectStore()
    const { ops } = mkOps()
    render(<ProviderSettings ops={ops} onEditKey={onEditKey} />)
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText(/搜索 provider/), {
      target: { value: "anthropic" },
    })
    await waitFor(() => expect(screen.getByText("设置 key")).toBeTruthy())
    fireEvent.click(screen.getByText("设置 key"))
    expect(onEditKey).toHaveBeenCalledWith(
      expect.objectContaining({ id: "anthropic", name: "Anthropic" }),
    )
  })

  it("ProviderKeyForm：输入 → 保存调用 setKey → onSaved；空 key 禁保存", async () => {
    connectStore()
    const { ops, setKey } = mkOps()
    const onSaved = vi.fn()
    const anthropic = cat.all[1]!
    render(
      <ProviderKeyForm provider={anthropic} ops={ops} onCancel={vi.fn()} onSaved={onSaved} />,
    )
    expect(screen.getByText("保存")).toBeTruthy()
    fireEvent.click(screen.getByText("保存"))
    expect(setKey).not.toHaveBeenCalled() // 空 key 禁用
    fireEvent.change(screen.getByLabelText("Anthropic 的 API key"), {
      target: { value: "sk-new" },
    })
    fireEvent.click(screen.getByText("保存"))
    await waitFor(() => expect(setKey).toHaveBeenCalledWith("anthropic", "sk-new"))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("删除 key：二次确认后调用并重拉", async () => {
    connectStore()
    const { ops, removeKey, list } = mkOps()
    render(<ProviderSettings ops={ops} onEditKey={onEditKey} />)
    await waitFor(() => expect(screen.getByText("DeepSeek")).toBeTruthy())
    const callsBefore = list.mock.calls.length
    fireEvent.click(screen.getByText("删除"))
    await waitFor(() => expect(screen.getByText(/删除 DeepSeek 的凭据/)).toBeTruthy())
    // 确认弹窗里的确认钮（danger）——行内也有「删除」，取 confirm 弹窗内那个
    const confirmBtn = screen
      .getAllByText("删除")
      .find((b) => (b as HTMLButtonElement).className.includes("btn-primary"))
    expect(confirmBtn).toBeTruthy()
    fireEvent.click(confirmBtn!)
    await waitFor(() => expect(removeKey).toHaveBeenCalledWith("deepseek"))
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it("默认视图并入 connected 集（多 env provider key 合并为 undefined 仍可见）", async () => {
    connectStore()
    const cat2: ProviderCatalog = {
      all: [
        { id: "deepseek", name: "DeepSeek", source: "api", env: [], key: "k1", models: {} },
        { id: "google", name: "Google", source: "env", env: [], key: undefined, models: {} },
      ],
      default: {},
      connected: ["deepseek", "google"],
    }
    const list = vi.fn(async (): Promise<ProviderCatalog> => cat2)
    render(<ProviderSettings ops={{ list, setKey: vi.fn(), removeKey: vi.fn() }} onEditKey={onEditKey} />)
    await waitFor(() => expect(screen.getByText("Google")).toBeTruthy())
    expect(screen.getAllByText("更换 key")).toHaveLength(2)
  })

  it("无连接：connectFirst 引导态", async () => {
    const { ops, list } = mkOps()
    render(<ProviderSettings ops={ops} onEditKey={onEditKey} />)
    await waitFor(() => expect(screen.getByText("请先连接服务器")).toBeTruthy())
    expect(list).not.toHaveBeenCalled()
  })

  it("已连接但无项目：providerNoProject 文案（与未连接区分）", async () => {
    storeState.current = {
      ...storeState.current,
      getActiveClient: () => ({}),
      scopeQuery: { directory: "" },
    }
    const { ops, list } = mkOps()
    render(<ProviderSettings ops={ops} onEditKey={onEditKey} />)
    await waitFor(() => expect(screen.getByText(/打开项目后/)).toBeTruthy())
    expect(list).not.toHaveBeenCalled()
  })
})
