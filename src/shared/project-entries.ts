/**
 * v1→v2 持久化迁移层（M1b，2026-09-28 用户裁定 A）。
 *
 * 语义变更：v2 server 取消 global 项目（非 git 目录 = 目录哈希伪项目行，出现在
 * `GET /api/project`）。桌面端 v1 的「global 项目按 directory 拆分为 N 个
 * `global\0<dir>` entry」模型随之退役——本模块原 global 行函数（globalEntryKey/
 * globalDirectoryName/globalDirectoryRows 等）已删除，仅保留旧持久化键的识别与
 * 迁移（连接期 projects 落地后按 worktree 匹配转项目 ID，见 app-store doConnect）。
 */
export const GLOBAL_PROJECT_ID = "global"
export const GLOBAL_ENTRY_PREFIX = "global\u0000"

/** 解析 v1 global entry 键 → directory；非 global entry 键返回 null（仅迁移用） */
export function globalDirectoryOfKey(key: string): string | null {
  return key.startsWith(GLOBAL_ENTRY_PREFIX) ? key.slice(GLOBAL_ENTRY_PREFIX.length) : null
}

/** 迁移目标的最小 ProjectState 形状（app-store.ProjectState 结构子集） */
interface MigratableState {
  opened: string[]
  currentProjectId: string | null
  currentWorkspaceId: string | null
}

/**
 * v1 global 键 → v2 项目 ID（原地改写，返回是否有变更）：
 * - `opened`：`global\0<dir>` → worktree === dir 的项目 ID（含伪项目行）；
 *   旧版裸 `"global"`（整项目一行）按根目录 "/" 处理；未匹配（零会话目录无
 *   项目行）的键丢弃——用户可经选择器重开；与已有同 ID 键保序去重
 * - `currentProjectId === "global"`：按 `currentWorkspaceId`（v1 的 global 目录
 *   语义）匹配转 ID，`currentWorkspaceId` 归一为 null；未匹配回退 null
 * 幂等：无 global 键时不改写。
 */
export function migrateLegacyGlobalState(
  ps: MigratableState,
  projects: ReadonlyArray<{ id: string; worktree: string }>,
): boolean {
  let changed = false
  const byDir = new Map(projects.map((p) => [p.worktree, p.id]))
  const opened: string[] = []
  for (const key of ps.opened) {
    if (key === GLOBAL_PROJECT_ID) {
      // 旧版裸键（最早格式，整项目一行）→ 根目录
      const id = byDir.get("/")
      if (id && !opened.includes(id)) opened.push(id)
      changed = true
      continue
    }
    const dir = globalDirectoryOfKey(key)
    if (dir != null) {
      const id = byDir.get(dir)
      if (id && !opened.includes(id)) opened.push(id)
      changed = true
      continue
    }
    opened.push(key)
  }
  if (ps.currentProjectId === GLOBAL_PROJECT_ID) {
    const dir = ps.currentWorkspaceId ?? "/"
    ps.currentProjectId = byDir.get(dir) ?? null
    ps.currentWorkspaceId = null
    changed = true
  }
  if (changed) ps.opened = [...new Set(opened)]
  return changed
}
