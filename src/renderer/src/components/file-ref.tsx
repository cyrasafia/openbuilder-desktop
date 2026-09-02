import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import { FileText, Folder, X } from "lucide-react"
import { useI18n, useStore } from "../app"
import type { FileRef, Part } from "@shared/api-types"
import { isFilePart, isFileRefPart } from "@shared/api-types"

/** 文件树拖拽引用的自定义 MIME（design-file-reference §3.3，与 Tab 拖拽同约定） */
export const FILEREF_MIME = "application/x-openbuilder-fileref"

/**
 * 拖拽中引用的带外登记（design-file-reference §3.3 修订）：dragover 阶段浏览器
 * 禁读 `dataTransfer.getData`，composer 悬停实时预览只能取 dragstart 登记的
 * 同页副本；dragend 由 FileRow 清除（drop 提交仍以 dataTransfer 解析为权威）。
 */
let draggingFileRef: FileRef | null = null

/** FileRow dragstart 登记拖拽负载 / dragend 传 null 清除（file-panel 调用） */
export function setDraggingFileRef(ref: FileRef | null) {
  draggingFileRef = ref
}

/**
 * 光标所在 `@词` 提取（design-file-reference §3.1）：从光标向前找最近空白后的
 * token，以半角 `@` 开头 → 返回 query 与文本区间（选中时删除该区间）。
 * 仅认光标前缀（光标落在 token 中间时取前半）；`\@` 转义不触发。
 */
export function atMentionQuery(
  text: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i]!)) i--
  const start = i + 1
  if (start >= caret) return null
  const token = text.slice(start, caret)
  if (!token.startsWith("@")) return null
  if (start > 0 && text[start - 1] === "\\") return null
  return { query: token.slice(1), start, end: caret }
}

/** 拖拽负载解析（§3.3）：非自定义 MIME / 坏 JSON / 字段缺失 → null */
export function fileRefFromDataTransfer(dt: DataTransfer): FileRef | null {
  const raw = dt.getData(FILEREF_MIME)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<FileRef>
    if (typeof v.path !== "string" || typeof v.absolute !== "string") return null
    return {
      path: v.path,
      absolute: v.absolute,
      filename:
        typeof v.filename === "string" && v.filename
          ? v.filename
          : v.absolute.replace(/\/+$/, "").split("/").pop() ?? v.absolute,
      isDir: !!v.isDir,
    }
  } catch {
    return null
  }
}

/** 引用 chip 条目（composer 与消息气泡共用形态）；pending = 拖拽悬停占位预览 */
export interface RefChipItem {
  key: string
  path: string
  absolute?: string
  isDir: boolean
  title?: string
  pending?: boolean
}

/**
 * 引用 chip 条（design-file-reference §5）：composer 顶部一行，横向滚动。
 * onRemove 提供 = 可删（composer 态）；onOpen 提供 = 可点（消息态，仅文件）。
 */
