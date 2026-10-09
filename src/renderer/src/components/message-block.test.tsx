/**
 * 中止/报错呈现分流（design-error-message §3.1 修订，2026-10-09）：
 * assistant 消息 error 为中止（isAbortError——v2 wire `type:"aborted"`，
 * 活体 ses_ee3e3c79… 实测；v1 防御键 MessageAbortedError）时呈系统提示行
 * `.system-notice.interrupted`，非中止错误才呈 `.error-card` 红卡。
 * ResizeObserver/IntersectionObserver jsdom 缺失，补 stub（workspace 模块图所需）。
 */
import { render } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { MessageBlock } from "./workspace"
import type { ChatEntry } from "@shared/message-merge"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      abortedNotice: "已停止",
      thinking: "思考中",
      toolCall: "工具",
      inputLabel: "输入",
      outputLabel: "输出",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({
    showThinking: false,
    findSession: () => undefined,
  }),
}))

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof IntersectionObserver
})

function assistantEntry(error: unknown): ChatEntry {
  return {
    kind: "message",
    data: {
      info: {
        id: "msg_a1",
        sessionID: "s1",
        role: "assistant",
        time: { created: 1, completed: 2 },
        ...(error !== undefined ? { error } : {}),
      },
      parts: [{ id: "prt_1", sessionID: "s1", messageID: "msg_a1", type: "text", text: "部分回复" }],
    },
  } as ChatEntry
}

describe("MessageBlock 中止/报错分流", () => {
  it("中止（v2 wire type:aborted）呈系统提示行，不呈错误卡", () => {
    const { container } = render(
      <MessageBlock entry={assistantEntry({ type: "aborted", message: "Step interrupted" })} />,
    )
    const notice = container.querySelector(".system-notice.interrupted")
    expect(notice).not.toBeNull()
    expect(notice!.getAttribute("role")).toBe("status")
    expect(notice!.textContent).toContain("已停止")
    expect(container.querySelector(".error-card")).toBeNull()
  })

  it("中止（v1 防御键 MessageAbortedError）同样呈系统提示行", () => {
    const { container } = render(
      <MessageBlock entry={assistantEntry({ name: "MessageAbortedError", data: { message: "Aborted" } })} />,
    )
    expect(container.querySelector(".system-notice.interrupted")).not.toBeNull()
    expect(container.querySelector(".error-card")).toBeNull()
  })

  it("非中止错误呈错误卡（红卡 + server 文案），不呈系统提示行", () => {
    const { container } = render(
      <MessageBlock entry={assistantEntry({ type: "APIError", message: "overloaded" })} />,
    )
    const card = container.querySelector(".error-card")
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain("overloaded")
    expect(container.querySelector(".system-notice.interrupted")).toBeNull()
  })

  it("无错误 assistant 消息：两者皆不呈", () => {
    const { container } = render(<MessageBlock entry={assistantEntry(undefined)} />)
    expect(container.querySelector(".error-card")).toBeNull()
    expect(container.querySelector(".system-notice.interrupted")).toBeNull()
  })

  it("中止未结算工具 chip：摘要/输出显示「已停止」，不显示 server 英文原文", () => {
    const entry = {
      kind: "message",
      data: {
        info: {
          id: "msg_a2",
          sessionID: "s1",
          role: "assistant",
          time: { created: 1, completed: 2 },
        },
        parts: [
          {
            id: "prt_t1",
            sessionID: "s1",
            messageID: "msg_a2",
            type: "tool",
            callID: "call_t1",
            tool: "bash",
            state: { status: "error", input: {}, error: "Tool execution interrupted: bash", aborted: true },
          },
        ],
      },
    } as unknown as ChatEntry
    const { container } = render(<MessageBlock entry={entry} />)
    const summary = container.querySelector(".chip-summary")
    expect(summary?.textContent).toBe("已停止")
    expect(container.textContent).not.toContain("Tool execution interrupted")
  })

  it("非中止错误工具 chip：摘要显示 server 错误文案", () => {
    const entry = {
      kind: "message",
      data: {
        info: {
          id: "msg_a3",
          sessionID: "s1",
          role: "assistant",
          time: { created: 1, completed: 2 },
        },
        parts: [
          {
            id: "prt_t2",
            sessionID: "s1",
            messageID: "msg_a3",
            type: "tool",
            callID: "call_t2",
            tool: "bash",
            state: { status: "error", input: {}, error: "exit 1" },
          },
        ],
      },
    } as unknown as ChatEntry
    const { container } = render(<MessageBlock entry={entry} />)
    expect(container.querySelector(".chip-summary")?.textContent).toBe("exit 1")
  })
})
