/**
 * agent/模型目录解析 + 全局默认值读写纯函数（design-agent-model-switch）。
 * 所有函数纯：不触网络、不读写持久化，输入/输出可序列化。vitest 覆盖。
 *
 * 坑与对策（见设计文档"移动端踩过的坑"表）：
 * - LR-1 数据源：v1 /config/providers（非 v2 /api/model）
 * - LR-2 Provider.key 明文，解析期丢弃（parseModels 不读 key 字段）
 * - LR-3 variants 是 dict `{"high":{...}}` 也可能是 List，双形态兼容
 * - LR-BL1 status 黑名单：仅排除 deprecated/disabled，其余（active/beta/缺省）放行
 * - AM-FIX-1 agent 过滤 !hidden && mode !== 'subagent'（与 server agent.ts:337 一致，
 *   有意偏离移动端"只留 primary"——config 自定义 agent 默认 mode:"all"，排除会全藏掉）
 */
import type { AgentInfo, ConfigProviders, ModelInfo, ModelRef } from "./api-types"

export interface ModelCatalog {
  agents: AgentInfo[]
  models: ModelInfo[]
}

export const emptyCatalog: ModelCatalog = { agents: [], models: [] }

/** 可作会话主 agent：!hidden 且非 subagent（server agent.ts:337 语义）。 */
export function parseAgents(raw: AgentInfo[] | null | undefined): AgentInfo[] {
  if (!raw) return []
  return raw.filter((a) => a && !a.hidden && a.mode !== "subagent")
}

/**
 * variants 解析：dict 形态取 keys（`{"high":{reasoningEffort:"high"}}` → ["high"]），
 * List 形态取每项 `id`（`[{id:"high"},…]` → ["high"]）。其他形态返回空。
 */
export function parseVariants(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((item) =>
        item && typeof item === "object" && "id" in item
          ? String((item as { id: unknown }).id)
          : "",
      )
      .filter((x): x is string => !!x)
  }
  if (v && typeof v === "object") {
    return Object.keys(v as Record<string, unknown>)
  }
  return []
}

/**
 * 拍平 providers.models 为 ModelInfo[]，黑名单过滤 deprecated/disabled。
 * Provider.key 解析期丢弃——只读 id/name/models（LR-2）。
 */
export function parseModels(raw: ConfigProviders | null | undefined): ModelInfo[] {
  if (!raw || !Array.isArray(raw.providers)) return []
  const out: ModelInfo[] = []
  for (const p of raw.providers) {
    if (!p || !p.models) continue
    for (const [id, m] of Object.entries(p.models)) {
      if (!m) continue
      const status = m.status
      if (status === "deprecated" || status === "disabled") continue
      out.push({
        id,
        providerID: p.id,
        name: m.name ?? id,
        status,
        variants: parseVariants(m.variants),
      })
    }
  }
  return out
}

export function parseCatalog(
  agents: AgentInfo[] | null | undefined,
  providers: ConfigProviders | null | undefined,
): ModelCatalog {
  return { agents: parseAgents(agents), models: parseModels(providers) }
}

/** (providerID, id) 双字段匹配（LR-4：跨 provider 重名不 id-only lookup）。 */
export function findModel(
  models: ModelInfo[],
  providerID: string,
  id: string,
): ModelInfo | undefined {
  return models.find((m) => m.providerID === providerID && m.id === id)
}

/**
 * 读边界归一化：服务器会话记录可能带字面 `variant: "default"`
 * （TUI/CLI 路径写入，本机实测既有会话 69/100 带此值）——UI 语义等同"未设思考强度"。
 * variants dict 不含 "default" 键（实测），归一化无歧义（AM-IMPL3-2）。
 */
export function normalizeModelRef(m: ModelRef | undefined): ModelRef | undefined {
  if (!m) return undefined
  if (m.variant === "default") return { id: m.id, providerID: m.providerID }
  return m
}

/**
 * 切到另一模型时思考强度的携带规则（设计文档"切模型时 variant 的携带规则"）：
 * 仅当新模型有同名 variant 才沿用，否则省略（重置「默认」）。
 * 返回 variant 字符串或 undefined（undefined = 省略字段 = 清掉已设值，AM-3）。
 */
export function carriedVariant(
  currentVariant: string | undefined,
  newModel: ModelInfo,
): string | undefined {
  if (!currentVariant) return undefined
  return newModel.variants.includes(currentVariant) ? currentVariant : undefined
}

// ---- 全局默认值（per-profile，纯函数；持久化由 app-store 负责）----

export type ModelDefaults = { agent?: string; model?: ModelRef }

/** 读取某 profile 的默认值（不存在返回空对象）。 */
export function getDefaults(
  record: Record<string, ModelDefaults> | null | undefined,
  profileKey: string,
): ModelDefaults {
  return record?.[profileKey] ?? {}
}

/**
 * 写入某 profile 的默认值（覆盖单字段；传 undefined 删除该字段）。
 * 返回新 record（不 mutate 入参）。字段值与现有相同时返回原引用（避免无谓重渲染）。
 */
export function setDefaults(
  record: Record<string, ModelDefaults> | null | undefined,
  profileKey: string,
  patch: ModelDefaults,
): Record<string, ModelDefaults> {
  const base = record ?? {}
  const prev = base[profileKey] ?? {}
  let next: ModelDefaults = { ...prev }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      delete (next as Record<string, unknown>)[k]
    } else {
      ;(next as Record<string, unknown>)[k] = v
    }
  }
  // 全空 → 删除条目
  if (Object.keys(next).length === 0) {
    if (!(profileKey in base)) return base
    const { [profileKey]: _omit, ...rest } = base
    void _omit
    return rest
  }
  if (JSON.stringify(prev) === JSON.stringify(next)) return base
  return { ...base, [profileKey]: next }
}

/** 默认值是否定义了 agent 或 model。 */
export function hasDefaults(d: ModelDefaults): boolean {
  return d.agent != null || (d.model != null && !!d.model.id && !!d.model.providerID)
}
