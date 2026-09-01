/**
 * 消息流 markdown 渲染（架构决策 design-architecture §5 L0：streamdown）。
 * 流式解析/块级 memo 由 streamdown 承担；组件层全部覆写——
 * 其内置样式依赖 Tailwind（本项目无），排版主体改由 vendor/github-markdown-css
 * （按 [data-theme] 切明暗）承担，本地仅覆写代码块外壳/表格包裹/链接色等结构。
 * 用户参考移动端 app：assistant 与 user 文本均走 markdown（用户消息气泡内），
 * reasoning 同走 markdown；GFM alert（[!NOTE] 等）在 blockquote 覆写层支持；
 * mermaid 图在 pre 覆写层分发（§2.7）。
 */
import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react"
import { Info, Lightbulb, MessageSquareWarning, OctagonX, TriangleAlert, type LucideIcon } from "lucide-react"
import {
  Streamdown,
  defaultRemarkPlugins,
  type Components,
  type LinkSafetyConfig,
  type StreamdownProps,
} from "streamdown"
import { useI18n } from "../app"
import { MermaidDiagram } from "./mermaid-diagram"

/* ---------- GFM Alerts（[!NOTE]/[!TIP]/…，design-markdown-preview §2.6） ----------
 * GitHub 规范：blockquote 首段以 [!TYPE] 标记开头即渲染为对应语义的提示卡。
 * 样式完全由 vendor github-markdown-css 的 .markdown-alert 系列承担（明暗两套
 * 主题齐全）；本层只做两件事——识别标记（在组件层检查首段文本，不动 streamdown
 * 的 remark 管道/插件默认集）+ 剥离标记并补标题行（图标用 lucide 线性，项目
 * 图标语言；GitHub 用 octicon 填充，语义对齐）。消息流与文件预览共用此组件，
 * 两处同时生效。 */
const ALERT_LABELS = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
} as const
type AlertKind = keyof typeof ALERT_LABELS
const ALERT_ICONS: Record<AlertKind, LucideIcon> = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: TriangleAlert,
  caution: OctagonX,
}
/** 吞掉标记后同行空隙或单个换行（软换行不产生空行） */
const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n)?[ \t]*/i

/** hast 节点的最小结构视图（alert 识别用；不引入 hast 类型依赖） */
interface HastLike {
  type: string
  tagName?: string
  children?: HastLike[]
  value?: string
}

/** blockquote 的 hast 节点是否为 GFM alert：首个元素子节点是 <p> 且该段首个
 *  子节点是以 [!TYPE] 开头的文本（标记必须在首段最前——嵌套引用/列表/标题
 *  开头、或标记在后续段落，均不成立，按普通引用块字面渲染） */
function alertKindFromNode(node: unknown): AlertKind | null {
  const bq = node as HastLike | null | undefined
  if (!bq || !Array.isArray(bq.children)) return null
  const firstEl = bq.children.find((c) => c.type === "element")
  if (!firstEl || firstEl.tagName !== "p" || !Array.isArray(firstEl.children)) return null
  const first = firstEl.children[0]
  if (!first || first.type !== "text" || typeof first.value !== "string") return null
  const m = ALERT_MARKER.exec(first.value)
  return m ? (m[1].toLowerCase() as AlertKind) : null
}

/** React children 侧剥离首段开头的标记文本（与 alertKindFromNode 同一棵树：
 *  块级 children 形如 ["\n", <P/>, "\n", <P/>, "\n"]，按首个元素子节点定位，
 *  标记所在的文本是段 props.children 的首个字符串）。整段只剩标记则丢弃该段。 */
function stripAlertMarker(children: ReactNode): ReactNode[] {
  const list = Array.isArray(children) ? children : [children]
  const firstIdx = list.findIndex((c) => isValidElement(c))
  if (firstIdx === -1) return list
  const first = list[firstIdx] as ReactElement<{ children?: ReactNode }>
  const inner = first.props.children
  const innerList = Array.isArray(inner) ? inner : [inner]
  const firstText = innerList[0]
  if (typeof firstText !== "string") return list
  const m = ALERT_MARKER.exec(firstText)
  if (!m) return list
  const rest = firstText.slice(m[0].length)
  const newInner = rest === "" ? innerList.slice(1) : [rest, ...innerList.slice(1)]
  const newList = [...list]
  if (newInner.length > 0) {
    newList[firstIdx] = cloneElement(first, {}, ...newInner)
  } else {
    newList.splice(firstIdx, 1)
  }
  return newList
}

