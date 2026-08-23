/**
 * 消息流 markdown 渲染（架构决策 design-architecture §5 L0：streamdown）。
 * 流式解析/块级 memo 由 streamdown 承担；组件层全部覆写——
 * 其内置样式依赖 Tailwind（本项目无），样式以 tokens.css 语义令牌重写。
 * 用户参考移动端 app：assistant 文本与 reasoning 走 markdown，用户消息保持纯文本。
 */
import { cloneElement, isValidElement, useState, type ReactNode } from "react"
import { Streamdown, type Components, type LinkSafetyConfig } from "streamdown"
import { useI18n } from "../app"

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

/** 代码块：语言标签 + 复制 + 滚动体（沿用 chip 展开体 code-block 的视觉语言） */
function renderPre(children: ReactNode) {
  const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null
  const lang = child ? (/language-(\S+)/.exec(child.props.className ?? "")?.[1] ?? "") : ""
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-header">
        <span className="md-codeblock-lang">{lang}</span>
        <CopyButton getText={() => extractText(child?.props.children)} />
      </div>
      <pre className="md-pre">{child ? cloneElement(child, { "data-block": "true" } as never) : children}</pre>
    </div>
  )
}

const mdComponents: Components = {
  // streamdown 的默认组件全部是 Tailwind 样式件（strong→span.font-semibold 等），
  // 本项目无 Tailwind，全部覆写回语义元素，样式由 app.css 的 .md 承担
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
  blockquote: ({ node: _node, children }) => <blockquote>{children}</blockquote>,
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
  a: ({ node: _node, children, ...rest }) => (
    <a {...rest} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // 代码块：语言标签 + 复制 + 滚动体
  pre: ({ node: _node, children }) => renderPre(children),
  table: ({ node: _node, children }) => (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  ),
}

/** 模块级常量：Streamdown 的 memo 按引用比较 props，内联字面量会导致流式期间整树重渲染 */
const mdLinkSafety: LinkSafetyConfig = { enabled: false }

export function Markdown({ children }: { children: string }) {
  return (
    <Streamdown className="md" components={mdComponents} linkSafety={mdLinkSafety}>
      {children}
    </Streamdown>
  )
}
