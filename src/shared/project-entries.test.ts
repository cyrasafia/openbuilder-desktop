/**
 * v1→v2 持久化迁移层测试（M1b）：global\0<dir> 键/裸 "global"/currentProjectId
 * "global" → 项目 ID（按 worktree 匹配）；未匹配丢弃；幂等。
 */
import { describe, expect, it } from "vitest"
import {
  GLOBAL_ENTRY_PREFIX,
  globalDirectoryOfKey,
  migrateLegacyGlobalState,
  migrateLegacyMemoryProjectIds,
  migrateLegacyPersistedProjectIds,
  buildProjectIdentityIndex,
  dedupeProjectsByIdentity,
  isNewerProjectIdentity,
  normalizeOpenedIds,
  normalizeProjectId,
} from "./project-entries"

const PROJECTS = [
  { id: "p_git", worktree: "/repo" },
  { id: "p_hash", worktree: "/plain" },
  { id: "p_root", worktree: "/" },
]

describe("globalDirectoryOfKey", () => {
  it("v1 global entry 键解析出 directory；普通键返回 null", () => {
    expect(globalDirectoryOfKey(GLOBAL_ENTRY_PREFIX + "/plain")).toBe("/plain")
    expect(globalDirectoryOfKey("p_git")).toBeNull()
  })
})

describe("migrateLegacyGlobalState", () => {
  it("global\\0<dir> 键按 worktree 匹配转项目 ID（含伪项目行）", () => {
    const ps = { opened: [GLOBAL_ENTRY_PREFIX + "/plain", "p_git"], currentProjectId: null, currentWorkspaceId: null }
    expect(migrateLegacyGlobalState(ps, PROJECTS)).toBe(true)
    expect(ps.opened).toEqual(["p_hash", "p_git"])
  })

  it("未匹配的 global 键丢弃；裸 \"global\" 按根目录处理", () => {
    const ps = { opened: [GLOBAL_ENTRY_PREFIX + "/nowhere", "global"], currentProjectId: null, currentWorkspaceId: null }
    expect(migrateLegacyGlobalState(ps, PROJECTS)).toBe(true)
    // /nowhere 无项目行（零会话目录）丢弃；裸 "global" → worktree "/" 的项目
    expect(ps.opened).toEqual(["p_root"])
  })

  it("currentProjectId=global：按 currentWorkspaceId 目录转 ID 并归一 null", () => {
    const ps = { opened: [GLOBAL_ENTRY_PREFIX + "/plain"], currentProjectId: "global", currentWorkspaceId: "/plain" }
    expect(migrateLegacyGlobalState(ps, PROJECTS)).toBe(true)
    expect(ps.currentProjectId).toBe("p_hash")
    expect(ps.currentWorkspaceId).toBeNull()
  })

  it("currentProjectId=global 且目录未匹配：回退 null", () => {
    const ps = { opened: [], currentProjectId: "global", currentWorkspaceId: "/nowhere" }
    expect(migrateLegacyGlobalState(ps, PROJECTS)).toBe(true)
    expect(ps.currentProjectId).toBeNull()
  })

  it("去重：global 键迁移出的 ID 与既有同 ID 键合并", () => {
    const ps = { opened: [GLOBAL_ENTRY_PREFIX + "/plain", "p_hash"], currentProjectId: null, currentWorkspaceId: null }
    expect(migrateLegacyGlobalState(ps, PROJECTS)).toBe(true)
    expect(ps.opened).toEqual(["p_hash"])
  })

  it("幂等：无 global 键时不改写（false 且内容不动）", () => {
    const ps = { opened: ["p_git", "p_hash"], currentProjectId: "p_git", currentWorkspaceId: "/wt" }
    expect(migrateLegacyGlobalState(ps, PROJECTS)).toBe(false)
    expect(ps).toEqual({ opened: ["p_git", "p_hash"], currentProjectId: "p_git", currentWorkspaceId: "/wt" })
  })
})

describe("migrateLegacyMemoryProjectIds / migrateLegacyPersistedProjectIds", () => {
  const PROJECTS2 = [
    { id: "p_git", worktree: "/repo", sandboxes: ["/repo/.wt"] },
    { id: "p_hash", worktree: "/plain", sandboxes: [] },
  ]

  it("memory：global 归属按 worktree 匹配转 ID（全 profile 切片）", () => {
    const memory = {
      profA: { "/plain": { projectId: "global", tabs: ["s1"], active: "s1" } },
      profB: { "/repo": { projectId: "global", tabs: [], active: null } },
    }
    expect(migrateLegacyMemoryProjectIds(memory, PROJECTS2)).toBe(true)
    expect(memory.profA["/plain"]!.projectId).toBe("p_hash")
    expect(memory.profB["/repo"]!.projectId).toBe("p_git")
  })

  it("memory：sandboxes 认领 + 未命中保持原值 + 非 global 不动（幂等 false）", () => {
    const memory = {
      p: {
        "/repo/.wt": { projectId: "global", tabs: [], active: null },
        "/nowhere": { projectId: "global", tabs: [], active: null },
        "/repo": { projectId: "p_git", tabs: [], active: null },
      },
    }
    expect(migrateLegacyMemoryProjectIds(memory, PROJECTS2)).toBe(true)
    expect(memory.p["/repo/.wt"]!.projectId).toBe("p_git")
    expect(memory.p["/nowhere"]!.projectId).toBe("global")
    expect(migrateLegacyMemoryProjectIds(memory, PROJECTS2)).toBe(false)
  })

  it("persisted：投影条目 global 归属按 directory 归一；未命中保持", () => {
    const session = {
      p: {
        tabs: [
          { kind: "chat", key: "chat:s1", projectId: "global", directory: "/plain", title: "t" },
          { kind: "file", key: "file:/repo/a", projectId: "global", directory: "/repo/.wt", title: "a" },
          { kind: "file", key: "file:/nowhere/a", projectId: "global", directory: "/nowhere", title: "a" },
          { kind: "file", key: "file:/repo/b", projectId: "p_git", directory: "/repo", title: "b" },
        ],
        scopeActive: {},
      },
    }
    expect(migrateLegacyPersistedProjectIds(session, PROJECTS2)).toBe(true)
    expect(session.p.tabs.map((t) => t.projectId)).toEqual(["p_hash", "p_git", "global", "p_git"])
    expect(migrateLegacyPersistedProjectIds(session, PROJECTS2)).toBe(false)
  })
})

