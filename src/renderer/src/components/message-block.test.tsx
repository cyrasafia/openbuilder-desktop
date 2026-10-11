/**
 * 中止/报错呈现分流（design-error-message §3.1 修订，2026-10-09）：
 * assistant 消息 error 为中止（isAbortError——v2 wire `type:"aborted"`，
 * 活体 ses_ee3e3c79… 实测；v1 防御键 MessageAbortedError）时呈系统提示行
 * `.system-notice.interrupted`，非中止错误才呈 `.error-card` 红卡。
 * ResizeObserver/IntersectionObserver jsdom 缺失，补 stub（workspace 模块图所需）。
 */
import { fireEvent, render } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageBlock } from "./workspace"
import type { ChatEntry } from "@shared/message-merge"

// store mock（可变状态供自动链接用例定向覆写；vi.hoisted 先于模块图求值）
const storeMock = vi.hoisted(() => ({
  showThinking: false,
  findSession: vi.fn((): unknown => undefined),
  openFileTab: vi.fn(),
}))

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
  useStore: () => storeMock,
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

describe("MessageBlock 文件路径自动链接（design-message-autolink）", () => {
  beforeEach(() => {
    storeMock.findSession.mockReturnValue(undefined)
    storeMock.openFileTab.mockClear()
  })

  it("assistant 消息项目内路径转链：点击 → openFileTab(绝对路径, 行号)", () => {
    storeMock.findSession.mockReturnValue({ directory: "/repo", parentID: null })
    const entry = assistantEntry(undefined)
    ;((entry.data as { parts: Array<{ text: string }> }).parts[0]).text =
      "见 lib/foo.dart:42 与项目外 /etc/hosts"
    const { container } = render(<MessageBlock entry={entry} />)
    // 项目内转链（绝对路径 + 行号进 query）；项目外保持纯文本
    const links = [...container.querySelectorAll("a")]
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "ob-file:////repo/lib/foo.dart?line=42",
    ])
    fireEvent.click(links[0])
    expect(storeMock.openFileTab).toHaveBeenCalledWith("/repo/lib/foo.dart", 42)
  })

  it("user 消息路径同样转链（软换行管线并存）", () => {
    storeMock.findSession.mockReturnValue({ directory: "/repo", parentID: null })
    const entry = {
      kind: "message",
      data: {
        info: { id: "msg_u9", sessionID: "s1", role: "user", time: { created: 1 } },
        parts: [{ id: "prt_u9", type: "text", text: "看下 src/a.ts\n再看看 b/c.md" }],
      },
    } as unknown as ChatEntry
    const { container } = render(<MessageBlock entry={entry} />)
    const links = [...container.querySelectorAll("a")]
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "ob-file:////repo/src/a.ts",
      "ob-file:////repo/b/c.md",
    ])
  })

  it("会话无 directory（findSession 未命中）：不转链不崩溃", () => {
    const entry = assistantEntry(undefined)
    ;((entry.data as { parts: Array<{ text: string }> }).parts[0]).text = "见 lib/foo.dart"
    const { container } = render(<MessageBlock entry={entry} />)
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("lib/foo.dart")
  })

  it("乐观回显不转链（发送中瞬时态，真实消息到达后转链）", () => {
    const entry = {
      kind: "optimistic",
      data: { localId: "opt_1", text: "见 lib/foo.dart", refs: [], attachments: [] },
    } as unknown as ChatEntry
    const { container } = render(<MessageBlock entry={entry} />)
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("lib/foo.dart")
  })
})

  it("手写 ob-file 越界链接：点击层同源归属校验拒绝（评审修复 3）", () => {
    storeMock.findSession.mockReturnValue({ directory: "/repo", parentID: null })
    const entry = assistantEntry(undefined)
    ;((entry.data as { parts: Array<{ text: string }> }).parts[0]).text =
      "[看这](ob-file:////etc/hosts) 与 [内的](ob-file:////repo/lib/a.ts)"
    const { container } = render(<MessageBlock entry={entry} />)
    const links = [...container.querySelectorAll("a")]
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "ob-file:////etc/hosts",
      "ob-file:////repo/lib/a.ts",
    ])
    fireEvent.click(links[0]) // 项目外：拒绝
    expect(storeMock.openFileTab).not.toHaveBeenCalled()
    fireEvent.click(links[1]) // 项目内：放行
    expect(storeMock.openFileTab).toHaveBeenCalledWith("/repo/lib/a.ts", undefined)
  })
