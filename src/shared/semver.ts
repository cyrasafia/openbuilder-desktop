/**
 * server 版本下限校验（design-managed-config §2）：单全局 SSE（/global/event）
 * 需 server ≥ 1.0.66；低于仅提示不阻断。纯函数供单测。
 */

/** 最低 server 版本（单全局事件流要求，design-sse-global-event） */
export const MIN_SERVER_VERSION = "1.0.66"

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
export function belowMinServerVersion(version: string, min: string = MIN_SERVER_VERSION): boolean {
  const p = parseTriple(version)
  const m = parseTriple(min)
  if (!p || !m) return false
  return compareTriple(p, m) < 0
}
