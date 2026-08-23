/**
 * 斜杠命令列表缓存——空响应防护层（纯函数，便于测试）。
 * 参考 openbuilder design-slash-command-refresh：
 * - 网络抖动恢复期连接池可能吐 200+空 body（fetch 不抛错），被当"真·空"信任
 *   会覆盖好缓存（内置 init/review 恒在，200 空=瞬态）；
 * - degraded（抛错）或 suspiciousEmpty（200 空）时保留**同目录完整好缓存**；
 * - 连击计数器限制保留次数（kMaxSuspiciousRetries），耗尽后信任空，
 *   防真删命令后永久卡旧缓存；中间任一次成功刷新立即清零；
 * - 纯抛错不消耗连击预算（断网永久保留是预期行为）；
 * - 目录隔离：缓存全局单份（per-server），degraded 只保留同目录缓存，
 *   项目 B 拉取失败不得展示项目 A 的命令。
 */
import type { CommandInfo } from "./api-types"

export interface CommandCacheState {
  commands: CommandInfo[]
  /** 当前 commands 对应的 directory */
  cacheDir: string | null
  /** 当前缓存是否来自一次完全成功的拉取（只有完整列表才值得保护） */
  complete: boolean
  /** 最近一次刷新降级（拉取抛错 / 瞬时空无缓存兜底）——下次输入 `/` 重试 */
  degraded: boolean
  /** 连续 suspiciousEmpty（200-OK 但空）次数 */
  suspiciousStreak: number
}

export const MAX_SUSPICIOUS_RETRIES = 3

export function initialCommandCache(): CommandCacheState {
  return { commands: [], cacheDir: null, complete: false, degraded: false, suspiciousStreak: 0 }
}

export type CommandFetchResult =
  | { ok: true; commands: CommandInfo[] }
  | { ok: false }

/** 应用一次 GET /command 结果（抛错由调用方捕获后传 ok:false） */
export function applyCommandFetch(
  state: CommandCacheState,
  directory: string | null,
  result: CommandFetchResult,
): CommandCacheState {
  const degraded = !result.ok
  const suspiciousEmpty = result.ok && result.commands.length === 0
  const haveGoodCache =
    state.commands.length > 0 && state.cacheDir === directory && state.complete
  const withinStreak = state.suspiciousStreak < MAX_SUSPICIOUS_RETRIES

  // 保留路径：降级/瞬时空 + 有同目录完整好缓存 → 不覆盖，标 degraded 让下次 `/` 重试
  if ((degraded || (suspiciousEmpty && withinStreak)) && haveGoodCache) {
    return {
      ...state,
      degraded: true,
      suspiciousStreak: suspiciousEmpty ? state.suspiciousStreak + 1 : state.suspiciousStreak,
    }
  }

  // 覆盖路径：健康刷新 / 连击耗尽信任空 / 无好缓存可保护
  const trustEmpty = suspiciousEmpty && !withinStreak
  return {
    commands: result.ok ? result.commands : [],
    cacheDir: directory,
    complete: !degraded,
    degraded: degraded || (suspiciousEmpty && !trustEmpty),
    suspiciousStreak: suspiciousEmpty ? state.suspiciousStreak + 1 : 0,
  }
}
