/**
 * Tab 会话持久层——纯函数层（docs/design-tab-session-restore.md §2/§3/§5）。
 * 运行期 live tabs 唯一权威，本层是派生投影（与 tabs.memory 同模型），仅冷启动消费。
 * 记忆层（scope-tab-memory）管 chat 的集合/校验/补开；本层管非 chat 实体 +
 * 全局混排顺序 + 各作用域最后激活，chat 条目仅作顺序标记。
 */

export type PersistedTabKind = "chat" | "file" | "diff" | "terminal" | "browser"

export interface PersistedTab {
  kind: PersistedTabKind
  /** 与 TabEntity.key 同构：chat:sid / file:path / diff\0dir / terminal:ptyId / browser:url */
  key: string
  projectId: string
  directory: string
  title: string
  /** browser 专用：持久化时的当前页 URL（key 恒为初始 URL，导航后两者不同；
   *  等于初始 URL 时省略） */
  url?: string
}

export interface TabSessionState {
  /** 全量 live Tab 的有序投影（全局混排顺序） */
  tabs: PersistedTab[]
  /** 各作用域最后激活（design-tab-state-memory §2.1 语义）：directory → tabKey；null = 引导页哨兵 */
  scopeActive: Record<string, string | null>
}

/** kind → tab key 前缀（sanitize 与 derive 共用的合法性契约） */
const KEY_PREFIX: Record<PersistedTabKind, string> = {
  chat: "chat:",
  file: "file:",
  diff: "diff\0",
  terminal: "terminal:",
  browser: "browser:",
}

/** 派生输入的最小 Tab 形状（结构性兼容 TabEntity，避免反向依赖 store 层） */
export interface SessionTabSource {
  kind: string
  key: string
  projectId: string
  directory?: string
  title: string
}

/**
 * live tabs + scopeActive → 会话投影（§5 挂点的派生核心）。browser 条目经
 * resolveBrowserUrl 取当前页 URL（main 推送态），与初始 URL 相同则省略 url 字段。
 */
export function deriveTabSession(
  tabs: SessionTabSource[],
  scopeActive: Map<string, string | null>,
  resolveBrowserUrl: (tabKey: string) => string | undefined,
): TabSessionState {
  return {
    tabs: tabs.map((t) => {
      const base: PersistedTab = {
        kind: t.kind as PersistedTabKind,
        key: t.key,
        projectId: t.projectId,
        directory: t.directory ?? "",
        title: t.title,
      }
      if (t.kind === "browser") {
        const initial = t.key.slice("browser:".length)
        const url = resolveBrowserUrl(t.key)
        if (url && url !== initial) return { ...base, url }
      }
      return base
    }),
    scopeActive: Object.fromEntries(scopeActive),
  }
}

/**
 * 模板序合并（§3 恢复管线）：模板中仍存活的 Tab 按模板序在前，模板外 Tab
 * （记忆补开的会话、模板漂移）按现有相对序追加尾部。模板键去重；未知键忽略。
 */
export function orderTabsByTemplate<T extends { key: string }>(live: T[], templateKeys: string[]): T[] {
  const byKey = new Map(live.map((t) => [t.key, t] as const))
  const seen = new Set<string>()
  const ordered: T[] = []
  for (const k of templateKeys) {
    if (seen.has(k)) continue
    const tab = byKey.get(k)
    if (!tab) continue
    seen.add(k)
    ordered.push(tab)
  }
  for (const t of live) {
    if (!seen.has(t.key)) ordered.push(t)
  }
  return ordered
}

function sanitizeTabEntry(raw: unknown, seen: Set<string>): PersistedTab | null {
  if (typeof raw !== "object" || raw === null) return null
  const e = raw as Record<string, unknown>
  const kind = e.kind
  if (typeof kind !== "string" || !(kind in KEY_PREFIX)) return null
  const prefix = KEY_PREFIX[kind as PersistedTabKind]
  const key = e.key
  if (typeof key !== "string" || !key.startsWith(prefix)) return null
  const ident = key.slice(prefix.length)
  // diff 的 directory 段不得再含 \0（数据 key 两段前缀，误传防御同 parseDiffTabKey）
  if (!ident || ident.includes("\0")) return null
  if (typeof e.projectId !== "string" || !e.projectId) return null
  if (typeof e.directory !== "string" || !e.directory) return null
  if (typeof e.title !== "string") return null
  if (seen.has(key)) return null
  const url = e.url
  if (url !== undefined && (typeof url !== "string" || !url)) return null
  seen.add(key)
  return {
    kind: kind as PersistedTabKind,
    key,
    projectId: e.projectId,
    directory: e.directory,
    title: e.title,
    ...(typeof url === "string" ? { url } : {}),
  }
}

function sanitizeScopeActive(raw: unknown): Record<string, string | null> {
  if (typeof raw !== "object" || raw === null) return {}
  const out: Record<string, string | null> = {}
  for (const [dir, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!dir) continue
    if (val === null) out[dir] = null
    else if (typeof val === "string" && val) out[dir] = val
  }
  return out
}

/** 单 profile 切片校验：结构非法/无有效内容 → null（消费方按无记录处理） */
export function sanitizeTabSession(raw: unknown): TabSessionState | null {
  if (typeof raw !== "object" || raw === null) return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.tabs)) return null
  const seen = new Set<string>()
  const tabs: PersistedTab[] = []
  for (const item of o.tabs) {
    const entry = sanitizeTabEntry(item, seen)
    if (entry) tabs.push(entry)
  }
  return { tabs, scopeActive: sanitizeScopeActive(o.scopeActive) }
}

/** 整体加载校验：非对象 → {}；逐 profile 切片校验，坏切片丢弃 */
export function sanitizeTabSessionMap(raw: unknown): Record<string, TabSessionState> {
  if (typeof raw !== "object" || raw === null) return {}
  const out: Record<string, TabSessionState> = {}
  for (const [profileKey, slice] of Object.entries(raw as Record<string, unknown>)) {
    if (!profileKey) continue
    const sess = sanitizeTabSession(slice)
    if (sess) out[profileKey] = sess
  }
  return out
}
