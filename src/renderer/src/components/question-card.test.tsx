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
      formExternalNotice: "此表单包含需在外部完成的授权步骤，提交即确认继续。",
      formAutoNotice: "此表单包含由服务端自动处理的字段，提交即确认继续。",
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
        question={form([{ key: "f", question: "继续？", description: "", kind: "boolean", options: [], placeholder: "", required: false, custom: false, hidden: false }])}
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
          { key: "b", question: "选分支", description: "", kind: "select", options: [{ value: "main", label: "main", description: "" }, { value: "dev", label: "dev", description: "" }], placeholder: "", required: false, custom: false, hidden: false },
          { key: "why", question: "原因", description: "", kind: "text", options: [], placeholder: "必填", required: true, custom: false, hidden: false },
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
        question={form([{ key: "n", question: "次数", description: "", kind: "number", options: [], placeholder: "", required: false, custom: false, hidden: false }])}
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
        question={form([{ key: "f", question: "q", description: "", kind: "boolean", options: [], placeholder: "", required: false, custom: false, hidden: false }])}
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
        question={form([{ key: "b", question: "选分支", description: "", kind: "select", options: [{ value: "main", label: "main", description: "" }], placeholder: "", required: false, custom: false, hidden: false }])}
        queueTotal={1}
      />,
    )
    expect(screen.queryByText("其他（自定义答案）")).toBeNull()
  })

  it("custom select：末尾「其他」行选中后输入框替代标题（placeholder 用标题文案），空文本禁用提交（T1）", () => {
    render(
      <QuestionCard
        question={form([{ key: "b", question: "选分支", description: "", kind: "select", options: [{ value: "main", label: "main", description: "" }], placeholder: "自定义分支名", required: false, custom: true, hidden: false }])}
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
        question={form([{ key: "tags", question: "附加标签", description: "", kind: "multiselect", options: [{ value: "Diff", label: "Diff", description: "" }], placeholder: "", required: false, custom: true, hidden: false }])}
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
        question={form([{ key: "b", question: "选分支", description: "", kind: "select", options: [{ value: "main", label: "main", description: "" }], placeholder: "", required: false, custom: true, hidden: false }])}
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

describe("QuestionCard hidden/external 步进（T5）", () => {
  it("hidden/external 不进步进：可见步直提，input 含全字段空槽（补键在 store 层）", () => {
    render(
      <QuestionCard
        question={form([
          { key: "v", question: "继续？", description: "", kind: "boolean", options: [], placeholder: "", required: false, custom: false, hidden: false },
          { key: "h", question: "隐藏必填", description: "", kind: "text", options: [], placeholder: "", required: true, custom: false, hidden: true, defaultValue: "auto" },
          { key: "e", question: "授权", description: "", kind: "external", options: [], placeholder: "", required: false, custom: false, hidden: false },
        ])}
        queueTotal={1}
      />,
    )
    // 可见步仅 1 步：无步进计数、无隐藏/外部字段的问题文本
    expect(screen.queryByText("1/1")).toBeNull()
    expect(screen.queryByText("隐藏必填")).toBeNull()
    expect(screen.queryByText("授权")).toBeNull()
    fireEvent.click(screen.getByText("是"))
    fireEvent.click(screen.getByRole("button", { name: "提交" }))
    expect(replyCalls).toEqual([
      [
        "frm_1",
        {
          0: { selected: ["true"], text: "", customText: "" },
          1: { selected: [], text: "", customText: "" },
          2: { selected: [], text: "", customText: "" },
        },
      ],
    ])
  })

  it("全 external 卡：单步授权提示，提交键恒可用，提交即 ack", () => {
    render(
      <QuestionCard
        question={form([{ key: "e1", question: "授权", description: "", kind: "external", options: [], placeholder: "", required: false, custom: false, hidden: false }])}
        queueTotal={1}
      />,
    )
    expect(screen.getByText("此表单包含需在外部完成的授权步骤，提交即确认继续。")).toBeTruthy()
    expect(screen.queryByRole("textbox")).toBeNull()
    const submit = screen.getByRole("button", { name: "提交" })
    expect(submit.hasAttribute("disabled")).toBe(false)
    fireEvent.click(submit)
    expect(replyCalls).toEqual([["frm_1", { 0: { selected: [], text: "", customText: "" } }]])
  })

  it("ack-only 混合卡（hidden+external）：external 授权提示优先于自动处理提示", () => {
    render(
      <QuestionCard
        question={form([
          { key: "h", question: "隐藏", description: "", kind: "text", options: [], placeholder: "", required: false, custom: false, hidden: true },
          { key: "e", question: "授权", description: "", kind: "external", options: [], placeholder: "", required: false, custom: false, hidden: false },
        ])}
        queueTotal={1}
      />,
    )
    expect(screen.getByText("此表单包含需在外部完成的授权步骤，提交即确认继续。")).toBeTruthy()
    expect(screen.queryByText("此表单包含由服务端自动处理的字段，提交即确认继续。")).toBeNull()
  })

  it("全 hidden 非 required 卡：自动处理提示，提交即空 answer（省键）", () => {
    render(
      <QuestionCard
        question={form([{ key: "h", question: "隐藏", description: "", kind: "text", options: [], placeholder: "", required: false, custom: false, hidden: true }])}
        queueTotal={1}
      />,
    )
    expect(screen.getByText("此表单包含由服务端自动处理的字段，提交即确认继续。")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "提交" }))
    expect(replyCalls).toEqual([["frm_1", { 0: { selected: [], text: "", customText: "" } }]])
  })

  it("hidden+required+default 空降级可见步：required 门控生效，填写后提交", () => {
    render(
      <QuestionCard
        question={form([{ key: "dg", question: "必填隐藏项", description: "", kind: "text", options: [], placeholder: "必填", required: true, custom: false, hidden: true, defaultValue: "" }])}
        queueTotal={1}
      />,
    )
    expect(screen.getByText("必填隐藏项")).toBeTruthy()
    const submit = screen.getByRole("button", { name: "提交" })
    expect(submit.hasAttribute("disabled")).toBe(true)
    fireEvent.change(screen.getByPlaceholderText("必填"), { target: { value: "用户填" } })
    expect(submit.hasAttribute("disabled")).toBe(false)
    fireEvent.click(submit)
    expect(replyCalls).toEqual([["frm_1", { 0: { selected: [], text: "用户填", customText: "" } }]])
  })

  it("hidden+required+default 非空不降级：不出现在步进（ack 补键由 store 层构造）", () => {
    render(
      <QuestionCard
        question={form([
          { key: "h", question: "有默认值", description: "", kind: "text", options: [], placeholder: "", required: true, custom: false, hidden: true, defaultValue: "auto" },
          { key: "v", question: "可见？", description: "", kind: "boolean", options: [], placeholder: "", required: false, custom: false, hidden: false },
        ])}
        queueTotal={1}
      />,
    )
    expect(screen.queryByText("有默认值")).toBeNull()
    expect(screen.getByText("可见？")).toBeTruthy()
  })

  it("同 id 载荷步数变短钳制：渲染末步不崩溃、选中态保留", () => {
    const a: PendingQuestion["fields"][number] = { key: "a", question: "甲？", description: "", kind: "boolean", options: [], placeholder: "", required: false, custom: false, hidden: false }
    const b: PendingQuestion["fields"][number] = { key: "b", question: "乙？", description: "", kind: "boolean", options: [], placeholder: "", required: false, custom: false, hidden: false }
    const { rerender } = render(<QuestionCard question={form([a, b])} queueTotal={1} />)
    fireEvent.click(screen.getByText("是"))
    fireEvent.click(screen.getByRole("button", { name: "下一步" }))
    // 同 id 载荷重新归一化后步数 2 → 1（hidden 判定变化/字段缩减）
    rerender(<QuestionCard question={form([a])} queueTotal={1} />)
    const submit = screen.getByRole("button", { name: "提交" })
    fireEvent.click(submit)
    expect(replyCalls).toEqual([["frm_1", { 0: { selected: ["true"], text: "", customText: "" } }]])
  })
})
