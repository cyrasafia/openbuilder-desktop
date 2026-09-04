/**
 * profile 表单按模式分化（design-managed-config §1）：managed 隐藏 URL/凭据、
 * 显示二进制路径与扫描候选；attach 字段齐全。mock desktop.scanBinaries。
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
      noProjectMatch: "无匹配",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeState.current,
}))

beforeEach(() => {
  scanBinaries.mockClear()
  openBinaryPicker.mockClear()
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
  }
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
})
