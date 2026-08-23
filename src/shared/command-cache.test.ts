import { describe, expect, it } from "vitest"
import {
  applyCommandFetch,
  initialCommandCache,
  MAX_SUSPICIOUS_RETRIES,
  type CommandCacheState,
} from "./command-cache"
import type { CommandInfo } from "./api-types"

const cmds = (names: string[]): CommandInfo[] => names.map((name) => ({ name, hints: [] }))
const ok = (c: CommandInfo[]) => ({ ok: true as const, commands: c })
const fail = { ok: false as const }

describe("applyCommandFetch", () => {
  it("健康刷新直接应用并清零连击", () => {
    let s = applyCommandFetch(initialCommandCache(), "/a", ok([])) // 空无缓存：应用+degraded
    expect(s.degraded).toBe(true)
    s = applyCommandFetch({ ...s, suspiciousStreak: 2 }, "/a", ok(cmds(["init"])))
    expect(s.commands.map((c) => c.name)).toEqual(["init"])
    expect(s.cacheDir).toBe("/a")
    expect(s.complete).toBe(true)
    expect(s.degraded).toBe(false)
    expect(s.suspiciousStreak).toBe(0)
  })

  it("可疑空保留同目录完整好缓存并计连击", () => {
    let s = applyCommandFetch(initialCommandCache(), "/a", ok(cmds(["init", "review"])))
    for (let i = 1; i <= MAX_SUSPICIOUS_RETRIES; i++) {
      s = applyCommandFetch(s, "/a", ok([]))
      expect(s.commands.map((c) => c.name)).toEqual(["init", "review"]) // 缓存未被覆盖
      expect(s.degraded).toBe(true)
      expect(s.suspiciousStreak).toBe(i)
    }
  })

  it("连击耗尽后信任空（防永久卡旧缓存）", () => {
    let s = applyCommandFetch(initialCommandCache(), "/a", ok(cmds(["init"])))
    for (let i = 0; i < MAX_SUSPICIOUS_RETRIES; i++) s = applyCommandFetch(s, "/a", ok([]))
    s = applyCommandFetch(s, "/a", ok([])) // 第 4 次：耗尽
    expect(s.commands).toEqual([])
    expect(s.degraded).toBe(false)
  })

  it("中间一次成功刷新清零连击", () => {
    let s = applyCommandFetch(initialCommandCache(), "/a", ok(cmds(["init"])))
    s = applyCommandFetch(s, "/a", ok([]))
    s = applyCommandFetch(s, "/a", ok(cmds(["init"]))) // 恢复
    expect(s.suspiciousStreak).toBe(0)
    // 恢复后再空：连击从头计数，仍保留
    s = applyCommandFetch(s, "/a", ok([]))
    expect(s.suspiciousStreak).toBe(1)
    expect(s.commands.map((c) => c.name)).toEqual(["init"])
  })

  it("抛错（degraded）保留好缓存且不消耗连击预算", () => {
    let s = applyCommandFetch(initialCommandCache(), "/a", ok(cmds(["init"])))
    for (let i = 0; i < 10; i++) s = applyCommandFetch(s, "/a", fail)
    expect(s.commands.map((c) => c.name)).toEqual(["init"])
    expect(s.suspiciousStreak).toBe(0)
    expect(s.degraded).toBe(true)
  })

  it("抛错 + 无缓存：应用空结果（degraded）", () => {
    const s = applyCommandFetch(initialCommandCache(), "/a", fail)
    expect(s.commands).toEqual([])
    expect(s.degraded).toBe(true)
    expect(s.complete).toBe(false)
  })

  it("目录隔离：异目录缓存不保护", () => {
    let s: CommandCacheState = applyCommandFetch(initialCommandCache(), "/a", ok(cmds(["init"])))
    s = applyCommandFetch(s, "/b", ok([])) // /b 可疑空，但缓存属于 /a
    expect(s.commands).toEqual([]) // 无好缓存可保护 → 应用空
    expect(s.cacheDir).toBe("/b")
    expect(s.degraded).toBe(true) // 无缓存的可疑空仍标 degraded（下次 `/` 重试）
  })

  it("可疑空 + 无缓存也标 degraded（下次输入 / 重试而非放弃）", () => {
    const s = applyCommandFetch(initialCommandCache(), "/a", ok([]))
    expect(s.degraded).toBe(true)
  })
})
