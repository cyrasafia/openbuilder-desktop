/**
 * server 版本下限校验：v0.5 起 v2-only——探活已拒 v1，这里只对 v2 小版本
 * 做推荐位提示（低于 2.0.0 仅提示不阻断，design-managed-config §2 语义延续）。
 * 纯函数供单测。
 */

/** 推荐 server 版本下限（v2 GA 基线；v1 的 1.0.66 下限已随 v2-only 退役） */
export const MIN_SERVER_VERSION_V2 = "2.0.0"

/** 解析数字三元组（容忍 v 前缀/预发布后缀/缺段补零）；无法解析 = null */
function parseTriple(version: string): number[] | null {
  const m = /^\s*v?(\d+(?:\.\d+){0,2})/.exec(version)
  if (!m) return null
  const parts = m[1].split(".").map(Number)
  while (parts.length < 3) parts.push(0)
  return parts
}

function compareTriple(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return 0
}

/** 版本比较（-1/0/1）；任一侧无法解析按相等处理（不误伤非常规版本串） */
export function compareVersions(a: string, b: string): number {
  const pa = parseTriple(a)
  const pb = parseTriple(b)
  if (!pa || !pb) return 0
  return compareTriple(pa, pb)
}

/** 是否低于最低版本；无法解析 = false（提示不阻断的原则下从宽） */
export function belowMinServerVersion(version: string, min: string = MIN_SERVER_VERSION_V2): boolean {
  const p = parseTriple(version)
  const m = parseTriple(min)
  if (!p || !m) return false
  return compareTriple(p, m) < 0
}
