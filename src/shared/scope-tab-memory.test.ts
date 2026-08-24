import { describe, expect, it } from "vitest"
import {
  buildFirstOpenMemory,
  deriveMemory,
  isSnapshotMissing,
  resolveRestoreActive,
  shrinkMemoryTabs,
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

describe("shrinkMemoryTabs", () => {
  it("valid = mem.tabs ∩ 可见会话（保序）；记忆外会话不补开", () => {
    const mem = { projectId: "p1", tabs: ["x", "a", "y", "b"], active: "a" as string | null }
    const next = shrinkMemoryTabs(mem, [mk("a"), mk("b")])
    expect(next.tabs).toEqual(["a", "b"])
    expect(next.active).toBe("a")
  })

  it("active 失效（被归档/删除）→ 置 null", () => {
    const mem = { projectId: "p1", tabs: ["x", "a"], active: "x" as string | null }
    const next = shrinkMemoryTabs(mem, [mk("a")])
    expect(next.tabs).toEqual(["a"])
    expect(next.active).toBeNull()
  })

  it("全部失效 → 收缩为空记忆（保留条目，不删）", () => {
    const mem = { projectId: "p1", tabs: ["x", "y"], active: "x" as string | null }
    const next = shrinkMemoryTabs(mem, [])
    expect(next).toEqual({ projectId: "p1", tabs: [], active: null })
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

describe("resolveRestoreActive（§7 激活规则）", () => {
  it("file Tab 已激活 → 保持（undefined）", () => {
    expect(resolveRestoreActive({ projectId: "p1", tabs: ["a"], active: "a" }, "file")).toBeUndefined()
  })

  it("mem.active 有效 → 激活之（回到切走时的位置）", () => {
    expect(
      resolveRestoreActive({ projectId: "p1", tabs: ["a", "b", "c"], active: "b" }, "chat"),
    ).toBe("b")
  })

  it("mem.active 失效 → valid 末位（最右）", () => {
    expect(
      resolveRestoreActive({ projectId: "p1", tabs: ["a", "b"], active: "gone" }, null),
    ).toBe("b")
  })

  it("valid 为空 → null（会话列表视图）", () => {
    expect(resolveRestoreActive({ projectId: "p1", tabs: [], active: null }, "chat")).toBeNull()
  })
})
