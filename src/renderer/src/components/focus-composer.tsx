/**
 * 专注模式面板（design-focus-mode，2026-10-19 变形改版）：会话页/引导页的
 * 大段 prompt 编辑面，嵌入 tab 内容区（视图根的绝对定位子元素，§3.2——
 * 非弹窗：Tab 栏/左栏/右栏照常可见可交互）。变形语义（§3.2 改写）：面板
 * 底缘经 bottomInset 钉在输入盒底缘——观感是「输入框本体长大撑满页面」，
 * 原发送行（composer-actions）原位保留在面板下方，面板内无发送按钮。
 *
 * - CM6 编辑器（§4）：markdown 高亮复用 cm-lang 同源语言包 + cm-theme class 化
 *   主题（颜色走 app.css --syntax-* 令牌）；Enter 一律换行、无发送命令（D4）
 *   ——defaultKeymap 的 insertNewlineAndIndent 即语义本身；Esc = 退回普通模式
 *   （CM 内 Prec.highest 压过选区折叠，面板根 bubble 监听兜底焦点不在编辑器
 *   的场景——bubble 保证内层先消费，"已 preventDefault 不处理"既有约定）
 * - FLIP grow-from-origin 开合动画（§7）：opening 自 origin rect（入口点击时
 *   量测的 composer-input 盒）变换到 identity——两视图同为向上展开（底缘
 *   钉输入盒底缘、上缘扫到页面顶边距，2026-10-19 变形改版）；closing 反向
 *   收拢回实时量测的 composer rect（getOriginRect）。
 *   只动 transform/opacity（合成器属性）；transitionend + 300ms 兜底定时器
 *   驱动 onOpened/onClosed（不保证必达）
 * - 拖放吞掉层（§6.2）：面板根 preventDefault + stopPropagation，落文件零效果
 *   ——不挂 fileDragProps/dragProps（禁用而非接收），will-navigate 只作兜底
 * - focusSurfaceFadeClass（§6.4）：卡片两槽位的两段式渐变类，供 ChatView
 *   在 opening/closing 期间挂载渐隐/渐显
 */
import { Minimize2 } from "lucide-react"
import { useEffect, useLayoutEffect, useRef } from "react"
import { markdown } from "@codemirror/lang-markdown"
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from "@codemirror/commands"
import { EditorSelection, EditorState, Prec } from "@codemirror/state"
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view"
import { cmSyntaxTheme } from "./cm-theme"

/** 专注模式相位（§6.4）：off = 未挂载本组件 */
export type FocusPhase = "off" | "opening" | "on" | "closing"

/** 跨模式选区偏移（§5：两编辑面持同一纯文本，1:1 映射） */
export interface FocusSelection {
  start: number
  end: number
}

/** 卡片两槽位两段式渐变类（§6.4）：opening 渐隐（forwards 保终态至 on 卸载）、
 * closing 挂载即播渐显、off 无——返回裸类名，调用侧自行拼空格 */
export function focusSurfaceFadeClass(phase: FocusPhase): string {
  return phase === "opening" ? "focus-fade-out" : phase === "closing" ? "focus-fade-in" : ""
}

/** 相位回调的兜底窗口（§7）：面板过渡 200ms + 余量；reduced-motion 下为 0 */
const ANIM_FALLBACK_MS = 300

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
}

function buildExtensions(
  placeholder: string,
  requestClose: () => void,
  onChange: (v: string) => void,
) {
  return [
    markdown(),
    cmSyntaxTheme,
    EditorView.lineWrapping,
    history(),
    keymap.of([
      // Enter 一律换行（D4）：defaultKeymap 的 Mod-Enter 绑 insertBlankLine
      // （插空行）、Alt/Shift-Enter 无绑定——显式前置三个修饰变体，裸 Enter
      // 落到 defaultKeymap 的 insertNewlineAndIndent，语义统一为单换行
      { key: "Mod-Enter", run: insertNewlineAndIndent },
      { key: "Alt-Enter", run: insertNewlineAndIndent },
      { key: "Shift-Enter", run: insertNewlineAndIndent },
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    cmPlaceholder(placeholder),
    // Esc = 退回普通模式（§4.2）：压过 defaultKeymap 的选区折叠
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: () => {
            requestClose()
            return true
          },
        },
      ]),
    ),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange(u.state.doc.toString())
    }),
  ]
}

