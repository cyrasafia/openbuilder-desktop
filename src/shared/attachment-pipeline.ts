/**
 * 会话附件管线（design-session-attachments §2）：读字节 → mime 推断 →
 * 图片压缩（base64 体积上限循环）→ data URL。纯逻辑 + 注入 canvas 实现供单测。
 * 参考移动端 design-attachments（AT-1~AT-R12 修复全量继承）。
 */

/** 客户端体积上限：对 base64 长度校验（server max_base64_bytes 同语义，AT-3） */
export const MAX_BASE64_BYTES = 4 * 1024 * 1024

/** 图片压缩边上限（移动端同款 2048） */
const IMAGE_MAX_EDGE = 2048

/** 压缩输出 jpeg（png 透明通道保留场景少见，jpeg 质量循环可控） */
const COMPRESS_MIME = "image/jpeg"

export interface Attachment {
  id: string
  mime: string
  filename: string
  dataUrl: string
  isImage: boolean
}

export interface RejectedFile {
  name: string
  reason: string
}

/** 可显示图片（缩略图渲染判定；svg 为文本非位图——移动端同款排除） */
export function isDisplayableImage(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml"
}

/** 扩展名 mime 推断（file.type 缺失时兜底；常见集足够，未知回 octet-stream） */
export function guessMime(filename: string, declared: string | null): string {
  if (declared) return declared
  const ext = filename.toLowerCase().split(".").pop() ?? ""
  const table: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    zip: "application/zip",
    gz: "application/gzip",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
  }
  return table[ext] ?? "application/octet-stream"
}

/** 字节 → data URL（纯函数供单测） */
export function toDataUrl(mime: string, bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/** base64 体积（含 padding：4×ceil(len/3)；对 base64 长度校验，AT-3） */
export function base64Length(bytes: Uint8Array): number {
  return 4 * Math.ceil(bytes.length / 3)
}

/** 注入面：浏览器图片编解码（测试用桩替换） */
export interface ImageOps {
  /** 解码字节取尺寸（失败 = null → 图片按非图片透传） */
  decodeSize(bytes: Uint8Array): Promise<{ width: number; height: number } | null>
  /** 重绘压缩：等比缩到 maxEdge 内 + quality（返回压缩字节；同尺寸同质量输入幂等） */
  reencode(bytes: Uint8Array, maxEdge: number, quality: number): Promise<Uint8Array>
}

/** 降质/缩宽计划（纯函数供单测，design §2 管线步骤 2） */
export function shrinkPlan(): Array<{ quality: number; maxEdge: number }> {
  const plan: Array<{ quality: number; maxEdge: number }> = []
  for (const q of [0.85, 0.65, 0.45, 0.3]) plan.push({ quality: q, maxEdge: IMAGE_MAX_EDGE })
  for (const e of [1024, 512]) plan.push({ quality: 0.5, maxEdge: e })
  return plan
}

function attachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export interface ResolveResult {
  accepted: Attachment[]
  rejected: RejectedFile[]
}

/** 单文件解析（图片压缩 + base64 上限循环；非图片超限拒绝） */
export async function resolveOne(
  name: string,
  bytes: Uint8Array,
  declaredMime: string | null,
  ops: ImageOps,
): Promise<Attachment | RejectedFile> {
  const mime = guessMime(name, declaredMime)
  if (isDisplayableImage(mime)) {
    const size = await ops.decodeSize(bytes)
    if (size) {
      let out = bytes
      for (const step of shrinkPlan()) {
        out = await ops.reencode(out, step.maxEdge, step.quality)
        if (base64Length(out) <= MAX_BASE64_BYTES) break
      }
      // 仍超：接受（发送侧自然失败提示，AT-3 服务端兜底语义）
      return {
        id: attachmentId(),
        mime: COMPRESS_MIME,
        filename: name,
        dataUrl: toDataUrl(COMPRESS_MIME, out),
        isImage: true,
      }
    }
    // 解码失败（HEIC 等）：按非图片透传原字节
  }
  if (base64Length(bytes) > MAX_BASE64_BYTES) {
    return {
      name,
      reason: `too_large`,
    }
  }
  return {
    id: attachmentId(),
    mime,
    filename: name,
    dataUrl: toDataUrl(mime, bytes),
    isImage: mime.startsWith("image/"),
  }
}

/** 多文件聚合（入口统一） */
export async function resolveFiles(
  files: Array<{ name: string; type: string | null; bytes: Uint8Array }>,
  ops: ImageOps,
): Promise<ResolveResult> {
  const accepted: Attachment[] = []
  const rejected: RejectedFile[] = []
  for (const f of files) {
    const r = await resolveOne(f.name, f.bytes, f.type, ops)
    if ("reason" in r) rejected.push(r)
    else accepted.push(r)
  }
  return { accepted, rejected }
}