// ============ 项目身份归一化（design-project-identity §3.1，2026-11-09） ============

describe("项目身份归一化（design-project-identity）", () => {
  const row = (id: string, worktree: string, created: number) => ({ id, worktree, time: { created } })

  it("无分裂路径：索引为 null（快路径）——单行/空集/全异路径", () => {
    expect(buildProjectIdentityIndex([])).toBeNull()
    expect(buildProjectIdentityIndex([row("a", "/x", 1)])).toBeNull()
    expect(
      buildProjectIdentityIndex([row("a", "/x", 1), row("b", "/y", 2)]),
    ).toBeNull()
  })

  it("双行同路径：created 大者为当前行；旧行进 legacyToCurrent；currentByPath 记路径", () => {
    // server 序任意（active desc 抖动）——旧行在前也不影响判定
    const index = buildProjectIdentityIndex([
      row("old", "/repo", 100),
      row("cur", "/repo", 200),
    ])
    expect(index).not.toBeNull()
    expect(index!.currentByPath.get("/repo")).toBe("cur")
    expect(index!.legacyToCurrent.get("old")).toBe("cur")
    expect(index!.legacyToCurrent.has("cur")).toBe(false)
  })

  it("created 相同：id 字典序小者为当前行（确定性 tie-break）", () => {
    const index = buildProjectIdentityIndex([
      row("bbb", "/repo", 100),
      row("aaa", "/repo", 100),
    ])
    expect(index!.legacyToCurrent.get("bbb")).toBe("aaa")
  })

  it("normalizeProjectId：旧 id → 当前行；当前/未知 id 原样；null 索引原样", () => {
    const index = buildProjectIdentityIndex([row("old", "/repo", 1), row("cur", "/repo", 2)])
    expect(normalizeProjectId(index, "old")).toBe("cur")
    expect(normalizeProjectId(index, "cur")).toBe("cur")
    expect(normalizeProjectId(index, "unknown")).toBe("unknown")
    expect(normalizeProjectId(null, "old")).toBe("old")
  })

  it("normalizeOpenedIds：归一去重保位（旧 id 在前则占其首现位）；无变化返回原引用", () => {
    const index = buildProjectIdentityIndex([row("old", "/repo", 1), row("cur", "/repo", 2)])
    // 旧 id 在前：当前行占据旧 id 的首现位置（用户排序不因归一重排）
    expect(normalizeOpenedIds(index, ["old", "cur", "x"])).toEqual(["cur", "x"])
    expect(normalizeOpenedIds(index, ["cur", "old", "x"])).toEqual(["cur", "x"])
    // 未知 id 原样保留（不丢弃——与 global 迁移的丢弃语义不同）
    expect(normalizeOpenedIds(index, ["gone", "cur"])).toEqual(["gone", "cur"])
    const untouched = ["cur", "x"]
    expect(normalizeOpenedIds(index, untouched)).toBe(untouched)
    const nullIndexList = ["old"]
    expect(normalizeOpenedIds(null, nullIndexList)).toBe(nullIndexList)
  })

  it("dedupeProjectsByIdentity：每路径取当前行（created 最大），输出保持首见序", () => {
    const out = dedupeProjectsByIdentity([
      row("oldA", "/a", 1),
      row("oldB", "/b", 1),
      row("curA", "/a", 2),
      row("c", "/c", 1),
    ])
    // /a 取 curA；序 = 路径首现序（/a, /b, /c）
    expect(out.map((p) => p.id)).toEqual(["curA", "oldB", "c"])
  })

  it("isNewerProjectIdentity：created 大者新；同 created id 小者新", () => {
    expect(isNewerProjectIdentity(row("z", "/r", 2), row("a", "/r", 1))).toBe(true)
    expect(isNewerProjectIdentity(row("z", "/r", 1), row("a", "/r", 2))).toBe(false)
    expect(isNewerProjectIdentity(row("a", "/r", 1), row("z", "/r", 1))).toBe(true)
    expect(isNewerProjectIdentity(row("z", "/r", 1), row("a", "/r", 1))).toBe(false)
  })
})
