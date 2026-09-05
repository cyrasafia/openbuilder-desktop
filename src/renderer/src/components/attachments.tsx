/**
 * 会话附件组件（design-session-attachments §4）：composer 附件条（图片缩略图/
 * 文件 chip，可删）+ 气泡缩略图（点击放大）+ 入口接线 hook（粘贴/拖拽/按钮）。
 * 图片渲染直接用 `<img src=dataUrl>`（浏览器异步解码 = 惰性，无 Flutter isolate 问题）。
 */
import { useCallback, useRef, useState, type DragEvent as ReactDragEvent } from "react"
import { FileText, Paperclip, X } from "lucide-react"
import { useI18n, useStore } from "../app"
import { FILEREF_MIME } from "./file-ref"
import {
  isDisplayableImage,
  resolveFiles,
  type Attachment,
  type ImageOps,
} from "@shared/attachment-pipeline"
import type { FileDisplayPart, Part } from "@shared/api-types"
import { isFilePart } from "@shared/api-types"

/** File → bytes */
async function fileToBytes(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer())
}

/** 压缩输出 jpeg（与 shared 管线一致） */
const COMPRESS_MIME = "image/jpeg"

/** 浏览器 canvas 图片操作（shared 管线的注入实现——纯函数层不依赖 DOM） */
export function canvasImageOps(): ImageOps {
  return {
    async decodeSize(bytes) {
      try {
        const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" })
        const bmp = await createImageBitmap(blob)
        const size = { width: bmp.width, height: bmp.height }
        bmp.close()
        return size
      } catch {
        return null
      }
    },
    async reencode(bytes, maxEdge, quality) {
      const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" })
      const bmp = await createImageBitmap(blob)
      const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
      const w = Math.max(1, Math.round(bmp.width * scale))
      const h = Math.max(1, Math.round(bmp.height * scale))
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("canvas 2d unavailable")
      ctx.drawImage(bmp, 0, 0, w, h)
      bmp.close()
      const outBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, COMPRESS_MIME, quality),
      )
      if (!outBlob) throw new Error("toBlob failed")
      return new Uint8Array(await outBlob.arrayBuffer())
    },
  }
}

/** composer 附件条（design §4：图片 48px 缩略图 / 非图片引用 chip 同款） */
export function AttachmentChips({
  items,
  onRemove,
}: {
  items: Attachment[]
  onRemove: (id: string) => void
}) {
  const { t } = useI18n()
  if (items.length === 0) return null
  return (
    <div className="ref-chips attach-chips">
      {items.map((a) =>
        a.isImage ? (
          <span key={a.id} className="attach-thumb" title={a.filename}>
            <img src={a.dataUrl} alt={a.filename} decoding="async" />
            <button
              className="ref-chip-x"
              aria-label={t.fileRefRemove}
              title={t.fileRefRemove}
              onClick={() => onRemove(a.id)}
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ) : (
          <span key={a.id} className="ref-chip" title={a.filename}>
            <FileText size={12} aria-hidden />
            <span className="ref-chip-path mono">{a.filename}</span>
            <button
              className="ref-chip-x"
              aria-label={t.fileRefRemove}
              title={t.fileRefRemove}
              onClick={() => onRemove(a.id)}
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ),
      )}
    </div>
  )
}

/** 点击放大遮罩（Esc/点击关闭） */
function ImageZoom({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="dialog-mask image-zoom"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose()
      }}
    >
      <img src={url} alt="" decoding="async" onClick={(e) => e.stopPropagation()} />
    </div>
  )
}

/** 气泡图片缩略图（最大高 220 圆角 + 点击放大；lazy/async 解码 = 惰性缩略图） */
export function AttachmentThumb({ url, filename }: { url: string; filename?: string }) {
  const [zoom, setZoom] = useState(false)
  return (
    <>
      <button
        type="button"
        className="attach-bubble-thumb"
        title={filename}
        onClick={() => setZoom(true)}
      >
        <img src={url} alt={filename ?? ""} loading="lazy" decoding="async" />
      </button>
      {zoom && <ImageZoom url={url} onClose={() => setZoom(false)} />}
    </>
  )
}

