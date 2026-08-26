/**
 * Diff 详情视图（design-diff-view §4）：顶部 segment 切换三种来源
 * （上一轮/未提交/分支，同移动端 DiffListScreen 的 SegmentedButton），
 * 主体 = 文件块（可折叠）→ hunk（可折叠，点头部收起行）；工具条「全部折叠/
 * 全部展开」一键切换所有文件块与 hunk（移动端将 hunk 折叠列为 future scope，
 * 桌面端按需求补齐）。
 * 行 = 双 gutter（old|new）+ marker + 内容；added/removed 底色 tint 为主标识，
 * token 走 --syntax-*（与代码视图同表）。高亮 = 双路重建（new/old 各整段
 * tokenize 再映射回行，openbuilder design-diff-view 同法），headless
 * CodeMirror + @lezer/highlight 官方编辑器外 API。大 diff 用
 * content-visibility 让浏览器跳过屏外渲染（零 JS 虚拟化）。
 */
import { useEffect, useLayoutEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react"
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
  // 全局折叠意图（工具条「全部折叠/展开」）：true = 展开态（缺省）。
  // 只表达意图、不追踪各块本地状态——按钮在两种意图间交替，手动折叠不改变标签。
  const [foldOpen, setFoldOpen] = useState(true)

  // 激活即重拉当前选中来源（同 FileView 语义；旧数据作首帧）
  useEffect(() => {
    void store.loadDiffTab(store.diffTypeFor(tabKey), directory)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey])

  const data = store.diffData.get(diffDataKey(type, directory))
  const hasFiles = !!data && !data.error && data.files.length > 0

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
      <DiffBody type={type} directory={directory} foldOpen={foldOpen} />
    </div>
  )
}

function DiffBody({
  type,
  directory,
  foldOpen,
}: {
  type: DiffTabType
  directory: string
  foldOpen: boolean
}) {
  const store = useStore()
  const { t } = useI18n()
  const data = store.diffData.get(diffDataKey(type, directory))

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
    <div className="diff-view scroll" tabIndex={-1}>
      {data.files.map((file) => (
        <FileDiffBlock key={`${file.status}:${file.file}`} file={file} foldOpen={foldOpen} />
      ))}
    </div>
  )
}

function FileDiffBlock({ file, foldOpen }: { file: FileDiff; foldOpen: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  /** 折叠中的 hunk 下标（缺省空 = 全展开） */
  const [closedHunks, setClosedHunks] = useState<ReadonlySet<number>>(new Set())
  // 解析 + 高亮一次成型（重渲染零重活，移动端教训：build 路径零重活）
  const prepared = useMemo(() => prepareFile(file), [file])

  // 全局折叠/展开：意图覆盖本地状态（含后续挂载的新文件块）；数据刷新不重置
  // 手动状态（deps 仅 foldOpen）。useLayoutEffect 免折叠态首帧闪现。
  // 函数式更新 + 无变化返回 prev：新 Set 恒不等价旧值，直接 set 会让每个文件块
  // 挂载时多一次 pre-paint 重渲染（大 diff 文件多时翻倍首屏开销）。
  useLayoutEffect(() => {
    setOpen(foldOpen)
    setClosedHunks((prev) => {
      if (foldOpen) return prev.size === 0 ? prev : new Set()
      return new Set(prepared.hunks.keys())
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldOpen])

  const toggleHunk = (hi: number) =>
    setClosedHunks((prev) => {
      const next = new Set(prev)
      if (next.has(hi)) {
        next.delete(hi)
      } else {
        next.add(hi)
      }
      return next
    })

  return (
    <section className={"diff-file" + (open ? "" : " closed")}>
      <button
        type="button"
        className="diff-file-header"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
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
      {open &&
        prepared.hunks.map((hunk, hi) => {
          const spans = prepared.spans[hi] ?? []
          const newEnd = hunk.newStart + Math.max(0, hunk.lines.filter((l) => l.kind !== "-").length - 1)
          const hunkOpen = !closedHunks.has(hi)
          return (
            <div className="diff-hunk" key={hi}>
              <button
                type="button"
                className="diff-hunk-header"
                aria-expanded={hunkOpen}
                onClick={() => toggleHunk(hi)}
              >
                {hunkOpen ? (
                  <ChevronDown className="diff-chevron" size={12} aria-hidden />
                ) : (
                  <ChevronRight className="diff-chevron" size={12} aria-hidden />
                )}
                <span>{t.diffHunkSegment.replace("{n}", String(hi + 1))}</span>
                <span className="mono">
                  L{hunk.newStart}–{newEnd}
                </span>
                <span className="diff-file-stat">
                  <span className="diff-add-num">+{hunk.additions}</span>{" "}
                  <span className="diff-del-num">−{hunk.deletions}</span>
                </span>
              </button>
              {hunkOpen && (
                <div className="diff-hunk-body">
                  {hunk.lines.map((line, li) => (
                    <DiffRow key={li} line={line} tokens={spans[li]} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      {open && prepared.hunks.length === 0 && (
        <div className="diff-hunk-body">
          <div className="diff-binary">{t.diffNoTextDiff}</div>
        </div>
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
