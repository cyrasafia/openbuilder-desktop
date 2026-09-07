/**
 * subagent 面板停止投影（design-subagent-status D4 修订）：server 对中断的
 * task part 永卡 status:"running"，UI 侧以「父/子会话均 idle」为停止证据。
 * 各状态下收起态 header 的图标与 aria 断言；面板默认收起，不触子会话加载。
 * ResizeObserver/IntersectionObserver jsdom 缺失，补 stub（workspace 模块图所需）。
 */
import { render } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { SubagentPanel } from "./workspace"
import type { ToolPart } from "@shared/api-types"

/** 测试内动态替换的 store 桩（vi.mock 提升导致闭包需经变量间接） */
let storeStub: Record<string, unknown>
/** chatEntries 返回内容（报错上浮用例注入子会话末条 assistant） */
let chatEntriesStub: unknown[] = []

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      assistant: "Assistant",
      subagentRunning: "运行中",
      subagentCompleted: "已完成",
      subagentError: "出错",
      subagentStopped: "已停止",
      subagentExpand: "展开子会话",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

const PARENT = "ses_parent"
const CHILD = "ses_child"

function makeStore(active: string[]): Record<string, unknown> {
  const set = new Set(active)
  return {
    isSessionActive: (id: string) => set.has(id),
    findSession: (id: string) =>
      id === CHILD ? { id: CHILD, parentID: PARENT, directory: "/repo" } : undefined,
    findChildSession: () => ({ id: CHILD, parentID: PARENT, directory: "/repo" }),
    chatEntries: () => chatEntriesStub,
    loadSessionMessages: vi.fn(),
  }
}

function taskPart(status: ToolPart["state"]["status"]): ToolPart {
  return {
    id: "prt_1",
    messageID: "msg_1",
    sessionID: PARENT,
    type: "tool",
    callID: "call_1",
    tool: "task",
    state: {
      status,
      input: { description: "探查仓库结构", subagent_type: "explore", prompt: "…" },
      ...(status !== "pending" && status !== "running" ? { time: { start: 1, end: 2 } } : { time: { start: 1 } }),
      ...(status === "running" || status === "completed"
        ? { metadata: { sessionId: CHILD } }
        : {}),
      ...(status === "completed" ? { output: "done", title: "探查完成" } : {}),
      ...(status === "error" ? { error: "boom" } : {}),
    } as ToolPart["state"],
  }
}

function renderPanel(part: ToolPart) {
  const { container } = render(<SubagentPanel part={part} parentSessionID={PARENT} />)
  const icon = container.querySelector<HTMLElement>(".subagent-status-icon")!
  expect(icon).not.toBeNull()
  const summary = container.querySelector<HTMLElement>(".chip-summary")
  return { icon, summary, spinning: icon.querySelector(".spin") != null }
}

beforeAll(() => {
  globalThis.ResizeObserver = class implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
  globalThis.IntersectionObserver = class implements IntersectionObserver {
    readonly root: Element | null = null
    readonly rootMargin: string = ""
    readonly scrollMargin: string = ""
    readonly thresholds: ReadonlyArray<number> = []
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return []
    }
  } as unknown as typeof IntersectionObserver
})

describe("SubagentPanel 状态投影", () => {
  beforeEach(() => {
    chatEntriesStub = []
  })

  it("part running + 父会话活跃：转圈（正常进行中）", () => {
    storeStub = makeStore([PARENT])
    const { icon, spinning } = renderPanel(taskPart("running"))
    expect(spinning).toBe(true)
    expect(icon.getAttribute("aria-label")).toBe("运行中")
  })

  it("part running + 父 idle 子活跃：仍转圈（父条目缺失时子会话兜底）", () => {
    storeStub = makeStore([CHILD])
    const { spinning } = renderPanel(taskPart("running"))
    expect(spinning).toBe(true)
  })

  it("part running + 父/子均 idle：停止样式（中断残留不永久转圈）", () => {
    storeStub = makeStore([])
    const { icon, spinning } = renderPanel(taskPart("running"))
    expect(spinning).toBe(false)
    expect(icon.getAttribute("aria-label")).toBe("已停止")
    expect(icon.querySelector("svg")).not.toBeNull()
  })

  it("part pending + 父/子均 idle：同样按停止渲染", () => {
    storeStub = makeStore([])
    const { icon, spinning } = renderPanel(taskPart("pending"))
    expect(spinning).toBe(false)
    expect(icon.getAttribute("aria-label")).toBe("已停止")
  })

  it("part completed：✓（与活跃无关）", () => {
    storeStub = makeStore([])
    const { icon, spinning } = renderPanel(taskPart("completed"))
    expect(spinning).toBe(false)
    expect(icon.getAttribute("aria-label")).toBe("已完成")
  })

  it("part error：✗ 出错", () => {
    storeStub = makeStore([])
    const { icon, spinning } = renderPanel(taskPart("error"))
    expect(spinning).toBe(false)
    expect(icon.getAttribute("aria-label")).toBe("出错")
  })
})

describe("SubagentPanel 报错上浮（§D6）", () => {
  beforeEach(() => {
    chatEntriesStub = []
  })

  /** 子会话消息 entry（kind message，末条 assistant 可带 error） */
  const entry = (role: string, error?: unknown) => ({
    kind: "message",
    data: {
      info: { id: `msg_${role}`, role, error: error ?? null },
      parts: [],
    },
  })

  it("part 卡 running + 子会话末条 assistant 报错：✗ 出错 + 报错文案上浮（优先于转圈）", () => {
    chatEntriesStub = [entry("user"), entry("assistant"), entry("assistant", { name: "UnknownError", data: { message: "provider 429" } })]
    storeStub = makeStore([PARENT])
    const { icon, summary, spinning } = renderPanel(taskPart("running"))
    expect(spinning).toBe(false)
    expect(icon.getAttribute("aria-label")).toBe("出错")
    expect(summary?.textContent).toContain("provider 429")
  })

  it("子会话活跃（retry 退避）期间挂起报错提取：保持转圈，不按轮次闪动", () => {
    chatEntriesStub = [entry("assistant", { name: "UnknownError", data: { message: "provider 429" } })]
    storeStub = makeStore([CHILD])
    const { spinning } = renderPanel(taskPart("running"))
    expect(spinning).toBe(true)
  })

  it("中止（MessageAbortedError）不算报错：保持已停止样式", () => {
    chatEntriesStub = [entry("assistant", { name: "MessageAbortedError", data: { message: "Aborted" } })]
    storeStub = makeStore([])
    const { icon, spinning } = renderPanel(taskPart("running"))
    expect(spinning).toBe(false)
    expect(icon.getAttribute("aria-label")).toBe("已停止")
  })

  it("末条 assistant 无报错：不受更早历史 assistant 报错影响", () => {
    chatEntriesStub = [
      entry("assistant", { name: "UnknownError", data: { message: "旧错" } }),
      entry("assistant"),
    ]
    storeStub = makeStore([PARENT])
    const { spinning } = renderPanel(taskPart("running"))
    expect(spinning).toBe(true)
  })

  it("stopped 且子会话无内容：触发一次性 REST 补拉（冷开报错文本来源）", () => {
    storeStub = makeStore([])
    renderPanel(taskPart("running"))
    expect(storeStub.loadSessionMessages).toHaveBeenCalledWith(CHILD, "/repo")
  })

  it("running（父活跃）不触发补拉", () => {
    storeStub = makeStore([PARENT])
    renderPanel(taskPart("running"))
    expect(storeStub.loadSessionMessages).not.toHaveBeenCalled()
  })
})