export function FocusComposer({
  phase,
  value,
  onChange,
  origin,
  getOriginRect,
  initialSelection,
  onOpened,
  onClosed,
  onRequestClose,
  placeholder,
  exitTitle,
  bottomInset,
  ariaLabel,
}: {
  /** opening/on/closing（off 时父级不渲染本组件） */
  phase: FocusPhase
  value: string
  onChange: (v: string) => void
  /** 打开动画的起始 rect（入口点击时量测的 composer-input 盒，§7） */
  origin: DOMRect | null
  /** 关闭动画的目标 rect 实时量测（composer 底层保持挂载的原因，§2） */
  getOriginRect: () => DOMRect | null
  /** 打开时的初始选区（textarea selectionStart/End，§5） */
  initialSelection: FocusSelection | null
  onOpened: () => void
  /** 关闭动画完成后携 CM 主选区回调（父级据此恢复 textarea 选区） */
  onClosed: (selection: FocusSelection) => void
  onRequestClose: () => void
  placeholder: string
  exitTitle: string
  /** 面板底缘距视图底的距离（px，§3.2 变形语义）：调用方实测输入盒底缘所得，
   *  面板底缘与输入盒底缘重合——CSS 类的 calc 值仅为兜底 */
  bottomInset: number
  ariaLabel: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** 面板自然 rect（未变换的布局盒）：opening 首帧量测缓存——closing 中途
   * 触发时当前 rect 是变换中的视觉盒，FLIP retarget 须以自然盒为基准
   * （review minor 2：transform-origin 锚自然盒，用视觉盒会偏移落点） */
  const naturalRectRef = useRef<DOMRect | null>(null)
  /** 当前相位镜像：opening 的兜底回调在 closing 抢跑后不得再报 onOpened
   * （review minor 3：transitionend 监听器无法中途解绑，以相位守卫代替） */
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  // 挂载期快照（创建后不再变化的 props，经 ref 供挂载 effect 取初值）
  const initialSelectionRef = useRef(initialSelection)
  const originRef = useRef(origin)

  // 回调稳定化：动画/键位闭包只装配一次，经 ref 触达最新实现
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const requestCloseRef = useRef(onRequestClose)
  requestCloseRef.current = onRequestClose
  const onOpenedRef = useRef(onOpened)
  onOpenedRef.current = onOpened
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed
  const getOriginRectRef = useRef(getOriginRect)
  getOriginRectRef.current = getOriginRect
  const valueRef = useRef(value)
  valueRef.current = value

  // CM 生命周期（复刻 code-view：挂载创建/卸载销毁，创建期快照初始 doc/选区）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const doc = valueRef.current
    const sel = initialSelectionRef.current
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.range(
          Math.min(sel?.start ?? doc.length, doc.length),
          Math.min(sel?.end ?? doc.length, doc.length),
        ),
        extensions: buildExtensions(
          placeholder,
          () => requestCloseRef.current(),
          (v) => onChangeRef.current(v),
        ),
      }),
      parent: host,
    })
    viewRef.current = view
    view.focus()
    // 光标滚入视口（创建当帧高度未建立，rAF 后一次性）
    const raf = requestAnimationFrame(() => {
      if (viewRef.current !== view) return
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.to) })
    })
    return () => {
      cancelAnimationFrame(raf)
      view.destroy()
      viewRef.current = null
    }
    // 创建期取值；后续 value 变化经 doc 同步 effect 整体替换（§5）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // doc 同步：外部改值（回滚回填/发送清空/失败回填）→ 整体替换（code-view 同款）
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc
    if (doc.length !== value.length || doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: doc.length, insert: value } })
    }
  }, [value])

  // FLIP 打开（§7）：挂载帧执行——面板置 origin 变换 + 内容透明，强制
  // 回流后清初始态 → CSS 过渡到 identity；transitionend + 兜底定时器 → onOpened
  useLayoutEffect(() => {
    const panel = panelRef.current
    const body = bodyRef.current
    if (!panel || !body) return
    const reduced = prefersReducedMotion()
    const r2 = panel.getBoundingClientRect()
    naturalRectRef.current = r2
    const from = originRef.current
    if (!reduced && from && r2.width > 0 && r2.height > 0) {
      const sx = from.width / r2.width
      const sy = from.height / r2.height
      panel.style.transformOrigin = "top left"
      panel.style.transition = "none"
      panel.style.transform = `translate(${from.left - r2.left}px, ${from.top - r2.top}px) scale(${sx}, ${sy})`
      body.style.transition = "none"
      body.style.opacity = "0"
      void panel.offsetHeight // 强制回流，锁定初始态后再起过渡
      panel.style.transition = ""
      panel.style.transform = ""
      body.style.transition = ""
      body.style.opacity = ""
    }
    let done = false
    const finish = (e?: Event) => {
      if (done) return
      if (e && (e.target !== panel || (e as TransitionEvent).propertyName !== "transform")) return
      done = true
      // closing 抢跑（opening 窗口内退出）：不再报 onOpened（review minor 3）
      if (phaseRef.current !== "opening") return
      onOpenedRef.current()
    }
    panel.addEventListener("transitionend", finish)
    const timer = window.setTimeout(() => finish(), reduced ? 0 : ANIM_FALLBACK_MS)
    return () => {
      panel.removeEventListener("transitionend", finish)
      window.clearTimeout(timer)
    }
    // 挂载帧一次性；origin 经 ref 快照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // FLIP 关闭（§7）：closing 相位触发——重新量测底层 composer rect，面板自
  // identity 过渡回该 rect；内容渐隐；完成后携 CM 主选区回调卸载
  useLayoutEffect(() => {
    if (phase !== "closing") return
    const panel = panelRef.current
    const body = bodyRef.current
    if (!panel || !body) return
    const reduced = prefersReducedMotion()
    const r1 = getOriginRectRef.current()
    // 自然盒基准（review minor 2，2026-10-19 修订）：identity 态（on 稳态，
    // computed transform none）下当前盒即自然盒——resize 后的几何漂移（inset
    // 重测/列宽变化）自然吸收；开合动画窗内（computed 为插值矩阵）视觉盒是
    // 变换中间态，退回 opening 首帧缓存（2026-10-18 review minor 2 原修）
    const r2 =
      getComputedStyle(panel).transform === "none"
        ? panel.getBoundingClientRect()
        : (naturalRectRef.current ?? panel.getBoundingClientRect())
    if (r1 && r2.width > 0 && r2.height > 0 && !reduced) {
      const sx = r1.width / r2.width
      const sy = r1.height / r2.height
      panel.style.transformOrigin = "top left"
      panel.style.transform = `translate(${r1.left - r2.left}px, ${r1.top - r2.top}px) scale(${sx}, ${sy})`
      body.style.opacity = "0"
    } else {
      // jsdom / 无 origin / reduced-motion：无动画直切（内容瞬时隐）
      body.style.transition = "none"
      body.style.opacity = "0"
    }
    let done = false
    const finish = (e?: Event) => {
      if (done) return
      if (e && (e.target !== panel || (e as TransitionEvent).propertyName !== "transform")) return
      done = true
      const sel = viewRef.current?.state.selection.main
      const len = valueRef.current.length
      onClosedRef.current(sel ? { start: sel.from, end: sel.to } : { start: len, end: len })
    }
    panel.addEventListener("transitionend", finish)
    const timer = window.setTimeout(() => finish(), reduced ? 0 : ANIM_FALLBACK_MS)
    return () => {
      panel.removeEventListener("transitionend", finish)
      window.clearTimeout(timer)
    }
  }, [phase])

  // 拖放吞掉（§6.2）：preventDefault + stopPropagation、无添加动作
  const swallowDrag = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={panelRef}
      className="focus-composer"
      role="region"
      aria-label={ariaLabel}
      style={{ bottom: `${bottomInset}px` }}
      onKeyDown={(e) => {
        // bubble 兜底（§4.2）：焦点在面板按钮等处时 Esc 仍可退回；内层
        // （CM keymap 等）先消费并 preventDefault 则不重复触发
        if (e.key !== "Escape" || e.nativeEvent.isComposing || e.defaultPrevented) return
        e.preventDefault()
        requestCloseRef.current()
      }}
      onDragOver={swallowDrag}
      onDrop={swallowDrag}
    >
      <div className="focus-toolbar">
        <button
          type="button"
          className="icon-btn"
          title={exitTitle}
          aria-label={exitTitle}
          onClick={() => requestCloseRef.current()}
        >
          <Minimize2 size={16} aria-hidden />
        </button>
      </div>
      <div ref={bodyRef} className="focus-body">
        <div ref={hostRef} className="focus-editor-host" />
      </div>
    </div>
  )
}
