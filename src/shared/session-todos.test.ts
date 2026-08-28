/** session-todos 归一化与投影（design-task-list） */
import { describe, expect, it } from "vitest"
import { normalizeTodoList, todoActive, todoDone, todosActive } from "./session-todos"

describe("normalizeTodoList", () => {
  it("合法负载逐条解析", () => {
    expect(
      normalizeTodoList([
        { content: "a", status: "in_progress", priority: "high" },
        { content: "b", status: "completed", priority: "low" },
      ]),
    ).toEqual([
      { content: "a", status: "in_progress", priority: "high" },
      { content: "b", status: "completed", priority: "low" },
    ])
  })

  it("非数组 / 空数组 → 空表", () => {
    expect(normalizeTodoList(undefined)).toEqual([])
    expect(normalizeTodoList(null)).toEqual([])
    expect(normalizeTodoList({})).toEqual([])
    expect(normalizeTodoList([])).toEqual([])
  })

  it("非对象条目与缺 content 条目丢弃", () => {
    expect(normalizeTodoList(["x", 3, null, { status: "pending" }, { content: "" }])).toEqual([])
    expect(normalizeTodoList([{ content: "ok" }, { nope: 1 }])).toEqual([
      { content: "ok", status: "pending", priority: "medium" },
    ])
  })

  it("status/priority 缺省回退 pending/medium", () => {
    expect(normalizeTodoList([{ content: "a" }, { content: "b", status: 1, priority: [] }])).toEqual([
      { content: "a", status: "pending", priority: "medium" },
      { content: "b", status: "pending", priority: "medium" },
    ])
  })
})

describe("完成/进行中投影", () => {
  it("completed 与 cancelled 均为 done（cancelled 不占用未完成）", () => {
    expect(todoDone({ content: "x", status: "completed", priority: "low" })).toBe(true)
    expect(todoDone({ content: "x", status: "cancelled", priority: "low" })).toBe(true)
    expect(todoDone({ content: "x", status: "pending", priority: "low" })).toBe(false)
    expect(todoDone({ content: "x", status: "in_progress", priority: "low" })).toBe(false)
  })

  it("todoActive 仅 in_progress", () => {
    expect(todoActive({ content: "x", status: "in_progress", priority: "low" })).toBe(true)
    expect(todoActive({ content: "x", status: "pending", priority: "low" })).toBe(false)
  })
})

describe("todosActive 展示闸门", () => {
  it("空表 / 全部完成 / 完成混取消 → 隐藏（false）", () => {
    expect(todosActive([])).toBe(false)
    expect(
      todosActive([
        { content: "a", status: "completed", priority: "low" },
        { content: "b", status: "cancelled", priority: "low" },
      ]),
    ).toBe(false)
  })

  it("存在任一未完成 → 显示（true）", () => {
    expect(
      todosActive([
        { content: "a", status: "completed", priority: "low" },
        { content: "b", status: "in_progress", priority: "low" },
      ]),
    ).toBe(true)
  })
})
