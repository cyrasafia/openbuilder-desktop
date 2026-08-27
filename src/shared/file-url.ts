/**
 * 本地路径 → file URL（design-browser-tab 评审 L8）：逐段 encodeURIComponent，
 * `#`/`?`/空格/中文安全（GURL 规范化不救 fragment/query 截断）。
 */
export function fileUrlOf(path: string): string {
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
  return `file://${encoded.startsWith("/") ? encoded : `/${encoded}`}`
}
