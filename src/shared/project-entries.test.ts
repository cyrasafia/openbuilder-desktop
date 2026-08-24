import { describe, expect, it } from "vitest"
import {
  GLOBAL_ENTRY_PREFIX,
  globalDirectoryName,
  globalDirectoryOfKey,
  globalDirectoryRows,
  globalEntryKey,
  migrateOpenedKeys,
} from "./project-entries"
import type { Session } from "./api-types"

function session(directory: string, updated: number): Session {
  return { id: `s_${directory}_${updated}`, projectID: "global", directory, time: { created: 1, updated } }
}

describe("global entry key", () => {
  it("编解码往返", () => {
    const key = globalEntryKey("/home/user/文档")
    expect(key.startsWith(GLOBAL_ENTRY_PREFIX)).toBe(true)
    expect(globalDirectoryOfKey(key)).toBe("/home/user/文档")
  })

  it("普通 project id 不是 global entry", () => {
    expect(globalDirectoryOfKey("abc123")).toBeNull()
    expect(globalDirectoryOfKey("global")).toBeNull()
  })

  it("根目录 key 可往返", () => {
    expect(globalDirectoryOfKey(globalEntryKey("/"))).toBe("/")
  })
})

describe("migrateOpenedKeys", () => {
  it("裸 global 迁移为根目录 entry，其余原样", () => {
    expect(migrateOpenedKeys(["global", "abc", "def"])).toEqual([
      globalEntryKey("/"),
      "abc",
      "def",
    ])
  })

  it("已迁移键幂等", () => {
    const keys = [globalEntryKey("/home/user"), "abc"]
    expect(migrateOpenedKeys(keys)).toEqual(keys)
  })
})

describe("globalDirectoryName", () => {
  it("取目录末段", () => {
    expect(globalDirectoryName("/home/cyrasafia")).toBe("cyrasafia")
    expect(globalDirectoryName("/tmp/ob-repro/proj")).toBe("proj")
  })

  it("根目录显示 global", () => {
    expect(globalDirectoryName("/")).toBe("global")
  })
})

describe("globalDirectoryRows", () => {
  it("按目录聚合，updated 取最大，按活跃度降序", () => {
    const rows = globalDirectoryRows([
      session("/tmp/a", 100),
      session("/tmp/a", 300),
      session("/home/u/docs", 200),
      session("/", 5),
    ])
    expect(rows.map((r) => r.directory)).toEqual(["/tmp/a", "/home/u/docs", "/"])
    expect(rows[0].updated).toBe(300)
    expect(rows[2].name).toBe("global")
  })

  it("空输入返回空数组", () => {
    expect(globalDirectoryRows([])).toEqual([])
  })
})
