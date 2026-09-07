/**
 * subagent 面板停止投影（design-subagent-status D4 修订）：server 对中断的
 * task part 永卡 status:"running"，UI 侧以「父/子会话均 idle」为停止证据。
 * 各状态下收起态 header 的图标与 aria 断言；面板默认收起，不触子会话加载。
 * ResizeObserver/IntersectionObserver jsdom 缺失，补 stub（workspace 模块图所需）。
 */
import { render } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { SubagentPanel } from "./workspace"
import type { ToolPart } from "@shared/api-types"

/** 测试内动态替换的 store 桩（vi.mock 提升导致闭包需经变量间接） */
let storeStub: Record<string, unknown>

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
    chatEntries: () => [],
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
  return { icon, spinning: icon.querySelector(".spin") != null }
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