/** 递归提取 ReactNode 纯文本（代码块复制用） */
function extractText(node: ReactNode): string {
  if (node == null || node === false) return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children)
  return ""
}

function CopyButton({ getText }: { getText: () => string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="md-copy"
      tabIndex={-1}
      onClick={() => {
        void navigator.clipboard
          .writeText(getText())
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {})
      }}
    >
      {copied ? t.copied : t.copy}
    </button>
  )
}

/** 代码块：语言标签 + 复制 + 滚动体（沿用 chip 展开体 code-block 的视觉语言）。
 * mermaid 语言（design-markdown-preview §2.7）分发到 MermaidDiagram：失败回落
 * 本外壳（由 MermaidDiagram 持有，二态共用同一视觉语言） */
function renderPre(children: ReactNode) {
  const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null
  const lang = child ? (/language-(\S+)/.exec(child.props.className ?? "")?.[1] ?? "") : ""
  const block = (
    <div className="md-codeblock">
      <div className="md-codeblock-header">
        <span className="md-codeblock-lang">{lang}</span>
        <CopyButton getText={() => extractText(child?.props.children)} />
      </div>
      {/* tabIndex=-1：滚动容器不入焦点序列（消息流内容全部排除，同 chip/链接） */}
      <pre className="md-pre" tabIndex={-1}>{child ? cloneElement(child, { "data-block": "true" } as never) : children}</pre>
    </div>
  )
  if (child && lang.toLowerCase() === "mermaid") {
    return (
      <MermaidDiagram
        source={extractText(child.props.children)}
        langLabel={lang}
        fallback={block}
      />
    )
  }
  return block
}

const mdComponents: Components = {
  // streamdown 的默认组件全部是 Tailwind 样式件（strong→span.font-semibold 等），
  // 本项目无 Tailwind，全部覆写回语义元素，排版样式由 vendor/github-markdown-css 承担
  p: ({ node: _node, children }) => <p>{children}</p>,
  strong: ({ node: _node, children }) => <strong>{children}</strong>,
  em: ({ node: _node, children }) => <em>{children}</em>,
  h1: ({ node: _node, children }) => <h1>{children}</h1>,
  h2: ({ node: _node, children }) => <h2>{children}</h2>,
  h3: ({ node: _node, children }) => <h3>{children}</h3>,
  h4: ({ node: _node, children }) => <h4>{children}</h4>,
  h5: ({ node: _node, children }) => <h5>{children}</h5>,
  h6: ({ node: _node, children }) => <h6>{children}</h6>,
  ul: ({ node: _node, children }) => <ul>{children}</ul>,
  ol: ({ node: _node, children }) => <ol>{children}</ol>,
  li: ({ node: _node, children }) => <li>{children}</li>,
  hr: ({ node: _node }) => <hr />,
  thead: ({ node: _node, children }) => <thead>{children}</thead>,
  tbody: ({ node: _node, children }) => <tbody>{children}</tbody>,
  tr: ({ node: _node, children }) => <tr>{children}</tr>,
  th: ({ node: _node, children }) => <th>{children}</th>,
  td: ({ node: _node, children }) => <td>{children}</td>,
  blockquote: ({ node, children }) => {
    const kind = alertKindFromNode(node)
    if (kind) {
      const Icon = ALERT_ICONS[kind]
      return (
        <blockquote className={`markdown-alert markdown-alert-${kind}`}>
          <p className="markdown-alert-title">
            <Icon size={16} aria-hidden />
            {ALERT_LABELS[kind]}
          </p>
          {stripAlertMarker(children)}
        </blockquote>
      )
    }
    return <blockquote>{children}</blockquote>
  },
  img: ({ node: _node, ...rest }) => <img {...rest} />,
  sup: ({ node: _node, children }) => <sup>{children}</sup>,
  sub: ({ node: _node, children }) => <sub>{children}</sub>,
  // 行内代码；代码块内的 code（pre 打了 data-block 标记）走同一组件
  code: ({ node: _node, className, children, ...rest }) => {
    if ("data-block" in rest) {
      return <code className={"md-codeblock-code" + (className ? ` ${className}` : "")}>{children}</code>
    }
    return <code className="md-code-inline">{children}</code>
  },
  // 链接交给系统浏览器：main 进程 setWindowOpenHandler → shell.openExternal
  // tabIndex=-1：消息流内容整体不参与键盘焦点序列（同 chip/复制按钮，鼠标点击不受影响）
  a: ({ node: _node, children, ...rest }) => (
    <a {...rest} target="_blank" rel="noopener noreferrer" tabIndex={-1}>
      {children}
    </a>
  ),
  // 代码块：语言标签 + 复制 + 滚动体
  pre: ({ node: _node, children }) => renderPre(children),
  table: ({ node: _node, children }) => (
    <div className="md-table-wrap" tabIndex={-1}>
      <table>{children}</table>
    </div>
  ),
}

