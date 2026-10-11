import { describe, expect, it } from "vitest"
import { mergeMonotoneSessionTime, mergeSessionsSnapshot } from "./session-merge"
import type { Session } from "./api-types"

const ROOT = "/repo"
const WT = "/repo-wt"

function mk(id: string, directory: string, updated: number): Session {
  return {
    id,
    projectID: "p1",
    directory,
    title: id,
    time: { created: updated - 1000, updated },
  }
}

describe("mergeSessionsSnapshot", () => {
  it("REST 快照权威覆盖同 id", () => {
    const local = new Map([["a", mk("a", ROOT, 1)]])
    const next = mergeSessionsSnapshot(local, ROOT, [mk("a", ROOT, 2)])
    expect(next.get("a")?.time.updated).toBe(2)
  })

  it("回归：项目根快照不得把窗口内的 worktree 会话误判为已删除", () => {
    const local = new Map([
      ["r1", mk("r1", ROOT, 100)],
      ["r2", mk("r2", ROOT, 300)],
      ["wt1", mk("wt1", WT, 200)], // updated 落在根快照窗口内，但 directory 不同
    ])
    const next = mergeSessionsSnapshot(local, ROOT, [mk("r1", ROOT, 100), mk("r2", ROOT, 300)])
    expect(next.has("wt1")).toBe(true)
  })

  it("同 directory：窗口开区间内且不在快照 → 删除；边界与窗外 → 保留", () => {
    const local = new Map([
      ["a", mk("a", ROOT, 100)],
      ["b", mk("b", ROOT, 200)], // 窗口内，被删
      ["c", mk("c", ROOT, 300)], // 在快照中
      ["e", mk("e", ROOT, 300)], // == max 边界且不在快照：开区间不含端点，保留
      ["d", mk("d", ROOT, 400)], // 窗外（SSE-only 更新），保留
    ])
    const snap = [mk("a", ROOT, 100), mk("c", ROOT, 300)]
    const next = mergeSessionsSnapshot(local, ROOT, snap)
    expect(next.has("b")).toBe(false)
    expect(next.has("c")).toBe(true)
    expect(next.has("e")).toBe(true)
    expect(next.has("d")).toBe(true)
  })

  it("快照不足 2 条：同目录未命中会话保守保留（空快照不清空）", () => {
    const local = new Map([["a", mk("a", ROOT, 100)]])
    const next = mergeSessionsSnapshot(local, ROOT, [])
    expect(next.has("a")).toBe(true)
  })

  it("idle/viewed 单调：在途旧快照不回退本地乐观置位（design-unread-marker §4.1）", () => {
    const localSession: Session = {
      ...mk("a", ROOT, 2),
      time: { created: 1, updated: 2, idle: 200, viewed: 200 },
    }
    const local = new Map([["a", localSession]])
    // 快照是 POST /view 之前发出的旧值（viewed 缺省、idle 更旧）
    const stale: Session = { ...mk("a", ROOT, 2), time: { created: 1, updated: 2, idle: 150 } }
    const next = mergeSessionsSnapshot(local, ROOT, [stale])
    expect(next.get("a")?.time.viewed).toBe(200)
    expect(next.get("a")?.time.idle).toBe(200)
    // 其余字段仍取快照权威值（title/updated）
    expect(next.get("a")?.time.updated).toBe(2)
  })
})

describe("mergeMonotoneSessionTime", () => {
  it("prev 更新（乐观置位）不回退", () => {
    const prev = { created: 1, updated: 1, idle: 200, viewed: 200 }
    const next = { created: 1, updated: 2, idle: 100, viewed: 100 }
    expect(mergeMonotoneSessionTime(prev, next)).toEqual({ created: 1, updated: 2, idle: 200, viewed: 200 })
  })

  it("权威值前进时取 new", () => {
    const prev = { created: 1, updated: 1, idle: 100, viewed: 100 }
    const next = { created: 1, updated: 2, idle: 300, viewed: 250 }
    expect(mergeMonotoneSessionTime(prev, next)).toEqual({ created: 1, updated: 2, idle: 300, viewed: 250 })
  })

  it("单侧缺省不误造字段", () => {
    const prev = { created: 1, updated: 1 }
    const next = { created: 1, updated: 2, idle: 100 }
    expect(mergeMonotoneSessionTime(prev, next)).toEqual({ created: 1, updated: 2, idle: 100 })
    // prev 有而 next 无（在途补拉缺字段）→ 保留 prev
    expect(mergeMonotoneSessionTime({ created: 1, updated: 1, viewed: 9 }, { created: 1, updated: 2 })).toEqual({
      created: 1,
      updated: 2,
      viewed: 9,
    })
  })
})