/**
 * user 消息 file parts → 可显示图片附件（design §4 分流：无 source + data: url +
 * image mime）——这些渲染为缩略图，不进 chip 条（userFileChipItems 侧排除）
 */
export function userImageParts(parts: Part[]): Array<{ id: string; url: string; filename?: string }> {
  const out: Array<{ id: string; url: string; filename?: string }> = []
  for (const part of parts) {
    if (!isFilePart(part)) continue
    const p = part as FileDisplayPart
    const url = p.url
    const mime = p.mime
    if (p.source || !url?.startsWith("data:") || !mime || !isDisplayableImage(mime)) continue
    out.push({ id: p.id, url, filename: p.filename })
  }
  return out
}

/**
 * 入口接线（design §3）：粘贴/拖拽外部文件/附件按钮 → 管线 → store.attachments。
 * 处理中态与拒绝提示在 composer 本地（无 toast 基建，内联提示）。
 */
export function useAttachmentInput(refKey: string): {
  chips: React.ReactNode
  pasteProps: {
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  }
  fileDragProps: {
    onDragOver: (e: ReactDragEvent<HTMLElement>) => void
    onDrop: (e: ReactDragEvent<HTMLElement>) => void
  }
  pickerButton: React.ReactNode
} {
  const store = useStore()
  const { t } = useI18n()
  const [processing, setProcessing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number>(0)

  const showNotice = useCallback((msg: string) => {
    setNotice(msg)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000)
  }, [])

  const ingest = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      setProcessing(true)
      try {
        const inputs = await Promise.all(
          files.map(async (f) => ({ name: f.name, type: f.type || null, bytes: await fileToBytes(f) })),
        )
        const { accepted, rejected } = await resolveFiles(inputs, canvasImageOps())
        if (accepted.length > 0) store.addAttachments(refKey, accepted)
        if (rejected.length > 0) {
          showNotice(
            t.attachTooLarge.replace("{names}", rejected.map((r) => r.name).join("、")),
          )
        }
      } catch (e) {
        showNotice(e instanceof Error ? e.message : String(e))
      } finally {
        setProcessing(false)
      }
    },
    [refKey, showNotice, store, t],
  )

  const items = store.attachmentsFor(refKey)
  const chips = (
    <>
      <AttachmentChips items={items} onRemove={(id) => store.removeAttachment(refKey, id)} />
      {notice && <div className="form-note attach-notice">{notice}</div>}
      {processing && <div className="form-note">{t.attachProcessing}</div>}
    </>
  )

  const pickerButton = (
    <button
      type="button"
      className="icon-btn attach-pick"
      title={t.attachPick}
      aria-label={t.attachPick}
      disabled={processing}
      onClick={() => {
        // main 侧读字节返回（renderer 无法从路径构造 File）
        void window.desktop.openFilesPicker().then((files) => {
          if (!files || files.length === 0) return
          void ingest(
            files.map((f) => new File([f.bytes as unknown as BlobPart], f.name, { type: f.type ?? "" })),
          )
        })
      }}
    >
      <Paperclip size={14} aria-hidden />
    </button>
  )

  return {
    chips,
    pasteProps: {
      onPaste: (e) => {
        const files = Array.from(e.clipboardData?.files ?? [])
        if (files.length === 0) return // 文本粘贴不拦截（spec）
        e.preventDefault()
        void ingest(files)
      },
    },
    fileDragProps: {
      // 外部文件拖入（design §3）：FILEREF_MIME 优先（工作区文件树拖入仍是 source 引用）
      onDragOver: (e) => {
        if (e.dataTransfer.types.includes(FILEREF_MIME)) return
        if (!e.dataTransfer.types.includes("Files")) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
      },
      onDrop: (e) => {
        if (e.dataTransfer.types.includes(FILEREF_MIME)) return
        const files = Array.from(e.dataTransfer.files ?? [])
        if (files.length === 0) return
        e.preventDefault()
        void ingest(files)
      },
    },
    pickerButton,
  }
}
