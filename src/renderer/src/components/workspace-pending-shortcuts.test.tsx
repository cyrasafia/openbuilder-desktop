/**
 * 会话页待处理卡片快捷键测试（design-keyboard-shortcuts §1.1b，2026-09-28 增；
 * 同日授权卡改字母键）：授权卡 Ctrl+N/A/Y = 拒绝/总是允许/允许一次（Ctrl+A/Y
 * 文本域聚焦让行 全选/redo）；问题卡 Ctrl+1..9 切换选项、Ctrl+0 拒绝、Ctrl+Enter
 * 下一步/末步提交（未选不动作，同按钮禁用态）。
 * 守卫：Shift/Alt/repeat/IME/已消费/回复中/收起/overlay 不动作；Ctrl 按住期间
 * 按钮/选项显示键位角标（禁用不显，Enter 显示 "↵"，选项超 9 项截断）；
 * 卸载后不再监听。角标跟踪是模块级单例（ctrl-held.ts）——afterEach 归零防
 * 用例间残留（workspace-guide 惯例）。
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PermissionCard, QuestionCard } from "./workspace"
import type { PendingPermission, PendingQuestion } from "@shared/pending-requests"

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      permissionRequest: "授权请求",
      permissionExecute: "执行命令",
      replyFailed: "回复失败",
      reject: "拒绝",
      permissionAlwaysAllow: "总是允许",
      permissionAllowOnce: "允许一次",
      questionSubmit: "提交",
      questionNext: "下一步",
      pendingQueue: "队列 {total}",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

/** 测试内动态替换的 store 桩（vi.mock 提升导致闭包需经变量间接） */
let storeStub: Record<string, unknown>

function makeStore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    overlayCount: 0,
    respondPermission: vi.fn(async () => ({ ok: false })),
    replyQuestion: vi.fn(async () => ({ ok: false })),
    rejectQuestion: vi.fn(async () => ({ ok: false })),
    ...overrides,
  }
}

function makePermission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    id: "per_1",
    sessionID: "s1",
    type: "bash",
    patterns: [],
    metadata: { command: "echo hi" },
    always: [],
    directory: "/repo/a",
    ...overrides,
  }
}

function makeQuestion(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    id: "que_1",
    sessionID: "s1",
    directory: "/repo/a",
    questions: [
      {
        question: "继续吗？",
        header: "确认",
        options: [
          { label: "是", description: "" },
          { label: "否", description: "" },
        ],
        multiple: false,
        custom: false,
      },
    ],
    ...overrides,
  }
}

/** 原生 window 派发需包 act，状态/角标断言前 React 才会 flush */
function press(init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { cancelable: true, ...init })
  act(() => {
    window.dispatchEvent(ev)
  })
  return ev
}

/** flush 微任务（应答 promise 回落 replying=false，连续按键用例必需） */
async function flush() {
  await act(async () => {})
}

function releaseCtrl() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }))
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }))
  })
}

function badges(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".pending-key-badge"))
}

/** 选项行选中态（顺序映射 options） */
function optionActive(): boolean[] {
  return Array.from(document.querySelectorAll(".pending-option")).map((el) =>
    el.classList.contains("active"),
  )
}

beforeEach(() => {
  storeStub = makeStore()
})

// 角标跟踪是模块级单例：用例间残留（如按住未松）会让角标缺席断言假失败
afterEach(() => {
  cleanup()
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }))
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }))
    window.dispatchEvent(new Event("blur"))
  })
})

