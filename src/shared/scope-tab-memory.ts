/**
 * worktree 级 Tab 记忆——纯函数层（docs/design-tab-memory.md §3/§5/§6/§7）。
 * 运行期 live tabs 唯一权威，记忆是派生投影；仅重启/切入作用域时作为恢复输入。
 * 空记忆 ≠ 无记忆（tabs: [] 表示用户已收敛到零 Tab，必须保留，不触发首次打开）。
 */
import type { Session } from "./api-types"

export interface ScopeTabMemory {
  /** 写入时该 directory 所属项目——closeProject 整体清除 + worktree 重建检测 */
  projectId: string
  /** 有序 sessionID 列表（Tab 顺序，左→右） */
  tabs: string[]
  /** 该作用域最近激活的 chat sessionID；无则 null */
  active: string | null
}

/** 派生输入的最小 Tab 形状（结构性兼容 TabEntity，避免反向依赖 store 层） */
export interface MemoryTabSource {
  kind: string
  /** chat: `chat:<sessionID>` */
  key: string
  directory?: string
}

/** 首次打开：tabs 按 created 升序（时间线左→右）；active = updated 最大（无会话则 null） */
export function buildFirstOpenMemory(projectId: string, sessions: Session[]): ScopeTabMemory {
  const ordered = [...sessions].sort((a, b) => a.time.created - b.time.created)
  const mostActive = [...sessions].sort((a, b) => b.time.updated - a.time.updated)[0]
  return {
    projectId,
    tabs: ordered.map((s) => s.id),
    active: mostActive?.id ?? null,
  }
}

/**
 * 恢复校验与增量吸收（2026-08-24 修订，原 shrinkMemoryTabs"记忆外不补开"，见
 * design-tab-memory §17）：valid = mem.tabs ∩ 可见会话（保序；可见 = 未归档 +
 * 非 subagent，过滤在 store 层完成）在前，"可见但不在记忆中"的会话按 created
 * 升序追加尾部——他端新建（SSE session.created 只写 sessionsByProject，不开
 * Tab 不写记忆）或外部取消归档的会话没有其他 UI 入口（引导页仅列归档会话），
 * 不补开即在本端永久不可见；引导页发送失败的 pending 会话（openTab:false
 * 先建后发）亦属此类——作用域往返后 GuidePage 卸载、草稿与复用引用已失，
 * 补开是其唯一可达路径（review §17 第五轮）。用户关闭的 Tab 已归档（不可见），
 * 不会因此复活；
 * 空记忆（零 Tab 哨兵）同样补开——哨兵防的是"重新全量打开已收敛的旧会话"，
 * 它们已归档不可见，不受影响。active 失效则置 null（运行时由 §7 激活规则
 * 回退到末位 Tab，不因补开顶替）。
 */
export function reconcileMemoryTabs(mem: ScopeTabMemory, sessions: Session[]): ScopeTabMemory {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const kept = mem.tabs.filter((id) => byId.has(id))
  const known = new Set(mem.tabs)
  const fresh = sessions
    .filter((s) => !known.has(s.id))
    .sort((a, b) => a.time.created - b.time.created)
  return {
    projectId: mem.projectId,
    tabs: [...kept, ...fresh.map((s) => s.id)],
    active: mem.active != null && kept.includes(mem.active) ? mem.active : null,
  }
}

/**
 * 防御闸门（§6）：记忆非空但该目录快照从未落地（可见会话与全量记录皆空）——
 * 视为快照拉取失败，不打开、不收缩。真"全部归档/删除"时本地目录会话集非空
 * （归档仅被过滤、删除被合并层保守保留），唯快照未落地才是全空。
 */
export function isSnapshotMissing(
  mem: ScopeTabMemory,
  visibleSessions: Session[],
  allSessionsInDirectory: Session[],
): boolean {
  return (
    mem.tabs.length > 0 && visibleSessions.length === 0 && allSessionsInDirectory.length === 0
  )
}

/**
 * live tabs → 记忆派生（§5）。只投影该目录的 chat Tab（file Tab 跨作用域全局
 * 显示，不参与记忆）。active 派生：当前激活为该目录 chat Tab → 该会话；
 * 激活 file Tab / 无激活 → 保留原值（若仍在 tabs 中，否则 null）。
 */
export function deriveMemory(
  projectId: string,
  directory: string,
  tabs: MemoryTabSource[],
  activeTabKey: string | null,
  prevActive: string | null,
): ScopeTabMemory {
  const chatIds = tabs
    .filter((t) => t.kind === "chat" && t.directory === directory)
    .map((t) => t.key.slice("chat:".length))
  const activeId = activeTabKey?.startsWith("chat:") ? activeTabKey.slice("chat:".length) : null
  const active =
    activeId != null && chatIds.includes(activeId)
      ? activeId
      : prevActive != null && chatIds.includes(prevActive)
        ? prevActive
        : null
  return { projectId, tabs: chatIds, active }
}

/**
 * §7 激活规则。返回值：undefined = 保持现状（当前激活是 file Tab）；
 * string = 激活该会话；null = 清空激活（会话列表视图）。
 */
export function resolveRestoreActive(
  mem: ScopeTabMemory,
  activeTabKind: string | null,
): string | null | undefined {
  if (activeTabKind === "file") return undefined
  if (mem.active != null && mem.tabs.includes(mem.active)) return mem.active
  return mem.tabs[mem.tabs.length - 1] ?? null
}
