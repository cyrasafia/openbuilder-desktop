/**
 * 表单卡（v2 form 体系，M6a）交互测试：字段类型渲染、前进门控
 * （Q-7：当前步未答不得前进）、提交构造（replyQuestion 携带 UI 原始输入，
 * answer 由 store 层 buildFormAnswer 构造——本测试只断言原始输入透传）。
 * ResizeObserver/IntersectionObserver jsdom 缺失，补 stub（workspace 模块图所需）。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { QuestionCard } from "./workspace"
import { CUSTOM_OPTION_VALUE } from "@shared/pending-requests"
import type { PendingQuestion } from "@shared/pending-requests"

let storeStub: Record<string, unknown>
let replyCalls: Array<[string, Record<number, unknown>]> = []
let rejectCalls: string[] = []

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      formYes: "是",
      formNo: "否",
      formCustomAnswer: "其他（自定义答案）",
      reject: "拒绝",
      questionSubmit: "提交",
      questionNext: "下一步",
      pendingQueue: "1/{total} 待处理",
      replyFailed: "操作失败",
    },
    locale: "zh" as const,
  }),
  useStore: () => storeStub,
}))

function form(fields: PendingQuestion["fields"]): PendingQuestion {
  return { id: "frm_1", sessionID: "ses_1", title: "表单", fields, directory: "/r" }
}

function makeStore() {
  return {
    replyQuestion: async (id: string, input: Record<number, unknown>) => {
      replyCalls.push([id, input])
      return { ok: true }
    },
    rejectQuestion: async (id: string) => {
      rejectCalls.push(id)
      return { ok: true }
    },
  }
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver
})

beforeEach(() => {
  replyCalls = []
  rejectCalls = []
  storeStub = makeStore()
})

afterEach(() => {
  cleanup()
})

describe("QuestionCard（v2 form，M6a）", () => {
  it("boolean 字段：合成是/否选项，未选禁用前进，选中还原 value", () => {
    render(
      <QuestionCard
        question={form([{ key: "f", question: "继续？", description: "", kind: "boolean", options: [], placeholder: "", required: false, custom: false }])}
        queueTotal={1}
      />,
    )
    expect(screen.getByText("是")).toBeTruthy()
    expect(screen.getByText("否")).toBeTruthy()
    const next = screen.getByRole("button", { name: "提交" })
    expect(next.hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByText("是"))
    expect(next.hasAttribute("disabled")).toBe(false)
    fireEvent.click(next)
    expect(replyCalls).toEqual([["frm_1", { 0: { selected: ["true"], text: "", customText: "" } }]])
  })

  it("select + text 步进：选项步选后前进，required 文本步空禁用", () => {
    render(
      <QuestionCard
        question={form([
          { key: "b", question: "选分支", description: "", kind: "select", options: [{ value: "main", label: "main", description: "" }, { value: "dev", label: "dev", description: "" }], placeholder: "", required: false, custom: false },
          { key: "why", question: "原因", description: "", kind: "text", options: [], placeholder: "必填", required: true, custom: false },
        ])}
        queueTotal={1}
      />,
    )
    fireEvent.click(screen.getByText("dev"))
    fireEvent.click(screen.getByRole("button", { name: "下一步" }))
    // 第二步：required 文本空 → 提交禁用
    const submit = screen.getByRole("button", { name: "提交" })
    expect(submit.hasAttribute("disabled")).toBe(true)
    fireEvent.change(screen.getByPlaceholderText("必填"), { target: { value: "理由" } })
    expect(submit.hasAttribute("disabled")).toBe(false)
    fireEvent.click(submit)
    expect(replyCalls).toEqual([
      ["frm_1", { 0: { selected: ["dev"], text: "", customText: "" }, 1: { selected: [], text: "理由", customText: "" } }],
    ])
  })

  it("非 required 文本步可空提交（value 兜底空串由 buildFormAnswer 处理）", () => {
    render(
      <QuestionCard
        question={form([{ key: "n", question: "次数", description: "", kind: "number", options: [], placeholder: "", required: false, custom: false }])}
        queueTotal={1}
      />,
    )
    const submit = screen.getByRole("button", { name: "提交" })
    expect(submit.hasAttribute("disabled")).toBe(false)
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "3" } })
    fireEvent.click(submit)
    expect(replyCalls).toEqual([["frm_1", { 0: { selected: [], text: "3", customText: "" } }]])
  })

  it("拒绝按钮 → rejectQuestion", () => {
    render(
      <QuestionCard
        question={form([{ key: "f", question: "q", description: "", kind: "boolean", options: [], placeholder: "", required: false, custom: false }])}
        queueTotal={1}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }))
    expect(rejectCalls).toEqual(["frm_1"])
    expect(replyCalls).toHaveLength(0)
  })

  it("custom:false 选项式字段不渲染「其他」行", () => {
    render(
      <QuestionCard
        question={form([{ key: "b", question: "选分支", description: "", kind: "select", options: [{ value: "main", label: "main", description: "" }], placeholder: "", required: false, custom: false }])}
        queueTotal={1}
      />,
    )
    expect(screen.queryByText("其他（自定义答案）")).toBeNull()
  })

  it("custom select：末尾「其他」行选中后输入框替代标题（placeholder 用标题文案），空文本禁用提交（T1）", () => {
    render(
      <QuestionCard
        question={form([{ key: "b", question: "选分支", description: "", kind: "select", options: [{ value: "main", label: "main", description: "" }], placeholder: "自定义分支名", required: false, custom: true }])}
        queueTotal={1}
      />,
    )
    // 未选中：标题文案可见、无输入框、提交禁用
    expect(screen.getByText("其他（自定义答案）")).toBeTruthy()
    expect(screen.queryByPlaceholderText("其他（自定义答案）")).toBeNull()
    const submit = screen.getByRole("button", { name: "提交" })
    expect(submit.hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByText("其他（自定义答案）"))
    // 选中：标题替代为输入框（placeholder = 标题文案）；文本空 → 提交仍禁用
    const input = screen.getByPlaceholderText("其他（自定义答案）")
    expect(screen.queryByText("其他（自定义答案）")).toBeNull()
    expect(submit.hasAttribute("disabled")).toBe(true)
    fireEvent.change(input, { target: { value: "feat/x" } })
    expect(submit.hasAttribute("disabled")).toBe(false)
    fireEvent.click(submit)
    expect(replyCalls).toEqual([
      ["frm_1", { 0: { selected: [CUSTOM_OPTION_VALUE], text: "", customText: "feat/x" } }],
    ])
  })

  it("custom multiselect：「其他」与既有选项并列，选中后输入框替代标题，提交时哨兵+文本进入选中数组", () => {
    render(
      <QuestionCard
        question={form([{ key: "tags", question: "附加标签", description: "", kind: "multiselect", options: [{ value: "Diff", label: "Diff", description: "" }], placeholder: "", required: false, custom: true }])}
        queueTotal={1}
      />,
    )
    fireEvent.click(screen.getByText("Diff"))
    fireEvent.click(screen.getByText("其他（自定义答案）"))
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "note" } })
    fireEvent.click(screen.getByRole("button", { name: "提交" }))
    expect(replyCalls).toEqual([
      ["frm_1", { 0: { selected: ["Diff", CUSTOM_OPTION_VALUE], text: "", customText: "note" } }],
    ])
  })

  it("custom select 切回既有选项：radio 排他清哨兵，输入框消失回标题、customText 不参与答案", () => {
    render(
      <QuestionCard
        question={form([{ key: "b", question: "选分支", description: "", kind: "select", options: [{ value: "main", label: "main", description: "" }], placeholder: "", required: false, custom: true }])}
        queueTotal={1}
      />,
    )
    fireEvent.click(screen.getByText("其他（自定义答案）"))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "已输入但不提交" } })
    // radio 语义切回 main：哨兵被清，输入框换回标题
    fireEvent.click(screen.getByText("main"))
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText("其他（自定义答案）")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "提交" }))
    expect(replyCalls).toEqual([
      ["frm_1", { 0: { selected: ["main"], text: "", customText: "已输入但不提交" } }],
    ])
  })
})
