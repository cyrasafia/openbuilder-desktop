/**
 * v2 wire → 内部模型适配层（docs/plan-v2-protocol.md §模块策略）。
 * 迁移过渡：内部 Project/Session 仍是 v1 形状（worktree/directory 字段名），
 * v2 的 canonical/location 映射到旧字段名——M5/M6 收敛时统一改名，届时本层收编进 api 层。
 */
import type { ProjectInfo, SessionInfo } from "./api-v2-types"
import type { Project, Session } from "./api-types"

/** v2 ProjectInfo → 内部 Project：canonical → worktree 字段名（basename 展示/
 *  作用域键逻辑不变）；v2 无 initialized（active 取代），置 undefined。
 *  v2 无 global 项目行（用户裁定 2026-09-28：非 git 目录 = 目录哈希伪项目行，
 *  以普通项目进列表——v1 global 拆分语义退役，特殊路径 M1b 删除）。 */
export function toInternalProject(p: ProjectInfo): Project {
  return {
    id: p.id,
    worktree: p.canonical,
    vcs: p.vcs === "git" ? "git" : undefined,
    name: p.name,
    icon: p.icon,
    time: {
      created: p.time.created,
      updated: p.time.updated,
      initialized: undefined,
    },
    sandboxes: p.sandboxes ?? [],
  }
}

/** v2 SessionInfo → 内部 Session：directory ← location.directory。
 *  metadata 透传（D1 归档私约 metadata.archivedAt 的识别数据源）；
 *  agent/model 透传（创建回显/默认模型链路消费）。 */
export function toInternalSession(s: SessionInfo): Session {
  return {
    id: s.id,
    parentID: s.parentID,
    projectID: s.projectID,
    agent: s.agent,
    model: s.model,
    directory: s.location.directory,
    title: s.title,
    time: {
      created: s.time.created,
      updated: s.time.updated,
      archived: s.time.archived,
    },
    metadata: s.metadata,
  }
}

/**
 * 归档判定（D1，双源）：v2 的 REST 归档字段不可写（官方 app 占位 + TODO），
 * 关 Tab = 归档走 metadata.archivedAt 私约；存量会话（v1 迁移/import 透传）
 * 带 time.archived。v1 server 端过滤归档，v2 返回全部——客户端统一过滤（对齐
 * 官方 v2 app 的 client-side filter 行为）。parentID 过滤（子/后台会话）是
 * M2 会话域的决策点，本层不做。
 */
export function isArchivedSession(s: Session): boolean {
  if (s.time.archived) return true
  return archivedAtOf(s) !== null
}

/** 归档时间戳（排序用）：time.archived ?? metadata.archivedAt；未归档 null。
 *  time.archived 判定用 truthy——v1 以 archived:0 为取消归档标记（v1 展示层
 *  全部 falsy 判定），v2 wire 侧 fromRow 同口径归一（0 → undefined） */
export function archivedAtOf(s: Session): number | null {
  if (s.time.archived) return s.time.archived
  const at = s.metadata?.archivedAt
  return typeof at === "number" && at > 0 ? at : null
}
