import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IME_REFOCUS_WINDOW_MS, useImeBlurDebounce } from "./ime-refocus"

/**
 * useImeBlurDebounce（IME 切换 blur→focus 反弹窗口判定，2026-09-30）：
 * 三条路径——窗口内回焦取消挂起动作（反弹）、窗口外执行（真实失焦）、
 * 主动 cancel 使挂起动作失效（Enter 导航防覆写乐观展示）
 */
describe("useImeBlurDebounce", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("真实失焦：窗口外执行挂起动作", () => {
    const action = vi.fn()
    const { result } = renderHook(() => useImeBlurDebounce())
    result.current.defer(action)
    expect(action).not.toHaveBeenCalled()
    vi.advanceTimersByTime(IME_REFOCUS_WINDOW_MS - 1)
    expect(action).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(action).toHaveBeenCalledTimes(1)
  })

  it("IME 反弹：窗口内回焦取消挂起动作，refocus 返回 true", () => {
    const action = vi.fn()
    const { result } = renderHook(() => useImeBlurDebounce())
    result.current.defer(action)
    vi.advanceTimersByTime(IME_REFOCUS_WINDOW_MS - 1)
    expect(result.current.refocus()).toBe(true)
    vi.advanceTimersByTime(IME_REFOCUS_WINDOW_MS * 2)
    expect(action).not.toHaveBeenCalled()
  })

  it("无挂起动作时 refocus 返回 false（真实聚焦走全选等常规逻辑）", () => {
    const { result } = renderHook(() => useImeBlurDebounce())
    expect(result.current.refocus()).toBe(false)
  })

  it("cancel：主动使挂起动作失效", () => {
    const action = vi.fn()
    const { result } = renderHook(() => useImeBlurDebounce())
    result.current.defer(action)
    result.current.cancel()
    vi.advanceTimersByTime(IME_REFOCUS_WINDOW_MS * 2)
    expect(action).not.toHaveBeenCalled()
  })

  it("重复 defer：只保留最后一次挂起（连续 blur 不叠加）", () => {
    const first = vi.fn()
    const second = vi.fn()
    const { result } = renderHook(() => useImeBlurDebounce())
    result.current.defer(first)
    vi.advanceTimersByTime(50)
    result.current.defer(second)
    vi.advanceTimersByTime(IME_REFOCUS_WINDOW_MS)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("卸载清理挂起计时器", () => {
    const action = vi.fn()
    const { result, unmount } = renderHook(() => useImeBlurDebounce())
    result.current.defer(action)
    unmount()
    vi.advanceTimersByTime(IME_REFOCUS_WINDOW_MS * 2)
    expect(action).not.toHaveBeenCalled()
  })
})