/** 模块级常量：Streamdown 的 memo 按引用比较 props，内联字面量会导致流式期间整树重渲染 */
const mdLinkSafety: LinkSafetyConfig = { enabled: false }

/* ---------- 用户消息软换行（对齐移动端 softLineBreak: user） ----------
 * 用户回显按所键入的原样断行：单个 \n 渲染为 <br>，而非 CommonMark 的折叠为空格
 * （Shift+Enter 是桌面输入框的换行操作，回显丢失换行即"发出的和写的不一致"）。
 * assistant 文本/reasoning/文件预览维持标准 markdown 语义（移动端 softLineBreak
 * 仅作用于 user，同口径）。等价 remark-breaks 的最小实现：遍历 mdast text 节点，
 * 值内 \n 拆为 break 节点；代码块/行内代码的值在 code/inlineCode 节点上而非
 * text 节点，天然不被触及。手动递归遍历（避免为 15 行逻辑引入 unist-util 直依赖）。 */
interface MdNode {
  type?: string
  value?: string
  children?: MdNode[]
}

const softBreaks = () => (tree: MdNode) => {
  // CRLF/CR 与 LF 同拆（remark-breaks 口径）：回显可能来自未规范换行的客户端（如
  // Windows CLI 写入的历史消息），残留在文本里的 \r 至多表现为 br 前的多余空白
  const split = (value: string) => value.split(/\r\n|\r|\n/)
  const walk = (node: MdNode) => {
    if (!Array.isArray(node.children)) return
    for (const child of node.children) walk(child)
    // 后序替换：children 数组整体重建一次，避免遍历中变更索引
    if (node.children.some((c) => c.type === "text" && c.value?.includes("\n"))) {
      const next: MdNode[] = []
      for (const child of node.children) {
        if (child.type === "text" && child.value?.includes("\n")) {
          split(child.value).forEach((seg, i) => {
            if (i > 0) next.push({ type: "break" })
            if (seg) next.push({ type: "text", value: seg })
          })
        } else {
          next.push(child)
        }
      }
      node.children = next
    }
  }
  walk(tree)
}

/** remarkPlugins 传入即整体替换默认集（gfm + codeMeta），需拼回默认件；模块级常量防 memo 失效 */
const userRemarkPlugins: StreamdownProps["remarkPlugins"] = [
  ...Object.values(defaultRemarkPlugins),
  softBreaks,
]

export function Markdown({ children, softLineBreak }: { children: string; softLineBreak?: boolean }) {
  return (
    <Streamdown
      className="markdown-body md"
      components={mdComponents}
      linkSafety={mdLinkSafety}
      remarkPlugins={softLineBreak ? userRemarkPlugins : undefined}
    >
      {children}
    </Streamdown>
  )
}
