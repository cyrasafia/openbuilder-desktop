/**
 * Diff 详情视图（design-diff-view §4）：顶部 segment 切换三种来源
 * （上一轮/未提交/分支，同移动端 DiffListScreen 的 SegmentedButton），
 * 主体 = 文件块（可折叠）→ hunk（静态分节头，不可折叠）；工具条「全部折叠/
 * 全部展开」一键切换所有文件块。视图状态（segment 选中 / foldOpen / 文件折叠 /
 * 滚动位置）切 Tab 卸载前落 store、重挂载恢复（design-tab-state-memory §2.5）。
 * 行 = 双 gutter（old|new）+ marker + 内容；added/removed 底色 tint 为主标识，
 * token 走 --syntax-*（与代码视图同表）。高亮 = 双路重建（new/old 各整段
 * tokenize 再映射回行，openbuilder design-diff-view 同法），headless
 * CodeMirror + @lezer/highlight 官方编辑器外 API。大 diff 用
 * content-visibility 让浏览器跳过屏外渲染（零 JS 虚拟化）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, ExternalLink, LoaderCircle } from "lucide-react"
import { createPortal } from "react-dom"
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  RefObject,
} from "react"
import { EditorState } from "@codemirror/state"
import { ensureSyntaxTree } from "@codemirror/language"
import { highlightCode } from "@lezer/highlight"
import { useI18n, useStore } from "../app"
import { DIFF_TAB_TYPES, diffDataKey, type DiffTabType } from "../store/app-store"
import type { Catalog } from "../i18n"
import { languageForPath } from "./cm-lang"
import { classHighlighter } from "./cm-theme"
import { parseDiffHunks, type DiffHunk } from "@shared/diff-parse"
import type { FileDiff } from "@shared/api-types"

/** 拼接作用域目录 + diff 相对路径为绝对路径 */
function joinPath(directory: string, relative: string): string {
  if (!directory) return relative
  return directory.replace(/\/$/, "") + "/" + relative.replace(/^\//, "")
}

/** segment 短标签（移动端 diffMode* 同源；完整语义在 Tab 标题「改动」之下） */
function diffSegLabel(t: Catalog, type: DiffTabType): string {
  switch (type) {
    case "round":
      return t.diffRound
    case "uncommitted":
      return t.diffUncommitted
    case "branch":
      return t.diffBranch
  }
}

/** 单行内的 token 片段（cls 为空 = 无样式） */
interface Token {
  text: string
  cls: string
}

/** patch 尺寸上限：超过跳过语法高亮（纯文本渲染，底色/行号照常） */
const HIGHLIGHT_PATCH_LIMIT = 512 * 1024

/**
 * 整段代码 headless 高亮为逐行 token（编辑器外 API）。
 * null = 无语言/解析超时/异常 → 调用方降级纯文本。
 */
function highlightCodeLines(code: string, path: string): Token[][] | null {
  const lang = languageForPath(path)
  if (!lang || !code) return null
  try {
    const state = EditorState.create({ doc: code, extensions: [lang] })
    const tree = ensureSyntaxTree(state, code.length, 500)
    if (!tree) return null
    const lines: Token[][] = [[]]
    // highlightCode 的 putText 通常不含换行（putBreak 单独调用），但防御性
    // 拆分含 \n 的 text，确保 cls 不跨行污染、lines 与代码行对齐
    highlightCode(
      code,
      tree,
      classHighlighter,
      (text, cls) => {
        const parts = text.split("\n")
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) lines.push([])
          if (parts[i] !== "") lines[lines.length - 1].push({ text: parts[i], cls })
        }
      },
      () => lines.push([]),
    )
    return lines
  } catch {
    return null
  }
}

/** 双游标映射：hunk 行 → token（context 取 new 路） */
function mapHunkSpans(hunk: DiffHunk, newLines: Token[][] | null, oldLines: Token[][] | null): Array<Token[] | undefined> {
  let ni = 0
  let oi = 0
  const out: Array<Token[] | undefined> = []
  for (const line of hunk.lines) {
    if (line.kind === "-") {
      out.push(oldLines?.[oi] ?? undefined)
      oi++
    } else {
      // context 与 added 都取 new 路（context 双路等价）
      out.push(newLines?.[ni] ?? undefined)
      if (line.kind === " ") oi++
      ni++
    }
  }
  return out
}

/** hunk 双路重建：new = context+added，old = context+removed（各自是合法代码） */
function hunkSideCode(hunk: DiffHunk, side: "new" | "old"): string {
  return hunk.lines
    .filter((l) => (side === "new" ? l.kind !== "-" : l.kind !== "+"))
    .map((l) => l.text)
    .join("\n")
}

