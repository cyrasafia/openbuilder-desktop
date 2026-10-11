/**
 * 会话状态指示器（design-indicator-aggregate-chip，2026-10-11 重设计）测试：
 * - ≤4 逐会话状态点：按列表序渲染 session-* 变体类；
 * - >4 聚合计数 chip：状态圆点领头 + 中性数字（无状态变体类），渲染序对齐移动端
 *   裁定（running → error → failed → waiting → unread → idle），为 0 的态省略；
 * - 未读纳入 chip：idle 计数扣未读，chip 数字之和 = 会话总数。
 */
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionIndicator } from "./sidebar"
import type { Session } from "@shared/api-types"
import type { SessionDotState } from "@shared/pending-requests"

/** id → dot 状态（store stub 数据面；缺省 idle） */
const stateFor: Record<string, SessionDotState> = {}

vi.mock("../app", () => ({
  useI18n: () => ({
    t: {
      sessionIndicatorTitle:
        "会话 {count}，进行中 {busy}，重试 {error}，失败 {failed}，待输入 {waiting}，未读 {unread}",
    },
    locale: "zh" as const,
  }),
  useStore: () => ({ dotStateFor: (id: string) => stateFor[id] ?? "idle" }),
}))

/** 投影只消费 id；其余字段与本组件无关 */
const session = (id: string): Session => ({ id }) as Session

function setStates(map: Record<string, SessionDotState>) {
  for (const k of Object.keys(stateFor)) delete stateFor[k]
  Object.assign(stateFor, map)
}

afterEach(() => {
  cleanup()
})

describe("SessionIndicator ≤4 逐会话状态点", () => {
  it("按列表序渲染 session-* 变体类，不出现聚合 chip", () => {
    setStates({ s1: "waiting", s2: "running", s3: "unread", s4: "idle" })
    const { container } = render(
      <SessionIndicator sessions={[session("s1"), session("s2"), session("s3"), session("s4")]} />,
    )
    const dots = container.querySelectorAll(".session-indicator > .status-dot")
    expect([...dots].map((d) => d.className)).toEqual([
      "status-dot session-waiting",
      "status-dot session-running",
      "status-dot session-unread",
      "status-dot session-idle",
    ])
    expect(container.querySelector(".session-count")).toBeNull()
  })
})

describe("SessionIndicator >4 聚合计数 chip", () => {
  it("圆点领头 + 数字，渲染序对齐移动端裁定，为 0 的态省略", () => {
    setStates({
      s1: "idle",
      s2: "running",
      s3: "error",
      s4: "running",
      s5: "failed",
      s6: "idle",
      s7: "idle",
      s8: "idle",
    })
    const { container } = render(
      <SessionIndicator
        sessions={["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map(session)}
      />,
    )
    const chips = [...container.querySelectorAll(".session-count")]
    // 序：running → error → failed → waiting(0 省) → unread(0 省) → idle
    expect(chips.map((c) => c.textContent)).toEqual(["2", "1", "1", "4"])
    expect(chips.map((c) => c.querySelector(".status-dot")?.className)).toEqual([
      "status-dot session-running",
      "status-dot session-error",
      "status-dot session-failed",
      "status-dot session-idle",
    ])
    // chip 本体不再按状态分支（变体类已删，状态类只在圆点上）
    expect(chips.every((c) => /^session-count$/.test(c.className))).toBe(true)
  })

  it("未读纳入 chip：idle 扣未读，chip 数字之和 = 会话总数", () => {
    setStates({ s1: "running", s2: "unread", s3: "waiting", s4: "idle", s5: "idle" })
    const { container } = render(
      <SessionIndicator sessions={["s1", "s2", "s3", "s4", "s5"].map(session)} />,
    )
    const chips = [...container.querySelectorAll(".session-count")]
    expect(chips.map((c) => c.textContent)).toEqual(["1", "1", "1", "2"])
    expect(chips.map((c) => c.querySelector(".status-dot")?.className)).toEqual([
      "status-dot session-running",
      "status-dot session-waiting",
      "status-dot session-unread",
      "status-dot session-idle",
    ])
    const sum = chips.reduce((acc, c) => acc + Number(c.textContent), 0)
    expect(sum).toBe(5)
  })
})
