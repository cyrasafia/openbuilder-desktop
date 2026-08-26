/**
 * 只读 CodeMirror 6 React 壳（design-code-view §2.3）：
 * 生命周期（挂载创建/卸载销毁）+ doc 同步（重拉后整体替换保滚动位置）+
 * 只读装配（行号/语法高亮/搜索）。openchamber 自写壳同思路，不引入封装包。
 * readonly + editable 并用：内容可聚焦（键盘滚动/Ctrl+F 搜索面板），不可编辑；
 * search 面板在 readonly 下自动隐藏 replace 控件（CM 内建行为）。
 */
import { useEffect, useRef } from "react"
import { EditorState } from "@codemirror/state"
import { EditorView, keymap, lineNumbers } from "@codemirror/view"
import { search, searchKeymap } from "@codemirror/search"
import { languageForPath } from "./cm-lang"
import { cmSyntaxTheme } from "./cm-theme"
import type { Locale } from "../i18n"

/** 搜索面板短语（CM 默认英文；zh 提供本地化，en 用内建默认） */
const searchPhrasesZh: Record<string, string> = {
  Find: "查找",
  Replace: "替换",
  next: "下一处",
  previous: "上一处",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则表达式",
  "by word": "全字匹配",
  "replace all": "全部替换",
  close: "关闭",
  "current match": "当前匹配",
  "Go to line": "跳到行",
  go: "跳转",
}

function buildExtensions(path: string, locale: Locale | undefined) {
  const lang = languageForPath(path)
  return [
    lineNumbers(),
    cmSyntaxTheme,
    ...(lang ? [lang] : []),
    search({ top: true }),
    keymap.of(searchKeymap),
    ...(locale === "zh" ? [EditorState.phrases.of(searchPhrasesZh)] : []),
    EditorState.readOnly.of(true),
  ]
}

export function CodeView({
  path,
  content,
  locale,
  initialScrollTop,
  onScrollTop,
}: {
  path: string
  content: string
  locale?: Locale
  /** 挂载后恢复的滚动偏移（design-tab-state-memory §2.2；超界由浏览器 clamp） */
  initialScrollTop?: number
  /** 滚动偏移上报（上层落 store，供切走再回恢复；高频，上层写入不得触发重渲染） */
  onScrollTop?: (top: number) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions: buildExtensions(path, locale) }),
      parent: host,
    })
    viewRef.current = view
    // CM 内滚（.cm-scroller）：布局落定（rAF）后一次性恢复偏移——创建当帧
    // scrollHeight 未建立，直接设会被 clamp 到 0；另挂滚动监听上报
    let raf = 0
    if (initialScrollTop) {
      raf = requestAnimationFrame(() => {
        if (viewRef.current === view) view.scrollDOM.scrollTop = initialScrollTop
      })
    }
    const scroller = view.scrollDOM
    const onScroll = () => onScrollTop?.(scroller.scrollTop)
    scroller.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      scroller.removeEventListener("scroll", onScroll)
      view.destroy()
      viewRef.current = null
    }
    // path/language/locale 变更 = 换文件或换语言，由上层 key 隔离重挂载；只在创建期取值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // doc 同步：激活重拉后 content 变化 → 整体替换（保滚动位置，不重建视图）。
  // 长度快路径先行，避免每次重拉 O(n) toString 分配
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc
    if (doc.length !== content.length || doc.toString() !== content) {
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: content },
      })
    }
  }, [content])

  return <div ref={hostRef} className="code-view-host" />
}
