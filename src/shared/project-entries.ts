/**
 * 左栏「项目行」（entry）纯函数层——global 项目按 directory 拆分。
 *
 * 语义（design-layout §3、参考 openbuilder server_store：`id==="global"` 时
 * 按 worktree/directory 聚合，活动键 `global\u0000$directory`）：
 * - 普通项目 1 entry：key = project.id，directory = worktree；
 * - global 项目 N entry：每个出现过的会话 directory 一个 entry，
 *   key = `global\0<directory>`，directory 即作用域根（global 无 git、无 sandboxes）。
 * - persisted `ProjectState.opened` 存 entry key；旧版裸 `"global"` 迁移为根目录 entry。
 */
import type { Session } from "./api-types"

export const GLOBAL_PROJECT_ID = "global"
export const GLOBAL_ENTRY_PREFIX = "global\u0000"

/** global entry key（目录即身份） */
export function globalEntryKey(directory: string): string {
  return GLOBAL_ENTRY_PREFIX + directory
}

/** 解析 global entry key → directory；非 global entry 返回 null */
export function globalDirectoryOfKey(key: string): string | null {
  return key.startsWith(GLOBAL_ENTRY_PREFIX) ? key.slice(GLOBAL_ENTRY_PREFIX.length) : null
}

/** 旧版持久化键迁移：裸 "global"（整项目一行）→ 根目录 entry */
export function migrateOpenedKeys(opened: string[]): string[] {
  return opened.map((k) => (k === GLOBAL_PROJECT_ID ? globalEntryKey("/") : k))
}

/** entry 显示名：目录末段；根目录 `/`（末段为空）显示 "global"（同 openbuilder projectDisplayOf） */
export function globalDirectoryName(directory: string): string {
  return directory.split("/").pop() || GLOBAL_PROJECT_ID
}

export interface GlobalDirectoryRow {
  directory: string
  name: string
  /** 该目录会话最大 updated（0 = 无会话）——排序/最近活跃展示用 */
  updated: number
}

/**
 * 会话集 → global 目录行（发现聚合）。updated 取目录内会话最大值；
 * 已归档会话不在 REST 快照内，目录活跃度会随归档下沉（已知局限，见
 * design-v0.1-implementation global 拆分一节；量级小不引入单调活动表）。
 */
export function globalDirectoryRows(sessions: Session[]): GlobalDirectoryRow[] {
  const updatedByDir = new Map<string, number>()
  for (const s of sessions) {
    if (!s.directory) continue
    const prev = updatedByDir.get(s.directory) ?? 0
    if (s.time.updated > prev) updatedByDir.set(s.directory, s.time.updated)
  }
  return [...updatedByDir.entries()]
    .map(([directory, updated]) => ({ directory, name: globalDirectoryName(directory), updated }))
    .sort((a, b) => b.updated - a.updated)
}