describe("授权卡快捷键（design-keyboard-shortcuts §1.1b，2026-09-28 增，字母键）", () => {
  it("Ctrl+N/A/Y 分别应答 拒绝/总是允许/允许一次（preventDefault）", async () => {
    render(<PermissionCard permission={makePermission()} queueTotal={1} />)
    const evN = press({ key: "n", code: "KeyN", ctrlKey: true })
    expect(evN.defaultPrevented).toBe(true)
    await flush()
    const evA = press({ key: "a", code: "KeyA", ctrlKey: true })
    expect(evA.defaultPrevented).toBe(true)
    await flush()
    const evY = press({ key: "y", code: "KeyY", ctrlKey: true })
    expect(evY.defaultPrevented).toBe(true)
    expect((storeStub.respondPermission as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["s1", "reject"],
      ["s1", "always"],
      ["s1", "once"],
    ])
  })

  it("Ctrl+A/Y 文本域聚焦让行（全选/redo 默认行为不动作不消费），N 照常；焦点离开文本域后 Y 恢复动作", async () => {
    render(
      <>
        <textarea aria-label="draft" />
        <PermissionCard permission={makePermission()} queueTotal={1} />
      </>,
    )
    const ta = document.querySelector("textarea")!
    const fromTa = (key: string, code: string) => {
      const ev = new KeyboardEvent("keydown", {
        key,
        code,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      act(() => {
        ta.dispatchEvent(ev)
      })
      return ev
    }
    const evA = fromTa("a", "KeyA")
    expect(evA.defaultPrevented).toBe(false)
    const evY = fromTa("y", "KeyY")
    expect(evY.defaultPrevented).toBe(false)
    expect(storeStub.respondPermission).not.toHaveBeenCalled()
    // 同场景下 N 无文本语义，照常动作（editable 让行仅限 A/Y）
    const evN = fromTa("n", "KeyN")
    expect(evN.defaultPrevented).toBe(true)
    expect(storeStub.respondPermission).toHaveBeenCalledWith("s1", "reject")
    await flush()
    // 焦点不在文本域（window 直发，target 非 Element）时 Y 恢复动作
    const evY2 = press({ key: "y", code: "KeyY", ctrlKey: true })
    expect(evY2.defaultPrevented).toBe(true)
    expect((storeStub.respondPermission as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["s1", "reject"],
      ["s1", "once"],
    ])
  })

  it("Shift/Alt/repeat/IME 组合/已消费事件不触发", () => {
    render(<PermissionCard permission={makePermission()} queueTotal={1} />)
    const evs = [
      press({ key: "n", code: "KeyN", ctrlKey: true, shiftKey: true }),
      press({ key: "a", code: "KeyA", ctrlKey: true, altKey: true }),
      press({ key: "y", code: "KeyY", ctrlKey: true, repeat: true }),
      press({ key: "n", code: "KeyN", ctrlKey: true, isComposing: true }),
    ]
    // 已 preventDefault 的事件（内层消费方先处理，如消息区 onKeySelectAll）不重复处理
    const consumed = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
      cancelable: true,
    })
    consumed.preventDefault()
    act(() => {
      window.dispatchEvent(consumed)
    })
    expect(evs.every((ev) => !ev.defaultPrevented)).toBe(true)
    expect(storeStub.respondPermission).not.toHaveBeenCalled()
  })

  it("回复中（在途请求未返回）不动作不消费", async () => {
    storeStub = makeStore({ respondPermission: vi.fn(() => new Promise(() => {})) })
    render(<PermissionCard permission={makePermission()} queueTotal={1} />)
    press({ key: "n", code: "KeyN", ctrlKey: true })
    await flush()
    const ev = press({ key: "a", code: "KeyA", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(storeStub.respondPermission).toHaveBeenCalledTimes(1)
  })

  it("收起后不动作（按钮不可见）", () => {
    render(<PermissionCard permission={makePermission()} queueTotal={1} />)
    fireEvent.click(document.querySelector(".pending-card-header")!)
    const ev = press({ key: "n", code: "KeyN", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(storeStub.respondPermission).not.toHaveBeenCalled()
  })

  it("overlay 遮挡不动作（§1.2 闸门语义）", () => {
    storeStub = makeStore({ overlayCount: 1 })
    render(<PermissionCard permission={makePermission()} queueTotal={1} />)
    const ev = press({ key: "n", code: "KeyN", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(storeStub.respondPermission).not.toHaveBeenCalled()
  })

  it("Ctrl 按住显示 N/A/Y 角标，松开消失", () => {
    render(<PermissionCard permission={makePermission()} queueTotal={1} />)
    press({ key: "Control", ctrlKey: true })
    expect(badges().map((el) => el.textContent)).toEqual(["N", "A", "Y"])
    releaseCtrl()
    expect(badges()).toHaveLength(0)
  })

  it("回复中不显示角标（同禁用态）", async () => {
    storeStub = makeStore({ respondPermission: vi.fn(() => new Promise(() => {})) })
    render(<PermissionCard permission={makePermission()} queueTotal={1} />)
    press({ key: "n", code: "KeyN", ctrlKey: true })
    await flush()
    press({ key: "Control", ctrlKey: true })
    expect(badges()).toHaveLength(0)
  })

  it("卸载后不再监听", () => {
    const { unmount } = render(<PermissionCard permission={makePermission()} queueTotal={1} />)
    unmount()
    press({ key: "n", code: "KeyN", ctrlKey: true })
    expect(storeStub.respondPermission).not.toHaveBeenCalled()
  })
})

describe("问题卡快捷键（design-keyboard-shortcuts §1.1b，2026-09-28 增）", () => {
  it("Ctrl+1/2 切换选项（radio 单选排他，与点击同 toggle 语义）", () => {
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    const ev1 = press({ key: "1", code: "Digit1", ctrlKey: true })
    expect(ev1.defaultPrevented).toBe(true)
    expect(optionActive()).toEqual([true, false])
    press({ key: "2", code: "Digit2", ctrlKey: true })
    expect(optionActive()).toEqual([false, true])
  })

  it("checkbox 多选：Ctrl+1/2 增选，再按 Ctrl+1 删选", () => {
    const q = makeQuestion({
      questions: [
        {
          question: "选哪些？",
          header: "多选",
          options: [
            { label: "是", description: "" },
            { label: "否", description: "" },
          ],
          multiple: true,
          custom: false,
        },
      ],
    })
    render(<QuestionCard question={q} queueTotal={1} />)
    press({ key: "1", code: "Digit1", ctrlKey: true })
    press({ key: "2", code: "Digit2", ctrlKey: true })
    expect(optionActive()).toEqual([true, true])
    press({ key: "1", code: "Digit1", ctrlKey: true })
    expect(optionActive()).toEqual([false, true])
  })

  it("Ctrl+Enter 提交（answers 含选中项）", () => {
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    press({ key: "1", code: "Digit1", ctrlKey: true })
    const ev = press({ key: "Enter", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(storeStub.replyQuestion).toHaveBeenCalledWith("que_1", [["是"]])
  })

  it("未选时 Ctrl+Enter 不动作不消费（同按钮禁用态）", () => {
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    const ev = press({ key: "Enter", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(storeStub.replyQuestion).not.toHaveBeenCalled()
  })

  it("多子问：Ctrl+Enter 步进，末步提交全部答案", () => {
    const q = makeQuestion({
      questions: [
        {
          question: "1?",
          header: "A",
          options: [
            { label: "是", description: "" },
            { label: "否", description: "" },
          ],
          multiple: false,
          custom: false,
        },
        {
          question: "2?",
          header: "B",
          options: [
            { label: "好", description: "" },
            { label: "差", description: "" },
          ],
          multiple: false,
          custom: false,
        },
      ],
    })
    render(<QuestionCard question={q} queueTotal={1} />)
    press({ key: "1", code: "Digit1", ctrlKey: true })
    press({ key: "Enter", ctrlKey: true })
    expect(document.querySelector(".pending-card-title")?.textContent).toBe("B")
    press({ key: "2", code: "Digit2", ctrlKey: true })
    press({ key: "Enter", ctrlKey: true })
    expect(storeStub.replyQuestion).toHaveBeenCalledWith("que_1", [["是"], ["差"]])
  })

  it("Ctrl+0 拒绝（preventDefault）", () => {
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    const ev = press({ key: "0", code: "Digit0", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(storeStub.rejectQuestion).toHaveBeenCalledWith("que_1")
  })

  it("未映射数字（超选项数）不消费", () => {
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    const ev = press({ key: "5", code: "Digit5", ctrlKey: true })
    expect(ev.defaultPrevented).toBe(false)
    expect(optionActive()).toEqual([false, false])
  })

  it("选项超过 9 个：仅前 9 项有快捷键角标", () => {
    const q = makeQuestion({
      questions: [
        {
          question: "?",
          header: "多选项",
          options: Array.from({ length: 10 }, (_, i) => ({ label: `选项${i + 1}`, description: "" })),
          multiple: false,
          custom: false,
        },
      ],
    })
    render(<QuestionCard question={q} queueTotal={1} />)
    press({ key: "Control", ctrlKey: true })
    expect(document.querySelectorAll(".pending-option .pending-key-badge")).toHaveLength(9)
  })

  it("回复中不动作", async () => {
    storeStub = makeStore({ replyQuestion: vi.fn(() => new Promise(() => {})) })
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    press({ key: "1", code: "Digit1", ctrlKey: true })
    press({ key: "Enter", ctrlKey: true })
    await flush()
    press({ key: "0", code: "Digit0", ctrlKey: true })
    expect(storeStub.rejectQuestion).not.toHaveBeenCalled()
    expect(storeStub.replyQuestion).toHaveBeenCalledTimes(1)
  })

  it("Shift/Alt/repeat 组合不触发", () => {
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    press({ key: "1", code: "Digit1", ctrlKey: true, shiftKey: true })
    press({ key: "1", code: "Digit1", ctrlKey: true, altKey: true })
    press({ key: "1", code: "Digit1", ctrlKey: true, repeat: true })
    expect(optionActive()).toEqual([false, false])
  })

  it("收起后不动作（再展开选中态不变）；overlay 遮挡不动作", () => {
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    fireEvent.click(document.querySelector(".pending-card-header")!)
    press({ key: "1", code: "Digit1", ctrlKey: true })
    // 再展开：收起期间的按键未改变选中态
    fireEvent.click(document.querySelector(".pending-card-header")!)
    expect(optionActive()).toEqual([false, false])
    cleanup()
    storeStub = makeStore({ overlayCount: 1 })
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    press({ key: "1", code: "Digit1", ctrlKey: true })
    expect(optionActive()).toEqual([false, false])
  })

  it("Ctrl 按住显示角标 [1,2,0]，选中后追加 ↵；松开消失", () => {
    render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    press({ key: "Control", ctrlKey: true })
    expect(badges().map((el) => el.textContent)).toEqual(["1", "2", "0"])
    press({ key: "1", code: "Digit1", ctrlKey: true })
    expect(badges().map((el) => el.textContent)).toEqual(["1", "2", "0", "↵"])
    releaseCtrl()
    expect(badges()).toHaveLength(0)
  })

  it("卸载后不再监听", () => {
    const { unmount } = render(<QuestionCard question={makeQuestion()} queueTotal={1} />)
    unmount()
    press({ key: "1", code: "Digit1", ctrlKey: true })
    press({ key: "Enter", ctrlKey: true })
    expect(storeStub.replyQuestion).not.toHaveBeenCalled()
  })
})
