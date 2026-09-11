/**
 * 回环 baseUrl 判定（design-terminal-tab §1.1 显示环境注入）：
 * pty 显示环境注入只对同机 server 安全——远程 attach 的 DISPLAY 语义属远端
 * （如 ssh -X 转发的 localhost:10.0），本地值覆盖反而破坏其 GUI 启动。
 * 纯函数供单测；解析失败/非回环一律 false（false = 不注入，保守侧）。
 */

/** hostname 是否回环：localhost / 127.0.0.0/8 / ::1（URL 规范化后 IPv6 带方括号） */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === "localhost" || host === "[::1]" || host === "::1") return true
  // 127.0.0.0/8：整段任意地址均回环（URL.hostname 已去端口/去方括号）
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** baseUrl（如 http://127.0.0.1:15120）是否指向本机回环；空/非法 URL = false */
export function isLoopbackBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  try {
    return isLoopbackHostname(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}
