import { describe, expect, it } from "vitest"
import {
  buildFirstOpenMemory,
  deriveMemory,
  isSnapshotMissing,
  reconcileMemoryTabs,
  resolveRestoreActive,
} from "./scope-tab-memory"
import type { Session } from "./api-types"

const DIR = "/repo-wt"
const OTHER = "/repo"

function mk(
  id: string,
  opts: { created?: number; updated?: number; directory?: string } = {},
): Session {
  return {
    id,
    projectID: "p1",
    directory: opts.directory ?? DIR,
    time: { created: opts.created ?? 0, updated: opts.updated ?? opts.created ?? 0 },
  }
}

describe("buildFirstOpenMemory", () => {
  it("tabs 按 created 升序；active = updated 最大", () => {
    const a = mk("a", { created: 30, updated: 100 })
    const b = mk("b", { created: 10, updated: 300 }) // 最旧创建但最近活跃
    const c = mk("c", { created: 20, updated: 200 })
    const mem = buildFirstOpenMemory("p1", [a, b, c])
    expect(mem.tabs).toEqual(["b", "c", "a"])
    expect(mem.active).toBe("b")
  })

  it("空会话集 → 写入空记忆（空记忆 ≠ 无记忆，不触发下次首次打开）", () => {
    const mem = buildFirstOpenMemory("p1", [])
    expect(mem).toEqual({ projectId: "p1", tabs: [], active: null })
  })
})

describe("reconcileMemoryTabs（§17 收缩 + 补开）", () => {
  it("valid = mem.tabs ∩ 可见（保序）在前；记忆外可见会话按 created 升序追加尾部", () => {
    const mem = { projectId: "p1", tabs: ["x", "a", "y", "b"], active: "a" as string | null }
    const n2 = mk("n2", { created: 5 })
    const n1 = mk("n1", { created: 40 })
    const next = reconcileMemoryTabs(mem, [n1, mk("a"), n2, mk("b")])
    expect(next.tabs).toEqual(["a", "b", "n2", "n1"])
    expect(next.active).toBe("a")
  })

  it("active 失效（被归档/删除）→ 置 null，不因补开会话顶替（§7 末位回退）", () => {
    const mem = { projectId: "p1", tabs: ["x", "a"], active: "x" as string | null }
    const next = reconcileMemoryTabs(mem, [mk("a"), mk("n1", { created: 1 })])
    expect(next.tabs).toEqual(["a", "n1"])
    expect(next.active).toBeNull()
  })

  it("记忆全部失效但可见集非空 → created 升序全量补开；active 置 null（≠首次打开的 updated 最大，§7 末位回退）", () => {
    const mem = { projectId: "p1", tabs: ["x", "y"], active: "x" as string | null }
    const next = reconcileMemoryTabs(mem, [mk("n2", { created: 20 }), mk("n1", { created: 10 })])
    expect(next).toEqual({ projectId: "p1", tabs: ["n1", "n2"], active: null })
  })

  it("可见集为空 → 收缩为空记忆（保留条目，不删；不触发首次打开）", () => {
    const mem = { projectId: "p1", tabs: ["x", "y"], active: "x" as string | null }
    const next = reconcileMemoryTabs(mem, [])
    expect(next).toEqual({ projectId: "p1", tabs: [], active: null })
  })

  it("空记忆（零 Tab 哨兵）+ 新会话 → 补开（空作用域新会话唯一入口）", () => {
    const mem = { projectId: "p1", tabs: [], active: null }
    const next = reconcileMemoryTabs(mem, [mk("n1", { created: 1 })])
    expect(next).toEqual({ projectId: "p1", tabs: ["n1"], active: null })
  })
})

describe("isSnapshotMissing（防御闸门）", () => {
  const mem = { projectId: "p1", tabs: ["x"], active: "x" as string | null }

  it("记忆非空 + 可见空 + 目录全量空（快照从未落地）→ 触发", () => {
    expect(isSnapshotMissing(mem, [], [])).toBe(true)
  })

  it("可见空但全量非空（真被归档/删除，本地记录仍在）→ 不触发", () => {
    expect(isSnapshotMissing(mem, [], [mk("x", { created: 1 })])).toBe(false)
  })

  it("空记忆不触发（无 Tab 可恢复，无需闸门）", () => {
    expect(isSnapshotMissing({ ...mem, tabs: [] }, [], [])).toBe(false)
  })
})

describe("deriveMemory（live tabs → 记忆派生）", () => {
  const tabs = [
    { kind: "chat", key: "chat:a", directory: DIR },
    { kind: "file", key: "file:/x.ts" },
    { kind: "chat", key: "chat:b", directory: DIR },
    { kind: "chat", key: "chat:o", directory: OTHER }, // 其他作用域：不投影
  ]

  it("只投影该目录的 chat Tab（file/他目录过滤），激活 chat → active 派生", () => {
    const mem = deriveMemory("p1", DIR, tabs, "chat:a", null)
    expect(mem.tabs).toEqual(["a", "b"])
    expect(mem.active).toBe("a")
  })

  it("激活 file Tab → 不改写 active（保留原值，若仍在 tabs 中）", () => {
    const mem = deriveMemory("p1", DIR, tabs, "file:/x.ts", "b")
    expect(mem.active).toBe("b")
  })

  it("原 active 不在 tabs 中 → null；顺序 = live 顺序", () => {
    const mem = deriveMemory("p1", DIR, tabs, "file:/x.ts", "gone")
    expect(mem.active).toBeNull()
  })
})

describe("resolveRestoreActive（§7 激活规则，纯记忆解析；作用域归属判定在调用方）", () => {
  it("mem.active 有效 → 激活之（回到切走时的位置）", () => {
    expect(resolveRestoreActive({ projectId: "p1", tabs: ["a", "b", "c"], active: "b" })).toBe("b")
  })

  it("mem.active 失效 → valid 末位（最右）", () => {
    expect(resolveRestoreActive({ projectId: "p1", tabs: ["a", "b"], active: "gone" })).toBe("b")
  })

  it("valid 为空 → null（会话列表视图）", () => {
    expect(resolveRestoreActive({ projectId: "p1", tabs: [], active: null })).toBeNull()
  })
})
