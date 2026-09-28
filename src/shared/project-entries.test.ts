/**
 * v1→v2 持久化迁移层测试（M1b）：global\0<dir> 键/裸 "global"/currentProjectId
 * "global" → 项目 ID（按 worktree 匹配）；未匹配丢弃；幂等。
 */
import { describe, expect, it } from "vitest"
import { GLOBAL_ENTRY_PREFIX, globalDirectoryOfKey, migrateLegacyGlobalState } from "./project-entries"

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