interface PreparedFile {
  hunks: DiffHunk[]
  /** hunk → 行 → tokens（undefined = 该行无高亮） */
  spans: Array<Array<Token[] | undefined>>
}

function prepareFile(file: FileDiff): PreparedFile {
  const hunks = parseDiffHunks(file.patch)
  // 大文件保护（设计 §4.2）：超过阈值跳过高亮（纯文本渲染，底色/行号照常）
  if (file.patch.length > HIGHLIGHT_PATCH_LIMIT) {
    return { hunks, spans: hunks.map(() => []) }
  }
  const spans = hunks.map((hunk) => {
    const newLines = highlightCodeLines(hunkSideCode(hunk, "new"), file.file)
    const oldLines = highlightCodeLines(hunkSideCode(hunk, "old"), file.file)
    if (!newLines && !oldLines) return []
    return mapHunkSpans(hunk, newLines, oldLines)
  })
  return { hunks, spans }
}

const STATUS_LETTER: Record<FileDiff["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
}

export function DiffView({
  tabKey,
  directory,
}: {
  tabKey: string
  directory: string
}) {
  const store = useStore()
  const { t } = useI18n()
  const type = store.diffTypeFor(tabKey)
  // 视图状态恢复（design-tab-state-memory §2.5）：切 Tab 卸载前落 store，重挂载恢复
  const savedState = store.diffViewStateFor(tabKey)
  // 全局折叠意图（工具条「全部折叠/展开」）：true = 展开态。
  // 只表达意图、不追踪各块本地状态——按钮在两种意图间交替，手动折叠不改变标签。
  const [foldOpen, setFoldOpen] = useState(savedState?.foldOpen ?? true)
  /** 折叠中的文件路径集（手动点击文件头切换）；从 store 恢复 + 卸载落 store */
  const [closedFiles, setClosedFiles] = useState<ReadonlySet<string>>(savedState?.closedFiles ?? new Set())
  // 滚动偏移：不设 state（避免高频 emit），ref 读写 + 卸载落 store
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scrollTopRef = useRef(savedState?.scrollTop ?? 0)
  // 卸载落 store 需读最新值（cleanup 闭包在挂载时捕获、不随 state 更新）
  const foldOpenRef = useRef(foldOpen)
  const closedFilesRef = useRef(closedFiles)
  foldOpenRef.current = foldOpen
  closedFilesRef.current = closedFiles

  // 激活即重拉当前选中来源（同 FileView 语义；旧数据作首帧）
  useEffect(() => {
    void store.loadDiffTab(store.diffTypeFor(tabKey), directory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey])

  // 卸载落 store（design-tab-state-memory §2.5）：复活闸门——Tab 仍在才写，
  // 否则 closeTab 已清的条目被卸载写复活（同 chatScrollTops 模式）。
  // 经 ref 读最新值（cleanup 闭包在挂载时捕获、不随 state 更新）
  useEffect(() => {
    return () => {
      if (store.tabs.some((t) => t.key === tabKey)) {
        store.setDiffViewState(tabKey, {
          foldOpen: foldOpenRef.current,
          closedFiles: closedFilesRef.current,
          scrollTop: scrollTopRef.current,
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const data = store.diffData.get(diffDataKey(type, directory))
  const hasFiles = !!data && !data.error && data.files.length > 0

  // 文件折叠/展开切换 → 更新 closedFiles
  const toggleFile = (filePath: string) => {
    setClosedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  // segment 常驻渲染（同 FileView 工具条——避免内容落地时工具条弹入的布局跳动）
  return (
    <div className="diff-view-wrap">
      <div className="diff-toolbar">
        <div className="ms-segmented" role="group" aria-label={t.diffTitle}>
          {DIFF_TAB_TYPES.map((ty) => (
            <button
              key={ty}
              type="button"
              aria-pressed={ty === type}
              className={"ms-seg" + (ty === type ? " active" : "")}
              onClick={() => store.switchDiffType(tabKey, ty)}
            >
              {diffSegLabel(t, ty)}
            </button>
          ))}
        </div>
        {hasFiles && (
          <button
            type="button"
            className="btn-tonal diff-fold-all"
            onClick={() => setFoldOpen((v) => !v)}
          >
            {foldOpen ? t.diffCollapseAll : t.diffExpandAll}
          </button>
        )}
      </div>
      <DiffBody
        type={type}
        directory={directory}
        foldOpen={foldOpen}
        closedFiles={closedFiles}
        onToggleFile={toggleFile}
        scrollRef={scrollRef}
        scrollTopRef={scrollTopRef}
      />
    </div>
  )
}

function DiffBody({
  type,
  directory,
  foldOpen,
  closedFiles,
  onToggleFile,
  scrollRef,
  scrollTopRef,
}: {
  type: DiffTabType
  directory: string
  foldOpen: boolean
  closedFiles: ReadonlySet<string>
  onToggleFile: (filePath: string) => void
  scrollRef: RefObject<HTMLDivElement | null>
  scrollTopRef: MutableRefObject<number>
}) {
  const store = useStore()
  const { t } = useI18n()
  const data = store.diffData.get(diffDataKey(type, directory))

  // 滚动位置恢复（design-tab-state-memory §2.5）：内容落地后一次性恢复。
  // 数据从 store 变更（激活重拉）会重触发，但 scrollTopRef 已被 onScroll 更新为当前值，
  // 恢复值 = 当前值 → 无跳动；首次挂载从 savedState 恢复切走前的偏移
  useLayoutEffect(() => {
    if (!data || data.error || data.files.length === 0) return
    const el = scrollRef.current
    if (el && scrollTopRef.current > 0) el.scrollTop = scrollTopRef.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.files])

  if (!data || (data.loading && data.files.length === 0)) {
    return (
      <div className="diff-view">
        <div className="history-row" role="status">
          <LoaderCircle className="history-spinner" size={14} aria-hidden />
          <span>{t.loading}</span>
        </div>
      </div>
    )
  }
  if (data.error) {
    return (
      <div className="diff-view">
        <div className="file-state file-error">{data.error}</div>
        <button type="button" className="btn-tonal" onClick={() => void store.loadDiffTab(type, directory)}>
          {t.retry}
        </button>
      </div>
    )
  }
  if (data.files.length === 0) {
    // round 空态区分：作用域无会话（入口语义）与有会话但无改动
    const emptyText =
      type === "round" && !store.visibleSessions.length ? t.diffRoundNoSession : t.diffEmpty
    return (
      <div className="diff-view">
        <div className="diff-empty">{emptyText}</div>
      </div>
    )
  }
  return (
    <div
      className="diff-view scroll"
      tabIndex={-1}
      ref={scrollRef}
      onScroll={(e) => {
        scrollTopRef.current = e.currentTarget.scrollTop
      }}
    >
      {data.files.map((file) => (
        <FileDiffBlock
          key={`${file.status}:${file.file}`}
          file={file}
          foldOpen={foldOpen}
          directory={directory}
          closedFiles={closedFiles}
          onToggleFile={onToggleFile}
        />
      ))}
    </div>
  )
}

function FileDiffBlock({
  file,
  foldOpen,
  directory,
  closedFiles,
  onToggleFile,
}: {
  file: FileDiff
  foldOpen: boolean
  directory: string
  closedFiles: ReadonlySet<string>
  onToggleFile: (filePath: string) => void
}) {
  const { t } = useI18n()
  const store = useStore()
  // 挂载恢复：foldOpen=false（全局折叠意图）→ 收起；否则看 closedFiles（手动折叠记录）
  const [open, setOpen] = useState(!foldOpen ? false : !closedFiles.has(file.file))
  const [hunkMenu, setHunkMenu] = useState<HunkMenuState | null>(null)
  // 解析 + 高亮一次成型（重渲染零重活，移动端教训：build 路径零重活）
  const prepared = useMemo(() => prepareFile(file), [file])
  // 首次挂载标记：foldOpen 的 useLayoutEffect 仅在意图变化时覆盖，不覆盖恢复值
  const firstMount = useRef(true)

  // 全局折叠/展开：意图覆盖文件块开关（含后续挂载的新文件块）；数据刷新不重置
  // 手动状态（deps 仅 foldOpen）。useLayoutEffect 免折叠态首帧闪现。
  // 首次挂载跳过——open 已从 closedFiles 恢复，不应被 foldOpen 覆盖。
  useLayoutEffect(() => {
    if (firstMount.current) {
      firstMount.current = false
      return
    }
    setOpen(foldOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldOpen])

  const toggleOpen = () => {
    setOpen((v) => {
      const next = !v
      onToggleFile(file.file)
      return next
    })
  }

  // 查看文件：在新 Tab 中打开，锚定至首个 hunk 的 newStart 行（1-based）
  const viewFile = () => {
    const abs = joinPath(directory, file.file)
    const firstHunk = prepared.hunks[0]
    const line = firstHunk ? firstHunk.newStart : undefined
    store.openFileTab(abs, line)
  }

  return (
    <section className={"diff-file" + (open ? "" : " closed")}>
      <button
        type="button"
        className="diff-file-header"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        {open ? (
          <ChevronDown className="diff-chevron" size={14} aria-hidden />
        ) : (
          <ChevronRight className="diff-chevron" size={14} aria-hidden />
        )}
        <span className={"diff-status-badge " + file.status}>{STATUS_LETTER[file.status]}</span>
        <span className="diff-file-path mono" title={file.file}>
          {file.file}
        </span>
        <span className="diff-file-stat">
          <span className="diff-add-num">+{file.additions}</span>{" "}
          <span className="diff-del-num">−{file.deletions}</span>
        </span>
      </button>
      {open && (
        <button
          type="button"
          className="btn-tonal diff-view-file"
          title={t.diffViewFile}
          onClick={viewFile}
        >
          <ExternalLink size={14} aria-hidden />
          {t.diffViewFile}
        </button>
      )}
      {open &&
        prepared.hunks.map((hunk, hi) => {
          const spans = prepared.spans[hi] ?? []
          const newEnd = hunk.newStart + Math.max(0, hunk.lines.filter((l) => l.kind !== "-").length - 1)
          const onHunkContextMenu = (e: ReactMouseEvent) => {
            e.preventDefault()
            e.stopPropagation()
            setHunkMenu({ x: e.clientX, y: e.clientY, line: hunk.newStart })
          }
          return (
            <div className="diff-hunk" key={hi}>
              <div className="diff-hunk-header" onContextMenu={onHunkContextMenu}>
                <span>{t.diffHunkSegment.replace("{n}", String(hi + 1))}</span>
                <span className="mono">
                  L{hunk.newStart}–{newEnd}
                </span>
                <span className="diff-file-stat">
                  <span className="diff-add-num">+{hunk.additions}</span>{" "}
                  <span className="diff-del-num">−{hunk.deletions}</span>
                </span>
              </div>
              <div className="diff-hunk-body" onContextMenu={onHunkContextMenu}>
                {hunk.lines.map((line, li) => (
                  <DiffRow key={li} line={line} tokens={spans[li]} />
                ))}
              </div>
            </div>
          )
        })}
      {open && prepared.hunks.length === 0 && (
        <div className="diff-hunk-body">
          <div className="diff-binary">{t.diffNoTextDiff}</div>
        </div>
      )}
      {hunkMenu && (
        <DiffHunkContextMenu
          menu={hunkMenu}
          directory={directory}
          file={file.file}
          onClose={() => setHunkMenu(null)}
        />
      )}
    </section>
  )
}

function DiffRow({ line, tokens }: { line: DiffHunk["lines"][number]; tokens?: Token[] }) {
  return (
    <div className={"diff-row " + (line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx")}>
      <span className="diff-no old">{line.oldNo ?? ""}</span>
      <span className="diff-no new">{line.newNo ?? ""}</span>
      <span className="diff-marker">{line.kind === " " ? "" : line.kind}</span>
      <span className="diff-text mono">
        {tokens && tokens.length > 0
          ? tokens.map((tok, i) =>
              tok.cls ? (
                <span key={i} className={tok.cls}>
                  {tok.text}
                </span>
              ) : (
                <span key={i}>{tok.text}</span>
              ),
            )
          : line.text || " "}
      </span>
    </div>
  )
}

/** hunk 右键菜单态：坐标 + 目标行号 */
interface HunkMenuState {
  x: number
  y: number
  /** 锚定行（1-based，hunk.newStart） */
  line: number
}

/** hunk 右键菜单：单项「查看文件」，打开文件 Tab 并锚定至该 hunk 行。
 *  复用 FileContextMenu 模式（首帧隐藏测量钳制 + capture 四触发关闭 + 浮层计数） */
function DiffHunkContextMenu({
  menu,
  directory,
  file,
  onClose,
}: {
  menu: HunkMenuState
  directory: string
  file: string
  onClose: () => void
}) {
  const { t } = useI18n()
  const store = useStore()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - el.offsetWidth - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - el.offsetHeight - 4)),
    })
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>("button")?.focus())
  }, [menu])

  useEffect(() => {
    store.pushOverlay()
    return () => store.popOverlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const outside = (target: EventTarget | null) => !ref.current?.contains(target as Node)
    const onDown = (e: MouseEvent) => {
      if (outside(e.target)) onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    const onWheel = (e: WheelEvent) => {
      if (outside(e.target)) onCloseRef.current()
    }
    const onBlur = () => onCloseRef.current()
    window.addEventListener("mousedown", onDown, true)
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("wheel", onWheel, true)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("mousedown", onDown, true)
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("wheel", onWheel, true)
      window.removeEventListener("blur", onBlur)
    }
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    e.preventDefault()
  }

  return createPortal(
    <div
      ref={ref}
      className="popover context-menu"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <button
        className="context-menu-item"
        onClick={() => {
          onClose()
          store.openFileTab(joinPath(directory, file), menu.line)
        }}
      >
        {t.diffViewFile}
      </button>
    </div>,
    document.body,
  )
}
