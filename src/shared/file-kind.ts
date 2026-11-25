/**
 * 文件路径的扩展名判定——FileView 渲染分发（workspace.tsx）、md 相对图片闸门
 * （markdown-image.ts）、文件监听注册（app-store，design-file-watcher §7.3）
 * 共用，单一来源。纯函数，无平台依赖。
 *
 * 按**扩展名**而非 server 的 MIME 头判定：server 的 MIME 库会误判（如 `.ts` →
 * `video/mp2t`，ref-pin-bump-2.4.1 §5.1），渲染与监听注册须同口径。
 */

/**
 * 位图扩展 → mime（design-image-preview §2.3：服务端 mimeType 缺省时的
 * data URL 兜底映射）。svg 不在此表（服务端对 svg 返回 text 源码，另行分发）。
 */
export const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

/**
 * 图片文件判定（design-image-preview §2.2）：basename 最后一个**非前导**点的
 * 后缀，大小写不敏感；点文件（前导点，如 `.png`）不命中。
 */
export function isImagePath(path: string): boolean {
  const base = path.split("/").pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return false
  const ext = base.slice(dot + 1).toLowerCase()
  return ext === "svg" || ext in IMAGE_MIME_BY_EXT
}

/** PDF 判定（design-pdf-preview §1）：仅 .pdf 扩展名（大小写不敏感） */
export function isPdfPath(path: string): boolean {
  const base = path.split("/").pop() ?? ""
  return base.toLowerCase().endsWith(".pdf")
}
