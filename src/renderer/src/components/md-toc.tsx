/**
 * markdown 预览 TOC 大纲（design-markdown-preview §2.4）。
 * 标题来源是预览体渲染后的 DOM 扫描（h1–h6）——不侵入消息流共享的 streamdown
 * 渲染管道；点击条目 scrollIntoView 锚定，章节树支持按节点收起/展开。
 * TOC 整列占据内容左侧（列内自滚、始终可见）——「吸顶」语义由全高列满足，
 * 不用 sticky + 视口高度魔法值。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { ChevronDown, ChevronRight, ListTree, PanelLeftClose } from "lucide-react"
import { useI18n } from "../app"

export interface TocHeading {
  level: number
  text: string
  el: HTMLElement
}

export interface TocNode {
  heading: TocHeading
  children: TocNode[]
}

/** 扫描预览体 DOM 收集真实标题（代码块内的 `#` 不会被解析为标题元素，天然排除） */
export function collectHeadings(root: ParentNode): TocHeading[] {
  return Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((el) => ({
    level: Number(el.tagName[1]),
    text: (el.textContent ?? "").trim(),
    el: el as HTMLElement,
  }))
}

/** 扁平标题 → 章节树：level 更大的挂入最近的更浅标题之下（栈式归并） */
export function buildTocTree(headings: TocHeading[]): TocNode[] {
  const root: TocNode[] = []
  const stack: { level: number; children: TocNode[] }[] = [{ level: 0, children: root }]
  for (const heading of headings) {
    const node: TocNode = { heading, children: [] }
    while (stack.length > 1 && stack[stack.length - 1].level >= heading.level) stack.pop()
    stack[stack.length - 1].children.push(node)
    stack.push({ level: heading.level, children: node.children })
  }
  return root
}

interface TocLevelProps {
  nodes: TocNode[]
  depth: number
  folded: ReadonlySet<HTMLElement>
  sectionToggleLabel: string
  onFold: (el: HTMLElement) => void
  onJump: (heading: TocHeading) => void
}

function TocLevel({ nodes, depth, folded, sectionToggleLabel, onFold, onJump }: TocLevelProps) {
  return (
    <ul>
      {nodes.map((node, i) => {
        const { heading } = node
        const hasChildren = node.children.length > 0
        const isFolded = folded.has(heading.el)
        return (
          <li key={i}>
            <div className="md-toc-item" style={{ "--toc-indent": depth } as CSSProperties}>
              {hasChildren ? (
                <button
                  type="button"
                  className="md-toc-fold"
                  aria-expanded={!isFolded}
                  aria-label={sectionToggleLabel}
                  onClick={() => onFold(heading.el)}
                >
                  {isFolded ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
                </button>
              ) : (
                <span className="md-toc-fold md-toc-fold-empty" aria-hidden />
              )}
              <button
                type="button"
                className="md-toc-link"
                title={heading.text}
                onClick={() => onJump(heading)}
              >
                {heading.text}
              </button>
            </div>
            {hasChildren && !isFolded && (
              <TocLevel
                nodes={node.children}
                depth={depth + 1}
                folded={folded}
                sectionToggleLabel={sectionToggleLabel}
                onFold={onFold}
                onJump={onJump}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** TOC 侧栏。无标题时不渲染（内容区保持原限宽居中布局） */
export function MdToc({ headings }: { headings: TocHeading[] }) {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  const [folded, setFolded] = useState<ReadonlySet<HTMLElement>>(new Set())
  const tree = useMemo(() => buildTocTree(headings), [headings])

  // 内容更换后旧元素引用失效，章节折叠态重置（整栏收起态保留）
  useEffect(() => {
    setFolded(new Set())
  }, [headings])

  if (headings.length === 0) return null

  const jump = (h: TocHeading) => {
    h.el.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  if (collapsed) {
    return (
      <aside className="md-toc collapsed">
        <button
          type="button"
          className="icon-btn"
          title={t.tocExpand}
          aria-label={t.tocExpand}
          onClick={() => setCollapsed(false)}
        >
          <ListTree size={16} aria-hidden />
        </button>
      </aside>
    )
  }

  return (
    <aside className="md-toc" aria-label={t.tocTitle}>
      <div className="md-toc-header">
        <span className="md-toc-title">{t.tocTitle}</span>
        <button
          type="button"
          className="icon-btn"
          title={t.tocCollapse}
          aria-label={t.tocCollapse}
          onClick={() => setCollapsed(true)}
        >
          <PanelLeftClose size={14} aria-hidden />
        </button>
      </div>
      <nav className="md-toc-tree">
        <TocLevel
          nodes={tree}
          depth={0}
          folded={folded}
          sectionToggleLabel={t.tocSectionToggle}
          onFold={(el) =>
            setFolded((prev) => {
              const next = new Set(prev)
              if (next.has(el)) next.delete(el)
              else next.add(el)
              return next
            })
          }
          onJump={jump}
        />
      </nav>
    </aside>
  )
}
