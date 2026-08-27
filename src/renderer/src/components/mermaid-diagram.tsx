/**
 * mermaid 图渲染（design-markdown-preview §2.7）。
 * 前置事实：streamdown 自带 mermaid 支持，但其分发在默认 code 组件内——本项目
 * 的 mdComponents 全量覆写 code/pre（无 Tailwind），其路径不可达也不合视觉语言，
 * 故自建渲染件：`renderPre` 按 lang 分发到此，成功渲染 SVG，失败回落代码块外壳
 * （流式期间图未画完是常态，回落源码比报错卡友好；静态文件里语法错误同样回落，
 * 与 GitHub 无效 mermaid 显示源码的行为一致）。
 * mermaid 包是 streamdown 依赖树中的既有传递依赖（已随锁文件安装），此处直连
 * 故在 package.json 显式声明；懒加载（动态 import）——无 mermaid 块的会话/文档
 * 不付出 ~1.4MB chunk 的加载成本（electron-vite 自动分包）。
 */
import { useEffect, useState, type ReactNode } from "react"

/** 懒加载的 mermaid 默认导出类型（type-only，不引入运行时依赖） */
type Mermaid = (typeof import("mermaid"))["default"]

let mermaidPromise: Promise<Mermaid> | null = null

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((m) => m.default)
  return mermaidPromise
}

/** render 全局序号：mermaid.render 的 id 须唯一（并发同 id 会互相覆盖） */
let renderSeq = 0

/** 渲染串行队列：mermaid.render 内部经全局测量元素排版，并发调用互相踩踏
 * （官方 issue 实证），队列化后每个实例的 render 依次执行 */
let renderQueue: Promise<unknown> = Promise.resolve()

function enqueueRender(fn: () => Promise<{ svg: string }>): Promise<{ svg: string }> {
  const run = renderQueue.then(fn, fn)
  renderQueue = run.then(
    () => {},
    () => {},
  )
  return run
}

/** 当前主题对应的 mermaid 主题：light → default，dark → dark。
 * 主题真值在 document.documentElement[data-theme]（app.tsx 维护，无 store 级
 * 订阅），渲染前读取 + MutationObserver 监听变更重渲染。 */
function mermaidTheme(): "default" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "default" : "dark"
}

/**
 * @param source 图源码（renderPre 从 code 元素提取的纯文本）
 * @param langLabel 语言标签（加载/回落态外壳展示，与代码块外壳同源）
 * @param fallback 失败回落节点（renderPre 预构建的代码块外壳，含复制按钮）
 */
export function MermaidDiagram({ source, langLabel, fallback }: {
  source: string
  langLabel: string
  fallback: ReactNode
}) {
  // stale-while-revalidate：源/主题变化时保留旧图直到新图落地，流式不闪加载态
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [theme, setTheme] = useState(mermaidTheme)

  useEffect(() => {
    const el = document.documentElement
    const mo = new MutationObserver(() => setTheme(mermaidTheme()))
    mo.observe(el, { attributes: true, attributeFilter: ["data-theme"] })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    // 防抖 200ms：流式期间源码每个 emit 都变，逐次 render 既昂贵又必然失败
    // （图未画完），等流稳定后再尝试；取消时清定时器丢弃在途尝试
    const timer = setTimeout(() => {
      void loadMermaid()
        .then((mermaid) => {
          if (cancelled) return null
          // securityLevel "strict"（默认）：mermaid 内置 DOMPurify 清洗 SVG；
          // startOnLoad false：只走手动 render，不做 DOM 扫描自动渲染
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme })
          return enqueueRender(() => mermaid.render(`md-mermaid-${++renderSeq}`, source))
        })
        .then((res) => {
          if (cancelled || !res) return
          setSvg(res.svg)
          setFailed(false)
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source, theme])

  if (failed) return <>{fallback}</>
  if (svg === null) {
    return (
      <div className="md-mermaid md-mermaid-pending">
        <div className="md-mermaid-label">{langLabel}</div>
        {/* 无文案骨架（呼吸动画）：不引 i18n，加载中无需用户阅读内容 */}
        <div className="md-mermaid-skeleton" aria-hidden />
      </div>
    )
  }
  // SVG 经 mermaid strict 级清洗；id 唯一化由 renderSeq 保证
  return <div className="md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
}
