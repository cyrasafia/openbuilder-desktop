import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useSelectionRestore } from "./selection-restore"

/** 独立 DOM 元素（save/restore 仅依赖元素 API，无需挂载组件树） */
function makeInput(value: string, start: number, end: number) {
  const el = document.createElement("input")
  el.value = value
  el.setSelectionRange(start, end)
  return el
}

/**
 * useSelectionRestore（编辑会话保存/恢复，2026-09-30）：失焦保存 value+选区，
 * 回焦 value 未变恢复选区；value 已变/无保存/显式 clear 均走默认（false）
 */
describe("useSelectionRestore", () => {
  it("save→restore：value 未变恢复选区并返回 true", () => {
    const { result } = renderHook(() => useSelectionRestore())
    const a = makeInput("草稿内容abc", 2, 5)
    result.current.save(a)
    const b = makeInput("草稿内容abc", 0, 0)
    expect(result.current.restore(b)).toBe(true)
    expect(b.selectionStart).toBe(2)
    expect(b.selectionEnd).toBe(5)
  })

  it("无保存：restore 返回 false（首次聚焦走默认）", () => {
    const { result } = renderHook(() => useSelectionRestore())
    expect(result.current.restore(makeInput("x", 0, 0))).toBe(false)
  })

  it("value 已变：restore 返回 false 且清除保存（会话结束，连续第二次亦 false）", () => {
    const { result } = renderHook(() => useSelectionRestore())
    result.current.save(makeInput("旧草稿", 1, 1))
    expect(result.current.restore(makeInput("新页面URL", 0, 0))).toBe(false)
    expect(result.current.restore(makeInput("旧草稿", 0, 0))).toBe(false)
  })

  it("clear：显式结束会话，restore 返回 false", () => {
    const { result } = renderHook(() => useSelectionRestore())
    result.current.save(makeInput("草稿", 0, 0))
    result.current.clear()
    expect(result.current.restore(makeInput("草稿", 0, 0))).toBe(false)
  })

  it("连续 save 保留最后一次（同一会话多次 blur）", () => {
    const { result } = renderHook(() => useSelectionRestore())
    result.current.save(makeInput("草稿abc", 0, 0))
    result.current.save(makeInput("草稿abc", 3, 3))
    const el = makeInput("草稿abc", 0, 0)
    expect(result.current.restore(el)).toBe(true)
    expect(el.selectionStart).toBe(3)
  })
})
