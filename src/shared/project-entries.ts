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

/**
 * 目录 → v2 项目 ID（worktree 精确优先，sandboxes 认领；未命中 null）——
 * 归一 v1 记忆/投影的 `projectId="global"` 遗留用。
 */
export function legacyProjectIdForDirectory(
  directory: string,
  projects: ReadonlyArray<{ id: string; worktree: string; sandboxes?: string[] }>,
): string | null {
  const p = projects.find(
    (x) => x.worktree === directory || (x.sandboxes ?? []).includes(directory),
  )
  return p?.id ?? null
}

/**
 * tabs.memory 各条目（profile → directory → {projectId,…}）的 `"global"` 归属
 * 按目录转项目 ID（评审 2026-09-28 增补：restoreScopeTabs 的记忆匹配与
 * forgetProjectMemory 的清理按 projectId 精确比对，遗留值使恢复退化为首次
 * 全量打开且清理不到）。未命中的条目保持原值（死条目无害，记忆归零风险
 * 大于残留）。返回是否有变更。
 */
export function migrateLegacyMemoryProjectIds(
  memory: Record<string, Record<string, { projectId: string }>>,
  projects: ReadonlyArray<{ id: string; worktree: string; sandboxes?: string[] }>,
): boolean {
  let changed = false
  for (const slice of Object.values(memory)) {
    if (!slice) continue
    for (const [dir, mem] of Object.entries(slice)) {
      if (!mem || mem.projectId !== GLOBAL_PROJECT_ID) continue
      const id = legacyProjectIdForDirectory(dir, projects)
      if (id) {
        mem.projectId = id
        changed = true
      }
    }
  }
  return changed
}

/**
 * tabs.session 投影条目（projectId + directory）的 `"global"` 归属按目录转
 * 项目 ID（chat 条目仅作顺序标记，归一为一致性；非 chat 条目的
 * sessionEntryOwned 闸门按 projectId 比对）。未命中保持原值。返回是否有变更。
 */
export function migrateLegacyPersistedProjectIds(
  session: Record<string, { tabs?: Array<{ projectId: string; directory: string }> }>,
  projects: ReadonlyArray<{ id: string; worktree: string; sandboxes?: string[] }>,
): boolean {
  let changed = false
  for (const slice of Object.values(session)) {
    if (!slice?.tabs) continue
    for (const tab of slice.tabs) {
      if (tab.projectId !== GLOBAL_PROJECT_ID) continue
      const id = legacyProjectIdForDirectory(tab.directory, projects)
      if (id) {
        tab.projectId = id
        changed = true
      }
    }
  }
  return changed
}