export function FileRefChips({
  items,
  onRemove,
  onOpen,
}: {
  items: RefChipItem[]
  onRemove?: (key: string) => void
  onOpen?: (item: RefChipItem) => void
}) {
  const { t } = useI18n()
  if (items.length === 0) return null
  return (
    <div className="ref-chips">
      {items.map((r) => {
        const clickable = !!onOpen && !r.isDir && !!r.absolute && !r.pending
        return (
          <span
            key={r.key}
            className={
              "ref-chip" + (r.isDir ? " dir" : "") + (clickable ? " clickable" : "") + (r.pending ? " pending" : "")
            }
            title={r.title ?? r.path}
            onClick={clickable ? () => onOpen!(r) : undefined}
          >
            {r.isDir ? <Folder size={12} aria-hidden /> : <FileText size={12} aria-hidden />}
            <span className="ref-chip-path mono">{r.path}</span>
            {onRemove && !r.pending && (
              <button
                className="ref-chip-x"
                aria-label={t.fileRefRemove}
                title={t.fileRefRemove}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(r.key)
                }}
                >
                  <X size={12} aria-hidden />
                </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

/** @ 浮层条目（find/file 相对路径 → FileRef；rel 以 / 开头直接作绝对，DR-1） */
export function fileRefFromSearch(rel: string, directory: string): FileRef {
  const absolute = rel.startsWith("/") ? rel : `${directory.replace(/\/+$/, "")}/${rel}`
  const filename = absolute.split("/").pop() ?? absolute
  return { path: rel, absolute, filename, isDir: false }
}

/**
 * user 消息 file parts → chip 条目（design-file-reference §5，回显只画文件名）：
 * - 引用回灌型（source.type=file）：path = source.path，absolute = 会话目录拼合
 *   （禁用 part.url——二进制回灌变 data:，4R-B），文件可点开 Tab、目录不可点
 * - 附件回灌型（无 source，server 对图片/PDF 引用以 data: 附件替换原 part）：
 *   仅文件名 chip，无 absolute 不可点
 */
export function userFileChipItems(parts: Part[], sessionDir: string | undefined): RefChipItem[] {
  return parts.filter(isFilePart).map((p): RefChipItem => {
    // 字段先取后判：isFileRefPart 与 isFilePart 同为目标类型，负分支 narrowing 会塌缩 never
    const name = p.filename ?? ""
    const id = p.id
    if (isFileRefPart(p)) {
      const rel = p.source?.path ?? name
      const abs =
        sessionDir && rel && !rel.startsWith("/")
          ? `${sessionDir.replace(/\/+$/, "")}/${rel.replace(/^\.?\//, "")}`
          : null
      return {
        key: p.id,
        path: rel,
        absolute: abs ?? undefined,
        isDir: rel.endsWith("/"),
        title: abs ?? rel,
      }
    }
    return { key: id, path: name, isDir: false, title: name }
  })
}

/**
 * `@` 引用输入接线（design-file-reference §3.1/§3.3）：检测 + 防抖搜索 + 键盘
 * 选择 + drop 接收。chips/picker 为即插 ReactNode；onRemoveAtToken 由调用方
 * 落地文本删除（选中引用时移除 `@词` 区间）。
 */
export function useFileRefInput(opts: {
  refKey: string
  directory: string | null
  onRemoveAtToken: (start: number, end: number) => void
}): {
  chips: ReactNode
  picker: ReactNode
  onTextChange: (text: string, caret: number) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean
  dragProps: {
    onDragOver: (e: ReactDragEvent<HTMLElement>) => void
    onDrop: (e: ReactDragEvent<HTMLElement>) => void
    onDragLeave: (e: ReactDragEvent<HTMLElement>) => void
  }
} {
  const store = useStore()
  const { t } = useI18n()
  const [state, setState] = useState<{
    query: string
    start: number
    end: number
    results: string[]
    loading: boolean
    sel: number
  } | null>(null)
  const seqRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const { refKey, directory, onRemoveAtToken } = opts
  const onRemoveAtTokenRef = useRef(onRemoveAtToken)
  onRemoveAtTokenRef.current = onRemoveAtToken

  const close = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    seqRef.current++
    setState(null)
  }, [])

  // 卸载清定时器
  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const onTextChange = useCallback(
    (text: string, caret: number) => {
      const hit = directory ? atMentionQuery(text, caret) : null
      if (!hit) {
        close()
        return
      }
      setState((prev) =>
        prev && prev.start === hit.start && prev.query === hit.query
          ? prev
          : { query: hit.query, start: hit.start, end: hit.end, results: [], loading: true, sel: 0 },
      )
      // 防抖 250ms + 请求序号（晚到响应丢弃，design §3.1）；失败（null）落空态
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
      const seq = ++seqRef.current
      timerRef.current = window.setTimeout(() => {
        void store.searchFiles(hit.query, directory!).then((rel) => {
          if (seqRef.current !== seq) return
          setState((prev) =>
            prev && prev.start === hit.start && prev.query === hit.query
              ? { ...prev, results: rel ?? [], loading: false }
              : prev,
          )
        })
      }, 250)
    },
    [close, directory, store],
  )

  const pick = useCallback(
    (rel: string) => {
      if (!state || !directory) return
      const ref = fileRefFromSearch(rel, directory)
      store.addFileRef(refKey, ref)
      onRemoveAtTokenRef.current(state.start, state.end)
      close()
    },
    [close, directory, refKey, state, store],
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (!state || e.nativeEvent.isComposing) return false
      // 浮层打开期间 Enter/Tab/Esc 属于浮层（空态/加载中也消费 Enter——防把
      // 含 @词 的草稿误发出，想发送先 Esc 关浮层）
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const hit = state.results[state.sel] ?? state.results[0]
        if (hit) pick(hit)
        return true
      }
      if (e.key === "Escape") {
        e.preventDefault()
        close()
        return true
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (state.results.length === 0) return false
        e.preventDefault()
        const len = state.results.length
        setState((prev) =>
          prev ? { ...prev, sel: e.key === "ArrowDown" ? (prev.sel + 1) % len : (prev.sel - 1 + len) % len } : prev,
        )
        return true
      }
      return false
    },
    [close, pick, state],
  )

  // 实时预览（design-file-reference §3.3 修订）：拖拽引用悬停 composer 期间，
  // 引用条末位渲染占位 chip——所见即所得，drop 落位与预览一致（占位 chip 即
  // 落位指示，不再叠加 drop-active 虚线框高亮）
  const [pending, setPending] = useState<FileRef | null>(null)
  const dragProps = useMemo(
    () => ({
      onDragOver: (e: ReactDragEvent<HTMLElement>) => {
        if (!e.dataTransfer.types.includes(FILEREF_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        // dragover 阶段 getData 禁读，负载取 dragstart 登记的带外副本；
        // absolute 已引用时不出占位（addFileRef 按 absolute 去重，提交将是
        // no-op——占位如实反映"无变化"）。同值保留旧引用 bail out
        const drag = draggingFileRef
        if (!drag || store.fileRefsFor(refKey).some((r) => r.absolute === drag.absolute)) {
          setPending(null)
          return
        }
        setPending((prev) => (prev?.absolute === drag.absolute ? prev : drag))
      },
      onDrop: (e: ReactDragEvent<HTMLElement>) => {
        if (!e.dataTransfer.types.includes(FILEREF_MIME)) return
        e.preventDefault()
        // 提交以 dataTransfer 解析为权威（字段校验：缺字段/坏 JSON 丢弃）；
        // 松手在 composer 外/原生取消不经此路径——引用是复制语义，落位只认 drop
        const ref = fileRefFromDataTransfer(e.dataTransfer)
        if (ref) store.addFileRef(refKey, ref)
        setPending(null)
      },
      onDragLeave: (e: ReactDragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPending(null)
      },
    }),
    [refKey, store],
  )

  // 拖拽以任何方式结束（松手在 composer 外/Esc 原生取消——后者 dragleave 不可
  // 靠）时清占位防幽灵 chip：dragend 在源元素上恒触发且冒泡，window 一次性监听
  useEffect(() => {
    if (!pending) return
    const clear = () => setPending(null)
    window.addEventListener("dragend", clear, { once: true })
    return () => window.removeEventListener("dragend", clear)
  }, [pending])

  const refs = store.fileRefsFor(refKey)
  const chips = (
    <FileRefChips
      items={[
        ...refs.map((r) => ({
          key: r.absolute,
          path: r.path,
          absolute: r.absolute,
          isDir: r.isDir,
          title: r.absolute,
        })),
        // 悬停占位 chip（实时预览）：挂引用条末位 = addFileRef 追加语义的预演
        ...(pending
          ? [
              {
                key: pending.absolute,
                path: pending.path,
                absolute: pending.absolute,
                isDir: pending.isDir,
                title: pending.absolute,
                pending: true,
              },
            ]
          : []),
      ]}
      onRemove={(key) => store.removeFileRef(refKey, key)}
    />
  )
  const picker = state ? (
    <div className="command-hints-slot">
      <div className="command-hints file-ref-picker scroll" tabIndex={-1}>
        {state.results.map((rel, i) => (
          <button
            key={rel}
            className={"command-row" + (i === state.sel ? " selected" : "")}
            onMouseDown={(e) => {
              e.preventDefault()
              pick(rel)
            }}
          >
            <FileText size={12} aria-hidden />
            <span className="command-name mono">{rel}</span>
          </button>
        ))}
        {state.results.length === 0 && (
          <div className="command-empty">{state.loading ? t.commandListLoading : t.fileRefNoMatch}</div>
        )}
      </div>
    </div>
  ) : null

  return { chips, picker, onTextChange, onKeyDown, dragProps }
}
